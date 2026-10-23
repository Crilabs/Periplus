import { and, eq, isNull, sql } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import { getConfig, type AppConfig, type ResearchConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places, type BerthSignalKind, type PageKind, type PlaceKind, type PlaceStatus } from "@/lib/db/schema";
import type { ObservedAtBasis } from "@/lib/db/schema/sources";
import { dismissTasks, lockOpenPlaceTasks } from "@/lib/domain/consolidation/task-locks";
import { recheckExclusion } from "@/lib/domain/geometry/restrictions";
import { newPublicId } from "@/lib/domain/ids";
import { hasOpenPairTask, recordDecision, SYSTEM_ACTOR } from "@/lib/domain/places/auto-status";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { activeAssessor } from "./assessment";
import { activeRouteExtractor, berthNameMatches, placeNames } from "./assign";

/*
 * Confirmation of a berth by its research signals (spec 5.6, plan N2 task 6). The rule (`decideBerth`) is pure;
 * `applyBerthVerdicts` loads the signals per place, decides and sets the place's status. It replaces the old
 * auto-confirmation of the consolidation (`applyAutoStatus`, which now only switches the kind). Only a berth this
 * rule confirms is delivered.
 */

type ConfirmationConfig = ResearchConfig["confirmation"];

/** How the signal's page is linked to the place: a search hit of it, a name (assessed berth or route stop), or only a route corridor. */
export type EvidenceLink = "search" | "name" | "corridor";

export type Evidence = {
  signalId: string;
  kind: BerthSignalKind;
  firstHand: boolean;
  confidence: number;
  observedAt: string;
  /** How `observedAt` was found; `fetched`: the page has no date, the fetch dates it. */
  observedAtBasis: ObservedAtBasis;
  /** Registrable domain of the page. */
  domain: string;
  pageKind: PageKind;
  generated: boolean;
  /** The strongest link of the page to the place. */
  link: EvidenceLink;
};

export type Verdict = {
  status: "confirmed" | "candidate" | "no_anchoring";
  /** German, for the admin UI. */
  reason: string;
  /** The domains of the counting positive signals, sorted. */
  independentSources: string[];
  blockingSignalId: string | null;
  /** The signals that decided: the counting positive ones and the blocking one, sorted. */
  signalIds: string[];
};

const NEGATIVE_LABEL: Record<BerthSignalKind, string> = {
  anchored: "geankert",
  moored_buoy: "an der Boje",
  berthed: "am Steg",
  listed_as_berth: "als Liegeplatz geführt",
  prohibited: "Ankerverbot",
  buoys_private: "Bojen privat",
  no_space: "kein Platz",
  unsafe: "unsicher",
  closed: "geschlossen",
};

/** Whether a positive signal is a source: a first-hand stay, or a listing by a page kind that lists berths (official pages for marinas and ports). */
function isSource(e: Evidence, placeKind: PlaceKind, cfg: ConfirmationConfig): boolean {
  if (!cfg.positiveKinds.includes(e.kind)) return false;
  if (e.kind === "listed_as_berth") {
    return cfg.listedAsBerthPageKinds.includes(e.pageKind) || (cfg.officialPlaceKinds.includes(placeKind) && cfg.officialPageKinds.includes(e.pageKind));
  }
  return e.firstHand;
}

const byDateThenId = (a: Evidence, b: Evidence) => a.observedAt.localeCompare(b.observedAt) || a.signalId.localeCompare(b.signalId);

/**
 * The confirmation rule (spec 5.6):
 * 1. a signal counts only with `confidence ≥ minSignalConfidence`, from a not generated page of a counting page kind;
 * 2. positive are first-hand `anchored` / `moored_buoy` / `berthed` and `listed_as_berth` from a listing page kind
 *    (for a marina or port also from an official page);
 * 3. independent sources are the distinct domains of the counting positive signals; positives of pages linked only by
 *    a route corridor count only beside one from a page linked by search hit or name (discovery alone never confirms,
 *    unless `corridorAloneConfirms`);
 * 4. a counting `prohibited` from the authority blocks whatever its age (a ban holds until the authority lifts it):
 *    `no_anchoring`, for an `officialPlaceKinds` place (marina, port) `candidate` (a harbour's anchoring ban does not
 *    mean no berths); any other counting negative blocks when it is at least as young as every dated counting positive
 *    (an undated positive, dated by its fetch, never overrides a dated negative) → `candidate`;
 * 5. an anchorage or mooring field is confirmed by `minIndependentSources` sources, an `officialPlaceKinds` place by an
 *    official page plus another domain;
 * 6. otherwise `candidate`, with the reason.
 */
export function decideBerth(placeKind: PlaceKind, evidence: Evidence[], cfg: ConfirmationConfig): Verdict {
  const counting = evidence.filter((e) => e.confidence >= cfg.minSignalConfidence && !e.generated && cfg.countingPageKinds.includes(e.pageKind));
  const sources = counting.filter((e) => isSource(e, placeKind, cfg));
  const anchored = cfg.corridorAloneConfirms || sources.some((e) => e.link !== "corridor");
  const positives = anchored ? sources : [];
  const domains = [...new Set(positives.map((e) => e.domain))].sort();
  const positiveIds = positives.map((e) => e.signalId);
  const verdict = (status: Verdict["status"], reason: string, blocking: Evidence | null = null): Verdict => ({
    status,
    reason,
    independentSources: domains,
    blockingSignalId: blocking?.signalId ?? null,
    signalIds: [...new Set([...positiveIds, ...(blocking ? [blocking.signalId] : [])])].sort(),
  });

  const official = cfg.officialPlaceKinds.includes(placeKind);
  const negatives = counting.filter((e) => cfg.negativeKinds.includes(e.kind)).sort(byDateThenId);
  const ban = negatives.filter((e) => e.kind === "prohibited" && e.pageKind === "authority").at(-1);
  if (ban) return verdict(official ? "candidate" : "no_anchoring", `Ankerverbot laut Behörde (${ban.observedAt})`, ban);
  const newestPositive = positives
    .filter((e) => e.observedAtBasis !== "fetched")
    .reduce<string | null>((max, e) => (max === null || e.observedAt > max ? e.observedAt : max), null);
  const negative = negatives.filter((e) => newestPositive === null || e.observedAt >= newestPositive).at(-1);
  if (negative) return verdict("candidate", `jüngerer Negativbeleg: ${NEGATIVE_LABEL[negative.kind]} (${negative.domain}, ${negative.observedAt})`, negative);

  if (!anchored && sources.length > 0) return verdict("candidate", "nur über Routen-Korridor gefunden");
  if (official) {
    const officialDomains = new Set(positives.filter((e) => cfg.officialPageKinds.includes(e.pageKind)).map((e) => e.domain));
    if (officialDomains.size === 0) return verdict("candidate", "keine offizielle Seite (Marina oder Behörde)");
    if (domains.length < 2) return verdict("candidate", "keine weitere unabhängige Quelle neben der offiziellen Seite");
    return verdict("confirmed", `offizielle Seite und weitere Quelle: ${domains.join(", ")}`);
  }
  if (domains.length >= cfg.minIndependentSources) return verdict("confirmed", `${domains.length} unabhängige Quellen: ${domains.join(", ")}`);
  return verdict("candidate", `${domains.length} von ${cfg.minIndependentSources} unabhängigen Quellen`);
}

/** The model and prompt version `extract-berth` reads with now; only signals of its done units count. */
function activeExtractor(config: AppConfig): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, "extract-berth");
  return { model, promptVersion: taskConfig.promptVersion };
}

type SignalRow = {
  id: string;
  place_id: string;
  document_version_id: string;
  kind: BerthSignalKind;
  first_hand: boolean;
  confidence: number;
  observed_at: string;
  observed_at_basis: ObservedAtBasis;
  url: string;
  page_kind: PageKind;
  generated: boolean;
  berths: Array<{ name: string; island: string | null }>;
  search_hit: boolean;
  name_stop: boolean;
  corridor_stop: boolean;
};

/**
 * The evidence of each place: the signals of its done research units of the active `extract-berth` model and
 * prompt, with the page's active assessment (kind, generated), its registrable domain and its link to the place. A
 * page without an active assessment gives no evidence. A page linked by a corridor route stop only (no search hit,
 * no name stop) is still name-linked when one of its assessed berths matches a (not provisional) name of the place.
 */
export async function loadEvidence(db: Db, placeIds: string[], config: AppConfig = getConfig()): Promise<Map<string, Evidence[]>> {
  const out = new Map<string, Evidence[]>();
  if (placeIds.length === 0) return out;
  const extractor = activeExtractor(config);
  const assessor = activeAssessor(config);
  const route = activeRouteExtractor(config);
  const ids = sql.join(placeIds.map((id) => sql`${id}::uuid`), sql`, `);
  const stop = (match: "name" | "corridor") => sql`exists (
    select 1 from research_route_stops rs
    where rs.document_version_id = s.document_version_id and rs.place_id = s.place_id and rs.match = ${match}
      and rs.model = ${route.model} and rs.prompt_version = ${route.promptVersion})`;
  const { rows } = await db.execute<SignalRow>(sql`
    select s.id, s.place_id, s.document_version_id, s.kind::text as kind, s.first_hand, s.confidence, s.observed_at::text as observed_at, s.observed_at_basis::text as observed_at_basis,
      d.url, a.page_kind::text as page_kind, a.generated, a.berths,
      exists (select 1 from research_hits h where h.place_id = s.place_id and h.url_normalized = d.url_normalized) as search_hit,
      ${stop("name")} as name_stop,
      ${stop("corridor")} as corridor_stop
    from berth_signals s
    join research_units u on u.id = s.unit_id
    join document_versions v on v.id = s.document_version_id
    join documents d on d.id = v.document_id
    join page_assessments a on a.document_version_id = s.document_version_id and a.model = ${assessor.model} and a.prompt_version = ${assessor.promptVersion}
    where s.place_id in (${ids}) and u.status = 'done' and u.model = ${extractor.model} and u.prompt_version = ${extractor.promptVersion}
    order by s.place_id, s.id`);

  const corridorOnly = rows.filter((r) => !r.search_hit && !r.name_stop && r.corridor_stop);
  const names = await placeNames(db, [...new Set(corridorOnly.map((r) => r.place_id))]);
  const link = (r: SignalRow): EvidenceLink => {
    if (r.search_hit) return "search";
    if (r.name_stop || !r.corridor_stop) return "name";
    const place = names.get(r.place_id);
    const named = !!place && r.berths.some((b) => berthNameMatches(b, place.names, config.nameAffixes, place.islands));
    return named ? "name" : "corridor";
  };
  for (const r of rows) {
    const e: Evidence = {
      signalId: r.id,
      kind: r.kind,
      firstHand: r.first_hand,
      confidence: Number(r.confidence),
      observedAt: r.observed_at,
      observedAtBasis: r.observed_at_basis,
      domain: registrableDomain(r.url),
      pageKind: r.page_kind,
      generated: r.generated,
      link: link(r),
    };
    (out.get(r.place_id) ?? out.set(r.place_id, []).get(r.place_id)!).push(e);
  }
  return out;
}

/**
 * Whether an admin set the place's current status: the newest status decision on the place (a `place_status` pseudo
 * task, or a `place` review task decided `confirm` / `reject` / `no_anchoring`) is not by `system`; without one, a
 * place an admin created („Ort anlegen“, `create_place`, as `kindChosenByAdmin` in auto-status).
 */
async function statusSetByAdmin(tx: Db, placeId: string, geoObjectId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ decided_by: string }>(sql`
    select d.decided_by
    from review_decisions d join review_tasks t on t.id = d.task_id
    where t.kind = 'place_candidate' and t.subject_id = ${placeId}
      and (t.subject_type = 'place_status' or (t.subject_type = 'place' and d.decision->>'action' in ('confirm', 'reject', 'no_anchoring')))
    order by d.decided_at desc, d.id desc
    limit 1`);
  const newest = rows[0];
  if (newest) return newest.decided_by !== SYSTEM_ACTOR;
  const { rows: created } = await tx.execute<{ admin: boolean }>(sql`
    select exists (
      select 1 from geo_objects o
      join geo_names n on n.geo_object_id = o.id and n.origin = 'text'
      join review_decisions d on d.decision->>'action' = 'create_place' and d.decision->>'name' = n.name
      join review_tasks t on t.id = d.task_id and t.kind = 'place_candidate' and t.subject_type = 'name_candidate'
      where o.id = ${geoObjectId} and o.origin = 'text'
    ) as admin`);
  return created[0]?.admin === true;
}

/** The statuses this rule decides on; `rejected`, `abandoned` and `no_anchoring` (whoever set it) are final here. */
const DECIDED_STATUSES: ReadonlySet<PlaceStatus> = new Set<PlaceStatus>(["candidate", "confirmed"]);

const ACTION: Record<Verdict["status"], string> = { confirmed: "confirm", candidate: "candidate", no_anchoring: "no_anchoring" };

export type BerthTransition = { placeId: string; from: PlaceStatus; to: PlaceStatus };

/**
 * Decides one place in the caller's transaction. Lock order (M5-F-R4): the place's open tasks, then the place row.
 * Left alone: an ended or merged place, `rejected`, `abandoned` and `no_anchoring`, and a status an admin set. A
 * confirmation waits while a duplicate review of the object is open,
 * and re-checks the restricted areas first: a place inside one becomes `no_anchoring` there instead. Each change is a
 * `place_status` system decision `{ action, auto, rule: "research", reason, sources, signalIds, blockingSignalId }`;
 * `confirmed` and `no_anchoring` get a public id; a confirmation dismisses the place's open tasks (`auto_confirmed`).
 * Without a change of status, only the reason is brought up to date.
 */
async function applyVerdict(tx: Db, placeId: string, evidence: Evidence[], now: Date, cfg: AppConfig): Promise<BerthTransition | null> {
  const taskIds = await lockOpenPlaceTasks(tx, placeId);
  const [place] = await tx
    .select({ id: places.id, geoObjectId: places.geoObjectId, kind: places.kind, status: places.status, statusReason: places.statusReason, publicId: places.publicId })
    .from(places)
    .where(and(eq(places.id, placeId), isNull(places.validTo), isNull(places.mergedIntoId)))
    .for("update");
  if (!place || !DECIDED_STATUSES.has(place.status) || (await statusSetByAdmin(tx, place.id, place.geoObjectId))) return null;

  const verdict = decideBerth(place.kind, evidence, cfg.research.confirmation);
  let to: Verdict["status"] = verdict.status;
  let reason = verdict.reason;
  // a candidate inside a restricted area: `applyExclusion` set `no_anchoring` with its own reason (`restricted:<kind>:<id>`)
  let excluded = false;
  if (to === "confirmed" && place.status === "candidate") {
    if (await hasOpenPairTask(tx, place.geoObjectId)) {
      to = "candidate";
      reason = `offene Dubletten-Prüfung (${verdict.reason})`;
    } else if ((await recheckExclusion(tx, { id: place.id, geoObjectId: place.geoObjectId }, cfg.geometry.restriction.minShare)) === "excluded") {
      to = "no_anchoring";
      reason = "Sperrgebiet";
      excluded = true;
    }
  }
  const wantedReason = to === "confirmed" ? null : reason;
  if (to === place.status) {
    if (wantedReason !== place.statusReason) await tx.update(places).set({ statusReason: wantedReason, updatedAt: sql`now()` }).where(eq(places.id, place.id));
    return null;
  }
  const statusReason = excluded ? {} : { statusReason: wantedReason };

  const publicId = to === "candidate" ? place.publicId : (place.publicId ?? newPublicId("sp"));
  await tx.update(places).set({ status: to, ...statusReason, publicId, updatedAt: sql`now()` }).where(eq(places.id, place.id));
  await recordDecision(tx, place.id, "place_status", place.status, {
    action: ACTION[to],
    auto: true,
    rule: "research",
    reason,
    sources: verdict.independentSources,
    signalIds: verdict.signalIds,
    blockingSignalId: verdict.blockingSignalId,
  }, now);
  if (to === "confirmed" && taskIds.length > 0) {
    const { rows: open } = await tx.execute<{ id: string }>(sql`
      select id from review_tasks where id in (${sql.join(taskIds.map((id) => sql`${id}`), sql`, `)}) and status = 'open' order by id`);
    await dismissTasks(tx, open.map((r) => r.id), "auto_confirmed");
  }
  return { placeId: place.id, from: place.status, to };
}

/**
 * Applies the confirmation rule to the places (spec 5.6), one transaction per place, in id order; returns the status
 * changes (for the follow-up run of newly confirmed berths, plan N2 task 7).
 */
export async function applyBerthVerdicts(db: Db, placeIds: string[], now: Date, cfg: AppConfig = getConfig()): Promise<BerthTransition[]> {
  const ids = [...new Set(placeIds)].sort();
  const evidence = await loadEvidence(db, ids, cfg);
  const out: BerthTransition[] = [];
  for (const placeId of ids) {
    const t = await db.transaction((tx) => applyVerdict(tx, placeId, evidence.get(placeId) ?? [], now, cfg));
    if (t) out.push(t);
  }
  return out;
}

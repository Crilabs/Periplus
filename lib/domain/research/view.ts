import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { berthFacts, berthStates, berthSignals, documents, geoObjects, pageAssessments, placeWebsites, places, researchFetches, researchHits, researchUnits, serpQueries } from "@/lib/db/schema";
import type { BerthStateFact, BerthStateLanding, BerthStateOrigin } from "@/lib/db/schema/research-state";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import type { PoiCategory } from "@/lib/db/schema";
import type { PageKind, ResearchFetchOutcome, ResearchPurpose } from "@/lib/db/schema/research";
import type { BerthSignalKind, Tone } from "@/lib/db/schema/research-extract";
import type { ObservedAtBasis } from "@/lib/db/schema/sources";
import { getConfig } from "@/lib/config";
import { activeAssessor } from "./assessment";
import type { PlaceStatus } from "@/lib/db/schema";
import { getFactSchema } from "@/lib/domain/facts/schema";
import { factAttributeLabel, formatFactValue, POI_CATEGORY_LABELS } from "@/lib/domain/facts/labels";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { activeRouteExtractor } from "./assign";
import { activeExtractor, decideBerth, loadEvidence, type Verdict } from "./confirmation";
import { activeLandsideExtractor } from "./landside-extraction";

export type SignalRow = {
  kind: BerthSignalKind;
  firstHand: boolean;
  confidence: number;
  observedAt: string;
  observedAtBasis: ObservedAtBasis;
  quote: string;
};

export type FactRow = {
  /** What the page says: the statement, else the attribute and its value. */
  statement: string;
  /** `null`: the berth itself; else the name of the landside thing. */
  subject: string | null;
  observedAt: string;
  tone: Tone | null;
  quote: string;
};

/**
 * How the page belongs to the place: a search hit of it, a hit of a neighbouring berth that names it (its research
 * unit, `unitsForPlaces`), or a route stop pointing to it.
 */
export type ResearchLink = "search" | "neighbour" | "route";

export type ResearchRow = {
  url: string;
  domain: string;
  link: ResearchLink;
  /** Rank, purpose and keyword of the search hit; null (purposes empty) for a page linked otherwise. */
  rank: number | null;
  /** `positive` when the page is a hit of a confirmation search, else `negative`; `rank` and `keyword` are of that hit. */
  purpose: ResearchPurpose | null;
  /** Every purpose the page was found for, positive first. */
  purposes: ResearchPurpose[];
  keyword: string | null;
  /** The page is the place's own website (a hit without a search behind it). */
  ownWebsite: boolean;
  documentId: string | null;
  /** The newest fetch attempt of the page (null while none was made). */
  fetch: { outcome: ResearchFetchOutcome; reason: string | null } | null;
  assessment: {
    pageKind: PageKind;
    firstHand: boolean;
    generated: boolean;
    observedAt: string;
    berths: string[];
  } | null;
  /** The signals and facts the active extraction found on the current version of the page for this place. */
  signals: SignalRow[];
  facts: FactRow[];
  signalCount: number;
  factCount: number;
};

export type ResearchViewData = {
  /** The place's actual status and its reason (admin-set, final, duplicate-held or restricted places differ from the verdict). */
  status: PlaceStatus;
  statusReason: string | null;
  /** The confirmation rule applied to the place's evidence now (what `research.confirm` would decide). */
  verdict: Verdict;
  rows: ResearchRow[];
};

/**
 * The pages of a place: its research hits with the search term, the archived document (null while not fetched) and the
 * assessment of its current version by the active model and prompt version (null while not assessed) and the
 * outcome of its newest fetch attempt (`research_fetches`), confirmation (positive) before negative search, then by
 * rank; after them every other page whose signals can count for the place, so the verdict's evidence is all shown:
 * pages with a research unit of the place (a neighbour's hit naming it) and pages with a route stop pointing to it
 * (active extraction and route model), by link and URL.
 */
export async function researchView(db: Db, placeId: string): Promise<ResearchViewData> {
  const [place] = await db.select({ kind: places.kind, status: places.status, statusReason: places.statusReason }).from(places).where(eq(places.id, placeId));
  if (!place) throw new Error(`place ${placeId} does not exist`);
  const cfg = getConfig();
  const verdict = decideBerth(place.kind, (await loadEvidence(db, [placeId], cfg)).get(placeId) ?? [], cfg.research.confirmation);

  const hits = await db
    .select({
      url: researchHits.urlNormalized,
      domain: researchHits.domain,
      rank: researchHits.rank,
      purpose: researchHits.purpose,
      keyword: serpQueries.keyword,
      origin: researchHits.origin,
      documentId: documents.id,
      versionId: documents.currentVersionId,
    })
    .from(researchHits)
    .leftJoin(serpQueries, eq(serpQueries.id, researchHits.serpQueryId))
    .leftJoin(documents, eq(documents.urlNormalized, researchHits.urlNormalized))
    .where(eq(researchHits.placeId, placeId));

  // the label „eigene Website“ follows the CURRENT binding: the newest website row, bound, with the hit's URL
  const [site] = await db
    .select({ urlNormalized: placeWebsites.urlNormalized, bound: placeWebsites.bound })
    .from(placeWebsites)
    .where(eq(placeWebsites.placeId, placeId))
    .orderBy(desc(placeWebsites.createdAt), desc(placeWebsites.id))
    .limit(1);

  // pages linked otherwise: a route stop to the place, else a research unit of it; the current version where it has one
  const extractor = activeExtractor(cfg);
  const landside = activeLandsideExtractor(cfg);
  const route = activeRouteExtractor(cfg);
  const hitUrls = new Set(hits.map((h) => h.url));
  const { rows: linkedRows } = await db.execute<{ url: string; document_id: string; version_id: string; link: "neighbour" | "route" }>(sql`
    select distinct on (d.url_normalized) d.url_normalized as url, d.id as document_id, x.version_id, x.link
    from (
      select rs.document_version_id as version_id, 'route' as link from research_route_stops rs
      where rs.place_id = ${placeId} and rs.model = ${route.model} and rs.prompt_version = ${route.promptVersion}
      union all
      select u.document_version_id, 'neighbour' from research_units u
      where u.place_id = ${placeId} and u.kind = 'berth' and u.model = ${extractor.model} and u.prompt_version = ${extractor.promptVersion}
    ) x
    join document_versions v on v.id = x.version_id
    join documents d on d.id = v.document_id
    order by d.url_normalized, (x.version_id = d.current_version_id) desc, (x.link = 'route') desc`);
  const linked = linkedRows.filter((l) => !hitUrls.has(l.url));

  const versionIds = [...hits.flatMap((h) => (h.versionId ? [h.versionId] : [])), ...linked.map((l) => l.version_id)];
  const { model, promptVersion } = activeAssessor(getConfig());
  const assessments =
    versionIds.length === 0
      ? []
      : await db
          .select()
          .from(pageAssessments)
          .where(and(inArray(pageAssessments.documentVersionId, versionIds), eq(pageAssessments.model, model), eq(pageAssessments.promptVersion, promptVersion)));
  const byVersion = new Map(assessments.map((a) => [a.documentVersionId, a]));

  const urls = [...new Set([...hits.map((h) => h.url), ...linked.map((l) => l.url)])];
  const attempts =
    urls.length === 0
      ? []
      : await db
          .selectDistinctOn([researchFetches.urlNormalized], { url: researchFetches.urlNormalized, outcome: researchFetches.outcome, reason: researchFetches.reason })
          .from(researchFetches)
          .where(inArray(researchFetches.urlNormalized, urls))
          .orderBy(researchFetches.urlNormalized, desc(researchFetches.createdAt), desc(researchFetches.id));
  const fetchOf = new Map(attempts.map((f) => [f.url, { outcome: f.outcome, reason: f.reason }]));

  const unitOf = and(
    eq(researchUnits.id, berthSignals.unitId),
    eq(researchUnits.kind, "berth"),
    eq(researchUnits.model, extractor.model),
    eq(researchUnits.promptVersion, extractor.promptVersion),
    eq(researchUnits.status, "done"),
  );
  const signalRows =
    versionIds.length === 0
      ? []
      : await db
          .select({
            versionId: berthSignals.documentVersionId,
            kind: berthSignals.kind,
            firstHand: berthSignals.firstHand,
            confidence: berthSignals.confidence,
            observedAt: berthSignals.observedAt,
            observedAtBasis: berthSignals.observedAtBasis,
            quote: berthSignals.quote,
          })
          .from(berthSignals)
          .innerJoin(researchUnits, unitOf)
          .where(and(eq(berthSignals.placeId, placeId), inArray(berthSignals.documentVersionId, versionIds)))
          .orderBy(asc(berthSignals.observedAt), asc(berthSignals.id));
  const factRows =
    versionIds.length === 0
      ? []
      : await db
          .select({
            versionId: berthFacts.documentVersionId,
            attribute: berthFacts.attribute,
            value: berthFacts.value,
            statement: berthFacts.statement,
            subject: berthFacts.subjectName,
            observedAt: berthFacts.observedAt,
            tone: berthFacts.tone,
            quote: berthFacts.quote,
          })
          .from(berthFacts)
          .innerJoin(
            researchUnits,
            and(
              eq(researchUnits.id, berthFacts.unitId),
              eq(researchUnits.status, "done"),
              or(
                and(eq(researchUnits.kind, "berth"), eq(researchUnits.model, extractor.model), eq(researchUnits.promptVersion, extractor.promptVersion)),
                and(eq(researchUnits.kind, "landside"), eq(researchUnits.model, landside.model), eq(researchUnits.promptVersion, landside.promptVersion)),
              ),
            ),
          )
          .where(and(eq(berthFacts.placeId, placeId), inArray(berthFacts.documentVersionId, versionIds)))
          .orderBy(asc(berthFacts.observedAt), asc(berthFacts.id));
  const signalsOf = new Map<string, SignalRow[]>();
  for (const { versionId, ...r } of signalRows) (signalsOf.get(versionId) ?? signalsOf.set(versionId, []).get(versionId)!).push(r);
  const factsOf = new Map<string, FactRow[]>();
  for (const f of factRows) {
    const fact: FactRow = {
      statement: f.statement ?? `${factAttributeLabel(f.attribute!)}: ${formatFactValue(f.attribute!, f.value)}`,
      subject: f.subject,
      observedAt: f.observedAt,
      tone: f.tone,
      quote: f.quote,
    };
    (factsOf.get(f.versionId) ?? factsOf.set(f.versionId, []).get(f.versionId)!).push(fact);
  }

  const pageOf = (versionId: string | null) => {
    const a = versionId ? byVersion.get(versionId) : undefined;
    const signals = (versionId ? signalsOf.get(versionId) : undefined) ?? [];
    const facts = (versionId ? factsOf.get(versionId) : undefined) ?? [];
    return {
      assessment: a
        ? { pageKind: a.pageKind, firstHand: a.firstHand, generated: a.generated, observedAt: a.observedAt, berths: a.berths.map((b) => b.name) }
        : null,
      signals,
      facts,
      signalCount: signals.length,
      factCount: facts.length,
    };
  };
  const rows = hits
    .map((h): ResearchRow => ({
      url: h.url,
      domain: h.domain,
      link: "search",
      rank: h.rank,
      purpose: h.purpose,
      purposes: [h.purpose],
      keyword: h.keyword,
      ownWebsite: h.origin === "place_website" && !!site && site.bound && site.urlNormalized === h.url,
      documentId: h.documentId,
      fetch: fetchOf.get(h.url) ?? null,
      ...pageOf(h.versionId),
    }))
    .sort((x, y) => (x.purpose === y.purpose ? x.rank! - y.rank! : x.purpose === "positive" ? -1 : 1));
  // a URL found by a positive and a negative search is one page: shown once, with both purposes
  const byUrl = new Map<string, ResearchRow>();
  for (const r of rows) {
    const seen = byUrl.get(r.url);
    if (seen) seen.purposes.push(r.purpose!);
    else byUrl.set(r.url, r);
  }
  const others = linked
    .map((l): ResearchRow => ({
      url: l.url,
      domain: registrableDomain(l.url),
      link: l.link,
      rank: null,
      purpose: null,
      purposes: [],
      keyword: null,
      ownWebsite: false,
      documentId: l.document_id,
      fetch: fetchOf.get(l.url) ?? null,
      ...pageOf(l.version_id),
    }))
    .sort((x, y) => (x.link === y.link ? (x.url < y.url ? -1 : x.url > y.url ? 1 : 0) : x.link === "neighbour" ? -1 : 1));
  return { status: place.status, statusReason: place.statusReason, verdict, rows: [...byUrl.values(), ...others] };
}

export type StateCoreRow = { attribute: string; label: string; value: string; origin: BerthStateOrigin; confidence: number; observedAt: string | null };
export type StateNearbyRow = { geoObjectId: string; name: string | null; category: PoiCategory; categoryLabel: string; distanceM: number; access: "foot" | "transport" };

/** Where a state fact comes from: a page about the berth itself or a landside page (unit kind `berth` / `landside`); `null` when no unit is known. */
export type StateFactOrigin = "berth" | "landside" | null;
export type StateFactRow = BerthStateFact & { origin: StateFactOrigin };

/** The state of a confirmed berth as the tab „Stand“ shows it: formatted core values with their origin, gaps, facts, landing points and reachable things. */
export type BerthStateView = {
  status: PlaceStatus;
  updatedAt: Date;
  runId: string | null;
  core: StateCoreRow[];
  gaps: Array<{ attribute: string; label: string }>;
  facts: StateFactRow[];
  landing: BerthStateLanding[];
  nearby: StateNearbyRow[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The origin of each stored fact by the kind of the unit of the facts it stands for (`memberIds`, else its own id):
 * `berth` as soon as one member comes from a berth page (a berth page is evidence, a landside page only adds), else `landside`.
 */
async function factOrigins(db: Db, facts: BerthStateFact[]): Promise<Map<string, StateFactOrigin>> {
  const members = new Map(facts.map((f) => [f.factId, f.memberIds ?? [f.factId]]));
  const ids = [...new Set([...members.values()].flat().filter((id) => UUID.test(id)))];
  const kinds = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await db
      .select({ id: berthFacts.id, kind: researchUnits.kind })
      .from(berthFacts)
      .innerJoin(researchUnits, eq(researchUnits.id, berthFacts.unitId))
      .where(inArray(berthFacts.id, ids));
    for (const r of rows) kinds.set(r.id, r.kind);
  }
  const origins = new Map<string, StateFactOrigin>();
  for (const [factId, memberIds] of members) {
    const own = memberIds.flatMap((id) => (kinds.has(id) ? [kinds.get(id)!] : []));
    origins.set(factId, own.length === 0 ? null : own.includes("berth") ? "berth" : "landside");
  }
  return origins;
}

/** The state row of a place with its values formatted and the reachable objects named; null while no state was built. */
export async function berthStateView(db: Db, placeId: string): Promise<BerthStateView | null> {
  const [row] = await db
    .select({ state: berthStates, status: places.status })
    .from(berthStates)
    .innerJoin(places, eq(places.id, berthStates.placeId))
    .where(eq(berthStates.placeId, placeId));
  if (!row) return null;
  const { state } = row;
  const defs = getFactSchema(getConfig().research.extraction.factSchema).levels.place.map((d) => d.key);
  const order = (k: string) => (defs.includes(k) ? defs.indexOf(k) : defs.length);
  const core = Object.entries(state.core)
    .map(([attribute, v]): StateCoreRow => ({ attribute, label: factAttributeLabel(attribute), value: formatFactValue(attribute, v.value), origin: v.origin, confidence: v.confidence, observedAt: v.observedAt }))
    .sort((a, b) => order(a.attribute) - order(b.attribute) || a.attribute.localeCompare(b.attribute));
  const ids = [...new Set(state.nearby.map((n) => n.geoObjectId))];
  const names = ids.length === 0 ? [] : await db.select({ id: geoObjects.id, name: displayNameSql(geoObjects.id) }).from(geoObjects).where(inArray(geoObjects.id, ids));
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const origins = await factOrigins(db, state.facts);
  return {
    status: row.status,
    updatedAt: state.updatedAt,
    runId: state.runId,
    core,
    gaps: state.gaps.map((attribute) => ({ attribute, label: factAttributeLabel(attribute) })),
    facts: state.facts
      .map((f): StateFactRow => ({ ...f, origin: origins.get(f.factId) ?? null }))
      .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : a.factId < b.factId ? -1 : 1)),
    landing: state.landing,
    nearby: state.nearby.map((n) => ({ ...n, name: nameOf.get(n.geoObjectId) ?? null, categoryLabel: POI_CATEGORY_LABELS[n.category] })),
  };
}

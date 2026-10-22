import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { placeKindEnum, places, reviewDecisions, reviewTasks, type PlaceKind, type PlaceStatus } from "@/lib/db/schema";
import { getFactSchema } from "@/lib/domain/facts/schema";
import type { ProfileContext } from "@/lib/domain/consolidation/inputs";
import { applyRule } from "@/lib/domain/consolidation/rules";
import { dismissTasks, lockOpenPlaceTasks, lockOpenTasks } from "@/lib/domain/consolidation/task-locks";
import type { ConsolidationInput, RuleName } from "@/lib/domain/consolidation/types";
import { recheckExclusion } from "@/lib/domain/geometry/restrictions";
import { newPublicId } from "@/lib/domain/ids";
import { berthEvidence, countingTextInputs, type Evidence } from "./evidence";

/*
 * Confirmation and kind switch by evidence (spec 17 „Bestätigung nach Beleg“, „Ortsart aus Belegen“), run inside
 * `consolidateGeo` (regular mode) after the inputs are loaded and before the profile is built, so the profile of the same
 * run carries the new status and kind (and `place_new`). Every change is recorded like an admin decision: a decided
 * `place_candidate` pseudo task (`place_kind` / `place_status`) with one `review_decisions` row by `system` carrying
 * `auto: true`, the rule and the evidence ids.
 */

export const SYSTEM_ACTOR = "system";
const KIND_EVIDENCE = "place.kind_evidence";
/** Only a candidate or a confirmed place switches its kind by evidence (final review 5); a rejected, `no_anchoring` or abandoned one never. */
const KIND_SWITCH_STATUSES: ReadonlySet<PlaceStatus> = new Set<PlaceStatus>(["candidate", "confirmed"]);

export type AutoStatusOutcome = {
  action: "none" | "confirmed" | "no_anchoring" | "kind_changed";
  /** The place's kind after the step (set when it changed or the place was confirmed). */
  kind?: PlaceKind;
  evidence?: Evidence;
  /** The place row after the step, for the profile context (set unless `none`). */
  place?: { kind: PlaceKind; status: PlaceStatus; statusReason: string | null; publicId: string | null };
};

export type AutoStatusOptions = {
  /** The consolidation rules the run uses (the `place.kind_evidence` rule needs them). */
  rules: ConsolidationConfig;
  /** The run date (`YYYY-MM-DD`). */
  today: string;
};

/** The consolidated `place.kind_evidence` of the inputs, through its schema rule; null without a valid value. */
export function consolidatedKindEvidence(
  inputs: ConsolidationInput[],
  context: ProfileContext,
  cfg: AppConfig,
  opts: AutoStatusOptions,
): { kind: PlaceKind; factIds: string[] } | null {
  const def = getFactSchema(cfg.factSchema.version).levels.place.find((d) => d.key === KIND_EVIDENCE);
  if (!def || !context.place) return null;
  const own = inputs
    .filter((i) => i.attribute === KIND_EVIDENCE)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || (a.factId ?? "").localeCompare(b.factId ?? ""));
  if (own.length === 0) return null;
  const r = applyRule(def.rule as RuleName, own, {
    attribute: KIND_EVIDENCE,
    level: "place",
    place: { kind: context.place.kind, status: context.place.status },
    today: opts.today,
    cfg: opts.rules,
  });
  const kind = r?.value;
  if (typeof kind !== "string" || !(placeKindEnum.enumValues as readonly string[]).includes(kind)) return null;
  return { kind: kind as PlaceKind, factIds: [...new Set(r!.support.map((i) => i.factId).filter((id): id is string => id !== null))].sort() };
}

/**
 * Whether an admin chose the place's kind (spec 17): a decided `place_candidate` task on the place whose `confirm`
 * decision names another kind than the task's `context.kind` (the seed's proposal), or a `place_kind` decision not by
 * `system`, or a place an admin created with its kind („Ort anlegen“, `create_place` on a name candidate: the only way a
 * geo object of origin `text` comes about; the decision is found by the name it gave the object). A confirmation that
 * took the proposal does not lock the kind; a task without a proposal cannot tell.
 */
async function kindChosenByAdmin(tx: Db, placeId: string, geoObjectId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ locked: boolean }>(sql`
    select exists (
      select 1 from review_tasks t join review_decisions d on d.task_id = t.id
      where t.kind = 'place_candidate' and t.subject_id = ${placeId}
        and ((t.subject_type = 'place' and d.decision->>'action' = 'confirm' and t.context ? 'kind'
              and d.decision->>'kind' is distinct from t.context->>'kind')
          or (t.subject_type = 'place_kind' and d.decided_by <> ${SYSTEM_ACTOR}))
    ) or exists (
      select 1 from geo_objects o
      join geo_names n on n.geo_object_id = o.id and n.origin = 'text'
      join review_decisions d on d.decision->>'action' = 'create_place' and d.decision->>'name' = n.name
      join review_tasks t on t.id = d.task_id and t.kind = 'place_candidate' and t.subject_type = 'name_candidate'
      where o.id = ${geoObjectId} and o.origin = 'text'
    ) as locked
  `);
  return rows[0]?.locked === true;
}

/** Whether an open duplicate review (`geo_object_pair`) names the object on either side. */
async function hasOpenPairTask(tx: Db, geoObjectId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ open: boolean }>(sql`
    select exists (
      select 1 from review_tasks
      where kind = 'place_candidate' and subject_type = 'geo_object_pair' and status = 'open'
        and (split_part(subject_id, ':', 1) = ${geoObjectId} or split_part(subject_id, ':', 2) = ${geoObjectId})
    ) as open
  `);
  return rows[0]?.open === true;
}

/**
 * After an automatic kind switch, the open (locked) tasks on the place that carry a proposal (`context.kind`) propose the
 * new kind (final review 1): the confirm form defaults to the place's current kind, so taking that default must not read
 * as an admin choice, and picking the old seed kind must (`kindChosenByAdmin`). `review_tasks` context is not
 * append-only (as `dismissTasks`).
 */
async function reproposeKind(tx: Db, taskIds: string[], kind: PlaceKind): Promise<void> {
  if (taskIds.length === 0) return;
  await tx.execute(sql`
    update review_tasks set context = context || ${JSON.stringify({ kind })}::jsonb
    where id in (${sql.join(taskIds.map((id) => sql`${id}`), sql`, `)}) and status = 'open' and context ? 'kind'
  `);
}

/** One decided pseudo task on the place with its `system` decision. */
async function recordDecision(tx: Db, placeId: string, subjectType: "place_kind" | "place_status", previous: string, decision: Record<string, unknown>, now: Date) {
  const [task] = await tx
    .insert(reviewTasks)
    .values({ kind: "place_candidate", subjectType, subjectId: placeId, context: { previous }, status: "decided" })
    .returning({ id: reviewTasks.id });
  await tx.insert(reviewDecisions).values({ taskId: task!.id, decision, decidedBy: SYSTEM_ACTOR, decidedAt: now });
}

/**
 * Applies the evidence to the place of `context` (spec 17), in the caller's transaction, under the profile lock the
 * caller holds:
 * 1. only a valid, unmerged place; lock order (M5-P9, as the place merge): the object's open profile tasks, the
 *    place's open tasks, then the place row;
 * 2. kind switch (only a `candidate` or `confirmed` place): the consolidated `place.kind_evidence` (of documents whose type counts, `countingTextInputs`) differs from the place's kind and no admin chose the kind →
 *    the kind changes, recorded as a `place_kind` decision `{ action: "set_kind", kind, auto, factIds }`, and the place's
 *    open tasks with a proposal propose the new kind (`reproposeKind`);
 * 3. confirmation only for a `candidate` without an open duplicate review and with evidence (`berthEvidence`);
 * 4. the restricted areas of the newest geometry are checked while the place is still a candidate (`recheckExclusion`):
 *    a banned place becomes `no_anchoring` (reason set by it) and gets its public id; otherwise `confirmed` with its
 *    public id. Either is recorded as a `place_status` decision with the rule and the evidence ids;
 * 5. the place's open tasks on subject `place` are dismissed (`auto_confirmed`); duplicate reviews stay.
 * `rejected`, `no_anchoring`, `confirmed` and `abandoned` places never change status here.
 */
export async function applyAutoStatus(
  tx: Db,
  context: ProfileContext,
  inputs: ConsolidationInput[],
  cfg: AppConfig,
  now: Date,
  opts: AutoStatusOptions,
): Promise<AutoStatusOutcome> {
  const known = context.place;
  if (!known) return { action: "none" };
  const geoObjectId = await geoObjectOf(tx, known.id);
  if (!geoObjectId) return { action: "none" };
  // only documents whose type counts for this place may switch its kind (a dataset or a neighbour's marina page never)
  const kindInputs = await countingTextInputs(tx, geoObjectId, inputs.filter((i) => i.attribute === KIND_EVIDENCE), cfg);
  const kindEvidence = consolidatedKindEvidence(kindInputs, context, cfg, opts);
  if (known.status !== "candidate" && (!kindEvidence || kindEvidence.kind === known.kind || !KIND_SWITCH_STATUSES.has(known.status))) return { action: "none" };

  await lockOpenTasks(tx, geoObjectId);
  const placeTaskIds = await lockOpenPlaceTasks(tx, known.id);
  const [place] = await tx
    .select({ id: places.id, kind: places.kind, status: places.status, statusReason: places.statusReason, publicId: places.publicId })
    .from(places)
    .where(and(eq(places.id, known.id), isNull(places.validTo), isNull(places.mergedIntoId)))
    .for("update");
  if (!place) return { action: "none" };

  let kind = place.kind;
  let kindChanged = false;
  if (kindEvidence && kindEvidence.kind !== place.kind && KIND_SWITCH_STATUSES.has(place.status) && !(await kindChosenByAdmin(tx, place.id, geoObjectId))) {
    await tx.update(places).set({ kind: kindEvidence.kind, updatedAt: sql`now()` }).where(eq(places.id, place.id));
    await recordDecision(tx, place.id, "place_kind", place.kind, { action: "set_kind", kind: kindEvidence.kind, auto: true, factIds: kindEvidence.factIds }, now);
    await reproposeKind(tx, placeTaskIds, kindEvidence.kind);
    kind = kindEvidence.kind;
    kindChanged = true;
  }
  const settled = async (action: AutoStatusOutcome["action"], evidence?: Evidence): Promise<AutoStatusOutcome> => {
    if (action === "none") return { action };
    const [row] = await tx
      .select({ kind: places.kind, status: places.status, statusReason: places.statusReason, publicId: places.publicId })
      .from(places)
      .where(eq(places.id, place.id));
    return { action, kind: row!.kind, ...(evidence ? { evidence } : {}), place: row! };
  };
  const unconfirmed = kindChanged ? "kind_changed" : "none";

  if (place.status !== "candidate" || (await hasOpenPairTask(tx, geoObjectId))) return settled(unconfirmed);
  const tags = await tagsOf(tx, geoObjectId);
  const evidence = await berthEvidence(tx, { geoObjectId, placeId: place.id, kind, tags, today: opts.today, kindEvidence: kindEvidence?.kind ?? null }, inputs, cfg);
  if (!evidence) return settled(unconfirmed);

  const exclusion = await recheckExclusion(tx, { id: place.id, geoObjectId }, cfg.geometry.restriction.minShare);
  const action = exclusion === "excluded" ? "no_anchoring" : "confirm";
  await tx
    .update(places)
    .set(
      action === "confirm"
        ? { status: "confirmed", statusReason: null, publicId: place.publicId ?? newPublicId("sp"), updatedAt: sql`now()` }
        : { publicId: place.publicId ?? newPublicId("sp"), updatedAt: sql`now()` },
    )
    .where(eq(places.id, place.id));
  await recordDecision(tx, place.id, "place_status", place.status, { action, auto: true, rule: evidence.rule, factIds: evidence.factIds, documentIds: evidence.documentIds, routeStopIds: evidence.routeStopIds }, now);

  if (placeTaskIds.length > 0) {
    const { rows: open } = await tx.execute<{ id: string }>(sql`
      select id from review_tasks where id in (${sql.join(placeTaskIds.map((id) => sql`${id}`), sql`, `)}) and status = 'open' order by id
    `);
    await dismissTasks(tx, open.map((r) => r.id), "auto_confirmed");
  }
  return settled(action === "confirm" ? "confirmed" : "no_anchoring", evidence);
}

async function geoObjectOf(tx: Db, placeId: string): Promise<string | null> {
  const [row] = await tx.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, placeId));
  return row?.geoObjectId ?? null;
}

async function tagsOf(tx: Db, geoObjectId: string): Promise<Record<string, string>> {
  const { rows } = await tx.execute<{ tags: Record<string, string> | null }>(sql`select tags from geo_objects where id = ${geoObjectId}`);
  return rows[0]?.tags ?? {};
}

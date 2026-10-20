import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  changeRateEnum,
  DOC_TYPES,
  facts,
  geoObjects,
  nameCandidates,
  placeKindEnum,
  places,
  poiCategoryEnum,
  reviewDecisions,
  reviewTasks,
  sources,
  tiles,
  type GeoObjectType,
  type PlaceKind,
  type PoiCategory,
  type ReviewKind,
  type SourceStatus,
} from "@/lib/db/schema";
import { attributeDef, canonicalJson, InvalidFactValue, UnknownAttribute, validateFactValue } from "@/lib/domain/facts/schema";
import { assignParentOf } from "@/lib/domain/gazetteer/hierarchy";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { addNames, isGreek, transliterateElot743, type NameDraft } from "@/lib/domain/gazetteer/names";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { newPublicId } from "@/lib/domain/ids";
import { candidateObjects, withNeighbours } from "@/lib/domain/mentions/scope";
import { appendReviewOutcome, comparisonTaskContextSchema } from "@/lib/domain/quality/comparison-results";
import { crawlRulesSchema } from "@/lib/domain/sources/crawl-rules";
import { isForbiddenHost } from "@/lib/domain/sources/forbidden-domains";
import { QUEUES, type QueueName } from "@/lib/jobs/queues";
import { CONSOLIDATION_SUMMARY_STAGE } from "@/lib/pipeline/consolidation/stages";

const lonLatSchema = z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) });

export const reviewDecisionSchema = z.discriminatedUnion("action", [
  // place_candidate / place
  z.object({
    action: z.literal("confirm"),
    kind: z.enum(placeKindEnum.enumValues),
    position: z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) }).optional(),
  }),
  z.object({ action: z.literal("merge"), intoPlaceId: z.uuid() }),
  // place_candidate / name_candidate
  z.object({
    action: z.literal("create_place"),
    kind: z.enum(placeKindEnum.enumValues),
    position: lonLatSchema,
    name: z.string().trim().min(1).max(120),
    language: z.string().regex(/^[a-z]{2}$/),
  }),
  z.object({ action: z.literal("assign_name"), geoObjectId: z.uuid() }),
  // place_candidate / place, place_candidate / name_candidate and source_approval / source
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("no_anchoring") }),
  // place_candidate / geo_object_pair
  z.object({ action: z.literal("same") }),
  z.object({ action: z.literal("distinct") }),
  // coast_tile_without_area
  z.object({ action: z.literal("assign_area"), areaId: z.uuid() }),
  z.object({ action: z.literal("no_area") }),
  // failed_job
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("ignore") }),
  z.object({ action: z.literal("pause_source") }),
  // failed_job / profile_summary: run the summary stage again for the object
  z.object({ action: z.literal("regenerate_summary") }),
  // conflict / profile_attribute: one of the two values, both seasonally, or leave the conflict open
  z.object({ action: z.literal("value_a") }),
  z.object({ action: z.literal("value_b") }),
  z.object({ action: z.literal("seasonal") }),
  z.object({ action: z.literal("leave_open") }),
  // uncertain_change / profile_attribute
  z.object({ action: z.literal("accept_change") }),
  z.object({ action: z.literal("discard_change") }),
  // comparison_deviation / comparison: the own value is right, Navily is right (own value wrong), or unclear
  z.object({ action: z.literal("own_correct") }),
  z.object({ action: z.literal("navily_correct") }),
  z.object({ action: z.literal("unclear") }),
  // source_approval / source
  z.object({
    action: z.literal("approve"),
    type: z.enum(DOC_TYPES),
    weight: z.number().min(0).max(1),
    changeRate: z.enum(changeRateEnum.enumValues),
    crawlRules: crawlRulesSchema,
  }),
]);

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
type Action = ReviewDecision["action"];

export class TaskNotOpen extends Error {
  constructor(taskId: string) {
    super(`review task ${taskId} is not open`);
    this.name = "TaskNotOpen";
  }
}

/** The action does not fit the task's kind and subject, or its subject or target is not (or no longer) valid. */
export class DecisionNotAllowed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionNotAllowed";
  }
}

/**
 * The task changed since it was shown (a later consolidation run replaced its context with another key, ruling
 * M5-F-R2): the admin decided on a value that is no longer the one in question. Nothing is written.
 */
export class TaskContextChanged extends Error {
  constructor(taskId: string) {
    super(`review task ${taskId} changed since it was shown`);
    this.name = "TaskContextChanged";
  }
}

/**
 * A stable fingerprint of a value (first 16 hex characters of the SHA-256 of its canonical JSON). The decision form of
 * a conflict posts the fingerprint of the side the admin chose; the server compares it with the side's current value,
 * so a run that swapped the sides under the same (swap-stable) key cannot make the decision write the other value
 * (ruling M5-G-R2).
 */
export function valueFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value === undefined ? null : value)).digest("hex").slice(0, 16);
}

/** Allowed actions per `<kind>/<subject_type>`. */
const ALLOWED: Record<string, readonly Action[]> = {
  "conflict/profile_attribute": ["value_a", "value_b", "seasonal", "leave_open"],
  "uncertain_change/profile_attribute": ["accept_change", "discard_change"],
  "place_candidate/place": ["confirm", "merge", "reject", "no_anchoring"],
  "place_candidate/geo_object_pair": ["same", "distinct"],
  "place_candidate/name_candidate": ["create_place", "assign_name", "reject"],
  "coast_tile_without_area/tile": ["assign_area", "no_area"],
  "failed_job/job": ["retry", "ignore", "pause_source"],
  "failed_job/profile_summary": ["ignore", "regenerate_summary"],
  "source_approval/source": ["approve", "reject"],
  "comparison_deviation/comparison": ["own_correct", "navily_correct", "unclear"],
};

export type DecideDeps = { retryJob?: (queue: QueueName, jobId: string) => Promise<void> };

/**
 * What a decision asks for after its commit (ruling M5-P10): `documentVersionIds` for the rematch of a new name;
 * `consolidate` for a consolidation run of one geo object (after a `conflict` / `uncertain_change` decision or a
 * `place_candidate` decision on a place), never started inside the decision's transaction, which could roll back under
 * a started run.
 */
export type DecideResult = { documentVersionIds: string[]; consolidate: { geoObjectId: string; stagesOnly?: string[] } | null };

type Task = typeof reviewTasks.$inferSelect;

/**
 * Decides an open review task in one transaction: locks the task (`TaskNotOpen` unless it is open), writes
 * exactly one `review_decisions` row (`duration_ms = now - openedAt` when `openedAt` is given), applies the
 * decision and marks the task `decided`. `DecisionNotAllowed` when the action does not fit the task or its
 * subject or target is not valid; nothing is written then. A `retry` calls `deps.retryJob` last, so a failed
 * retry rolls the decision back.
 *
 * A `create_place` or `assign_name` decision on a `name_candidate` (new name from texts) returns the current versions
 * of the documents the name was found in (`documentVersionIds`, for the rematch run of Task 17); every other decision,
 * including `reject`, returns none. A decision on a `profile_attribute` task (`applyProfileDecision`) and a
 * `confirm` / `merge` / `reject` / `no_anchoring` on a place return the geo object to consolidate again (`consolidate`); `regenerate_summary` on a `failed_job` / `profile_summary` task returns
 * it with `stagesOnly ["consolidation.summary"]`; the caller starts that run after the commit (ruling M5-P10). A
 * profile decision needs `taskKey`, the `context.key` the admin saw: another key means a later run replaced the question
 * (`TaskContextChanged`, ruling M5-F-R2); `value_a` / `value_b` also need `valueKey`, the `valueFingerprint` of the
 * chosen side's value as shown (ruling M5-G-R2). A decision on a `comparison_deviation` task appends its outcome to
 * `comparison_results` (`deviation_confirmed_own` / `deviation_confirmed_navily` / `unclear`, method `review`) and
 * returns nothing to do.
 *
 * Global lock order: the review task row first, then the subject row(s) (`lockPlace`, `lockSource`,
 * `lockNameCandidate`). Every transaction that locks both an open `place_candidate` task and its place
 * (`applyExclusion`, stage `geometry.place`) or its name candidate (`geocodeCandidate`) takes them in this order, so
 * none of them deadlocks with a decision. Profiles (ruling M5-P9): only `consolidateGeo` takes the per-object profile
 * lock (`pg_advisory_xact_lock(hashtext('profile:' || id))`), before any review task row; a decision on a
 * `profile_attribute` task never takes that lock, so the two cannot wait on each other.
 */
export async function decideReviewTask(
  db: Db,
  input: { taskId: string; decision: ReviewDecision; decidedBy: string; openedAt?: Date; now?: Date; taskKey?: string; valueKey?: string },
  deps: DecideDeps = {},
): Promise<DecideResult> {
  const decision = reviewDecisionSchema.parse(input.decision);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, input.taskId)).for("update");
    if (!task || task.status !== "open") throw new TaskNotOpen(input.taskId);
    if (!ALLOWED[`${task.kind}/${task.subjectType}`]?.includes(decision.action)) {
      throw new DecisionNotAllowed(`action ${decision.action} does not fit a ${task.kind} task on a ${task.subjectType}`);
    }
    if (task.subjectType === PROFILE_SUBJECT && (input.taskKey === undefined || (task.context as { key?: unknown } | null)?.key !== input.taskKey)) {
      throw new TaskContextChanged(task.id);
    }

    const [decisionRow] = await tx
      .insert(reviewDecisions)
      .values({
        taskId: task.id,
        decision,
        decidedBy: input.decidedBy,
        decidedAt: now,
        durationMs: input.openedAt ? now.getTime() - input.openedAt.getTime() : null,
      })
      .returning({ id: reviewDecisions.id });
    await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, task.id));
    // Dispatch by `<kind>/<subject_type>` (ruling M4-P13): a name candidate's reject never touches a place.
    if (task.subjectType === "name_candidate") {
      return { documentVersionIds: await applyNameDecision(tx, task, decision), consolidate: null };
    }
    if (task.subjectType === COMPARISON_SUBJECT) {
      // the outcome is a new comparison_results row beside the deviation (append-only); the profile is untouched
      const context = comparisonTaskContextSchema.safeParse(task.context);
      if (!context.success) throw new DecisionNotAllowed(`comparison task ${task.id} has no valid context`);
      const action = decision.action as "own_correct" | "navily_correct" | "unclear";
      await appendReviewOutcome(tx, { context: context.data, action, taskId: task.id, decidedBy: input.decidedBy, now });
      return { documentVersionIds: [], consolidate: null };
    }
    if (task.subjectType === PROFILE_SUBJECT) {
      const geoObjectId = await applyProfileDecision(tx, task, decision, decisionRow!.id, now, input.valueKey);
      return { documentVersionIds: [], consolidate: { geoObjectId } };
    }
    if (decision.action === "regenerate_summary") {
      // `<geoObjectId>:<version>` of a summary that stayed empty: the summary stage runs again after the commit
      const geoObjectId = task.subjectId.slice(0, 36);
      if (!z.uuid().safeParse(geoObjectId).success) throw new DecisionNotAllowed(`subject ${task.subjectId} is no profile summary`);
      const [object] = await tx.select({ id: geoObjects.id }).from(geoObjects).where(eq(geoObjects.id, geoObjectId));
      if (!object) throw new DecisionNotAllowed(`geo object ${geoObjectId} does not exist`);
      return { documentVersionIds: [], consolidate: { geoObjectId, stagesOnly: [CONSOLIDATION_SUMMARY_STAGE] } };
    }
    const placeObject = await apply(tx, task, decision, deps);
    return { documentVersionIds: [], consolidate: placeObject ? { geoObjectId: placeObject } : null };
  });
}

/**
 * Applies a decision that is no name or profile decision. Returns the geo object of the place a `place_candidate`
 * decision changed (`confirm`, `merge`, `reject`, `no_anchoring`): its status, exclusion and `place_new` /
 * `place_abandoned` reach the profile only through a consolidation, which the caller starts after the commit (final
 * review I-2, ruling M5-FIN-R1); null otherwise.
 */
async function apply(tx: Db, task: Task, decision: ReviewDecision, deps: DecideDeps): Promise<string | null> {
  switch (decision.action) {
    case "confirm": {
      const place = await lockPlace(tx, task.subjectId);
      await tx
        .update(places)
        .set({
          status: "confirmed",
          statusReason: null,
          kind: decision.kind,
          publicId: place.publicId ?? newPublicId("sp"),
          ...(decision.position
            ? { position: sql`${geomFromGeoJson({ type: "Point", coordinates: [decision.position.lon, decision.position.lat] })}` }
            : {}),
        })
        .where(eq(places.id, place.id));
      return place.geoObjectId;
    }
    case "merge": {
      const place = await lockPlace(tx, task.subjectId);
      if (decision.intoPlaceId === place.id) throw new DecisionNotAllowed(`place ${place.id} cannot merge into itself`);
      const [target] = await tx
        .select({ id: places.id, geoObjectId: places.geoObjectId })
        .from(places)
        .where(
          and(
            eq(places.id, decision.intoPlaceId),
            isNull(places.validTo),
            isNull(places.mergedIntoId),
            inArray(places.status, ["candidate", "confirmed"]),
          ),
        )
        .for("update");
      if (!target || target.geoObjectId === place.geoObjectId) {
        throw new DecisionNotAllowed(`place ${decision.intoPlaceId} is no valid merge target for ${place.id}`);
      }
      await tx
        .update(places)
        .set({ status: "rejected", statusReason: "merged", mergedIntoId: target.id })
        .where(eq(places.id, place.id));
      return place.geoObjectId;
    }
    case "approve": {
      const domain = await lockSource(tx, task.subjectId, ["proposed"]);
      // a forbidden domain (Navily, Google) is never approved (ruling M6-D-R2)
      if (isForbiddenHost(domain, getConfig().delivery.forbiddenDomains)) {
        throw new DecisionNotAllowed(`source ${task.subjectId} is on the forbidden domain ${domain}`);
      }
      await tx
        .update(sources)
        .set({
          type: decision.type,
          weight: decision.weight,
          changeRate: decision.changeRate,
          crawlRules: decision.crawlRules,
          status: "approved",
          statusReason: null,
        })
        .where(eq(sources.id, task.subjectId));
      return null;
    }
    case "reject":
      if (task.kind === "source_approval") {
        await lockSource(tx, task.subjectId, ["proposed"]);
        await tx
          .update(sources)
          .set({ status: "rejected", statusReason: "review" })
          .where(eq(sources.id, task.subjectId));
        return null;
      }
      return applyPlaceStatus(tx, task, "rejected");
    case "no_anchoring":
      return applyPlaceStatus(tx, task, "no_anchoring");
    case "pause_source": {
      const context = (task.context ?? {}) as { sourceId?: unknown; queue?: unknown; key?: unknown };
      const sourceId = z.uuid().safeParse(context.sourceId);
      if (!sourceId.success) throw new DecisionNotAllowed(`failed_job task ${task.id} names no source`);
      await lockSource(tx, sourceId.data, ["approved", "paused"]);
      await tx
        .update(sources)
        .set({ status: "paused", statusReason: `Job fehlgeschlagen: ${text(context.queue)}/${text(context.key)}` })
        .where(eq(sources.id, sourceId.data));
      return null;
    }
    case "same": {
      const ids = task.subjectId.split(":");
      const objects = await tx
        .select({ id: geoObjects.id, osmId: geoObjects.osmId })
        .from(geoObjects)
        .where(and(inArray(geoObjects.id, ids), isNull(geoObjects.validTo), isNull(geoObjects.mergedIntoId)))
        .orderBy(geoObjects.id);
      if (ids.length !== 2 || objects.length !== 2) {
        throw new DecisionNotAllowed(`geo object pair ${task.subjectId} is no longer valid`);
      }
      // Keep the object with an OSM ID; otherwise (or with two) the older one (smaller UUIDv7).
      const [older, newer] = objects as [(typeof objects)[0], (typeof objects)[0]];
      const [keep, drop] = newer.osmId !== null && older.osmId === null ? [newer, older] : [older, newer];
      await mergeGeoObjects(tx, keep.id, drop.id);
      return null;
    }
    case "assign_area": {
      const [area] = await tx
        .select({ id: geoObjects.id })
        .from(geoObjects)
        .where(
          and(
            eq(geoObjects.id, decision.areaId),
            eq(geoObjects.type, "area"),
            isNull(geoObjects.validTo),
            isNull(geoObjects.mergedIntoId),
          ),
        );
      if (!area) throw new DecisionNotAllowed(`geo object ${decision.areaId} is no valid area`);
      const updated = await tx
        .update(tiles)
        .set({ areaId: area.id })
        .where(and(eq(tiles.id, task.subjectId), isNull(tiles.validTo)))
        .returning({ id: tiles.id });
      if (updated.length === 0) throw new DecisionNotAllowed(`tile ${task.subjectId} is not valid`);
      return null;
    }
    case "retry": {
      if (!deps.retryJob) throw new Error("retry decision needs deps.retryJob");
      const queue = z.enum(QUEUES).safeParse((task.context as { queue?: unknown }).queue);
      if (!queue.success) throw new DecisionNotAllowed(`failed_job task ${task.id} has no retryable queue`);
      await deps.retryJob(queue.data, task.subjectId);
      return null;
    }
    case "distinct":
    case "no_area":
    case "ignore":
      return null;
    case "create_place":
    case "assign_name":
      throw new DecisionNotAllowed(`action ${decision.action} needs a name candidate`);
    case "value_a":
    case "value_b":
    case "seasonal":
    case "leave_open":
    case "accept_change":
    case "discard_change":
      throw new DecisionNotAllowed(`action ${decision.action} needs a profile attribute`);
    case "regenerate_summary":
      throw new DecisionNotAllowed(`action ${decision.action} needs a profile summary`);
    case "own_correct":
    case "navily_correct":
    case "unclear":
      throw new DecisionNotAllowed(`action ${decision.action} needs a comparison deviation`);
  }
}

const PROFILE_SUBJECT = "profile_attribute";
/** Subject of a `comparison_deviation` task: `<placeId>:<attribute>:<valueHash>` (`recordComparisonResults`). */
const COMPARISON_SUBJECT = "comparison";

/** `<geoObjectId>:<attribute>` of a profile task; `DecisionNotAllowed` for another shape. */
function profileSubject(subjectId: string): { geoObjectId: string; attribute: string } {
  const geoObjectId = subjectId.slice(0, 36);
  const attribute = subjectId.slice(37);
  if (!z.uuid().safeParse(geoObjectId).success || subjectId[36] !== ":" || attribute === "") {
    throw new DecisionNotAllowed(`subject ${subjectId} is no profile attribute`);
  }
  return { geoObjectId, attribute };
}

/**
 * The value a review fact on `attribute` stores, validated against the fact schema `version`. A list-valued profile
 * attribute whose single fact is one entry (`season_notes`, rule `union`) stores the list, every entry validated: the
 * union rule reads a list or a single entry alike. `DecisionNotAllowed` for an unknown attribute or an invalid value.
 */
function reviewFactValue(attribute: string, value: unknown, version: string): unknown {
  try {
    const def = attributeDef(attribute, version);
    if (Array.isArray(value) && def.rule === "union" && !def.value.safeParse(value).success && value.length > 0) {
      return value.map((entry) => validateFactValue(attribute, entry, version));
    }
    return validateFactValue(attribute, value, version);
  } catch (e) {
    if (e instanceof UnknownAttribute || e instanceof InvalidFactValue) throw new DecisionNotAllowed(e.message);
    throw e;
  }
}

/**
 * Applies a decision on a profile attribute (spec 07; ruling M5-P10). `value_a` / `value_b` / `accept_change` write
 * one review fact on the decision row (`review_decision_id`): the attribute and the value of the task's context (side
 * `a` / `b` of the conflict, the proposed `newValue`), validated against the active fact schema, confidence
 * `confidence.review`, observed on the decision date, the active fact schema version. `seasonal`, `leave_open` and
 * `discard_change` are the decision row only: consolidation reads them from the decided task (`loadContext`) — a
 * resolution `seasonal` / `left_open` for the conflict key, a decided uncertain key that keeps the old value. Never
 * consolidates and never takes the profile lock (ruling M5-F-R4): the caller starts the follow-up run after the commit.
 * Returns the geo object.
 */
async function applyProfileDecision(
  tx: Db,
  task: Task,
  decision: ReviewDecision,
  decisionId: string,
  now: Date,
  valueKey: string | undefined,
): Promise<string> {
  const { geoObjectId, attribute } = profileSubject(task.subjectId);
  const [object] = await tx.select({ id: geoObjects.id }).from(geoObjects).where(eq(geoObjects.id, geoObjectId));
  if (!object) throw new DecisionNotAllowed(`geo object ${geoObjectId} does not exist`);
  const context = (task.context ?? {}) as Record<string, unknown>;
  const sideValue = (side: unknown): unknown => {
    if (side === null || typeof side !== "object" || !("value" in side)) {
      throw new DecisionNotAllowed(`conflict task ${task.id} has no such side`);
    }
    return (side as { value: unknown }).value;
  };
  let value: unknown;
  switch (decision.action) {
    case "value_a":
    case "value_b":
      // the chosen side must still hold the value the admin saw: sides can swap under one key (ruling M5-G-R2)
      value = sideValue(decision.action === "value_a" ? context.a : context.b);
      if (valueKey === undefined || valueKey !== valueFingerprint(value)) throw new TaskContextChanged(task.id);
      break;
    case "accept_change":
      value = context.newValue;
      break;
    case "seasonal":
    case "leave_open":
    case "discard_change":
      return geoObjectId;
    default:
      throw new DecisionNotAllowed(`action ${decision.action} does not fit a profile attribute`);
  }
  if (value === null || value === undefined) throw new DecisionNotAllowed(`task ${task.id} proposes no value for ${attribute}`);
  const factSchemaVersion = getConfig().factSchema.version;
  await tx.insert(facts).values({
    geoObjectId,
    attribute,
    value: reviewFactValue(attribute, value, factSchemaVersion),
    reviewDecisionId: decisionId,
    observedAt: now.toISOString().slice(0, 10),
    confidence: (await consolidationConfigFor(tx)).confidence.review,
    factSchemaVersion,
  });
  return geoObjectId;
}

/**
 * Ring of neighbour tiles around a name candidate's tile that forms its candidate space (spec 06: "plus deren 8
 * Nachbarn"): the matcher's `neighbourRing` from `config/mentions.json`, so the decision, the review view and the
 * matcher share one candidate space.
 */
export const nameCandidateRing = (): 1 | 2 => getConfig().mentions.neighbourRing;

/** Geo object types a new name may create. */
const HINT_TYPES: Record<string, GeoObjectType> = {
  bay: "bay",
  anchorage: "bay",
  harbour: "harbour",
  marina: "harbour",
  cape: "cape",
  island: "islet",
};

/**
 * The geo object a new name creates, from the candidate's hint: `bay`/`anchorage` → bay, `harbour`/`marina` → harbour,
 * `cape` → cape, `island` → islet, `poi:<category>` → poi of that category. Without a known hint, the place kind
 * decides: a port or marina is a harbour, an anchorage or mooring field a bay.
 */
export function newNameObjectType(hint: string | null, kind: PlaceKind): { type: GeoObjectType; category: PoiCategory | null } {
  if (hint?.startsWith("poi:")) {
    const category = z.enum(poiCategoryEnum.enumValues).safeParse(hint.slice(4));
    if (category.success) return { type: "poi", category: category.data };
  }
  const type = hint ? HINT_TYPES[hint] : undefined;
  if (type) return { type, category: null };
  return { type: kind === "port" || kind === "marina" ? "harbour" : "bay", category: null };
}

/** Types that get a place when a new name creates them. */
const PLACE_TYPES: readonly GeoObjectType[] = ["bay", "harbour"];

/**
 * Applies a decision on a name candidate (after the task row, the candidate row is locked): `create_place` creates the
 * geo object (type by `newNameObjectType`, origin `text`) with the given name (origin `text`; a missing German name
 * gets the name, Greek transliterated, as `de` fallback), links it to the tiles it lies in, gives it its parent by
 * the gazetteer's hierarchy rule (`assignParentOf`, after the task and candidate locks) and, for a bay or harbour,
 * creates a confirmed place with a public id (its geometry and restriction check follow in the next geometry run of
 * its area); `assign_name` adds the candidate's name (origin `review`) to a valid object of the candidate space (the
 * tile and its neighbours); `reject` only decides the candidate. After `create_place` or `assign_name`, returns the
 * current versions of the active documents the name was found in (for the rematch); after `reject`, none.
 */
async function applyNameDecision(tx: Db, task: Task, decision: ReviewDecision): Promise<string[]> {
  const candidate = await lockNameCandidate(tx, task.subjectId);
  switch (decision.action) {
    case "create_place": {
      const { type, category } = newNameObjectType(candidate.hint, decision.kind);
      const names: NameDraft[] = [{ name: decision.name, language: decision.language, origin: "text", isPreferred: true }];
      if (decision.language !== "de") {
        const de = isGreek(decision.name) ? transliterateElot743(decision.name) : decision.name;
        names.push({ name: de, language: "de", origin: "fallback", isPreferred: true });
      }
      const point: GeoJSON.Point = { type: "Point", coordinates: [decision.position.lon, decision.position.lat] };
      const created = await upsertGeoObject(tx, { type, category: category ?? undefined, origin: "text", geometry: point, names });
      if ("skipped" in created) throw new DecisionNotAllowed(`position of ${candidate.id} is no valid point: ${created.skipped}`);
      await tx.execute(sql`
        insert into tile_geo_objects (tile_id, geo_object_id)
        select t.id, o.id from tiles t join geo_objects o on o.geom && t.bbox and ST_Intersects(t.bbox, o.geom)
        where o.id = ${created.id} and t.valid_to is null
        on conflict do nothing`);
      await assignParentOf(tx, created.id);
      if (PLACE_TYPES.includes(type)) {
        await tx.insert(places).values({
          geoObjectId: created.id,
          kind: decision.kind,
          status: "confirmed",
          statusReason: null,
          publicId: newPublicId("sp"),
          position: sql`${geomFromGeoJson(point)}`,
        });
      }
      break;
    }
    case "assign_name": {
      const space = await candidateObjects(tx, withNeighbours([candidate.tileId], nameCandidateRing()));
      if (!space.includes(decision.geoObjectId)) {
        throw new DecisionNotAllowed(`geo object ${decision.geoObjectId} is not valid or not in the candidate space of ${candidate.tileId}`);
      }
      await addNames(tx, decision.geoObjectId, [{ name: candidate.displayName, language: "und", origin: "review" }]);
      break;
    }
    case "reject":
      await tx.update(nameCandidates).set({ status: "decided" }).where(eq(nameCandidates.id, candidate.id));
      return [];
    default:
      throw new DecisionNotAllowed(`action ${decision.action} does not fit a name candidate`);
  }
  await tx.update(nameCandidates).set({ status: "decided" }).where(eq(nameCandidates.id, candidate.id));
  // The current version of each active document that carried the name in this tile (a superseded version is no
  // rematch target; the rematch also matches the chunks carried into it, where the name may sit, ruling M4-FIN-R1).
  const { rows } = await tx.execute<{ id: string }>(sql`
    select distinct d.current_version_id as id
    from unmatched_names u
    join document_versions v on v.id = u.document_version_id
    join documents d on d.id = v.document_id
    where u.name_normalized = ${candidate.nameNormalized} and u.tile_id = ${candidate.tileId}
      and d.status = 'active' and d.valid_to is null and d.current_version_id is not null
    order by id`);
  return rows.map((r) => r.id);
}

/** The task's name candidate, locked; `DecisionNotAllowed` when it does not exist or was decided already. */
async function lockNameCandidate(tx: Db, candidateId: string) {
  const [candidate] = z.uuid().safeParse(candidateId).success
    ? await tx.select().from(nameCandidates).where(eq(nameCandidates.id, candidateId)).for("update")
    : [];
  if (!candidate || candidate.status === "decided") throw new DecisionNotAllowed(`name candidate ${candidateId} is not open`);
  return candidate;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "?");

/** Sets the status of the task's place; returns its geo object. */
async function applyPlaceStatus(tx: Db, task: Task, status: "rejected" | "no_anchoring"): Promise<string> {
  const place = await lockPlace(tx, task.subjectId);
  await tx.update(places).set({ status, statusReason: "review" }).where(eq(places.id, place.id));
  return place.geoObjectId;
}

/**
 * The source, locked, returning its domain; `DecisionNotAllowed` when it does not exist, has ended or its status is
 * not one of `statuses` (e.g. a proposal approved or rejected meanwhile).
 */
async function lockSource(tx: Db, sourceId: string, statuses: readonly SourceStatus[]): Promise<string> {
  const [source] = z.uuid().safeParse(sourceId).success
    ? await tx
        .select({ status: sources.status, domain: sources.domain })
        .from(sources)
        .where(and(eq(sources.id, sourceId), isNull(sources.validTo)))
        .for("update")
    : [];
  if (!source) throw new DecisionNotAllowed(`source ${sourceId} is not valid`);
  if (!statuses.includes(source.status)) {
    throw new DecisionNotAllowed(`source ${sourceId} is ${source.status}, not ${statuses.join(" or ")}`);
  }
  return source.domain;
}

/** The task's place, locked; `DecisionNotAllowed` when it does not exist, has ended or was merged. */
async function lockPlace(tx: Db, placeId: string) {
  const [place] = await tx
    .select({ id: places.id, geoObjectId: places.geoObjectId, publicId: places.publicId })
    .from(places)
    .where(and(eq(places.id, placeId), isNull(places.validTo), isNull(places.mergedIntoId)))
    .for("update");
  if (!place) throw new DecisionNotAllowed(`place ${placeId} is not valid`);
  return place;
}

/** Queue order of review tasks: highest `priority` first, then the oldest. */
export const QUEUE_ORDER = [desc(reviewTasks.priority), asc(reviewTasks.createdAt), asc(reviewTasks.id)] as const;

/**
 * Tasks after task `afterId` in `QUEUE_ORDER` (all tasks when it does not exist). Compared in SQL: created_at
 * has microseconds, a JS Date only milliseconds.
 */
export function afterInQueue(afterId: string): SQL {
  return sql`(
    not exists (select 1 from review_tasks a where a.id = ${afterId})
    or exists (
      select 1 from review_tasks a
      where a.id = ${afterId}
        and (${reviewTasks.priority} < a.priority
             or (${reviewTasks.priority} = a.priority and (${reviewTasks.createdAt}, ${reviewTasks.id}) > (a.created_at, a.id)))
    )
  )`;
}

/**
 * The next open task, optionally of one kind: highest `priority` first, then the oldest. With `afterId`, the
 * first one after that task in this order (the task itself may be decided by now).
 */
export async function nextOpenTask(db: Db, kind?: ReviewKind, afterId?: string): Promise<{ id: string } | null> {
  const conditions: (SQL | undefined)[] = [eq(reviewTasks.status, "open"), kind ? eq(reviewTasks.kind, kind) : undefined];
  if (afterId) conditions.push(afterInQueue(afterId));
  const [row] = await db
    .select({ id: reviewTasks.id })
    .from(reviewTasks)
    .where(and(...conditions))
    .orderBy(...QUEUE_ORDER)
    .limit(1);
  return row ?? null;
}

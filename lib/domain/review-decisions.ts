import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { recheckExclusion } from "@/lib/domain/geometry/restrictions";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { Archive } from "@/lib/adapters/s3";
import { applyPlaceImageDecision, type RegenerateImage } from "@/lib/domain/images/approve";
import { geoObjects, placeKindEnum, places, reviewDecisions, reviewTasks, type ReviewKind } from "@/lib/db/schema";
import { NOT_BERTH_REASON, RESEARCH_CONFLICT_SUBJECT } from "@/lib/domain/research/gate-conflicts";
import { dismissTasks, lockOpenPlaceTasks } from "@/lib/domain/review/task-locks";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { newPublicId } from "@/lib/domain/ids";
import { appendReviewOutcome, comparisonTaskContextSchema } from "@/lib/domain/quality/comparison-results";
import { QUEUES, type QueueName } from "@/lib/jobs/queues";

export const reviewDecisionSchema = z.discriminatedUnion("action", [
  // place_candidate / place
  z.object({
    action: z.literal("confirm"),
    kind: z.enum(placeKindEnum.enumValues),
    position: z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) }).optional(),
  }),
  z.object({ action: z.literal("merge"), intoPlaceId: z.uuid() }),
  // place_candidate / place
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("no_anchoring") }),
  // place_candidate / geo_object_pair
  z.object({ action: z.literal("same") }),
  z.object({ action: z.literal("distinct") }),
  // failed_job
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("ignore") }),
  // comparison_deviation / comparison: the own value is right, Navily is right (own value wrong), or unclear
  z.object({ action: z.literal("own_correct") }),
  z.object({ action: z.literal("navily_correct") }),
  z.object({ action: z.literal("unclear") }),
  // place_image / place_image: approve the candidate, generate again (optionally at another zoom), or no image
  z.object({ action: z.literal("approve_image") }),
  z.object({ action: z.literal("regenerate_image"), zoom: z.enum(["z1", "z2", "z3"]).optional() }),
  z.object({ action: z.literal("no_image") }),
  // research_conflict: the place is a berth (status stays), or is none (rejected)
  z.object({ action: z.literal("berth") }),
  z.object({ action: z.literal("not_berth") }),
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

/** Allowed actions per `<kind>/<subject_type>`. */
const ALLOWED: Record<string, readonly Action[]> = {
  "place_candidate/place": ["confirm", "merge", "reject", "no_anchoring"],
  "place_candidate/geo_object_pair": ["same", "distinct"],
  "failed_job/job": ["retry", "ignore"],
  "comparison_deviation/comparison": ["own_correct", "navily_correct", "unclear"],
  "place_image/place_image": ["approve_image", "regenerate_image", "no_image"],
  "research_conflict/research_conflict": ["berth", "not_berth"],
};

export type DecideDeps = {
  retryJob?: (queue: QueueName, jobId: string) => Promise<void>;
  /** The archive an `approve_image` reads the candidate from and writes the image to. */
  archive?: Archive;
};

/** What a decision asks for after its commit (ruling M5-P10), never started inside the decision's transaction, which could roll back under a started run. */
export type DecideResult = {
  /** The image run „Neu erzeugen“ on a `place_image` task asks for (`applyPlaceImageDecision`). */
  regenerateImage: RegenerateImage | null;
};

type Task = typeof reviewTasks.$inferSelect;

/**
 * Decides an open review task in one transaction: locks the task (`TaskNotOpen` unless it is open), writes
 * exactly one `review_decisions` row (`duration_ms = now - openedAt` when `openedAt` is given), applies the
 * decision and marks the task `decided`. `DecisionNotAllowed` when the action does not fit the task or its
 * subject or target is not valid; nothing is written then. A `retry` calls `deps.retryJob` last, so a failed
 * retry rolls the decision back.
 *
 * A decision on a `comparison_deviation` task appends its outcome to `comparison_results` (`deviation_confirmed_own` /
 * `deviation_confirmed_navily` / `unclear`, method `review`). A decision on a `place_image` task needs `taskKey`
 * (`TaskContextChanged` when the pipeline replaced the image meanwhile) and is applied by `applyPlaceImageDecision`:
 * `approve_image` needs `deps.archive`, `regenerate_image` returns the image run to start after the commit
 * (`regenerateImage`).
 *
 * Global lock order: the review task row first, then the subject row(s) (`lockPlace`). Every transaction that locks
 * both an open `place_candidate` task and its place (`applyExclusion`, stage `geometry.place`) takes them in this
 * order, so none of them deadlocks with a decision.
 */
export async function decideReviewTask(
  db: Db,
  input: { taskId: string; decision: ReviewDecision; decidedBy: string; openedAt?: Date; now?: Date; taskKey?: string },
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
    if (
      task.subjectType === PLACE_IMAGE_SUBJECT &&
      (input.taskKey === undefined || (task.context as { key?: unknown } | null)?.key !== input.taskKey)
    ) {
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
    // Dispatch by `<kind>/<subject_type>` (ruling M4-P13).
    if (task.subjectType === COMPARISON_SUBJECT) {
      // the outcome is a new comparison_results row beside the deviation (append-only); the profile is untouched
      const context = comparisonTaskContextSchema.safeParse(task.context);
      if (!context.success) throw new DecisionNotAllowed(`comparison task ${task.id} has no valid context`);
      const action = decision.action as "own_correct" | "navily_correct" | "unclear";
      await appendReviewOutcome(tx, { context: context.data, action, taskId: task.id, decidedBy: input.decidedBy, now });
      return { regenerateImage: null };
    }
    if (task.subjectType === RESEARCH_CONFLICT_SUBJECT) {
      // „Kein Liegeplatz“ rejects the place for good (the research never confirms a rejected place); „Liegeplatz“ only records
      if (decision.action === "berth") return { regenerateImage: null };
      // Lock order (M5-F-R4): the place's open tasks, then the place. `lockOpenPlaceTasks` takes only the tasks on the
      // place itself (`subject_type = 'place'`), not this research_conflict task, which the decision holds already; a
      // rejected place has nothing left to decide there, so they are dismissed as superseded.
      const openPlaceTasks = await lockOpenPlaceTasks(tx, task.subjectId);
      const place = await lockPlace(tx, task.subjectId);
      await tx.update(places).set({ status: "rejected", statusReason: NOT_BERTH_REASON, updatedAt: sql`now()` }).where(eq(places.id, place.id));
      await dismissTasks(tx, openPlaceTasks, "superseded");
      return { regenerateImage: null };
    }
    if (task.subjectType === PLACE_IMAGE_SUBJECT) {
      const regenerateImage = await applyPlaceImageDecision(tx, task, decision, decisionRow!.id, now, { archive: deps.archive });
      return { regenerateImage };
    }
    await apply(tx, task, decision, deps);
    return { regenerateImage: null };
  });
}

/** Applies a decision on a place, a pair of geo objects or a failed job (never a comparison, image or research-conflict decision). */
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
      // a restricted-area review: the next undecided banning area asks at once (wave-1 review M-2)
      if ((task.context as { reason?: unknown } | null)?.reason === "restricted") {
        await recheckExclusion(tx, { id: place.id, geoObjectId: place.geoObjectId }, getConfig().geometry.restriction.minShare);
      }
      return place.geoObjectId;
    }
    case "merge": {
      // „Einem Ort zuordnen“ merges like „Derselbe Ort“ (GR-3): the geo objects, so the facts follow the merge chain.
      // Lock order (as `mergePlaceInto`): the open tasks on the place, both geo objects, then the places.
      if (decision.intoPlaceId === task.subjectId) throw new DecisionNotAllowed(`place ${task.subjectId} cannot merge into itself`);
      const { rows: read } = await tx.execute<{ id: string; geo_object_id: string }>(
        sql`select id, geo_object_id from places where id in (${task.subjectId}, ${decision.intoPlaceId})`,
      );
      const dropObject = read.find((r) => r.id === task.subjectId)?.geo_object_id;
      const keepObject = read.find((r) => r.id === decision.intoPlaceId)?.geo_object_id;
      if (!dropObject) throw new DecisionNotAllowed(`place ${task.subjectId} is not valid`);
      if (!keepObject || keepObject === dropObject) throw new DecisionNotAllowed(`place ${decision.intoPlaceId} is no valid merge target for ${task.subjectId}`);
      // the place's other open tasks, before the geo objects: `mergeGeoObjects` dismisses them (UI-5)
      await lockOpenPlaceTasks(tx, task.subjectId);
      const { rows: objects } = await tx.execute<{ id: string }>(sql`
        select id from geo_objects
        where id in (${dropObject}, ${keepObject}) and valid_to is null and merged_into_id is null
        order by id
        for update
      `);
      if (objects.length !== 2) throw new DecisionNotAllowed(`the geo objects of places ${task.subjectId} and ${decision.intoPlaceId} are not both valid`);
      const place = await lockPlace(tx, task.subjectId);
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
      if (!target || place.geoObjectId !== dropObject || target.geoObjectId !== keepObject) {
        throw new DecisionNotAllowed(`place ${decision.intoPlaceId} is no valid merge target for ${place.id}`);
      }
      await mergeGeoObjects(tx, keepObject, dropObject);
      return keepObject;
    }
    case "reject":
      return applyPlaceStatus(tx, task, "rejected");
    case "no_anchoring":
      return applyPlaceStatus(tx, task, "no_anchoring");
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
      // the survivor carries the merged object's facts and possibly its exclusion (GR-3/GR-4): consolidate it
      return keep.id;
    }
    case "retry": {
      if (!deps.retryJob) throw new Error("retry decision needs deps.retryJob");
      const queue = z.enum(QUEUES).safeParse((task.context as { queue?: unknown }).queue);
      if (!queue.success) throw new DecisionNotAllowed(`failed_job task ${task.id} has no retryable queue`);
      await deps.retryJob(queue.data, task.subjectId);
      return null;
    }
    case "distinct":
    case "ignore":
      return null;
    case "own_correct":
    case "navily_correct":
    case "unclear":
      throw new DecisionNotAllowed(`action ${decision.action} needs a comparison deviation`);
    case "approve_image":
    case "regenerate_image":
    case "no_image":
      throw new DecisionNotAllowed(`action ${decision.action} needs a place image`);
    case "berth":
    case "not_berth":
      throw new DecisionNotAllowed(`action ${decision.action} needs a research conflict`);
  }
}

/** Subject of a `comparison_deviation` task: `<placeId>:<attribute>:<valueHash>` (`recordComparisonResults`). */
const COMPARISON_SUBJECT = "comparison";
/** Subject of a `place_image` task: `<geoObjectId>:<slot>` (`generatePlaceImage`). */
const PLACE_IMAGE_SUBJECT = "place_image";

/** Sets the status of the task's place; returns its geo object. */
async function applyPlaceStatus(tx: Db, task: Task, status: "rejected" | "no_anchoring"): Promise<string> {
  const place = await lockPlace(tx, task.subjectId);
  await tx.update(places).set({ status, statusReason: "review" }).where(eq(places.id, place.id));
  return place.geoObjectId;
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
export async function nextOpenTask(db: Db, kind?: ReviewKind, afterId?: string, where?: SQL): Promise<{ id: string } | null> {
  const conditions: (SQL | undefined)[] = [eq(reviewTasks.status, "open"), kind ? eq(reviewTasks.kind, kind) : undefined, where];
  if (afterId) conditions.push(afterInQueue(afterId));
  const [row] = await db
    .select({ id: reviewTasks.id })
    .from(reviewTasks)
    .where(and(...conditions))
    .orderBy(...QUEUE_ORDER)
    .limit(1);
  return row ?? null;
}

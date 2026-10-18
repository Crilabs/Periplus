import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  geoObjects,
  placeKindEnum,
  places,
  reviewDecisions,
  reviewTasks,
  tiles,
  type ReviewKind,
} from "@/lib/db/schema";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { newPublicId } from "@/lib/domain/ids";

export const reviewDecisionSchema = z.discriminatedUnion("action", [
  // place_candidate / place
  z.object({
    action: z.literal("confirm"),
    kind: z.enum(placeKindEnum.enumValues),
    position: z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) }).optional(),
  }),
  z.object({ action: z.literal("merge"), intoPlaceId: z.uuid() }),
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

/** Allowed actions per `<kind>/<subject_type>`. */
const ALLOWED: Record<string, readonly Action[]> = {
  "place_candidate/place": ["confirm", "merge", "reject", "no_anchoring"],
  "place_candidate/geo_object_pair": ["same", "distinct"],
  "coast_tile_without_area/tile": ["assign_area", "no_area"],
  "failed_job/job": ["retry", "ignore"],
};

export type DecideDeps = { retryJob?: (queue: string, jobId: string) => Promise<void> };

type Task = typeof reviewTasks.$inferSelect;

/**
 * Decides an open review task in one transaction: locks the task (`TaskNotOpen` unless it is open), writes
 * exactly one `review_decisions` row (`duration_ms = now - openedAt` when `openedAt` is given), applies the
 * decision and marks the task `decided`. `DecisionNotAllowed` when the action does not fit the task or its
 * subject or target is not valid; nothing is written then. A `retry` calls `deps.retryJob` last, so a failed
 * retry rolls the decision back.
 */
export async function decideReviewTask(
  db: Db,
  input: { taskId: string; decision: ReviewDecision; decidedBy: string; openedAt?: Date; now?: Date },
  deps: DecideDeps = {},
): Promise<void> {
  const decision = reviewDecisionSchema.parse(input.decision);
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, input.taskId)).for("update");
    if (!task || task.status !== "open") throw new TaskNotOpen(input.taskId);
    if (!ALLOWED[`${task.kind}/${task.subjectType}`]?.includes(decision.action)) {
      throw new DecisionNotAllowed(`action ${decision.action} does not fit a ${task.kind} task on a ${task.subjectType}`);
    }

    await tx.insert(reviewDecisions).values({
      taskId: task.id,
      decision,
      decidedBy: input.decidedBy,
      decidedAt: now,
      durationMs: input.openedAt ? now.getTime() - input.openedAt.getTime() : null,
    });
    await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, task.id));
    await apply(tx, task, decision, deps);
  });
}

async function apply(tx: Db, task: Task, decision: ReviewDecision, deps: DecideDeps): Promise<void> {
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
      return;
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
      return;
    }
    case "reject":
    case "no_anchoring": {
      const place = await lockPlace(tx, task.subjectId);
      await tx
        .update(places)
        .set({ status: decision.action === "reject" ? "rejected" : "no_anchoring", statusReason: "review" })
        .where(eq(places.id, place.id));
      return;
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
      return;
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
      return;
    }
    case "retry": {
      if (!deps.retryJob) throw new Error("retry decision needs deps.retryJob");
      const queue = (task.context as { queue?: unknown }).queue;
      if (typeof queue !== "string") throw new DecisionNotAllowed(`failed_job task ${task.id} has no queue`);
      await deps.retryJob(queue, task.subjectId);
      return;
    }
    case "distinct":
    case "no_area":
    case "ignore":
      return;
  }
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

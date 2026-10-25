import { and, eq, isNull, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places, reviewDecisions, reviewTasks, type PlaceStatus } from "@/lib/db/schema";
import { lockOpenPlaceTasks } from "@/lib/domain/review/task-locks";
import { recheckExclusion } from "@/lib/domain/geometry/restrictions";
import { deleteHighlightSelections } from "@/lib/domain/highlights/selections";
import { newPublicId } from "@/lib/domain/ids";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";

/** The statuses an admin sets in the place header: „Bestätigen“, „Verwerfen“, „Kein Ankerplatz“. */
export const ADMIN_PLACE_STATUSES = ["confirmed", "rejected", "no_anchoring"] as const;
export type AdminPlaceStatus = (typeof ADMIN_PLACE_STATUSES)[number];

export type PlaceStatusRefusal = "open_task" | "changed" | "unchanged" | "not_valid";

/** Why a header status change is refused: an open review task decides it (with its context), or nothing changes. */
export class PlaceStatusNotAllowed extends DecisionNotAllowed {
  constructor(
    readonly reason: PlaceStatusRefusal,
    message: string,
  ) {
    super(message);
    this.name = "PlaceStatusNotAllowed";
  }
}

/** The statuses the header offers for a place of `status` (spec 09 `/places/[id]`: bestätigen, verwerfen). */
export function adminStatusChoices(status: PlaceStatus): AdminPlaceStatus[] {
  return ADMIN_PLACE_STATUSES.filter((s) => s !== status);
}

/**
 * „Bestätigen“ / „Verwerfen“ / „Kein Ankerplatz“ in the place header (spec 09, gesamt review UI-3): sets the status of
 * a valid, unmerged place outside a review task, in one transaction, recorded like the place merge and the position
 * correction: one immediately decided `place_candidate` task on subject `place_status` (context: the previous status)
 * and one `review_decisions` row `{ action: "confirm" | "reject" | "no_anchoring" }`. A confirmed place gets its public
 * id (`sp_`) if it has none yet, keeps its kind and loses its status reason; a rejected or excluded place gets the reason
 * `review`. Confirming also re-checks the restricted areas of the newest geometry (as the review's „Trotz Sperrgebiet
 * bestätigen“), so a place inside a ban asks for its review at once.
 *
 * Refused (`PlaceStatusNotAllowed`, nothing written) while the place has an open task of its own (`open_task`: that task
 * decides, with its context), when its status is no longer `from`, the status the page showed (`changed`: a stale tab
 * never withdraws a place confirmed meanwhile without the confirm step, W4-2), for the status it already has
 * (`unchanged`) and for a place that is ended or merged (`not_valid`). Lock order (M5-F-R4): the place's open tasks first, then the place. Returns the geo object; its profile
 * follows with a consolidation run the caller starts after the commit (`consolidateAfter`).
 */
export async function setPlaceStatusByAdmin(
  db: Db,
  input: { placeId: string; status: AdminPlaceStatus; from: PlaceStatus; decidedBy: string; now?: Date },
): Promise<{ geoObjectId: string; previous: PlaceStatus }> {
  return db.transaction(async (tx) => {
    const open = await lockOpenPlaceTasks(tx, input.placeId);
    const [place] = await tx
      .select({ id: places.id, geoObjectId: places.geoObjectId, status: places.status, publicId: places.publicId })
      .from(places)
      .where(and(eq(places.id, input.placeId), isNull(places.validTo), isNull(places.mergedIntoId)))
      .for("update");
    if (!place) throw new PlaceStatusNotAllowed("not_valid", `place ${input.placeId} is not valid`);
    if (open.length > 0) throw new PlaceStatusNotAllowed("open_task", `place ${input.placeId} has an open review task`);
    if (place.status !== input.from) {
      throw new PlaceStatusNotAllowed("changed", `place ${input.placeId} is ${place.status}, not ${input.from} as shown`);
    }
    if (place.status === input.status) throw new PlaceStatusNotAllowed("unchanged", `place ${input.placeId} is ${place.status} already`);

    const [task] = await tx
      .insert(reviewTasks)
      .values({
        kind: "place_candidate",
        subjectType: "place_status",
        subjectId: place.id,
        context: { previous: place.status },
        status: "decided",
      })
      .returning({ id: reviewTasks.id });
    const action = input.status === "confirmed" ? "confirm" : input.status === "rejected" ? "reject" : "no_anchoring";
    await tx.insert(reviewDecisions).values({
      taskId: task!.id,
      decision: { action },
      decidedBy: input.decidedBy,
      decidedAt: input.now ?? new Date(),
    });
    await tx
      .update(places)
      .set(
        input.status === "confirmed"
          ? { status: "confirmed", statusReason: null, publicId: place.publicId ?? newPublicId("sp"), updatedAt: sql`now()` }
          : { status: input.status, statusReason: "review", updatedAt: sql`now()` },
      )
      .where(eq(places.id, place.id));
    // a rejected place selects no highlights any more (spec 16)
    if (input.status === "rejected") await deleteHighlightSelections(tx, place.geoObjectId);
    if (input.status === "confirmed") {
      await recheckExclusion(tx, { id: place.id, geoObjectId: place.geoObjectId }, getConfig().geometry.restriction.minShare);
    }
    return { geoObjectId: place.geoObjectId, previous: place.status };
  });
}

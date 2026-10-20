import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { reviewDecisions, reviewTasks, type PlaceKind } from "@/lib/db/schema";
import { dismissTasks, lockOpenTasks } from "@/lib/domain/consolidation/task-locks";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { displayNameSql } from "@/lib/domain/gazetteer/names";

/*
 * „Mit Ort zusammenlegen“ (ruling M6-P15): an admin merges a confirmed place into another confirmed place, the remedy
 * for a `spot_duplicates` violation of a package. It follows the gazetteer merge (`mergeGeoObjects`): the place is
 * rejected with `merged_into_id`, its geo object ends with `merged_into_id`, so the consolidation of the surviving
 * object carries its facts (M5 merge chain, ruling M5-D-R2) and the next package delivers the merged spot with
 * `mergedInto` (ruling M6-P14). Never consolidates inside the merge (ruling M5-F-R4): the caller starts the run for the
 * surviving object after the commit.
 */

/** How many confirmed places nearby the merge dialog offers. */
const MERGE_CHOICES = 8;

export type MergeRefusal = "self" | "not_valid" | "across_areas";

/** The merge is not allowed; nothing was written. */
export class PlaceMergeNotAllowed extends Error {
  readonly reason: MergeRefusal;
  constructor(reason: MergeRefusal, message: string) {
    super(message);
    this.name = "PlaceMergeNotAllowed";
    this.reason = reason;
  }
}

export type MergeCandidate = {
  id: string;
  name: string | null;
  kind: PlaceKind;
  publicId: string | null;
  distanceM: number;
  areaName: string | null;
  /** In the same area (tile area) as the place: a merge across areas needs a confirmation. */
  sameArea: boolean;
};

/**
 * Two places lie in the same area when both have one (their tile's area, valid today) and it is the same: a place on
 * a tile without area is in no area, so a merge with it always needs the confirmation (the one predicate of the
 * dialog and of the merge).
 */
export const sameArea = (a: string | null, b: string | null): boolean => a !== null && a === b;

/** The area of a place: its tile's area, valid today. */
const placeAreaSql = (alias: string) =>
  sql.raw(`(select t.area_id from tiles t where t.id = ${alias}.tile_id
    and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date))`);

/** The confirmed, valid, unmerged places nearest to `placeId` (another geo object), with distance and area. */
export async function mergeCandidates(db: Db, placeId: string): Promise<MergeCandidate[]> {
  const { rows } = await db.execute<{
    id: string;
    name: string | null;
    kind: PlaceKind;
    public_id: string | null;
    distance_m: number;
    area_name: string | null;
    area_id: string | null;
    subject_area_id: string | null;
  }>(sql`
    select p.id, ${displayNameSql(sql`p.geo_object_id`)} as name, p.kind, p.public_id,
           ST_Distance(p.position::geography, s.position::geography) as distance_m,
           ${displayNameSql(placeAreaSql("p"))} as area_name,
           ${placeAreaSql("p")} as area_id, ${placeAreaSql("s")} as subject_area_id
    from places p, places s
    where s.id = ${placeId}
      and p.id <> s.id and p.geo_object_id <> s.geo_object_id
      and p.status = 'confirmed' and p.merged_into_id is null
      and p.valid_from <= current_date and (p.valid_to is null or p.valid_to > current_date)
    order by p.position <-> s.position, p.id
    limit ${MERGE_CHOICES}
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    publicId: r.public_id,
    distanceM: Number(r.distance_m),
    areaName: r.area_name,
    sameArea: sameArea(r.area_id, r.subject_area_id),
  }));
}

export type MergeResult = { keepGeoObjectId: string; dropGeoObjectId: string; dismissedTaskIds: string[] };

/**
 * Merges the confirmed place `placeId` into the confirmed place `intoPlaceId` in one transaction. Refused
 * (`PlaceMergeNotAllowed`, nothing written) for the place itself or its own geo object (`self`), for a place or target
 * that is not a valid, unmerged, confirmed place (`not_valid`), and for places of two areas unless `confirmAcrossAreas`
 * (`across_areas`).
 *
 * Lock order (ruling M5-F-R4, global order of `decideReviewTask`; the gazetteer merge `mergeGeoObjects` and the
 * review decision `same` lock geo objects before places): the merged object's open `conflict` / `uncertain_change`
 * tasks first, in one statement ordered by id (`lockOpenTasks`), then both geo objects ordered by id, then both place
 * rows ordered by id. Those tasks are dismissed (`context.dismissedReason` `object_ended`, M5-FIN-R1 M-6): the merged
 * object's profile stays history and is never delivered again. One immediately decided `place_candidate` task on
 * subject `place_merge` with one `review_decisions` row `{ action: "merge_place", intoPlaceId }` records who merged.
 * Never consolidates and never takes the profile lock.
 */
export async function mergePlaceInto(
  db: Db,
  input: { placeId: string; intoPlaceId: string; decidedBy: string; confirmAcrossAreas?: boolean; now?: Date },
): Promise<MergeResult> {
  if (input.placeId === input.intoPlaceId) throw new PlaceMergeNotAllowed("self", `place ${input.placeId} cannot merge into itself`);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // the geo objects as read now, unlocked: checked again under the place locks
    const { rows: read } = await tx.execute<{ id: string; geo_object_id: string }>(
      sql`select id, geo_object_id from places where id in (${input.placeId}, ${input.intoPlaceId})`,
    );
    const dropGeoObjectId = read.find((p) => p.id === input.placeId)?.geo_object_id;
    const keepGeoObjectId = read.find((p) => p.id === input.intoPlaceId)?.geo_object_id;
    if (!dropGeoObjectId) throw new PlaceMergeNotAllowed("not_valid", `place ${input.placeId} does not exist`);
    if (!keepGeoObjectId) throw new PlaceMergeNotAllowed("not_valid", `place ${input.intoPlaceId} does not exist`);
    if (keepGeoObjectId === dropGeoObjectId) throw new PlaceMergeNotAllowed("self", `places ${input.placeId} and ${input.intoPlaceId} share a geo object`);

    const tasks = [...(await lockOpenTasks(tx, dropGeoObjectId)).values()];

    const { rows: objects } = await tx.execute<{ id: string }>(sql`
      select id from geo_objects
      where id in (${dropGeoObjectId}, ${keepGeoObjectId}) and valid_to is null and merged_into_id is null
      order by id
      for update
    `);
    if (objects.length !== 2) throw new PlaceMergeNotAllowed("not_valid", `the geo objects of places ${input.placeId} and ${input.intoPlaceId} are not both valid`);

    const { rows: locked } = await tx.execute<{ id: string; geo_object_id: string; area_id: string | null }>(sql`
      select p.id, p.geo_object_id, ${placeAreaSql("p")} as area_id
      from places p
      where p.id in (${input.placeId}, ${input.intoPlaceId})
        and p.status = 'confirmed' and p.merged_into_id is null
        and p.valid_from <= current_date and (p.valid_to is null or p.valid_to > current_date)
      order by p.id
      for update of p
    `);
    const drop = locked.find((p) => p.id === input.placeId);
    const keep = locked.find((p) => p.id === input.intoPlaceId);
    if (!drop) throw new PlaceMergeNotAllowed("not_valid", `place ${input.placeId} is no valid confirmed place`);
    if (!keep) throw new PlaceMergeNotAllowed("not_valid", `place ${input.intoPlaceId} is no valid confirmed merge target`);
    if (drop.geo_object_id !== dropGeoObjectId || keep.geo_object_id !== keepGeoObjectId) {
      throw new PlaceMergeNotAllowed("not_valid", `places ${input.placeId} and ${input.intoPlaceId} changed their geo objects`);
    }
    const acrossAreas = !sameArea(drop.area_id, keep.area_id);
    if (acrossAreas && input.confirmAcrossAreas !== true) {
      throw new PlaceMergeNotAllowed("across_areas", `places ${drop.id} and ${keep.id} lie in different areas`);
    }

    const dismissedTaskIds = tasks.map((t) => t.id);
    await dismissTasks(tx, dismissedTaskIds, "object_ended");

    const [task] = await tx
      .insert(reviewTasks)
      .values({
        kind: "place_candidate",
        subjectType: "place_merge",
        subjectId: input.placeId,
        context: { intoPlaceId: keep.id, dropGeoObjectId, keepGeoObjectId: keep.geo_object_id, acrossAreas, dismissedTaskIds },
        status: "decided",
      })
      .returning({ id: reviewTasks.id });
    await tx.insert(reviewDecisions).values({
      taskId: task!.id,
      decision: { action: "merge_place", intoPlaceId: keep.id },
      decidedBy: input.decidedBy,
      decidedAt: now,
    });

    // both geo objects are locked and valid: the gazetteer merge takes their locks again and cannot find them ended
    await mergeGeoObjects(tx, keepGeoObjectId, dropGeoObjectId);
    return { keepGeoObjectId: keep.geo_object_id, dropGeoObjectId, dismissedTaskIds };
  });
}

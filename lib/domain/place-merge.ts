import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { reviewDecisions, reviewTasks, type PlaceKind } from "@/lib/db/schema";
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
    same_area: boolean;
  }>(sql`
    select p.id, ${displayNameSql(sql`p.geo_object_id`)} as name, p.kind, p.public_id,
           ST_Distance(p.position::geography, s.position::geography) as distance_m,
           ${displayNameSql(placeAreaSql("p"))} as area_name,
           ${placeAreaSql("p")} is not distinct from ${placeAreaSql("s")} as same_area
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
    sameArea: r.same_area,
  }));
}

export type MergeResult = { keepGeoObjectId: string; dropGeoObjectId: string; dismissedTaskIds: string[] };

/**
 * Merges the confirmed place `placeId` into the confirmed place `intoPlaceId` in one transaction. Refused
 * (`PlaceMergeNotAllowed`, nothing written) for the place itself or its own geo object (`self`), for a place or target
 * that is not a valid, unmerged, confirmed place (`not_valid`), and for places of two areas unless `confirmAcrossAreas`
 * (`across_areas`).
 *
 * Lock order (ruling M5-F-R4, global order of `decideReviewTask`): the merged object's open `conflict` /
 * `uncertain_change` tasks first, in one statement ordered by id, then both place rows ordered by id, then (in
 * `mergeGeoObjects`) both geo objects. Those tasks are dismissed (`context.dismissedReason` `object_ended`, M5-FIN-R1
 * M-6): the merged object's profile stays history and is never delivered again. One immediately decided
 * `place_candidate` task on subject `place_merge` with one `review_decisions` row `{ action: "merge_place", intoPlaceId }`
 * records who merged. Never consolidates and never takes the profile lock.
 */
export async function mergePlaceInto(
  db: Db,
  input: { placeId: string; intoPlaceId: string; decidedBy: string; confirmAcrossAreas?: boolean; now?: Date },
): Promise<MergeResult> {
  if (input.placeId === input.intoPlaceId) throw new PlaceMergeNotAllowed("self", `place ${input.placeId} cannot merge into itself`);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const { rows: subject } = await tx.execute<{ geo_object_id: string }>(sql`select geo_object_id from places where id = ${input.placeId}`);
    const dropGeoObjectId = subject[0]?.geo_object_id;
    if (!dropGeoObjectId) throw new PlaceMergeNotAllowed("not_valid", `place ${input.placeId} does not exist`);

    const prefix = `${dropGeoObjectId}:`;
    const { rows: tasks } = await tx.execute<{ id: string }>(sql`
      select id from review_tasks
      where kind in ('conflict', 'uncertain_change') and left(subject_id, ${prefix.length}) = ${prefix} and status = 'open'
      order by id
      for update
    `);

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
    if (drop.geo_object_id !== dropGeoObjectId) throw new PlaceMergeNotAllowed("not_valid", `place ${input.placeId} changed its geo object`);
    if (keep.geo_object_id === drop.geo_object_id) throw new PlaceMergeNotAllowed("self", `places ${drop.id} and ${keep.id} share a geo object`);
    const acrossAreas = keep.area_id === null || keep.area_id !== drop.area_id;
    if (acrossAreas && input.confirmAcrossAreas !== true) {
      throw new PlaceMergeNotAllowed("across_areas", `places ${drop.id} and ${keep.id} lie in different areas`);
    }

    const dismissedTaskIds = tasks.map((t) => t.id);
    if (dismissedTaskIds.length > 0) {
      await tx.execute(sql`
        update review_tasks set status = 'dismissed', context = context || ${JSON.stringify({ dismissedReason: "object_ended" })}::jsonb
        where id in (${sql.join(dismissedTaskIds.map((id) => sql`${id}`), sql`, `)})
      `);
    }

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

    try {
      await mergeGeoObjects(tx, keep.geo_object_id, dropGeoObjectId);
    } catch (e) {
      // an object ended or merged by another transaction since the place rows were read
      if (e instanceof Error && /is not valid$/.test(e.message)) throw new PlaceMergeNotAllowed("not_valid", e.message);
      throw e;
    }
    return { keepGeoObjectId: keep.geo_object_id, dropGeoObjectId, dismissedTaskIds };
  });
}

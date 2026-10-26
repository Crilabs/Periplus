import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { reviewDecisions, reviewTasks, type PlaceKind } from "@/lib/db/schema";
import { lockOpenPlaceTasks } from "@/lib/domain/review/task-locks";
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

export type MergeRefusal = "self" | "not_valid" | "across_subdivisions";

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
  subdivisionName: string | null;
  /** In the same subdivision (of its geo object, spec 14) as the place: a merge across subdivisions needs a confirmation. */
  sameSubdivision: boolean;
};

/**
 * Two places lie in the same subdivision when both have one (`geo_objects.subdivision_id` of their geo object, the
 * nearest land) and it is the same: a place whose object has none is in no subdivision, so a merge with it always needs
 * the confirmation (the one predicate of the dialog and of the merge).
 */
export const sameSubdivision = (a: string | null, b: string | null): boolean => a !== null && a === b;

/** The subdivision of a place: the one of its geo object (nearest land). */
const placeSubdivisionSql = (alias: string) =>
  sql.raw(`(select o.subdivision_id from geo_objects o where o.id = ${alias}.geo_object_id)`);

/** The geo object (admin region or country) of the subdivision an expression names, for its display name. */
const subdivisionObjectSql = (subdivisionId: ReturnType<typeof placeSubdivisionSql>) =>
  sql`(select sd.geo_object_id from subdivisions sd where sd.id = ${subdivisionId})`;

/** The confirmed, valid, unmerged places nearest to `placeId` (another geo object), with distance and subdivision. */
export async function mergeCandidates(db: Db, placeId: string): Promise<MergeCandidate[]> {
  const { rows } = await db.execute<{
    id: string;
    name: string | null;
    kind: PlaceKind;
    public_id: string | null;
    distance_m: number;
    subdivision_name: string | null;
    subdivision_id: string | null;
    subject_subdivision_id: string | null;
  }>(sql`
    select p.id, ${displayNameSql(sql`p.geo_object_id`)} as name, p.kind, p.public_id,
           ST_Distance(p.position::geography, s.position::geography) as distance_m,
           ${displayNameSql(subdivisionObjectSql(placeSubdivisionSql("p")))} as subdivision_name,
           ${placeSubdivisionSql("p")} as subdivision_id, ${placeSubdivisionSql("s")} as subject_subdivision_id
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
    subdivisionName: r.subdivision_name,
    sameSubdivision: sameSubdivision(r.subdivision_id, r.subject_subdivision_id),
  }));
}

export type MergeResult = { keepGeoObjectId: string; dropGeoObjectId: string; dismissedTaskIds: string[] };

/**
 * Merges the confirmed place `placeId` into the confirmed place `intoPlaceId` in one transaction. Refused
 * (`PlaceMergeNotAllowed`, nothing written) for the place itself or its own geo object (`self`), for a place or target
 * that is not a valid, unmerged, confirmed place (`not_valid`), and for places of two subdivisions unless `confirmAcrossSubdivisions`
 * (`across_subdivisions`).
 *
 * Lock order (ruling M5-F-R4, global order of `decideReviewTask`; the gazetteer merge `mergeGeoObjects` and the
 * review decision `same` lock geo objects before places): the open tasks on the merged place itself
 * (`lockOpenPlaceTasks`) first, then both geo objects ordered by id, then both place rows ordered by id. Those tasks are
 * dismissed by `mergeGeoObjects` (`context.dismissedReason` `object_ended`, M5-FIN-R1 M-6). One immediately decided `place_candidate` task on
 * subject `place_merge` with one `review_decisions` row `{ action: "merge_place", intoPlaceId }` records who merged.
 */
export async function mergePlaceInto(
  db: Db,
  input: { placeId: string; intoPlaceId: string; decidedBy: string; confirmAcrossSubdivisions?: boolean; now?: Date },
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

    // the drop place's own open tasks (e.g. a restricted-area review): dismissed by mergeGeoObjects below (UI-5)
    const placeTaskIds = await lockOpenPlaceTasks(tx, input.placeId);

    const { rows: objects } = await tx.execute<{ id: string }>(sql`
      select id from geo_objects
      where id in (${dropGeoObjectId}, ${keepGeoObjectId}) and valid_to is null and merged_into_id is null
      order by id
      for update
    `);
    if (objects.length !== 2) throw new PlaceMergeNotAllowed("not_valid", `the geo objects of places ${input.placeId} and ${input.intoPlaceId} are not both valid`);

    const { rows: locked } = await tx.execute<{ id: string; geo_object_id: string; subdivision_id: string | null }>(sql`
      select p.id, p.geo_object_id, ${placeSubdivisionSql("p")} as subdivision_id
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
    const acrossSubdivisions = !sameSubdivision(drop.subdivision_id, keep.subdivision_id);
    if (acrossSubdivisions && input.confirmAcrossSubdivisions !== true) {
      throw new PlaceMergeNotAllowed("across_subdivisions", `places ${drop.id} and ${keep.id} lie in different subdivisions`);
    }

    const dismissedTaskIds = placeTaskIds;

    const [task] = await tx
      .insert(reviewTasks)
      .values({
        kind: "place_candidate",
        subjectType: "place_merge",
        subjectId: input.placeId,
        context: { intoPlaceId: keep.id, dropGeoObjectId, keepGeoObjectId: keep.geo_object_id, acrossSubdivisions, dismissedTaskIds },
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

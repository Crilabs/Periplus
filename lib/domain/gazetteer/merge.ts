import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getConfig, type GazetteerConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, places, reviewTasks, type GeoObjectType, type GeoOrigin } from "@/lib/db/schema";
import { dismissTasks, lockOpenPlaceTasks } from "@/lib/domain/consolidation/task-locks";
import { levelFor } from "@/lib/domain/facts/levels";
import { dropHighlightSelectionsOf } from "@/lib/domain/highlights/selections";
import { createReviewTask, hasDecidedTask } from "@/lib/domain/review";
import { decideReviewTask, TaskNotOpen } from "@/lib/domain/review-decisions";
import { addNames, ensureFallbackNames, isGreek, normalizeName, transliterateElot743 } from "./names";

/** An object from another source; `names` raw, normalized internally. */
export type MatchInput = { type: GeoObjectType; point: { lon: number; lat: number }; names: string[] };

export type Match =
  | { kind: "same"; id: string; similarity: number; distanceM: number }
  | { kind: "uncertain"; id: string; similarity: number; distanceM: number }
  | { kind: "none" };

type MergeRules = GazetteerConfig["merge"];
type Found = Exclude<Match, { kind: "none" }>;

export const ISLAND_GROUP: GeoObjectType[] = ["island", "islet"];

/** The types an object of `type` may match: `island`/`islet` together, every other type only itself. */
export function typeGroup(type: GeoObjectType): GeoObjectType[] {
  return ISLAND_GROUP.includes(type) ? ISLAND_GROUP : [type];
}

/** Metres per degree of latitude, rounded down so the bounding box never cuts off a candidate. */
const MIN_M_PER_DEG = 110_000;

/** Normalized input names plus the normalized ELOT 743 transliteration of Greek ones, without empties. */
function searchKeys(names: string[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    keys.add(normalizeName(name));
    if (isGreek(name)) keys.add(normalizeName(transliterateElot743(name)));
  }
  keys.delete("");
  return [...keys];
}

/**
 * Looks for a valid, unmerged object of the same type group (`island`/`islet` together, else the same
 * type) that is the input object. Distance `d` = `opts.distanceM`, else `rules.distanceM[type]`, else the
 * default. "Within distance" means `≤ d` between the input point and the candidate's centroid; for an
 * island/islet candidate with an area geometry it means the point lies in the polygon (its distance is then
 * measured to the polygon). Similarity = the highest pg_trgm similarity over all valid names of the candidate
 * and all input names (with transliterations). `same`: similarity `≥ trigramMin` and within distance;
 * `uncertain`: (`≥ trigramMin` and `≤ d × uncertainDistanceFactor`) or (`≥ uncertainTrigramMin` and within
 * distance). Of several candidates `same` wins over `uncertain`, then the higher similarity, then the
 * smaller distance. With `opts.excludeGeonamesOnly`, objects known only from GeoNames (origin `geonames`, no
 * OSM or Wikidata ID) are no candidates.
 */
export async function findMatch(
  db: Db,
  input: MatchInput,
  rules: MergeRules,
  opts?: { distanceM?: number; excludeGeonamesOnly?: boolean },
): Promise<Match> {
  const keys = searchKeys(input.names);
  if (keys.length === 0) return { kind: "none" };
  const d = opts?.distanceM ?? rules.distanceM[input.type] ?? rules.distanceM.default;
  const maxM = d * rules.uncertainDistanceFactor;
  const islandGroup = ISLAND_GROUP.includes(input.type);
  const types = typeGroup(input.type);
  const excludeGeonamesOnly = opts?.excludeGeonamesOnly
    ? sql`and not (o.origin = 'geonames' and o.osm_id is null and o.wikidata_id is null)`
    : sql``;
  const { lon, lat } = input.point;
  const dLat = maxM / MIN_M_PER_DEG;
  const dLon = maxM / (MIN_M_PER_DEG * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const keyArray = sql`array[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;

  const { rows } = await db.execute<{ id: string; similarity: number; distance_m: number; within: boolean }>(sql`
    with p as (select ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326) as g)
    select c.id, c.similarity, c.distance_m, c.within
    from (
      select o.id,
             (select max(similarity(n.name_normalized, k))
              from geo_names n, unnest(${keyArray}) k
              where n.geo_object_id = o.id and n.valid_to is null) as similarity,
             x.distance_m,
             case when x.polygon then ST_Covers(o.geom, p.g) else x.distance_m <= ${d} end as within
      from geo_objects o
      cross join p
      cross join lateral (select ${islandGroup} and ST_Dimension(o.geom) = 2 as polygon) poly
      cross join lateral (
        select poly.polygon,
               case when poly.polygon then ST_Distance(o.geom::geography, p.g::geography)
                    else ST_Distance(o.centroid::geography, p.g::geography) end as distance_m
      ) x
      where o.valid_to is null and o.merged_into_id is null and o.type in ${types}
        and o.geom && ST_Expand(p.g, ${dLon}, ${dLat}) ${excludeGeonamesOnly}
    ) c
    where c.distance_m <= ${maxM} and c.similarity >= ${rules.uncertainTrigramMin}
  `);

  let best: Found | undefined;
  for (const row of rows) {
    const similarity = Number(row.similarity);
    const distanceM = Number(row.distance_m);
    const strong = similarity >= rules.trigramMin;
    const kind: Found["kind"] | undefined =
      strong && row.within ? "same" : (strong && distanceM <= maxM) || row.within ? "uncertain" : undefined;
    if (!kind) continue;
    const candidate: Found = { kind, id: row.id, similarity, distanceM };
    if (!best || better(candidate, best)) best = candidate;
  }
  return best ?? { kind: "none" };
}

function better(a: Found, b: Found): boolean {
  if (a.kind !== b.kind) return a.kind === "same";
  if (a.similarity !== b.similarity) return a.similarity > b.similarity;
  return a.distanceM < b.distanceM;
}

/** Who decides an automatically decided pair (`review_decisions.decided_by`). */
export const AUTO_DECIDER = "system";

/**
 * The decision the sources make clear for an uncertain pair, or null when a person decides. OSM is the master for
 * every type but anchorages (spec 12 addendum): an OSM object and an object known only from Wikidata or GeoNames are
 * `same` (the OSM object keeps, the other adds its names and IDs); two objects without OSM are `same` from
 * `rules.trigramMin` name similarity on, else `distinct`. A person decides a pair of two OSM objects, a pair one of
 * whose objects carries a place (anchorage, harbour), and a highlight pair (source `computed`, spec 16).
 */
export async function autoPairDecision(
  db: Db,
  geoObjectIds: string[],
  context: { similarity: number; source: GeoOrigin },
  rules: MergeRules,
): Promise<"same" | "distinct" | null> {
  if (!rules.autoDecidePairs || context.source === "computed") return null;
  const objects = await db
    .select({ osmId: geoObjects.osmId, placeId: places.id })
    .from(geoObjects)
    .leftJoin(places, eq(places.geoObjectId, geoObjects.id))
    .where(and(inArray(geoObjects.id, geoObjectIds), isNull(geoObjects.validTo), isNull(geoObjects.mergedIntoId)));
  if (objects.length !== 2 || objects.some((o) => o.placeId !== null)) return null;
  const osm = objects.filter((o) => o.osmId !== null).length;
  if (osm === 2) return null;
  if (osm === 1) return "same";
  return context.similarity >= rules.trigramMin ? "same" : "distinct";
}

/**
 * Opens a `place_candidate` review task for an uncertain pair of geo objects (`subjectType
 * "geo_object_pair"`, `subjectId "<smaller id>:<larger id>"`), unless one is open already or a task for the
 * pair was ever decided (e.g. "distinct"). When `autoPairDecision` knows the answer, the task is decided at once by
 * `AUTO_DECIDER` (a `same` merges the pair); returns that decision, else null.
 */
export async function openPairTask(
  db: Db,
  a: string,
  b: string,
  context: { similarity: number; distanceM: number; source: GeoOrigin },
): Promise<"same" | "distinct" | null> {
  const geoObjectIds = [a, b].sort();
  const subjectId = geoObjectIds.join(":");
  if (await hasDecidedTask(db, "place_candidate", subjectId)) return null;
  const task = await createReviewTask(db, {
    kind: "place_candidate",
    subjectType: "geo_object_pair",
    subjectId,
    context: { ...context, geoObjectIds },
  });
  const action = await autoPairDecision(db, geoObjectIds, context, getConfig().gazetteer.merge);
  if (!action) return null;
  await decideReviewTask(db, { taskId: task.id, decision: { action }, decidedBy: AUTO_DECIDER });
  return action;
}

/**
 * Decides every open pair task that `autoPairDecision` knows the answer to (by `AUTO_DECIDER`, oldest first, one
 * transaction per task), for pair tasks opened before the rule existed. A task one of whose objects ended meanwhile
 * (merged by an earlier decision of the same pass) is dismissed (`object_ended`). Returns the counts and the objects
 * that kept a merged object and take facts (to consolidate: the merged object may have brought facts).
 */
export async function autoDecideOpenPairTasks(
  db: Db,
  rules: MergeRules,
): Promise<{ same: number; distinct: number; dismissed: number; open: number; kept: string[] }> {
  const tasks = await db
    .select({ id: reviewTasks.id, subjectId: reviewTasks.subjectId, context: reviewTasks.context })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.subjectType, "geo_object_pair"), eq(reviewTasks.status, "open")))
    .orderBy(reviewTasks.createdAt, reviewTasks.id);
  const result = { same: 0, distinct: 0, dismissed: 0, open: 0, kept: [] as string[] };
  for (const task of tasks) {
    const ids = task.subjectId.split(":");
    const context = task.context as { similarity?: unknown; source?: unknown };
    const valid = await db
      .select({ id: geoObjects.id })
      .from(geoObjects)
      .where(and(inArray(geoObjects.id, ids), isNull(geoObjects.validTo), isNull(geoObjects.mergedIntoId)));
    if (valid.length !== 2) {
      const dismissed = await db.transaction(async (tx) => {
        const [open] = await tx
          .select({ id: reviewTasks.id })
          .from(reviewTasks)
          .where(and(eq(reviewTasks.id, task.id), eq(reviewTasks.status, "open")))
          .for("update");
        if (open) await dismissTasks(tx, [open.id], "object_ended");
        return open !== undefined;
      });
      if (dismissed) result.dismissed++;
      continue;
    }
    const action = await autoPairDecision(
      db,
      ids,
      { similarity: Number(context.similarity ?? 0), source: context.source as GeoOrigin },
      rules,
    );
    if (!action) {
      result.open++;
      continue;
    }
    let consolidate: { geoObjectId: string } | null;
    try {
      ({ consolidate } = await decideReviewTask(db, { taskId: task.id, decision: { action }, decidedBy: AUTO_DECIDER }));
    } catch (e) {
      // a person decided it meanwhile
      if (e instanceof TaskNotOpen) continue;
      throw e;
    }
    result[action]++;
    if (consolidate && (await levelFor(db, consolidate.geoObjectId)) !== null) result.kept.push(consolidate.geoObjectId);
  }
  result.kept = [...new Set(result.kept)];
  return result;
}

/** External ID columns of `geo_objects` that `resolveMergedByExternalId` follows. */
export type ExternalIdColumn = "wikidata_id" | "geonames_id" | "osm_id";

const EXTERNAL_ID_COLUMNS = {
  wikidata_id: geoObjects.wikidataId,
  geonames_id: geoObjects.geonamesId,
  osm_id: geoObjects.osmId,
} as const;

/** Upper bound on merge-chain hops, against a corrupt cycle. */
const MAX_MERGE_HOPS = 100;

/**
 * The surviving valid object for an external ID that is only carried by objects merged away: starts at
 * the ended objects with `column = value` and `merged_into_id` set and follows `merged_into_id` to an
 * object that is valid and unmerged. Null when there is none (also for an ID on a valid object or on an
 * object ended without merge). Of several survivors the lowest id wins.
 */
export async function resolveMergedByExternalId(
  db: Db,
  column: ExternalIdColumn,
  value: string,
): Promise<string | null> {
  const col = EXTERNAL_ID_COLUMNS[column];
  const { rows } = await db.execute<{ id: string }>(sql`
    with recursive chain(id, merged_into_id, valid_to, hops) as (
      select id, merged_into_id, valid_to, 0
      from geo_objects
      where ${col} = ${value} and valid_to is not null and merged_into_id is not null
      union
      select o.id, o.merged_into_id, o.valid_to, c.hops + 1
      from chain c join geo_objects o on o.id = c.merged_into_id
      where c.hops < ${MAX_MERGE_HOPS}
    )
    select id from chain where valid_to is null and merged_into_id is null order by id limit 1
  `);
  return rows[0]?.id ?? null;
}

/**
 * Merges `drop` into `keep` in one transaction: the valid names of `drop` become new rows on `keep`
 * (transliterations and fallbacks are regenerated, not copied) and are ended on `drop`; external IDs
 * missing on `keep` are taken over; children of `drop` move to `keep` (a `keep` below `drop` takes over its parent); `drop` ends with
 * `merged_into_id = keep`. Places: when both have one, the place of `drop` is rejected and merged into
 * that of `keep`, and a `no_anchoring` drop place makes a candidate or confirmed keep place `no_anchoring` with the
 * drop's `status_reason` (the stricter status wins, GR-4), and the open tasks on the drop place are dismissed
 * (`object_ended`, UI-5); when only `drop` has one, it moves to `keep`. Throws for `keep == drop` and for objects
 * that are not valid (ended or merged).
 */
export async function mergeGeoObjects(db: Db, keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) throw new Error(`cannot merge geo object ${keepId} into itself`);
  await db.transaction(async (tx) => {
    // Lock order (M5-F-R4): the open tasks on drop's place before the geo objects and places (read unlocked here,
    // checked again below).
    const [dropPlaceRead] = await tx.select({ id: places.id }).from(places).where(eq(places.geoObjectId, dropId));
    if (dropPlaceRead) await lockOpenPlaceTasks(tx, dropPlaceRead.id);
    const objects = await tx
      .select({
        id: geoObjects.id,
        osmId: geoObjects.osmId,
        wikidataId: geoObjects.wikidataId,
        geonamesId: geoObjects.geonamesId,
        parentId: geoObjects.parentId,
      })
      .from(geoObjects)
      .where(
        and(inArray(geoObjects.id, [keepId, dropId]), isNull(geoObjects.validTo), isNull(geoObjects.mergedIntoId)),
      )
      .orderBy(geoObjects.id)
      .for("update");
    const keep = objects.find((o) => o.id === keepId);
    const drop = objects.find((o) => o.id === dropId);
    if (!keep) throw new Error(`geo object ${keepId} is not valid`);
    if (!drop) throw new Error(`geo object ${dropId} is not valid`);

    const dropNames = await tx
      .update(geoNames)
      .set({ validTo: sql`current_date` })
      .where(and(eq(geoNames.geoObjectId, dropId), isNull(geoNames.validTo)))
      .returning({
        name: geoNames.name,
        language: geoNames.language,
        origin: geoNames.origin,
        isPreferred: geoNames.isPreferred,
      });

    // End drop first: the external IDs are unique among valid objects.
    await tx
      .update(geoObjects)
      .set({ mergedIntoId: keepId, validTo: sql`current_date`, updatedAt: sql`now()` })
      .where(eq(geoObjects.id, dropId));
    // the dropped object neither selects nor is a highlight any more (spec 16)
    await dropHighlightSelectionsOf(tx, dropId);
    const takeOver = {
      ...(keep.osmId === null && drop.osmId !== null ? { osmId: drop.osmId } : {}),
      ...(keep.wikidataId === null && drop.wikidataId !== null ? { wikidataId: drop.wikidataId } : {}),
      ...(keep.geonamesId === null && drop.geonamesId !== null ? { geonamesId: drop.geonamesId } : {}),
    };
    if (Object.keys(takeOver).length > 0) {
      await tx
        .update(geoObjects)
        .set({ ...takeOver, updatedAt: sql`now()` })
        .where(eq(geoObjects.id, keepId));
    }

    await addNames(
      tx,
      keepId,
      dropNames
        .filter((n) => n.origin !== "transliteration" && n.origin !== "fallback")
        .map((n) => ({ name: n.name, language: n.language, origin: n.origin, isPreferred: n.isPreferred })),
    );
    await ensureFallbackNames(tx, [keepId]);

    await tx
      .update(geoObjects)
      .set({ parentId: keepId, updatedAt: sql`now()` })
      .where(and(eq(geoObjects.parentId, dropId), ne(geoObjects.id, keepId)));
    // keep was a child of drop: it takes drop's place in the hierarchy.
    if (keep.parentId === dropId) {
      await tx
        .update(geoObjects)
        .set({ parentId: drop.parentId, updatedAt: sql`now()` })
        .where(eq(geoObjects.id, keepId));
    }

    const placeOf = (geoObjectId: string) =>
      tx.select({ id: places.id, status: places.status, statusReason: places.statusReason }).from(places).where(eq(places.geoObjectId, geoObjectId));
    const [keepPlace] = await placeOf(keepId);
    const [dropPlace] = await placeOf(dropId);
    if (dropPlace && keepPlace) {
      // its open place tasks can no longer be decided (a merged place refuses every decision): dismissed like the
      // place merge does (UI-5); already locked above unless the place moved meanwhile
      await dismissTasks(tx, await lockOpenPlaceTasks(tx, dropPlace.id), "object_ended");
      await tx
        .update(places)
        .set({ status: "rejected", statusReason: "merged", mergedIntoId: keepPlace.id, updatedAt: sql`now()` })
        .where(eq(places.id, dropPlace.id));
      // the stricter status wins (GR-4): an exclusion of the merged place is never lost to a candidate or confirmed survivor
      if (dropPlace.status === "no_anchoring" && (keepPlace.status === "candidate" || keepPlace.status === "confirmed")) {
        await tx
          .update(places)
          .set({ status: "no_anchoring", statusReason: dropPlace.statusReason ?? "merged", updatedAt: sql`now()` })
          .where(eq(places.id, keepPlace.id));
      }
    } else if (dropPlace) {
      await tx
        .update(places)
        .set({ geoObjectId: keepId, updatedAt: sql`now()` })
        .where(eq(places.id, dropPlace.id));
    }
  });
}

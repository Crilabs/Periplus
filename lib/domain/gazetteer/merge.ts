import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { GazetteerConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, places, type GeoObjectType, type GeoOrigin } from "@/lib/db/schema";
import { createReviewTask, hasDecidedTask } from "@/lib/domain/review";
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
 * smaller distance.
 */
export async function findMatch(
  db: Db,
  input: MatchInput,
  rules: MergeRules,
  opts?: { distanceM?: number },
): Promise<Match> {
  const keys = searchKeys(input.names);
  if (keys.length === 0) return { kind: "none" };
  const d = opts?.distanceM ?? rules.distanceM[input.type] ?? rules.distanceM.default;
  const maxM = d * rules.uncertainDistanceFactor;
  const islandGroup = ISLAND_GROUP.includes(input.type);
  const types = islandGroup ? ISLAND_GROUP : [input.type];
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
        and o.geom && ST_Expand(p.g, ${dLon}, ${dLat})
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

/**
 * Opens a `place_candidate` review task for an uncertain pair of geo objects (`subjectType
 * "geo_object_pair"`, `subjectId "<smaller id>:<larger id>"`), unless one is open already or a task for the
 * pair was ever decided (e.g. "distinct").
 */
export async function openPairTask(
  db: Db,
  a: string,
  b: string,
  context: { similarity: number; distanceM: number; source: GeoOrigin },
): Promise<void> {
  const geoObjectIds = [a, b].sort();
  const subjectId = geoObjectIds.join(":");
  if (await hasDecidedTask(db, "place_candidate", subjectId)) return;
  await createReviewTask(db, {
    kind: "place_candidate",
    subjectType: "geo_object_pair",
    subjectId,
    context: { ...context, geoObjectIds },
  });
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
 * that of `keep`; when only `drop` has one, it moves to `keep`. Throws for `keep == drop` and for objects
 * that are not valid (ended or merged).
 */
export async function mergeGeoObjects(db: Db, keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) throw new Error(`cannot merge geo object ${keepId} into itself`);
  await db.transaction(async (tx) => {
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

    const [keepPlace] = await tx.select({ id: places.id }).from(places).where(eq(places.geoObjectId, keepId));
    const [dropPlace] = await tx.select({ id: places.id }).from(places).where(eq(places.geoObjectId, dropId));
    if (dropPlace && keepPlace) {
      await tx
        .update(places)
        .set({ status: "rejected", statusReason: "merged", mergedIntoId: keepPlace.id, updatedAt: sql`now()` })
        .where(eq(places.id, dropPlace.id));
    } else if (dropPlace) {
      await tx
        .update(places)
        .set({ geoObjectId: keepId, updatedAt: sql`now()` })
        .where(eq(places.id, dropPlace.id));
    }
  });
}

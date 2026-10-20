import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { comparisonSet, geoObjects, places, tiles, type PlaceKind } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { validAt } from "@/lib/domain/timeline";

export type ComparisonCandidate = {
  placeId: string;
  name: string | null;
  kind: PlaceKind;
  tileId: string | null;
  inSet: boolean;
};

/** The valid area object of a configured area; null until a gazetteer run has created it. */
async function findAreaId(db: Db, areaKey: string): Promise<string | null> {
  const [area] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.type, "area"), eq(geoObjects.configKey, areaKey), validAt(geoObjects)));
  return area?.id ?? null;
}

async function areaIdFor(db: Db, areaKey: string): Promise<string> {
  const areaId = await findAreaId(db, areaKey);
  if (!areaId) throw new Error(`Unknown area ${areaKey}`);
  return areaId;
}

export type ComparisonOverview = { candidates: ComparisonCandidate[]; size: number };

/**
 * Candidates and set size of an area for the quality page; null when the area object does not exist yet
 * (configured, but no gazetteer run so far), so the page can say so instead of failing.
 */
export async function comparisonOverview(db: Db, areaKey: string): Promise<ComparisonOverview | null> {
  if (!(await findAreaId(db, areaKey))) return null;
  return { candidates: await listComparisonCandidates(db, areaKey), size: await comparisonSetSize(db, areaKey) };
}

/** Confirmed, valid places in tiles labelled with the area, by tile and name. */
export async function listComparisonCandidates(db: Db, areaKey: string): Promise<ComparisonCandidate[]> {
  const areaId = await areaIdFor(db, areaKey);
  const name = displayNameSql(places.geoObjectId);
  const rows = await db
    .select({
      placeId: places.id,
      name,
      kind: places.kind,
      tileId: places.tileId,
      inSet: sql<boolean>`${comparisonSet.placeId} is not null`,
    })
    .from(places)
    .innerJoin(tiles, eq(tiles.id, places.tileId))
    .leftJoin(comparisonSet, and(eq(comparisonSet.placeId, places.id), eq(comparisonSet.areaId, areaId)))
    .where(and(eq(tiles.areaId, areaId), eq(places.status, "confirmed"), validAt(places)))
    .orderBy(places.tileId, name, places.id);
  return rows;
}

/** Adds a confirmed place of the area to the set; adding it again is a no-op. */
export async function addToComparisonSet(db: Db, placeId: string, areaKey: string, by: string): Promise<void> {
  const areaId = await areaIdFor(db, areaKey);
  const [eligible] = await db
    .select({ id: places.id })
    .from(places)
    .innerJoin(tiles, eq(tiles.id, places.tileId))
    .where(and(eq(places.id, placeId), eq(places.status, "confirmed"), validAt(places), eq(tiles.areaId, areaId)));
  if (!eligible) throw new Error(`Place ${placeId} is not a confirmed place of area ${areaKey}`);
  await db.insert(comparisonSet).values({ placeId, areaId, addedBy: by }).onConflictDoNothing();
}

export async function removeFromComparisonSet(db: Db, placeId: string): Promise<void> {
  await db.delete(comparisonSet).where(eq(comparisonSet.placeId, placeId));
}

export async function comparisonSetSize(db: Db, areaKey: string): Promise<number> {
  const areaId = await areaIdFor(db, areaKey);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(comparisonSet)
    .where(eq(comparisonSet.areaId, areaId));
  return row!.n;
}

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { comparisonSet, geoObjects, places, type PlaceKind } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { requireSubdivision, subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { validAt } from "@/lib/domain/timeline";

export type ComparisonCandidate = {
  placeId: string;
  name: string | null;
  kind: PlaceKind;
  tileId: string | null;
  inSet: boolean;
};

/** The id of the valid subdivision `key`; refuses an unknown, excluded or area key (`requireSubdivision`). */
async function subdivisionIdFor(db: Db, subdivisionKey: string): Promise<string> {
  return (await requireSubdivision(db, subdivisionKey)).id;
}

export type ComparisonOverview = { candidates: ComparisonCandidate[]; size: number };

/**
 * Candidates and set size of a subdivision for the quality page; null when there is no such valid subdivision, so the
 * page can say so instead of failing.
 */
export async function comparisonOverview(db: Db, subdivisionKey: string): Promise<ComparisonOverview | null> {
  if (!(await subdivisionByKey(db, subdivisionKey))) return null;
  return { candidates: await listComparisonCandidates(db, subdivisionKey), size: await comparisonSetSize(db, subdivisionKey) };
}

/**
 * Confirmed, valid places of the subdivision (`geo_objects.subdivision_id`, nearest land, not the tile label), by tile
 * and name.
 */
export async function listComparisonCandidates(db: Db, subdivisionKey: string): Promise<ComparisonCandidate[]> {
  const subdivisionId = await subdivisionIdFor(db, subdivisionKey);
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
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .leftJoin(comparisonSet, and(eq(comparisonSet.placeId, places.id), eq(comparisonSet.subdivisionId, subdivisionId)))
    .where(and(eq(geoObjects.subdivisionId, subdivisionId), eq(places.status, "confirmed"), validAt(places)))
    .orderBy(places.tileId, name, places.id);
  return rows;
}

/** Adds a confirmed place of the subdivision to the set; adding it again is a no-op. */
export async function addToComparisonSet(db: Db, placeId: string, subdivisionKey: string, by: string): Promise<void> {
  const subdivisionId = await subdivisionIdFor(db, subdivisionKey);
  const [eligible] = await db
    .select({ id: places.id })
    .from(places)
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .where(and(eq(places.id, placeId), eq(places.status, "confirmed"), validAt(places), eq(geoObjects.subdivisionId, subdivisionId)));
  if (!eligible) throw new Error(`Place ${placeId} is not a confirmed place of subdivision ${subdivisionKey}`);
  await db.insert(comparisonSet).values({ placeId, subdivisionId, addedBy: by }).onConflictDoNothing();
}

export async function removeFromComparisonSet(db: Db, placeId: string): Promise<void> {
  await db.delete(comparisonSet).where(eq(comparisonSet.placeId, placeId));
}

/**
 * Saves the comparison set selection of a list (UI-11: one save for every ticked box): of the places `shown`, those in
 * `included` join the set of subdivision `subdivisionKey` and the others leave it, in one transaction. Throws (nothing saved) when an
 * included place is no confirmed place of the subdivision, or is not among `shown`.
 */
export async function saveComparisonSelection(
  db: Db,
  input: { subdivisionKey: string; shown: string[]; included: string[]; by: string },
): Promise<void> {
  const shown = new Set(input.shown);
  const stray = input.included.find((id) => !shown.has(id));
  if (stray) throw new Error(`Place ${stray} was not shown`);
  const included = new Set(input.included);
  await db.transaction(async (tx) => {
    for (const placeId of [...shown].sort()) {
      if (included.has(placeId)) await addToComparisonSet(tx, placeId, input.subdivisionKey, input.by);
      else await removeFromComparisonSet(tx, placeId);
    }
  });
}

export async function comparisonSetSize(db: Db, subdivisionKey: string): Promise<number> {
  const subdivisionId = await subdivisionIdFor(db, subdivisionKey);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(comparisonSet)
    .where(eq(comparisonSet.subdivisionId, subdivisionId));
  return row!.n;
}

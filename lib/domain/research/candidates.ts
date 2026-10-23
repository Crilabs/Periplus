import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, subdivisions } from "@/lib/db/schema";

/**
 * The places that are researched (spec 5.2): valid, not merged, status `candidate` or `confirmed` (`no_anchoring`
 * and `rejected` are not). Either all of a subdivision (by key) or the given ids; sorted by id.
 */
export async function researchCandidates(
  db: Db,
  scope: { subdivisionKey: string } | { placeIds: string[] },
): Promise<string[]> {
  const base = and(isNull(places.mergedIntoId), isNull(places.validTo), inArray(places.status, ["candidate", "confirmed"]));
  if ("placeIds" in scope) {
    if (scope.placeIds.length === 0) return [];
    const rows = await db
      .select({ id: places.id })
      .from(places)
      .where(and(base, inArray(places.id, scope.placeIds)))
      .orderBy(asc(places.id));
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: places.id })
    .from(places)
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .innerJoin(subdivisions, eq(subdivisions.id, geoObjects.subdivisionId))
    .where(and(base, eq(subdivisions.key, scope.subdivisionKey), isNull(subdivisions.validTo)))
    .orderBy(asc(places.id));
  return rows.map((r) => r.id);
}

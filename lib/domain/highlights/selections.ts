import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { highlightSelections, type PoiCategory } from "@/lib/db/schema";
import type { CategorySelection, HighlightLevel } from "./select";

/*
 * `highlight_selections` (spec 16): the working-state copy of a place profile's `derived.highlights`, one row per
 * selected POI, so delivery and the highlights stage find the selected POIs without reading every place profile.
 */

/** The profile attribute `derived.highlights`: per category the selected ids in rank order and the level. */
export type HighlightsValue = Partial<Record<PoiCategory, { ids: string[]; level: HighlightLevel }>>;

/**
 * Replaces the selection rows of the place with those of its profile `version`: `value` is its `derived.highlights`
 * (undefined: none), `selections` the `CategorySelection`s of the provenance (`derivedFrom`) the distances come from.
 */
export async function replaceHighlightSelections(
  tx: Db,
  placeGeoObjectId: string,
  version: number,
  value: HighlightsValue | undefined,
  selections: Partial<Record<PoiCategory, CategorySelection>> | undefined,
): Promise<void> {
  await deleteHighlightSelections(tx, placeGeoObjectId);
  const rows = Object.entries(value ?? {}).flatMap(([category, sel]) => {
    const distance = new Map((selections?.[category as PoiCategory]?.candidates ?? []).map((c) => [c.geoObjectId, c.distanceKm]));
    return (sel?.ids ?? []).map((poiGeoObjectId, i) => {
      const distanceKm = distance.get(poiGeoObjectId);
      if (distanceKm === undefined) throw new Error(`highlight ${poiGeoObjectId} of ${placeGeoObjectId} has no candidate distance`);
      return { placeGeoObjectId, poiGeoObjectId, category: category as PoiCategory, rank: i + 1, distanceKm, profileVersion: version };
    });
  });
  if (rows.length > 0) await tx.insert(highlightSelections).values(rows);
}

/** Deletes the selection rows of the place (it ended, was merged or rejected). */
export async function deleteHighlightSelections(tx: Db, placeGeoObjectId: string): Promise<void> {
  await tx.delete(highlightSelections).where(eq(highlightSelections.placeGeoObjectId, placeGeoObjectId));
}

/** The POIs the given places selected, sorted, without duplicates. */
export async function selectedPoiIds(db: Db, placeGeoObjectIds: string[]): Promise<string[]> {
  if (placeGeoObjectIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: highlightSelections.poiGeoObjectId })
    .from(highlightSelections)
    .where(inArray(highlightSelections.placeGeoObjectId, placeGeoObjectIds));
  return rows.map((r) => r.id).sort();
}

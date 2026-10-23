import { eq, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { validAtAlias } from "@/lib/domain/timeline";
import { highlightSelections, type HighlightCategory } from "@/lib/db/schema";
import type { CategorySelection, HighlightLevel } from "./select";

/*
 * `highlight_selections` (spec 16): the working-state copy of a place profile's `derived.highlights`, one row per
 * selected POI, so delivery and the highlights stage find the selected POIs without reading every place profile.
 */

/** The profile attribute `derived.highlights`: per category the selected ids in rank order and the level. */
export type HighlightsValue = Partial<Record<HighlightCategory, { ids: string[]; level: HighlightLevel }>>;

/**
 * Replaces the selection rows of the place with those of its profile `version`: `value` is its `derived.highlights`
 * (undefined: none), `selections` the `CategorySelection`s of the provenance (`derivedFrom`) the distances come from.
 */
export async function replaceHighlightSelections(
  tx: Db,
  placeGeoObjectId: string,
  version: number,
  value: HighlightsValue | undefined,
  selections: Partial<Record<HighlightCategory, CategorySelection>> | undefined,
): Promise<void> {
  await deleteHighlightSelections(tx, placeGeoObjectId);
  const rows = Object.entries(value ?? {}).flatMap(([category, sel]) => {
    const distance = new Map((selections?.[category as HighlightCategory]?.candidates ?? []).map((c) => [c.geoObjectId, c.distanceKm]));
    return (sel?.ids ?? []).map((poiGeoObjectId, i) => {
      const distanceKm = distance.get(poiGeoObjectId);
      if (distanceKm === undefined) throw new Error(`highlight ${poiGeoObjectId} of ${placeGeoObjectId} has no candidate distance`);
      return { placeGeoObjectId, poiGeoObjectId, category: category as HighlightCategory, rank: i + 1, distanceKm, profileVersion: version };
    });
  });
  if (rows.length > 0) await tx.insert(highlightSelections).values(rows);
}

/** Deletes the selection rows of the place (it ended, was merged or rejected). */
export async function deleteHighlightSelections(tx: Db, placeGeoObjectId: string): Promise<void> {
  await tx.delete(highlightSelections).where(eq(highlightSelections.placeGeoObjectId, placeGeoObjectId));
}

/**
 * Deletes every row of a geo object that ends as a whole (a gazetteer merge drops it): as the selecting place and as
 * a selected POI. The surviving object's places select again at their next consolidation.
 */
export async function dropHighlightSelectionsOf(tx: Db, geoObjectId: string): Promise<void> {
  await tx
    .delete(highlightSelections)
    .where(or(eq(highlightSelections.placeGeoObjectId, geoObjectId), eq(highlightSelections.poiGeoObjectId, geoObjectId)));
}

/**
 * The selection rows (alias `hs`) that count: of a valid, unmerged, not rejected place on a valid, unmerged geo object
 * (alias `po`), selecting a valid, unmerged POI (alias `o`), validity on `date` (default the database date). Safety net
 * beside the deletes on merge, rejection and end. The delivery reads them on its build date.
 */
export function countingSelectionsAt(date?: string): SQL {
  return sql`
  highlight_selections hs
  join geo_objects po on po.id = hs.place_geo_object_id and po.merged_into_id is null and ${validAtAlias("po", date)}
  join places pl on pl.geo_object_id = po.id and pl.merged_into_id is null and pl.status <> 'rejected' and ${validAtAlias("pl", date)}
  join geo_objects o on o.id = hs.poi_geo_object_id and o.merged_into_id is null and ${validAtAlias("o", date)}
`;
}

const countingSelections = countingSelectionsAt();

/** The POIs the given places selected, sorted, without duplicates (only rows that count, see `countingSelections`). */
export async function selectedPoiIds(db: Db, placeGeoObjectIds: string[]): Promise<string[]> {
  if (placeGeoObjectIds.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct hs.poi_geo_object_id as id
    from ${countingSelections}
    where hs.place_geo_object_id = any(${sql.param(placeGeoObjectIds)}::uuid[])
    order by 1
  `);
  return rows.map((r) => r.id);
}

/** Of the given geo objects, the POIs any place selected (a highlight), sorted, without duplicates. */
export async function selectedAnywhere(db: Db, poiGeoObjectIds: string[]): Promise<string[]> {
  if (poiGeoObjectIds.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct hs.poi_geo_object_id as id
    from ${countingSelections}
    where hs.poi_geo_object_id = any(${sql.param(poiGeoObjectIds)}::uuid[])
    order by 1
  `);
  return rows.map((r) => r.id);
}

/** SQL condition: the POI `poiId` is a highlight of some place (a selection row that counts). */
export const isSelectedSql = (poiId: SQL) => sql`exists (select 1 from ${countingSelections} where hs.poi_geo_object_id = ${poiId})`;

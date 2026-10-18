import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons } from "@/lib/db/schema";
import type { Bbox } from "@/lib/domain/tiles";

const KM_PER_DEGREE = 111.32;

type LandFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

/** Expands a box by `km` on every side; longitude degrees scale with the cosine of the mid-latitude. */
export function bufferBbox([west, south, east, north]: Bbox, km: number): Bbox {
  const dLat = km / KM_PER_DEGREE;
  const midLat = (south + north) / 2;
  const dLon = km / (KM_PER_DEGREE * Math.cos((midLat * Math.PI) / 180));
  return [west - dLon, south - dLat, east + dLon, north + dLat];
}

function envelope([west, south, east, north]: Bbox) {
  return sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`;
}

/**
 * Imports land polygons clipped to `bbox`. Polygons in the box that come from another or the same
 * dataset version are removed first (working state), so re-imports never duplicate.
 */
export async function importLandPolygons(
  db: Db,
  features: AsyncIterable<LandFeature>,
  bbox: Bbox,
  datasetVersion: string,
): Promise<{ inserted: number; replaced: number }> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(landPolygons)
      .where(sql`ST_Intersects(${landPolygons.geom}, ${envelope(bbox)})`)
      .returning({ id: landPolygons.id });
    let inserted = 0;
    for await (const feature of features) {
      const res = await tx.execute(sql`
        INSERT INTO land_polygons (id, geom, dataset_version)
        SELECT gen_random_uuid(), d.geom, ${datasetVersion}
        FROM (
          SELECT (ST_Dump(ST_CollectionExtract(
            ST_Intersection(ST_MakeValid(src.g), ${envelope(bbox)}), 3))).geom AS geom
          FROM (SELECT ${geomFromGeoJson(feature.geometry)} AS g) src
          WHERE ST_Intersects(src.g, ${envelope(bbox)})
        ) d
        WHERE NOT ST_IsEmpty(d.geom)`);
      inserted += res.rowCount ?? 0;
    }
    return { inserted, replaced: deleted.length };
  });
}

/** Number of land polygons intersecting the box. */
export async function landCoverage(db: Db, bbox: Bbox): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(landPolygons)
    .where(sql`ST_Intersects(${landPolygons.geom}, ${envelope(bbox)})`);
  return row.n;
}

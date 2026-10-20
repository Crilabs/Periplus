import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonSet, places, tiles, type PlaceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { insertNamedObject } from "@/test/text";

/** Navily markers of the synthetic fixture (`test/fixtures/navily/sample.json`): names, ids and urls (the rating is never read). */
export const NAVILY_MARKERS = /NAVILY-ONLY-NAME|NAVILY-PORT|987654321|123456789|555000111|navily\.com/;

/**
 * Every row of `comparison_results`, `review_tasks` and `quality_snapshots` the current transaction wrote, as JSON
 * (Grundprinzip 9 guards).
 * A row written in this transaction has `created_at = now()` (the transaction's start, also inside savepoints), so the
 * guard sees the writes of every place and subject, not only those of the place under test.
 */
export async function rowsWrittenInTransaction(tx: Db): Promise<string[]> {
  const { rows } = await tx.execute<{ row: string }>(sql`
    select row_to_json(c)::text as row from comparison_results c where c.created_at = now()
    union all
    select row_to_json(r)::text as row from review_tasks r where r.created_at = now()
    union all
    select row_to_json(q)::text as row from quality_snapshots q where q.created_at = now()`);
  return rows.map((r) => r.row);
}

/**
 * A synthetic area with its own key and one coast tile per point of `tiles` (outside the pilot box; the caller rolls
 * back). `addPlace` adds a place in the first tile (or the tile of `at`), confirmed unless told otherwise.
 */
export async function insertQualityArea(tx: Db, tilePoints: Array<{ lon: number; lat: number }>) {
  const areaKey = `test-${newId()}`;
  const first = tilePoints[0]!;
  const areaId = await insertNamedObject(tx, { type: "area", names: [{ name: "Test area" }], lon: first.lon + 0.11, lat: first.lat + 0.11, configKey: areaKey });
  const tileIds: string[] = [];
  for (const p of tilePoints) {
    const id = tileIdFor(p.lon, p.lat);
    const [w, s, e, n] = tileBbox(id);
    await tx
      .insert(tiles)
      .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId, hasCoast: true })
      .onConflictDoUpdate({ target: tiles.id, set: { areaId, hasCoast: true } });
    tileIds.push(id);
  }
  let n = 0;
  const addPlace = async (o: { status?: PlaceStatus; at?: { lon: number; lat: number }; inSet?: boolean } = {}) => {
    const at = o.at ?? first;
    const lon = at.lon + 0.0005 * ++n;
    const geoObjectId = await insertNamedObject(tx, { type: "bay", names: [{ name: `Place ${n}` }], lon, lat: at.lat });
    const [p] = await tx
      .insert(places)
      .values({
        geoObjectId,
        kind: "anchorage",
        status: o.status ?? "confirmed",
        // valid long before any fixed measurement date a test passes as today
        validFrom: "2000-01-01",
        tileId: tileIdFor(lon, at.lat),
        position: geomFromGeoJson({ type: "Point", coordinates: [lon, at.lat] }),
      })
      .returning({ id: places.id });
    if (o.inSet) await tx.insert(comparisonSet).values({ placeId: p!.id, areaId, addedBy: "test" });
    return { placeId: p!.id, geoObjectId };
  };
  return { areaKey, areaId, tileIds, addPlace };
}

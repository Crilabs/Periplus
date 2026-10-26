import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonSet, places, tiles, type PlaceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { insertNamedObject, insertTestSubdivision } from "@/test/text";

/** Navily markers of the synthetic fixture (`test/fixtures/navily/sample.json`): names, ids and urls (the rating is never read). */
export const NAVILY_MARKERS = /NAVILY-ONLY-NAME|NAVILY-PORT|987654321|123456789|555000111|navily\.com/;

/**
 * Every row of `comparison_results` and `review_tasks` the current transaction wrote, as JSON
 * (Grundprinzip 9 guards).
 * A row written in this transaction has `created_at = now()` (the transaction's start, also inside savepoints), so the
 * guard sees the writes of every place and subject, not only those of the place under test.
 */
export async function rowsWrittenInTransaction(tx: Db): Promise<string[]> {
  const { rows } = await tx.execute<{ row: string }>(sql`
    select row_to_json(c)::text as row from comparison_results c where c.created_at = now()
    union all
    select row_to_json(r)::text as row from review_tasks r where r.created_at = now()`);
  return rows.map((r) => r.row);
}

type LonLat = { lon: number; lat: number };

/**
 * A random shift by whole tiles into 170–30° W, 0–20° south of the given points: far from the pilot box and from the
 * fixed test coordinates (21.0/35.2 …), so concurrent test files never insert the same tile row and wait on each
 * other's uncommitted row until rollback (final review A M-1). Positions inside a tile are kept.
 */
function randomTileShift(): (p: LonLat) => LonLat {
  const cols = -764 + Math.floor(Math.random() * 561); // 21 + cols * 0.25 within about −170 … −30
  const rows = -Math.floor(Math.random() * 81);
  return (p) => ({ lon: p.lon + cols * 0.25, lat: p.lat + rows * 0.25 });
}

/**
 * A synthetic subdivision with its own key and one coast tile per point of `tiles`, labelled with it (the caller rolls
 * back). The subdivision (`insertTestSubdivision`, a box around the tiles) is moved by a random whole-tile shift
 * (`randomTileShift`): `at` maps a point given in the test's own coordinates to its real position. `addPlace` adds a
 * place in the first tile (or the tile of `at`, in the test's coordinates), confirmed unless told otherwise; its geo
 * object belongs to the subdivision (`geo_objects.subdivision_id`, which decides the metrics) when it lies in one of its
 * tiles, else to none; `subdivisionId` gives another or none explicitly (e.g. a place in a tile that carries this label
 * but whose land is the neighbour's, or the other way round).
 */
export async function insertQualitySubdivision(tx: Db, givenPoints: LonLat[]) {
  const subdivisionKey = `XT-${newId()}`;
  const at = randomTileShift();
  const tilePoints = givenPoints.map(at);
  const first = tilePoints[0]!;
  const boxes = tilePoints.map((p) => tileBbox(tileIdFor(p.lon, p.lat)));
  const box: [number, number, number, number] = [
    Math.min(...boxes.map((b) => b[0])) - 0.1,
    Math.min(...boxes.map((b) => b[1])) - 0.1,
    Math.max(...boxes.map((b) => b[2])) + 0.1,
    Math.max(...boxes.map((b) => b[3])) + 0.1,
  ];
  const { id: subdivisionId } = await insertTestSubdivision(tx, subdivisionKey, box);
  const tileIds: string[] = [];
  for (const p of tilePoints) {
    const id = tileIdFor(p.lon, p.lat);
    const [w, s, e, n] = tileBbox(id);
    await tx
      .insert(tiles)
      .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, subdivisionId, hasCoast: true })
      .onConflictDoUpdate({ target: tiles.id, set: { subdivisionId, hasCoast: true } });
    tileIds.push(id);
  }
  let n = 0;
  const addPlace = async (o: { status?: PlaceStatus; at?: LonLat; inSet?: boolean; subdivisionId?: string | null } = {}) => {
    const pos = o.at ? at(o.at) : first;
    const lon = pos.lon + 0.0005 * ++n;
    const geoObjectId = await insertNamedObject(tx, {
      type: "bay",
      names: [{ name: `Place ${n}` }],
      lon,
      lat: pos.lat,
      subdivisionId: o.subdivisionId === undefined ? (tileIds.includes(tileIdFor(lon, pos.lat)) ? subdivisionId : null) : o.subdivisionId,
    });
    const [p] = await tx
      .insert(places)
      .values({
        geoObjectId,
        kind: "anchorage",
        status: o.status ?? "confirmed",
        // valid long before any fixed measurement date a test passes as today
        validFrom: "2000-01-01",
        tileId: tileIdFor(lon, pos.lat),
        position: geomFromGeoJson({ type: "Point", coordinates: [lon, pos.lat] }),
      })
      .returning({ id: places.id });
    if (o.inSet) await tx.insert(comparisonSet).values({ placeId: p!.id, subdivisionId, addedBy: "test" });
    return { placeId: p!.id, geoObjectId };
  };
  return { subdivisionKey, subdivisionId, tileIds, addPlace, at };
}

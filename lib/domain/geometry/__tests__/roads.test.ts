import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { replaceRoads, ROADS_PER_STATEMENT, type RoadFeature } from "@/lib/domain/geometry/roads";
import { withRollback } from "@/test/db";

// A synthetic box far from the pilot box 23.0-23.75 E x 37.0-38.0 N; osm ids unique per run so committed rows of
// other tests never match.
const BOX: [number, number, number, number] = [10.0, 30.0, 10.5, 30.5];
const run = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

/** `n` short roads spread over the box, ids `way/<run>-<i>`. */
function roads(n: number, from = 0): RoadFeature[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const lon = 10.0 + ((i % 100) / 100) * 0.5;
    const lat = 30.0 + (Math.floor(i / 100) / 100) * 0.5;
    return { osmId: `way/${run}-${i}`, highway: i % 2 === 0 ? "residential" : "track", geometry: { type: "LineString", coordinates: [[lon, lat], [lon + 0.001, lat + 0.001]] } };
  });
}

async function count(db: Parameters<Parameters<typeof withRollback>[0]>[0]): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from roads where osm_id like ${`way/${run}-%`}`);
  return rows[0]!.n;
}

describe("replaceRoads", () => {
  // The roads of Attica are a 268 MB Overpass answer: one statement carrying every feature as jsonb, and a delete
  // expanding that jsonb inside NOT IN, killed the 2 GB database (N7 check). The import now works in pieces.
  it("stores more roads than fit one statement, in several, and removes the stale ones of the box by their ids", () =>
    withRollback(async (db) => {
      const n = 2 * ROADS_PER_STATEMENT + 7;
      const first = await replaceRoads(db, { box: BOX, datasetVersion: "v1", roads: roads(n) });
      expect(first).toEqual({ stored: n, removed: 0 });
      expect(await count(db)).toBe(n);

      // a rerun with the first half missing and one road changed: the missing half is removed, the rest updated
      const kept = roads(n).slice(ROADS_PER_STATEMENT + 3);
      kept[0] = { ...kept[0]!, highway: "primary" };
      const second = await replaceRoads(db, { box: BOX, datasetVersion: "v2", roads: kept });
      expect(second).toEqual({ stored: kept.length, removed: ROADS_PER_STATEMENT + 3 });
      expect(await count(db)).toBe(kept.length);
      const { rows } = await db.execute<{ highway: string; dataset_version: string }>(
        sql`select highway, dataset_version from roads where osm_id = ${kept[0]!.osmId}`,
      );
      expect(rows[0]).toEqual({ highway: "primary", dataset_version: "v2" });

      // an empty import clears the box
      expect(await replaceRoads(db, { box: BOX, datasetVersion: "v3", roads: [] })).toEqual({ stored: 0, removed: kept.length });
      expect(await count(db)).toBe(0);
    }));

  it("refuses duplicate ids", async () => {
    const dup = roads(2).map((r) => ({ ...r, osmId: `way/${run}-dup` }));
    await withRollback(async (db) => {
      await expect(replaceRoads(db, { box: BOX, datasetVersion: "v1", roads: dup })).rejects.toThrow(/duplicate road/);
    });
  });
});

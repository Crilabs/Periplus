import { describe, expect, it } from "vitest";
import { nearSea } from "@/lib/domain/gazetteer/sea-distance";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { withRollback } from "@/test/db";

// Synthetic sea square 40.0-40.2 E x 10.0-10.2 N, far from the pilot box 23.0-23.75 E x 37.0-38.0 N.
const SEA: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[40.0, 10.0], [40.2, 10.0], [40.2, 10.2], [40.0, 10.2], [40.0, 10.0]]] };

describe("nearSea", () => {
  it("keeps a point 15 km from the sea and drops one 25 km inland", () =>
    withRollback(async (db) => {
      const sea = await upsertGeoObject(db, {
        type: "sea",
        origin: "marine_regions",
        geometry: SEA,
        names: [],
      });
      if ("skipped" in sea) throw new Error(sea.skipped);
      // 1 degree of latitude ~111 km: 0.135 deg ~15 km, 0.225 deg ~25 km south of the sea's southern edge.
      const near = await nearSea(
        db,
        [
          { key: "near", lon: 40.1, lat: 10.0 - 0.135 },
          { key: "far", lon: 40.1, lat: 10.0 - 0.225 },
          { key: "inside", lon: 40.1, lat: 10.1 },
        ],
        20,
      );
      expect([...near].sort()).toEqual(["inside", "near"]);
    }));

  it("is empty without points", () => withRollback(async (db) => expect(await nearSea(db, [], 20)).toEqual(new Set())));
});

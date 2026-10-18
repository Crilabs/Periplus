import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { asGeoJson } from "@/lib/db/geometry";
import { landPolygons } from "@/lib/db/schema";
import { bufferBbox, importLandPolygons, landCoverage } from "@/lib/domain/gazetteer/land";
import type { Bbox } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";

type LandFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

function square(w: number, s: number, e: number, n: number): LandFeature {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

async function* stream(features: LandFeature[]): AsyncGenerator<LandFeature> {
  for (const f of features) yield f;
}

// Outside the pilot box 23.0-23.75 E x 37.0-38.0 N.
const BOX: Bbox = [26.0, 35.0, 27.0, 36.0];

describe("importLandPolygons", () => {
  it("imports only polygons intersecting the bbox, clipped to it", () =>
    withRollback(async (db) => {
      const features = [
        square(26.2, 35.2, 26.4, 35.4), // fully inside
        square(26.8, 35.5, 27.5, 35.8), // straddles the east edge
        square(28.0, 35.0, 28.5, 35.5), // outside
      ];
      const r = await importLandPolygons(db, stream(features), BOX, "2026-01-01");
      expect(r).toEqual({ inserted: 2, replaced: 0 });
      expect(await landCoverage(db, BOX)).toBe(2);
      const [{ maxLon }] = await db.execute<{ maxLon: number }>(
        sql`SELECT max(ST_XMax(geom)) AS "maxLon" FROM ${landPolygons}
            WHERE ST_Intersects(geom, ST_MakeEnvelope(26, 35, 27.0001, 36, 4326))`,
      ).then((x) => x.rows);
      expect(maxLon).toBeCloseTo(27.0, 6);
    }));

  it("splits multipolygons into polygons", () =>
    withRollback(async (db) => {
      const multi: LandFeature = {
        type: "Feature",
        properties: {},
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [[[26.1, 35.1], [26.2, 35.1], [26.2, 35.2], [26.1, 35.2], [26.1, 35.1]]],
            [[[26.5, 35.5], [26.6, 35.5], [26.6, 35.6], [26.5, 35.6], [26.5, 35.5]]],
          ],
        },
      };
      const r = await importLandPolygons(db, stream([multi]), BOX, "2026-01-01");
      expect(r.inserted).toBe(2);
      const rows = await db.select({ g: asGeoJson(landPolygons.geom) }).from(landPolygons)
        .where(sql`ST_Intersects(${landPolygons.geom}, ST_MakeEnvelope(26, 35, 27, 36, 4326))`);
      expect(rows.every((x) => x.g.type === "Polygon")).toBe(true);
    }));

  it("re-import of the same version yields the same row count", () =>
    withRollback(async (db) => {
      const features = [square(26.2, 35.2, 26.4, 35.4), square(26.6, 35.6, 26.8, 35.8)];
      await importLandPolygons(db, stream(features), BOX, "2026-01-01");
      const again = await importLandPolygons(db, stream(features), BOX, "2026-01-01");
      expect(again.inserted).toBe(2);
      expect(await landCoverage(db, BOX)).toBe(2);
    }));

  it("a new version replaces the old one inside the bbox but keeps polygons outside", () =>
    withRollback(async (db) => {
      const west = square(26.1, 35.1, 26.2, 35.2);
      const east = square(26.8, 35.8, 26.9, 35.9);
      await importLandPolygons(db, stream([west, east]), BOX, "2026-01-01");
      const small: Bbox = [26.0, 35.0, 26.5, 36.0];
      const r = await importLandPolygons(db, stream([west]), small, "2026-02-01");
      expect(r).toEqual({ inserted: 1, replaced: 1 });
      expect(await landCoverage(db, small)).toBe(1);
      expect(await landCoverage(db, [26.6, 35.0, 27.0, 36.0])).toBe(1);
      const versions = await db.execute<{ v: string }>(
        sql`SELECT dataset_version AS v FROM ${landPolygons}
            WHERE ST_Intersects(geom, ST_MakeEnvelope(26, 35, 27, 36, 4326)) ORDER BY 1`,
      );
      expect(versions.rows.map((x) => x.v)).toEqual(["2026-01-01", "2026-02-01"]);
    }));
});

describe("bufferBbox", () => {
  it("expands by km in degrees, wider in longitude at higher latitude", () => {
    const [w, s, e, n] = bufferBbox([23, 37, 24, 38], 10);
    expect(s).toBeCloseTo(37 - 10 / 111.32, 6);
    expect(n).toBeCloseTo(38 + 10 / 111.32, 6);
    const dLon = 23 - w;
    expect(dLon).toBeCloseTo(10 / (111.32 * Math.cos((37.5 * Math.PI) / 180)), 6);
    expect(dLon).toBeGreaterThan(10 / 111.32);
    expect(e - 24).toBeCloseTo(dLon, 9);
  });

  it("returns the box unchanged for 0 km", () => {
    expect(bufferBbox([23, 37, 24, 38], 0)).toEqual([23, 37, 24, 38]);
  });
});

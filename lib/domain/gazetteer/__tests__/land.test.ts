import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { asGeoJson } from "@/lib/db/geometry";
import { landPolygons } from "@/lib/db/schema";
import { getConfig } from "@/lib/config";
import { bufferBbox, featureIntersectsBbox, importLandPolygons, landCoverage, mediterraneanBbox } from "@/lib/domain/gazetteer/land";
import { TILE_SIZE, type Bbox } from "@/lib/domain/tiles";
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

describe("importLandPolygons neighbours and invalid input", () => {
  it("importing area B keeps area A's land outside B's box", () =>
    withRollback(async (db) => {
      const boxA: Bbox = [26.0, 35.0, 26.5, 36.0];
      const boxB: Bbox = [26.4, 35.0, 27.0, 36.0];
      const wide = square(26.0, 35.3, 27.0, 35.4);
      await importLandPolygons(db, stream([wide]), boxA, "2026-01-01");
      const area = (b: Bbox) => db.execute<{ a: number }>(
        sql`SELECT coalesce(sum(ST_Area(ST_Intersection(geom, ST_MakeEnvelope(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]}, 4326)))), 0)::float AS a
            FROM ${landPolygons}`,
      ).then((x) => x.rows[0].a);
      const before = await area([26.0, 35.0, 26.4, 36.0]);
      expect(before).toBeCloseTo(0.4 * 0.1, 6);
      const r = await importLandPolygons(db, stream([wide]), boxB, "2026-01-01");
      expect(r.inserted).toBe(1);
      expect(r.replaced).toBe(1);
      expect(await area([26.0, 35.0, 26.4, 36.0])).toBeCloseTo(before, 6);
      expect(await area([26.4, 35.0, 27.0, 36.0])).toBeCloseTo(0.6 * 0.1, 6);
    }));

  it("re-importing the same version for the same box keeps the row count with neighbours present", () =>
    withRollback(async (db) => {
      const boxA: Bbox = [26.0, 35.0, 26.5, 36.0];
      const boxB: Bbox = [26.5, 35.0, 27.0, 36.0];
      const wide = square(26.0, 35.3, 27.0, 35.4);
      await importLandPolygons(db, stream([wide]), boxA, "2026-01-01");
      await importLandPolygons(db, stream([wide]), boxB, "2026-01-01");
      const count = () => landCoverage(db, [26.0, 35.0, 27.0, 36.0]);
      const n = await count();
      await importLandPolygons(db, stream([wide]), boxB, "2026-01-01");
      expect(await count()).toBe(n);
    }));

  it("imports a self-intersecting polygon as valid polygons", () =>
    withRollback(async (db) => {
      const bowtie: LandFeature = {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[26.2, 35.2], [26.4, 35.4], [26.4, 35.2], [26.2, 35.4], [26.2, 35.2]]] },
      };
      const r = await importLandPolygons(db, stream([bowtie]), BOX, "2026-01-01");
      expect(r.inserted).toBeGreaterThan(0);
      const rows = await db.execute<{ valid: boolean }>(
        sql`SELECT ST_IsValid(geom) AS valid FROM ${landPolygons}
            WHERE ST_Intersects(geom, ST_MakeEnvelope(26, 35, 27, 36, 4326))`,
      );
      expect(rows.rows.length).toBe(r.inserted);
      expect(rows.rows.every((x) => x.valid)).toBe(true);
    }));
});

describe("featureIntersectsBbox", () => {
  const box: Bbox = [0, 0, 1, 1];
  const poly = (w: number, s: number, e: number, n: number) => square(w, s, e, n);
  it("accepts overlapping and touching extents, rejects disjoint ones", () => {
    expect(featureIntersectsBbox(poly(0.5, 0.5, 2, 2), box)).toBe(true);
    expect(featureIntersectsBbox(poly(1, 0, 2, 1), box)).toBe(true);
    expect(featureIntersectsBbox(poly(1.1, 0, 2, 1), box)).toBe(false);
    expect(featureIntersectsBbox(poly(0, 1.1, 1, 2), box)).toBe(false);
  });
  it("checks every part of a multipolygon", () => {
    const multi: LandFeature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: [poly(5, 5, 6, 6).geometry, poly(0.2, 0.2, 0.3, 0.3).geometry].map(
          (g) => (g as GeoJSON.Polygon).coordinates,
        ),
      },
    };
    expect(featureIntersectsBbox(multi, box)).toBe(true);
  });
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

describe("mediterraneanBbox", () => {
  it("is the configured box plus the buffer, snapped outward to the tile grid, without any sea in the database", () => {
    // config/subdivisions.json: mediterranean.bbox [-6.1, 30.0, 36.3, 45.9]; 55 km are 0.49 degrees of latitude.
    expect(getConfig().subdivisions.mediterranean.bbox).toEqual([-6.1, 30.0, 36.3, 45.9]);
    const box = mediterraneanBbox(55);
    expect(box).toEqual([-6.75, 29.5, 37, 46.5]);
    expect(box.every((v) => Number.isInteger(v / TILE_SIZE))).toBe(true);
  });

  it("covers the buffered configured box", () => {
    const [w, s, e, n] = bufferBbox(getConfig().subdivisions.mediterranean.bbox, 5);
    const box = mediterraneanBbox(5);
    expect(box[0]).toBeLessThanOrEqual(w);
    expect(box[1]).toBeLessThanOrEqual(s);
    expect(box[2]).toBeGreaterThanOrEqual(e);
    expect(box[3]).toBeGreaterThanOrEqual(n);
  });
});

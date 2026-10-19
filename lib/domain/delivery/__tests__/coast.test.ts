import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { coastCollectionSchema, type CoastCollection } from "@/contract/v1";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons, restrictedAreas } from "@/lib/db/schema";
import { withRollback } from "@/test/db";
import { seedDeliveryArea } from "@/test/fixtures/delivery/area";
import { buildCoast, coastBox } from "../coast";
import { distanceNm } from "../geo";

const cfg = loadConfig("config").delivery;
/** The fixture area's tiles. */
const BBOX: [number, number, number, number] = [21.0, 35.0, 21.5, 35.25];
const UTM = 32634;

const square = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

async function today(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select current_date::text as d`);
  return rows[0]!.d;
}

/** Mainland west of the area, crossing the west edge of the box (plus margin). */
const MAINLAND = square(20.8, 35.02, 21.02, 35.1);

async function seedCoast(tx: Db) {
  const f = await seedDeliveryArea(tx);
  await tx.insert(landPolygons).values({ geom: geomFromGeoJson(MAINLAND), datasetVersion: "test" });
  const asOf = await today(tx);
  const coast = await buildCoast(tx, { bbox: BBOX, cfg: cfg.coast, asOf });
  return { f, asOf, coast };
}

const features = (c: CoastCollection, kind: string) => c.features.filter((x) => x.properties.kind === kind);
const asSql = (g: unknown) => sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(g)}), 4326)`;

describe("buildCoast", () => {
  it("coast covers the box plus 2 nm and contains land, coastline and the military area", async () => {
    await withRollback(async (tx) => {
      const { f, coast } = await seedCoast(tx);
      const [west, south, east, north] = coastBox(BBOX, cfg.coast.marginNm);
      // at least 2 nm on every side, at the poleward edge too
      expect(distanceNm({ lon: west, lat: north }, { lon: BBOX[0], lat: north })).toBeGreaterThanOrEqual(2);
      expect(distanceNm({ lon: east, lat: north }, { lon: BBOX[2], lat: north })).toBeGreaterThanOrEqual(2);
      expect(distanceNm({ lon: west, lat: south }, { lon: west, lat: BBOX[1] })).toBeGreaterThanOrEqual(2);
      expect(distanceNm({ lon: west, lat: north }, { lon: west, lat: BBOX[3] })).toBeGreaterThanOrEqual(2);
      expect(distanceNm({ lon: west, lat: north }, { lon: BBOX[0], lat: north })).toBeLessThan(2.01);

      const land = features(coast, "land");
      // the island and the mainland cut at the west edge of the box plus margin
      expect(land).toHaveLength(2);
      const xs = land.flatMap((x) => (x.geometry.type === "Polygon" ? x.geometry.coordinates.flat() : [])).map(([lon]) => lon);
      expect(Math.min(...xs)).toBe(west);
      for (const x of [...land, ...features(coast, "coastline")]) {
        expect(x.properties).toEqual({ kind: x.properties.kind, source: "OpenStreetMap, ODbL", extractedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      }
      expect(features(coast, "coastline").length).toBeGreaterThan(0);
      const restricted = features(coast, "restrictedArea");
      expect(restricted).toEqual([
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[[21.38, 35.18], [21.42, 35.18], [21.42, 35.22], [21.38, 35.22], [21.38, 35.18]]] },
          properties: { kind: "restrictedArea", reason: "military", source: "test" },
        },
      ]);
      expect(f.restrictedAreaId).toBeTruthy();
    });
  });

  it("restricted areas: valid on asOf and in the box, reasons mapped, firing area military, default source", async () => {
    await withRollback(async (tx) => {
      await seedDeliveryArea(tx);
      await tx.insert(restrictedAreas).values([
        { kind: "firing_area", geom: geomFromGeoJson(square(21.3, 35.0, 21.32, 35.02)), sourceRef: null },
        { kind: "protected_area", geom: geomFromGeoJson(square(21.25, 35.21, 21.27, 35.23)), sourceRef: "natura" },
        { kind: "ferry_lane", geom: geomFromGeoJson(square(21.45, 35.0, 21.6, 35.01)), sourceRef: "lane" },
        // ended before asOf, and one far outside the box
        { kind: "cable", geom: geomFromGeoJson(square(21.1, 35.2, 21.11, 35.21)), validFrom: "2020-01-01", validTo: "2021-01-01" },
        { kind: "cable", geom: geomFromGeoJson(square(22.5, 36.0, 22.6, 36.1)) },
      ]);
      const coast = await buildCoast(tx, { bbox: BBOX, cfg: cfg.coast, asOf: await today(tx) });
      const restricted = features(coast, "restrictedArea").map((x) => x.properties);
      expect(restricted).toEqual([
        { kind: "restrictedArea", reason: "protectedArea", source: "natura" },
        { kind: "restrictedArea", reason: "military", source: "EMODnet Human Activities" },
        { kind: "restrictedArea", reason: "military", source: "test" },
        { kind: "restrictedArea", reason: "ferryLane", source: "lane" },
      ]);
      // the ferry lane is cut at the east edge of the box plus margin
      const lane = features(coast, "restrictedArea").at(-1)!;
      const lons = (lane.geometry as GeoJSON.Polygon).coordinates.flat().map(([lon]) => lon!);
      expect(Math.max(...lons)).toBe(coastBox(BBOX, cfg.coast.marginNm)[2]);
    });
  });

  it("the coastline has no segment on the box edge", async () => {
    await withRollback(async (tx) => {
      const { coast } = await seedCoast(tx);
      const [w, s, e, n] = coastBox(BBOX, cfg.coast.marginNm);
      const box = sql`ST_MakeEnvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326)`;
      const lines = features(coast, "coastline").map((x) => x.geometry);
      // the mainland's cut edge on the west side would be ~8.9 km of coastline on the box edge
      const { rows } = await tx.execute<{ near_m: number; min_vertex_m: number; total_m: number }>(sql`
        with c as (select ST_Collect(array[${sql.join(lines.map(asSql), sql`, `)}]) as g),
             edge as (select ST_Transform(ST_Segmentize(ST_ExteriorRing(${box}), 0.001), ${UTM}::int) as g)
        select ST_Length(ST_Intersection(ST_Transform(c.g, ${UTM}::int), ST_Buffer(edge.g, 2))) as near_m,
               (select min(ST_Distance(ST_Transform(d.geom, ${UTM}::int), edge.g)) from ST_DumpPoints(c.g) d) as min_vertex_m,
               ST_Length(ST_Transform(c.g, ${UTM}::int)) as total_m
        from c, edge`);
      const r = rows[0]!;
      expect(Number(r.total_m)).toBeGreaterThan(30_000);
      // only the two short stubs where the mainland's coast crosses the edge, each ≤ 1 m plus rounding
      expect(Number(r.near_m)).toBeLessThan(5);
      expect(Number(r.min_vertex_m)).toBeGreaterThan(0.4);
    });
  });

  it("simplification keeps every vertex within 10 m of the original land", async () => {
    await withRollback(async (tx) => {
      await seedDeliveryArea(tx);
      // a coast of 2 m zigzags every 20 m (5.6 km long) south of the island
      const ring: Array<[number, number]> = [];
      for (let i = 0; i <= 250; i++) ring.push([Number((21.25 + i * 0.00022).toFixed(6)), Number((35.02 + (i % 2) * 0.000018).toFixed(6))]);
      const zigzag: GeoJSON.Polygon = { type: "Polygon", coordinates: [[...ring, [21.305, 35.01], [21.25, 35.01], ring[0]!]] };
      await tx.insert(landPolygons).values({ geom: geomFromGeoJson(zigzag), datasetVersion: "test" });
      const coast = await buildCoast(tx, { bbox: BBOX, cfg: cfg.coast, asOf: await today(tx) });
      const land = features(coast, "land").map((x) => x.geometry);
      const { rows } = await tx.execute<{ hausdorff: number; before: number; after: number }>(sql`
        with out as (select ST_Union(array[${sql.join(land.map(asSql), sql`, `)}]) as g),
             src as (select ST_Union(geom) as g from land_polygons where dataset_version = 'test' and geom && ST_MakeEnvelope(21, 35, 21.5, 35.25, 4326))
        select ST_HausdorffDistance(ST_Transform(out.g, ${UTM}::int), ST_Transform(src.g, ${UTM}::int)) as hausdorff,
               ST_NPoints(src.g) as before, ST_NPoints(out.g) as after
        from out, src`);
      const r = rows[0]!;
      expect(Number(r.hausdorff)).toBeLessThanOrEqual(10);
      expect(Number(r.after)).toBeLessThan(Number(r.before) / 10);
    });
  });

  it("all coordinates have at most five decimals and the collection passes the contract schema", async () => {
    await withRollback(async (tx) => {
      const { coast } = await seedCoast(tx);
      expect(coastCollectionSchema.safeParse(coast).error?.issues).toBeUndefined();
      const numbers = JSON.stringify(coast).match(/-?\d+\.\d+/g) ?? [];
      expect(numbers.length).toBeGreaterThan(0);
      for (const n of numbers) expect(n.split(".")[1]!.length).toBeLessThanOrEqual(5);
      // land, then coastline, then restricted areas; within a kind west to east
      const kinds = coast.features.map((x) => x.properties.kind);
      expect(kinds).toEqual([...kinds].sort((a, b) => ["land", "coastline", "restrictedArea"].indexOf(a) - ["land", "coastline", "restrictedArea"].indexOf(b)));
      expect(features(coast, "land").map((x) => (x.geometry as GeoJSON.Polygon).coordinates[0]![0]![0]! < 21.03)).toEqual([true, false]);
    });
  });

  it("is the same collection on a second build", async () => {
    await withRollback(async (tx) => {
      const { coast, asOf } = await seedCoast(tx);
      expect(await buildCoast(tx, { bbox: BBOX, cfg: cfg.coast, asOf })).toEqual(coast);
    });
  });
});

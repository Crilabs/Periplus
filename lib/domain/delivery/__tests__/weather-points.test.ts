import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { weatherPointSchema } from "@/contract/v1";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, landPolygons } from "@/lib/db/schema";
import { withRollback } from "@/test/db";
import { seedDeliveryArea } from "@/test/fixtures/delivery/area";
import { insertNamedObject } from "@/test/text";
import { distanceNm } from "../geo";
import { loadAreaScope } from "../load";
import { namedRegions, regionIdAt } from "../map-region";
import type { RegionSource } from "../types";
import { buildWeatherPoints, weatherPointId } from "../weather-points";

const cfg = loadConfig("config").delivery;
const UTM = 32634;

const square = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

async function today(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select current_date::text as d`);
  return rows[0]!.d;
}

/** The fixture plus a strait north of the island; weather points from the loaded scope. */
async function build(tx: Db) {
  const f = await seedDeliveryArea(tx);
  const straitId = await insertNamedObject(tx, { type: "strait", names: [{ name: "Stenon Test" }], lon: 21.22, lat: 35.18, tiles: [f.tileIds[0]] });
  await tx.update(geoObjects).set({ geom: geomFromGeoJson(square(21.21, 35.17, 21.23, 35.19)) }).where(sql`${geoObjects.id} = ${straitId}`);
  const scope = await loadAreaScope(tx, f.areaId, cfg, await today(tx));
  const { regions } = namedRegions(scope.regions);
  const input = { regions, passages: scope.passages, regionIdFor: regionIdAt(regions, cfg.regions.memberMarginNm), cfg: cfg.weather };
  return { f, straitId, scope, input, result: await buildWeatherPoints(tx, input) };
}

describe("weatherPointId", () => {
  it("is wp_ and the first 26 Crockford base-32 characters of sha256(geoObjectId:kind)", () => {
    const geoObjectId = "01a15602-0000-7000-8000-000000000001";
    const id = weatherPointId(geoObjectId, "cape");
    expect(id).toMatch(/^wp_[0-9A-HJKMNP-TV-Z]{26}$/);
    // the first 5 bits of the digest are the first character
    const first = createHash("sha256").update(`${geoObjectId}:cape`).digest()[0]! >> 3;
    expect(id[3]).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ"[first]);
    expect(weatherPointId(geoObjectId, "cape")).toBe(id);
    expect(weatherPointId(geoObjectId, "region")).not.toBe(id);
  });
});

describe("buildWeatherPoints", () => {
  it("the island's weather point lies on water at the largest distance to land within the buffer", async () => {
    await withRollback(async (tx) => {
      const { f, result } = await build(tx);
      const wp = result.points.find((p) => p.kind === "region")!;
      expect(wp).toMatchObject({ id: weatherPointId(f.islandId, "region"), name: "Nisida", regionId: f.islandPublicId });
      // the archipelago is known as a point only: no region point
      expect(result.points.filter((p) => p.kind === "region")).toHaveLength(1);
      const bufferM = cfg.weather.regionBufferNm * 1852;
      const { rows } = await tx.execute<{ on_land: boolean; in_buffer: boolean; clearance: number; best_sample: number }>(sql`
        with island as (select ST_Transform(geom, ${UTM}::int) as g from geo_objects where id = ${f.islandId}),
             water as (select ST_Difference(ST_Buffer(island.g, ${bufferM}::float8), island.g) as g from island),
             p as (select ST_Transform(ST_SetSRID(ST_MakePoint(${wp.position.lon}::float8, ${wp.position.lat}::float8), 4326), ${UTM}::int) as g),
             grid as (
               select ST_Transform(ST_SetSRID(ST_MakePoint(x, y), 4326), ${UTM}::int) as g
               from generate_series(20.95, 21.3, 0.0025) x, generate_series(34.95, 35.25, 0.0025) y
             )
        select ST_Intersects(p.g, island.g) as on_land,
               ST_Within(p.g, ST_Buffer(island.g, ${bufferM}::float8)) as in_buffer,
               ST_Distance(p.g, ST_Boundary(water.g)) as clearance,
               (select max(ST_Distance(grid.g, ST_Boundary(water.g))) from grid where ST_Within(grid.g, water.g)) as best_sample
        from island, water, p`);
      const r = rows[0]!;
      expect(r.on_land).toBe(false);
      expect(r.in_buffer).toBe(true);
      // no sampled water point is clearly farther from land and the buffer edge (grid ≈ 250 m, MIC tolerance)
      expect(Number(r.clearance)).toBeGreaterThan(Number(r.best_sample) - 30);
      expect(Number(r.clearance)).toBeGreaterThan(bufferM / 2 - 50);
    });
  });

  it("a gulf's weather point lies inside the gulf, not on the open sea past its mouth (ruling M6-C-R2)", async () => {
    await withRollback(async (tx) => {
      const { f, input } = await build(tx);
      // a gulf ≈ 1.75 nm wide and 12 nm deep between two land blocks, closed to the south, open to the north
      await tx.insert(landPolygons).values([
        { geom: geomFromGeoJson(square(22.0, 36.0, 22.1, 36.2)), datasetVersion: "test" },
        { geom: geomFromGeoJson(square(22.136, 36.0, 22.25, 36.2)), datasetVersion: "test" },
        { geom: geomFromGeoJson(square(22.0, 35.95, 22.25, 36.0)), datasetVersion: "test" },
      ]);
      const gulfPolygon = square(22.1, 36.0, 22.136, 36.2);
      const gulf: RegionSource = {
        ...input.regions.find((r) => r.geoObjectId === f.islandId)!,
        geoObjectId: "01a15602-0000-7000-8000-0000000000ab",
        publicId: "rg_01J9ZD00000000000000000098",
        type: "gulf",
        name: "Kolpos Test",
        polygon: gulfPolygon,
        center: { lon: 22.118, lat: 36.1 },
      };
      const { points } = await buildWeatherPoints(tx, { ...input, regions: [gulf], passages: [] });
      expect(points).toHaveLength(1);
      const wp = points[0]!;
      expect(wp.regionId).toBe(gulf.publicId);
      const { rows } = await tx.execute<{ inside: boolean; clearance: number }>(sql`
        with g as (select ${geomFromGeoJson(gulfPolygon)} as g),
             p as (select ST_SetSRID(ST_MakePoint(${wp.position.lon}::float8, ${wp.position.lat}::float8), 4326) as g)
        select ST_Within(p.g, g.g) as inside,
               ST_Distance(ST_Transform(p.g, ${UTM}::int), ST_Transform(ST_Boundary(g.g), ${UTM}::int)) as clearance
        from g, p`);
      expect(rows[0]!.inside).toBe(true);
      // about half the gulf's width (≈ 1.6 km) from its shores
      expect(Number(rows[0]!.clearance)).toBeGreaterThan(1400);
    });
  });

  it("a cape point lies 1 nm seaward of the cape", async () => {
    await withRollback(async (tx) => {
      const { f, result } = await build(tx);
      const wp = result.points.find((p) => p.kind === "cape")!;
      const cape = { lon: 21.2, lat: 35.15 };
      expect(wp).toMatchObject({ id: weatherPointId(f.capeId, "cape"), name: "Akra Test" });
      expect(distanceNm(cape, wp.position)).toBeCloseTo(1, 1);
      // the island lies south-west of its north-east corner: seaward is north-east
      expect(wp.position.lon).toBeGreaterThan(cape.lon);
      expect(wp.position.lat).toBeGreaterThan(cape.lat);
      const { rows } = await tx.execute<{ on_land: boolean }>(sql`
        select exists (select 1 from land_polygons l
          where ST_Intersects(l.geom, ST_SetSRID(ST_MakePoint(${wp.position.lon}::float8, ${wp.position.lat}::float8), 4326))) as on_land`);
      expect(rows[0]!.on_land).toBe(false);
    });
  });

  it("a strait's point is its polygon's point nearest the centroid, with the region at that point", async () => {
    await withRollback(async (tx) => {
      const { straitId, result } = await build(tx);
      const wp = result.points.find((p) => p.kind === "channel")!;
      expect(wp).toEqual({ id: weatherPointId(straitId, "channel"), name: "Stenon Test", position: { lon: 21.22, lat: 35.18 }, kind: "channel", regionId: null });
    });
  });

  it("weather point ids are stable across builds; sorted by id, five decimals, contract points", async () => {
    await withRollback(async (tx) => {
      const { input, result } = await build(tx);
      expect(result.points).toHaveLength(3);
      expect(result.dropped).toEqual([]);
      expect(await buildWeatherPoints(tx, input)).toEqual(result);
      expect(result.points.map((p) => p.id)).toEqual(result.points.map((p) => p.id).sort());
      for (const p of result.points) expect(weatherPointSchema.safeParse(p).error?.issues).toBeUndefined();
    });
  });

  it("points without water or without a name are left out", async () => {
    await withRollback(async (tx) => {
      const { f, input } = await build(tx);
      // a region deep inside a large land mass: its buffer holds no water
      await tx.insert(landPolygons).values({ geom: geomFromGeoJson(square(20.0, 34.0, 21.0, 34.9)), datasetVersion: "test" });
      const inland: RegionSource = {
        ...input.regions.find((r) => r.geoObjectId === f.islandId)!,
        geoObjectId: "01a15602-0000-7000-8000-0000000000aa",
        publicId: "rg_01J9ZD00000000000000000099",
        polygon: square(20.4, 34.4, 20.5, 34.5),
      };
      const unnamed = { ...input.passages.find((p) => p.type === "cape")!, name: " " };
      const result = await buildWeatherPoints(tx, { ...input, regions: [inland], passages: [unnamed] });
      expect(result.points).toEqual([]);
      expect(result.dropped).toEqual([
        { geoObjectId: "01a15602-0000-7000-8000-0000000000aa", kind: "region", reason: "no_water" },
        { geoObjectId: f.capeId, kind: "cape", reason: "no_name" },
      ]);
    });
  });
});

import { existsSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { areaByKey, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, type GeoObjectType, type PlaceKind } from "@/lib/db/schema";
import { latestComputations } from "@/lib/domain/facts/computations";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import { areaBbox, syncAreas } from "@/lib/domain/gazetteer/areas";
import { bufferBbox, importLandPolygons } from "@/lib/domain/gazetteer/land";
import { ensureTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { sampleDepths } from "@/lib/domain/geometry/depth";
import { tileBbox, type Bbox } from "@/lib/domain/tiles";
import { DATASET_KINDS, importDataset } from "@/lib/pipeline/datasets";
import { computePlaceGeometry } from "@/lib/pipeline/geometry";
import { withRollback } from "@/test/db";
import { writeGoldenFile } from "@/test/geometry/golden-file";
import { memoryArchive } from "@/test/s3";

// The test area aegina-west (tile q025:813:510, as in the gazetteer run) joins the configured areas.
vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  const { areaConfigSchema } = await import("@/lib/config/schemas");
  const { readFileSync: read } = await import("node:fs");
  const testArea = areaConfigSchema.parse(JSON.parse(read("test/fixtures/areas/aegina-west.json", "utf8")));
  const getConfig = () => ({ ...original.getConfig(), areas: [...original.getConfig().areas, testArea] });
  return {
    ...original,
    getConfig,
    areaByKey: (key: string) => {
      const found = getConfig().areas.find((a) => a.key === key);
      if (!found) throw new Error(`Unknown area ${key}`);
      return found;
    },
  };
});

// Rate limiting is covered by the http tests; its bucket rows would stay locked by the long test transaction.
vi.mock("@/lib/domain/rate-limit", () => ({ takeToken: async () => ({ ok: true }) }));

// Land for 55 km around the area, the recorded datasets and 50 km rays per place.
vi.setConfig({ testTimeout: 300_000 });

const AREA = "aegina-west";
const TILE = "q025:813:510";
const TODAY = "2026-10-19";
const PLACES_FILE = "test/fixtures/geometry/golden-places.json";
const GOLDEN_FILE = "test/fixtures/geometry/golden.json";
/** Open water of the Saronic Gulf between Agistri and Methana. */
const SEA = { lon: 23.3, lat: 37.62 };
/** Agistri interior. */
const LAND = { lon: 23.345, lat: 37.695 };

/**
 * Perdika (marina way/404738101), Aponisos (islet relation/17897768, the anchorage between it and Agistri) and
 * the Aegina harbour (marina way/614791984 "Aegina Port"): centroids of the objects of the recorded Overpass
 * fixture, as points (a harbour gets the 250 m circle, the anchorage the 600 m circle).
 */
type GoldenPlace = { name: string; kind: PlaceKind; lon: number; lat: number };

type Golden = {
  sectors: Record<Sector, number>;
  swell: number;
  opening: { bearingDeg: number | null; widthDeg: number };
  depth: { approach: Record<string, number | null> | null; min: number | null; max: number | null } | null;
  seabed: Array<{ type: string; share: number }> | null;
  anchorAreaM2: number;
};

type GoldenFile = { rulesVersion: string; places: Record<string, Golden> };

/**
 * Datasets with recorded fixtures. Seabed is missing: on 2026-10-19 the EMODnet Seabed Habitats WFS answered no
 * GetFeature request (every layer, even a 2 km box, timed out after 60–300 s), so the golden values carry
 * `seabed: null`. Record it with `fixtures-record --datasets` once the service is back, add it here and
 * regenerate golden.json. Sitelinks are no geometry input (importance signal of the consolidation, ruling M5-P1).
 */
const RECORDED_DATASETS = DATASET_KINDS.filter((kind) => kind !== "seabed" && kind !== "sitelinks");

type LandFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

async function* landFixture(): AsyncGenerator<LandFeature> {
  const collection = JSON.parse(readFileSync(`test/fixtures/land/${AREA}.geojson`, "utf8")) as GeoJSON.FeatureCollection;
  for (const f of collection.features) yield f as LandFeature;
}

/** Land, area, tiles and every dataset of the area from the recorded fixtures (never the network). */
async function prepareArea(db: Db): Promise<void> {
  const area = areaByKey(AREA);
  await importLandPolygons(db, landFixture(), bufferBbox(areaBbox(area), getConfig().gazetteer.landBufferKm), "fixture");
  const ids = await syncAreas(db, [area]);
  await ensureTiles(db, area, ids);
  const deps = { transport: fixtureTransport(), archive: memoryArchive() };
  for (const kind of RECORDED_DATASETS) await importDataset(db, kind, { area, now: new Date(`${TODAY}T12:00:00Z`) }, deps);
}

const point = (lon: number, lat: number): GeoJSON.Point => ({ type: "Point", coordinates: [lon, lat] });

const geoTypeOf = (kind: PlaceKind): GeoObjectType => (kind === "port" || kind === "marina" ? "harbour" : "bay");

/** A candidate place on a point geo object at the golden coordinates; returns its id and geo object id. */
async function insertPlace(db: Db, p: GoldenPlace): Promise<{ placeId: string; geoObjectId: string; tileId: string | null }> {
  const geom = sql`${geomFromGeoJson(point(p.lon, p.lat))}`;
  const [object] = await db.insert(geoObjects).values({ type: geoTypeOf(p.kind), origin: "osm", geom }).returning({ id: geoObjects.id });
  const [place] = await db
    .insert(places)
    .values({ geoObjectId: object!.id, kind: p.kind, status: "candidate", position: geom })
    .returning({ id: places.id, tileId: places.tileId });
  return { placeId: place!.id, geoObjectId: object!.id, tileId: place!.tileId };
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** The golden values of a place from its newest computations. */
async function goldenOf(db: Db, geoObjectId: string): Promise<Golden> {
  const stored = await latestComputations(db, geoObjectId);
  const fact = (attribute: string) => [...stored.values()].flatMap((c) => c.facts).find((f) => f.attribute === attribute)?.value;
  const num = (attribute: string) => {
    const v = fact(attribute);
    return typeof v === "number" ? v : null;
  };
  const sectors = Object.fromEntries(SECTORS.map((s) => [s, round(num(`shelter.${s}`) ?? NaN, 3)])) as Record<Sector, number>;
  // A missing fact becomes NaN or undefined: the comparison reports it, and `writeGoldenFile` refuses to store it.
  const open = fact("opening_bearing") as { bearingDeg: number | null; widthDeg: number } | undefined;
  const approach = (fact("depth.approach") as Record<string, number | null> | undefined) ?? null;
  const min = num("depth.min");
  const max = num("depth.max");
  const seabed = (fact("seabed") as Array<{ type: string; share: number }> | undefined) ?? null;
  const area = fact("anchor_area") as { areaM2: number } | undefined;
  return {
    sectors,
    swell: round(num("swell_protection") ?? NaN, 3),
    opening: open
      ? { bearingDeg: open.bearingDeg === null ? null : round(open.bearingDeg, 1), widthDeg: round(open.widthDeg, 1) }
      : { bearingDeg: null, widthDeg: NaN },
    depth: approach === null && min === null && max === null ? null : { approach, min, max },
    seabed: seabed?.map((s) => ({ type: s.type, share: round(s.share, 3) })) ?? null,
    anchorAreaM2: Math.round(area?.areaM2 ?? 0),
  };
}

/** Differences beyond the tolerances of the golden test, one line each. */
function deviations(name: string, actual: Golden, expected: Golden): string[] {
  const out: string[] = [];
  const share = (what: string, a: number, e: number) => {
    if (!(Math.abs(a - e) <= 0.1)) out.push(`${name} ${what}: ${a} vs golden ${e} (tolerance 0.1)`);
  };
  const angle = (what: string, a: number | null, e: number | null, circular: boolean) => {
    if (a === null || e === null) {
      if (a !== e) out.push(`${name} ${what}: ${a} vs golden ${e}`);
      return;
    }
    const d = Math.abs(a - e) % 360;
    if (!((circular ? Math.min(d, 360 - d) : Math.abs(a - e)) <= 10)) out.push(`${name} ${what}: ${a}° vs golden ${e}° (tolerance 10°)`);
  };
  const metric = (what: string, a: number | null | undefined, e: number | null | undefined) => {
    if (a === null || a === undefined || e === null || e === undefined) {
      if ((a ?? null) !== (e ?? null)) out.push(`${name} ${what}: ${a} vs golden ${e}`);
      return;
    }
    const tolerance = Math.max(Math.abs(e) * 0.1, 1);
    if (!(Math.abs(a - e) <= tolerance)) out.push(`${name} ${what}: ${a} vs golden ${e} (tolerance ${round(tolerance, 1)})`);
  };

  for (const s of SECTORS) share(`shelter.${s}`, actual.sectors[s], expected.sectors[s]);
  share("swell", actual.swell, expected.swell);
  angle("opening.bearingDeg", actual.opening.bearingDeg, expected.opening.bearingDeg, true);
  angle("opening.widthDeg", actual.opening.widthDeg, expected.opening.widthDeg, false);
  if (actual.depth === null || expected.depth === null) {
    if (actual.depth !== expected.depth) out.push(`${name} depth: ${JSON.stringify(actual.depth)} vs golden ${JSON.stringify(expected.depth)}`);
  } else {
    metric("depth.min", actual.depth.min, expected.depth.min);
    metric("depth.max", actual.depth.max, expected.depth.max);
    const keys = new Set([...Object.keys(actual.depth.approach ?? {}), ...Object.keys(expected.depth.approach ?? {})]);
    for (const k of keys) metric(`depth.approach.${k}`, actual.depth.approach?.[k], expected.depth.approach?.[k]);
  }
  const types = (s: Golden["seabed"]) => (s === null ? "null" : [...new Set(s.map((x) => x.type))].sort().join(","));
  if (types(actual.seabed) !== types(expected.seabed)) {
    out.push(`${name} seabed types: ${types(actual.seabed)} vs golden ${types(expected.seabed)}`);
  }
  metric("anchorAreaM2", actual.anchorAreaM2, expected.anchorAreaM2);
  return out;
}

describe("recorded dataset fixtures (aegina-west)", () => {
  it("bathymetry is lon/lat oriented with positive depths at sea; restricted areas and roads lie in the box", () =>
    withRollback(async (db) => {
      await prepareArea(db);

      // Lon/lat order: the raster rows of the area tile cover exactly the tile box, depth is positive at sea and
      // absent on Agistri (swapped axes would put the raster near 23° N / 37° E, i.e. on land in Arabia).
      const [w, s, e, n] = tileBbox(TILE);
      const { rows: extent } = await db.execute<{ w: number; s: number; e: number; n: number }>(sql`
        select ST_XMin(x) as w, ST_YMin(x) as s, ST_XMax(x) as e, ST_YMax(x) as n
        from (select ST_Extent(ST_Envelope(rast))::geometry as x from bathymetry where tile_id = ${TILE}) t`);
      for (const [got, want] of [[extent[0]!.w, w], [extent[0]!.s, s], [extent[0]!.e, e], [extent[0]!.n, n]] as const) {
        expect(Math.abs(Number(got) - want)).toBeLessThan(0.01);
      }
      const [sea] = await sampleDepths(db, SEA, 0, [0]);
      expect(sea).toBeGreaterThan(20);
      expect(await sampleDepths(db, LAND, 0, [0])).toEqual([null]);

      const box: Bbox = bufferBbox(areaBbox(areaByKey(AREA)), getConfig().datasets.bufferKm);
      const env = sql`ST_MakeEnvelope(${box[0]}::float8, ${box[1]}::float8, ${box[2]}::float8, ${box[3]}::float8, 4326)`;
      // Restricted areas and roads: the dataset box (widened by the buffer of cables and aquaculture) holds them;
      // roads run on land.
      const { rows: restricted } = await db.execute<{ n: number; near: boolean }>(sql`
        select count(*)::int as n, coalesce(bool_and(ST_Intersects(geom, ST_Expand(${env}, 0.01))), true) as near
        from restricted_areas where valid_to is null and created_at = now()`);
      expect(restricted[0]!.n).toBeGreaterThan(0);
      expect(restricted[0]!.near).toBe(true);
      const { rows: roads } = await db.execute<{ n: number; land_share: number }>(sql`
        with r as (select ST_Union(geom) as g, count(*)::int as n from roads where created_at = now())
        select r.n, ST_Length(ST_Intersection(r.g, (select ST_Union(geom) from land_polygons where geom && r.g))) / ST_Length(r.g) as land_share
        from r`);
      expect(roads[0]!.n).toBeGreaterThan(0);
      expect(Number(roads[0]!.land_share)).toBeGreaterThan(0.95);
    }));
});

describe("geometry golden test", () => {
  it("Perdika, Aponisos and the Aegina harbour match test/fixtures/geometry/golden.json", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const goldenPlaces = JSON.parse(readFileSync(PLACES_FILE, "utf8")) as GoldenPlace[];

      const actual: GoldenFile = { rulesVersion: getConfig().geometry.rulesVersion, places: {} };
      for (const p of goldenPlaces) {
        const { placeId, geoObjectId, tileId } = await insertPlace(db, p);
        expect(tileId, p.name).toBe(TILE);
        const result = await computePlaceGeometry(db, placeId, { today: TODAY });
        expect(result.created, p.name).toContain("shelter");
        actual.places[p.name] = await goldenOf(db, geoObjectId);
      }

      if (process.env.UPDATE_GOLDEN === "1") {
        writeGoldenFile(GOLDEN_FILE, actual);
        return;
      }
      if (!existsSync(GOLDEN_FILE)) throw new Error(`${GOLDEN_FILE} missing: create it with UPDATE_GOLDEN=1`);
      const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as GoldenFile;
      expect(actual.rulesVersion, "rulesVersion changed: review the values and rerun with UPDATE_GOLDEN=1").toBe(golden.rulesVersion);
      expect(Object.keys(actual.places).sort()).toEqual(Object.keys(golden.places).sort());
      const failures = goldenPlaces.flatMap((p) => deviations(p.name, actual.places[p.name]!, golden.places[p.name]!));
      expect(failures).toEqual([]);
    }));
});

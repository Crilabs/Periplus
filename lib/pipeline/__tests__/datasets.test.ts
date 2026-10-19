import { readFileSync } from "node:fs";
import { eq, like, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { areaByKey, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { externalCalls, geoObjects, runs, tileGeoObjects, wikidataSitelinks } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { areaBbox, syncAreas } from "@/lib/domain/gazetteer/areas";
import { bufferBbox, importLandPolygons } from "@/lib/domain/gazetteer/land";
import { assignTiles } from "@/lib/domain/gazetteer/hierarchy";
import { ensureTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { sampleDepths } from "@/lib/domain/geometry/depth";
import { newId } from "@/lib/domain/ids";
import { tileBbox, type Bbox } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import {
  DATASET_KINDS,
  DATASETS_STAGE,
  importBathymetry,
  importRestrictions,
  importRoads,
  importSeabed,
  importSitelinks,
  importVesselDensity,
} from "@/lib/pipeline/datasets";
import { startDatasetImportRun } from "@/lib/pipeline/datasets-run";
import { importOsm } from "@/lib/pipeline/gazetteer/osm";
import { importWikidata } from "@/lib/pipeline/gazetteer/wikidata";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

// Test areas: aegina-west (tile q025:813:510, as in the gazetteer run) and datasets-unsynced (outside the
// pilot box, never synced, so it has no geo object). Everything else is the real config.
vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  const { areaConfigSchema } = await import("@/lib/config/schemas");
  const { readFileSync: read } = await import("node:fs");
  const testArea = areaConfigSchema.parse(JSON.parse(read("test/fixtures/areas/aegina-west.json", "utf8")));
  const unsynced = areaConfigSchema.parse({
    ...testArea,
    key: "datasets-unsynced",
    polygon: { type: "Polygon", coordinates: [[[21.0, 35.0], [21.25, 35.0], [21.25, 35.25], [21.0, 35.25], [21.0, 35.0]]] },
    tileBbox: [21.0, 35.0, 21.25, 35.25],
  });
  const getConfig = () => ({ ...original.getConfig(), areas: [...original.getConfig().areas, testArea, unsynced] });
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

// Every test imports the land fixture and builds the area's tiles first.
vi.setConfig({ testTimeout: 120_000 });

const AREA = "aegina-west";
const TILE = "q025:813:510";
const SEA = { lon: 23.3, lat: 37.62 };
/** Agistri interior. */
const LAND = { lon: 23.345, lat: 37.695 };

type LandFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

async function* landFixture(): AsyncGenerator<LandFeature> {
  const collection = JSON.parse(readFileSync(`test/fixtures/land/${AREA}.geojson`, "utf8")) as GeoJSON.FeatureCollection;
  for (const f of collection.features) yield f as LandFeature;
}

/** Land, the area's geo object and its tiles, as a gazetteer run leaves them. */
async function prepareArea(db: Db): Promise<void> {
  const area = areaByKey(AREA);
  await importLandPolygons(db, landFixture(), bufferBbox(areaBbox(area), getConfig().gazetteer.landBufferKm), "fixture");
  const ids = await syncAreas(db, [area]);
  await ensureTiles(db, area, ids);
}

/** The box every area dataset request uses: area box plus `datasets.bufferKm`. */
const datasetBox = (): Bbox => bufferBbox(areaBbox(areaByKey(AREA)), getConfig().datasets.bufferKm);

/** [west, south, east, north] from `Long(w,e)` / `Lat(s,n)` subsets of a WCS URL. */
function subsetBox(url: string): Bbox {
  const subsets = new URL(url).searchParams.getAll("subset");
  const pair = (axis: string) => {
    const m = new RegExp(`^${axis}\\(([-\\d.]+),([-\\d.]+)\\)$`).exec(subsets.find((s) => s.startsWith(`${axis}(`)) ?? "");
    if (!m) throw new Error(`no ${axis} subset in ${url}`);
    return [Number(m[1]), Number(m[2])];
  };
  const [west, east] = pair("Long");
  const [south, north] = pair("Lat");
  return [west!, south!, east!, north!];
}

/** `bbox` param of a WFS URL. */
const wfsBox = (url: string) => new URL(url).searchParams.get("bbox")!.split(",").slice(0, 4).map(Number);

const PIXEL_DEG = 0.0025;

/**
 * A synthetic EMODnet DTM answer for `box`: GeoTIFF (EPSG:4326, 32BF) with elevation −20 m in water and
 * nodata (−9999) on the land polygons, as the DTM has no values on land.
 */
async function dtmTiff(db: Db, [west, south, east, north]: Bbox): Promise<Uint8Array> {
  const width = Math.round((east - west) / PIXEL_DEG);
  const height = Math.round((north - south) / PIXEL_DEG);
  const { rows } = await db.execute<{ bytes: Buffer }>(sql`
    with r as (
      select ST_AddBand(
        ST_MakeEmptyRaster(${width}::int, ${height}::int, ${west}::float8, ${north}::float8,
          ${PIXEL_DEG}::float8, ${-PIXEL_DEG}::float8, 0::float8, 0::float8, 4326),
        '32BF'::text, -20::float8, -9999::float8) as rast
    ),
    land as (
      select ST_Union(geom) as g from land_polygons
      where geom && ST_MakeEnvelope(${west}::float8, ${south}::float8, ${east}::float8, ${north}::float8, 4326)
    )
    select ST_AsGDALRaster(case when land.g is null then r.rast else ST_SetValue(r.rast, 1, land.g, -9999) end, 'GTiff') as bytes
    from r, land`);
  return new Uint8Array(rows[0]!.bytes);
}

type Fc = { type: "FeatureCollection"; features: GeoJSON.Feature[] };
const fc = (features: GeoJSON.Feature[]): Fc => ({ type: "FeatureCollection", features });
const rect = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

/** Scripted services: DTM tiles from the DB, WFS layers by type name, Overpass answers by query kind. */
function scriptedServices(
  db: Db,
  answers: { seabed?: Fc; layers?: Record<string, Fc>; cables?: unknown[]; roads?: unknown[]; sitelinks?: Record<string, number> } = {},
) {
  const seen: HttpRequest[] = [];
  const json = (value: unknown) => makeResponse(200, new TextEncoder().encode(JSON.stringify(value)));
  const transport: Transport = async (req) => {
    seen.push(req);
    switch (req.service) {
      case "emodnet-bathymetry":
      case "emodnet-vessel-density":
        return makeResponse(200, await dtmTiff(db, subsetBox(req.url)));
      case "emodnet-seabed":
        return json(answers.seabed ?? fc([]));
      case "emodnet-human-activities":
        return json(answers.layers?.[new URL(req.url).searchParams.get("typeNames")!] ?? fc([]));
      case "overpass": {
        const ql = decodeURIComponent(req.body!.replace(/^data=/, ""));
        return json({ elements: (ql.includes("cable_submarine") ? answers.cables : answers.roads) ?? [] });
      }
      case "wikidata": {
        const ids = new URL(req.url).searchParams.get("ids")!.split("|");
        const links = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`wiki${i}`, { site: `wiki${i}`, title: "T" }]));
        return json({ entities: Object.fromEntries(ids.map((id) => [id, { type: "item", id, sitelinks: links(answers.sitelinks?.[id] ?? 0) }])) });
      }
      default:
        throw new Error(`unexpected service ${req.service}`);
    }
  };
  return { transport, seen };
}

const way = (id: number, tags: Record<string, string>, points: Array<[lon: number, lat: number]>) => ({
  type: "way",
  id,
  tags,
  geometry: points.map(([lon, lat]) => ({ lon, lat })),
});

describe("importBathymetry", () => {
  it("importBathymetry stores rasters per tile; a sea point has positive depth, a land point none", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const { transport, seen } = scriptedServices(db);
      const archive = memoryArchive();
      const runId = newId();

      const result = await importBathymetry(db, { area: areaByKey(AREA), runId }, { transport, archive });

      // The coast tile and its 8 neighbours, each requested with exactly its box.
      expect(result).toEqual({ tiles: 9, rasterTiles: 9, reused: 0 });
      expect(seen).toHaveLength(9);
      expect(seen.map((r) => subsetBox(r.url))).toContainEqual(tileBbox(TILE));
      expect(archive.keys()).toContain(`datasets/emodnet-bathymetry/2024/${TILE}.tif`);
      const [sea] = await sampleDepths(db, SEA, 0, [0]);
      expect(sea).toBeGreaterThan(5);
      expect(await sampleDepths(db, LAND, 0, [0])).toEqual([null]);

      const calls = await db.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(calls).toHaveLength(9);
      expect(calls.every((c) => c.service === "emodnet-bathymetry" && c.stage === DATASETS_STAGE)).toBe(true);
      expect(calls.map((c) => c.tileId)).toContain(TILE);
    }));

  it("a second bathymetry import reuses the archived tif without HTTP", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const archive = memoryArchive();
      await importBathymetry(db, { area: areaByKey(AREA) }, { transport: scriptedServices(db).transport, archive });

      const { transport, seen } = scriptedServices(db);
      const again = await importBathymetry(db, { area: areaByKey(AREA) }, { transport, archive });
      expect(seen).toHaveLength(0);
      expect(again).toEqual({ tiles: 9, rasterTiles: 9, reused: 9 });
      const { rows } = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from bathymetry where dataset = 'emodnet-dtm' and tile_id = ${TILE}`,
      );
      expect(rows[0]!.n).toBe(1);
    }));
  it("a downloaded tile that cannot be imported is not archived; the next import downloads it again", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const archive = memoryArchive();
      const good = scriptedServices(db);
      // TIFF magic bytes (passes the adapter's check) but no raster PostGIS can read.
      const broken: Transport = async (req) =>
        subsetBox(req.url).join() === tileBbox(TILE).join() ? makeResponse(200, new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2, 3])) : good.transport(req);

      // The savepoint keeps the outer test transaction usable after the failed raster import.
      await expect(
        db.transaction((tx) => importBathymetry(tx, { area: areaByKey(AREA) }, { transport: broken, archive })),
      ).rejects.toThrow();
      expect(archive.keys()).not.toContain(`datasets/emodnet-bathymetry/2024/${TILE}.tif`);

      const { transport, seen } = scriptedServices(db);
      const again = await importBathymetry(db, { area: areaByKey(AREA) }, { transport, archive });
      expect(seen.map((r) => subsetBox(r.url))).toContainEqual(tileBbox(TILE));
      expect(again.rasterTiles).toBe(9);
      expect(archive.keys()).toContain(`datasets/emodnet-bathymetry/2024/${TILE}.tif`);
    }));
});

describe("importSeabed", () => {
  it("seabed features lie inside the requested box", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const box = datasetBox();
      const seabed = fc([
        { type: "Feature", id: "eusm.1", properties: { substrate: "Sand", eunis2019d: "Infralittoral sand" }, geometry: rect(23.27, 37.56, 23.31, 37.6) },
        // Reaches 2 km past the west edge of the box: cut to the box.
        { type: "Feature", id: "eusm.2", properties: { substrate: "Mud" }, geometry: rect(box[0] - 0.03, 37.6, box[0] + 0.02, 37.62) },
        { type: "Feature", id: "eusm.3", properties: { substrate: "Sand", eunis2019d: "Posidonia oceanica meadows" }, geometry: rect(23.32, 37.56, 23.34, 37.58) },
        { type: "Feature", id: "eusm.4", properties: { substrate: "Bedrock?" }, geometry: rect(23.36, 37.56, 23.38, 37.58) },
      ]);
      const { transport, seen } = scriptedServices(db, { seabed });
      const archive = memoryArchive();

      const result = await importSeabed(db, { area: areaByKey(AREA) }, { transport, archive });

      expect(result.features).toBe(3);
      expect(result.unmapped).toBe(1);
      expect(result.version).toMatch(/^[0-9a-f]{12}$/);
      expect(seen).toHaveLength(1);
      expect(wfsBox(seen[0]!.url)).toEqual(box);
      expect(archive.keys()).toEqual([`datasets/emodnet-seabed/${result.version}/${AREA}/0.json`]);

      const { rows } = await db.execute<{ substrate: string; inside: boolean; version: string }>(sql`
        select substrate::text, dataset_version as version,
               ST_CoveredBy(geom, ST_MakeEnvelope(${box[0]}::float8, ${box[1]}::float8, ${box[2]}::float8, ${box[3]}::float8, 4326)) as inside
        from seabed_polygons where area_key = ${AREA} order by substrate`);
      expect(rows.map((r) => r.substrate)).toEqual(["mud", "sand", "weed"]);
      expect(rows.every((r) => r.inside && r.version === result.version)).toBe(true);
    }));
});

describe("importRestrictions", () => {
  it("restrictions: cable lines become 200 m polygons; re-import changes nothing", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const box = datasetBox();
      const outsideLat = box[1] - 0.0009; // ≈ 100 m south of the box: only its buffer reaches in
      const layers = {
        "emodnet:militaryareaspoly": fc([
          { type: "Feature", id: "militaryareaspoly.7", properties: { name: "Firing area" }, geometry: rect(23.27, 37.52, 23.29, 37.54) },
        ]),
        "emodnet:natura2000areas": fc([
          { type: "Feature", id: "natura.1", properties: { sitecode: "GR3000005" }, geometry: rect(23.4, 37.52, 23.42, 37.54) },
        ]),
        "emodnet:finfish": fc([
          { type: "Feature", id: "finfish.3", properties: { gid: 42 }, geometry: { type: "Point", coordinates: [23.31, 37.53] } },
        ]),
      };
      const cables = [
        way(101, { "seamark:type": "cable_submarine" }, [[23.28, 37.58], [23.32, 37.58]]),
        way(102, { power: "cable", location: "underground" }, [[23.48, 37.73], [23.5, 37.73]]), // on Aegina: dropped
        way(103, { telecom: "line", location: "underwater" }, [[23.3, outsideLat], [23.35, outsideLat]]),
      ];
      const archive = memoryArchive();
      const today = new Date("2026-10-19T12:00:00Z");
      const first = scriptedServices(db, { layers, cables });

      const result = await importRestrictions(db, { area: areaByKey(AREA), now: today }, { transport: first.transport, archive });

      const counts = (inserted: number) => ({ inserted, updated: 0, unchanged: 0, ended: 0 });
      expect(result).toEqual({ military: counts(1), protected_area: counts(1), aquaculture: counts(1), cable: counts(2) });
      // Buffered layers are requested for the box widened by their buffer.
      const finfish = first.seen.find((r) => r.url.includes("finfish"))!;
      expect(wfsBox(finfish.url)).toEqual(bufferBbox(box, 0.25));
      const military = first.seen.find((r) => r.url.includes("militaryareaspoly"))!;
      expect(wfsBox(military.url)).toEqual(box);
      const cableQuery = decodeURIComponent(first.seen.find((r) => r.service === "overpass")!.body!);
      const cableBox = bufferBbox(box, 0.2);
      expect(cableQuery).toContain(`(${cableBox[1]},${cableBox[0]},${cableBox[3]},${cableBox[2]})`);
      expect(archive.keys()).toEqual(
        [
          `datasets/emodnet-human-activities/2026-10-19/${AREA}/emodnet:finfish-0.json`,
          `datasets/emodnet-human-activities/2026-10-19/${AREA}/emodnet:militaryareaspoly-0.json`,
          `datasets/emodnet-human-activities/2026-10-19/${AREA}/emodnet:natura2000areas-0.json`,
          `datasets/emodnet-human-activities/2026-10-19/${AREA}/emodnet:shellfish-0.json`,
          `datasets/osm-cables/2026-10-19/${AREA}.json`,
        ].sort(),
      );

      const { rows } = await db.execute<{ kind: string; source_ref: string; type: string; area_m2: number }>(sql`
        select kind::text, source_ref, ST_GeometryType(geom) as type, ST_Area(geom::geography) as area_m2
        from restricted_areas
        where valid_to is null and valid_from = '2026-10-19'
          and (source_ref like 'emodnet:%' or source_ref like 'osm-cable:%')
          and geom && ST_MakeEnvelope(23.0, 37.0, 23.75, 38.0, 4326)
        order by source_ref`);
      expect(rows.map((r) => [r.kind, r.source_ref, r.type])).toEqual([
        ["aquaculture", "emodnet:finfish/42", "ST_Polygon"],
        ["military", "emodnet:militaryareaspoly/militaryareaspoly.7", "ST_Polygon"],
        ["protected_area", "emodnet:natura2000areas/GR3000005", "ST_Polygon"],
        ["cable", "osm-cable:way/101", "ST_Polygon"],
        ["cable", "osm-cable:way/103", "ST_Polygon"],
      ]);
      const finfishArea = Number(rows[0]!.area_m2);
      expect(finfishArea / (Math.PI * 250 ** 2)).toBeCloseTo(1, 1);

      // The cable polygon edge lies 200 m from the cable line.
      const { rows: widths } = await db.execute<{ d: number }>(sql`
        select ST_Distance(ST_Boundary(r.geom)::geography,
          ST_SetSRID(ST_MakeLine(ST_MakePoint(23.28, 37.58), ST_MakePoint(23.32, 37.58)), 4326)::geography) as d
        from restricted_areas r where r.source_ref = 'osm-cable:way/101' and r.valid_to is null`);
      expect(Number(widths[0]!.d)).toBeGreaterThan(198);
      expect(Number(widths[0]!.d)).toBeLessThan(201);

      const again = await importRestrictions(
        db,
        { area: areaByKey(AREA), now: today },
        { transport: scriptedServices(db, { layers, cables }).transport, archive },
      );
      const same = (unchanged: number) => ({ inserted: 0, updated: 0, unchanged, ended: 0 });
      expect(again).toEqual({ military: same(1), protected_area: same(1), aquaculture: same(1), cable: same(2) });
    }));
});

describe("importVesselDensity and importRoads", () => {
  it("vessel density is downloaded once per area and archived", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const archive = memoryArchive();
      const first = scriptedServices(db);
      const result = await importVesselDensity(db, { area: areaByKey(AREA) }, { transport: first.transport, archive });
      expect(result).toMatchObject({ key: `datasets/emodnet-vessel-density/2024/${AREA}.tif`, reused: false });
      expect(first.seen.map((r) => [r.service, subsetBox(r.url)])).toEqual([["emodnet-vessel-density", datasetBox()]]);
      expect(new URL(first.seen[0]!.url).searchParams.getAll("subset")).toContain('time("2024-01-01T00:00:00.000Z")');

      const second = scriptedServices(db);
      expect(await importVesselDensity(db, { area: areaByKey(AREA) }, { transport: second.transport, archive })).toMatchObject({
        reused: true,
      });
      expect(second.seen).toHaveLength(0);
    }));

  it("roads are stored per way; a rerun keeps them, a vanished way is removed", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const roads = [
        way(201, { highway: "residential" }, [[23.43, 37.745], [23.44, 37.746]]),
        way(202, { highway: "track" }, [[23.35, 37.69], [23.346, 37.695], [23.34, 37.70]]),
        way(203, {}, [[23.36, 37.69], [23.37, 37.69]]),
      ];
      const archive = memoryArchive();
      const first = scriptedServices(db, { roads });
      const result = await importRoads(db, { area: areaByKey(AREA) }, { transport: first.transport, archive });
      expect(result).toMatchObject({ roads: 2, removed: 0 });
      expect(archive.keys()).toEqual([`datasets/osm-roads/${result.version}/${AREA}.json`]);
      const query = decodeURIComponent(first.seen[0]!.body!);
      expect(query).toContain('way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)$"]');

      const again = await importRoads(db, { area: areaByKey(AREA) }, { transport: scriptedServices(db, { roads }).transport, archive });
      expect(again).toEqual({ roads: 2, removed: 0, version: result.version });

      const later = await importRoads(
        db,
        { area: areaByKey(AREA) },
        { transport: scriptedServices(db, { roads: roads.slice(1) }).transport, archive },
      );
      expect(later).toMatchObject({ roads: 1, removed: 1 });
      expect(later.version).not.toBe(result.version);
      const stored = await db.execute<{ osm_id: string; highway: string }>(
        sql`select osm_id, highway from roads where osm_id in ('way/201', 'way/202', 'way/203') order by osm_id`,
      );
      expect(stored.rows).toEqual([{ osm_id: "way/202", highway: "track" }]);
    }));
});

describe("importSitelinks", () => {
  /** A valid object with the Wikidata id `qid` (fixed per test, in a range no other test uses) in the area's tile. */
  async function itemInTile(db: Db, qid: string, type: "island" | "bay" = "bay"): Promise<string> {
    const [o] = await db
      .insert(geoObjects)
      .values({ type, origin: "wikidata", wikidataId: qid, geom: geomFromGeoJson({ type: "Point", coordinates: [SEA.lon, SEA.lat] }) })
      .returning({ id: geoObjects.id });
    await db.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: o!.id });
    return qid;
  }

  it("sitelinks fetched within 30 days are reused without a call", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const [fresh, stale, unknown] = [await itemInTile(db, "Q930000001"), await itemInTile(db, "Q930000002"), await itemInTile(db, "Q930000003", "island")];
      const now = new Date("2026-10-19T12:00:00Z");
      await db.insert(wikidataSitelinks).values([
        { wikidataId: fresh, sitelinks: 4, fetchedAt: new Date("2026-09-25T12:00:00Z") },
        { wikidataId: stale, sitelinks: 1, fetchedAt: new Date("2026-09-18T12:00:00Z") },
      ]);
      const { transport, seen } = scriptedServices(db, { sitelinks: { [stale]: 12, [unknown]: 3 } });
      const runId = newId();

      expect(await importSitelinks(db, { area: areaByKey(AREA), runId, now }, { transport })).toEqual({ fetched: 2, reused: 1 });
      expect(seen.map((r) => new URL(r.url).searchParams.get("ids"))).toEqual([[stale, unknown].sort().join("|")]);
      const stored = await db
        .select({ id: wikidataSitelinks.wikidataId, n: wikidataSitelinks.sitelinks, at: wikidataSitelinks.fetchedAt })
        .from(wikidataSitelinks)
        .where(sql`${wikidataSitelinks.wikidataId} in (${fresh}, ${stale}, ${unknown})`)
        .orderBy(wikidataSitelinks.wikidataId);
      expect(new Map(stored.map((r) => [r.id, [r.n, r.at.toISOString()]]))).toEqual(
        new Map([
          [fresh, [4, "2026-09-25T12:00:00.000Z"]],
          [stale, [12, now.toISOString()]],
          [unknown, [3, now.toISOString()]],
        ]),
      );
      const calls = await db.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(calls.map((c) => [c.service, c.operation, c.stage])).toEqual([["wikidata", "sitelink_counts", DATASETS_STAGE]]);

      // a day later everything is fresh: no call at all
      const again = scriptedServices(db);
      expect(await importSitelinks(db, { area: areaByKey(AREA), now: new Date("2026-10-20T12:00:00Z") }, { transport: again.transport })).toEqual({
        fetched: 0,
        reused: 3,
      });
      expect(again.seen).toHaveLength(0);
    }));

  it("the recorded counts of the area's gazetteer objects (fixtures:record --datasets sitelinks)", () =>
    withRollback(async (db) => {
      // the gazetteer as the recording built it: OSM and Wikidata from their fixtures, objects linked to the tile
      await prepareArea(db);
      const replay = fixtureTransport();
      const runId = newId();
      await importOsm(db, { area: areaByKey(AREA), runId }, { transport: replay, archive: memoryArchive() });
      await importWikidata(db, { area: areaByKey(AREA), runId }, { transport: replay });
      await assignTiles(db, AREA);

      expect(await importSitelinks(db, { area: areaByKey(AREA), runId }, { transport: replay })).toEqual({ fetched: 123, reused: 0 });
      const rows = await db
        .select({ id: wikidataSitelinks.wikidataId, n: wikidataSitelinks.sitelinks })
        .from(wikidataSitelinks)
        .where(sql`${wikidataSitelinks.wikidataId} in ('Q191082', 'Q539983')`)
        .orderBy(wikidataSitelinks.wikidataId);
      // Aegina and Agistri, as Wikidata counted them on 2026-10-19
      expect(rows).toEqual([
        { id: "Q191082", n: 69 },
        { id: "Q539983", n: 39 },
      ]);
      const calls = await db.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(calls.filter((c) => c.operation === "sitelink_counts")).toHaveLength(3);
    }));

  it("an ended object or one outside the area's tiles is not asked for", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const ended = await itemInTile(db, "Q930000011");
      await db.execute(sql`update geo_objects set valid_to = current_date where wikidata_id = ${ended}`);
      await db.insert(geoObjects).values({ type: "bay", origin: "wikidata", wikidataId: "Q930000012", geom: geomFromGeoJson({ type: "Point", coordinates: [SEA.lon, SEA.lat] }) });
      const { transport, seen } = scriptedServices(db);
      expect(await importSitelinks(db, { area: areaByKey(AREA) }, { transport })).toEqual({ fetched: 0, reused: 0 });
      expect(seen).toHaveLength(0);
    }));
});

describe("stage datasets.import", () => {
  const stage = STAGES[DATASETS_STAGE]!;

  it("stage plans one job per requested dataset", () =>
    withRollback(async (db) => {
      expect(stage.queue).toBe("datasets.import");
      const run = { id: newId(), params: { areaKey: AREA, datasets: ["seabed", "bathymetry"] } };
      expect(await stage.plan(db, run)).toEqual([
        { key: `seabed:${AREA}`, dataset: "seabed", areaKey: AREA },
        { key: `bathymetry:${AREA}`, dataset: "bathymetry", areaKey: AREA },
      ]);
      const all = await stage.plan(db, { id: newId(), params: { areaKey: AREA } });
      expect(all.map((j) => j.dataset)).toEqual([...DATASET_KINDS]);
      await expect(stage.plan(db, { id: newId(), params: { areaKey: AREA, datasets: ["tides"] } })).rejects.toThrow(
        "unknown dataset tides",
      );
      await expect(stage.plan(db, { id: newId(), params: { areaKey: "nowhere-test" } })).rejects.toThrow("Unknown area");
    }));
});

describe("startDatasetImportRun", () => {
  function recordingBoss() {
    const inserted: Array<{ queue: string; data: unknown }> = [];
    const boss = {
      insert: async (queue: string, jobs: Array<{ id: string; data: unknown }>) => {
        inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
        return jobs.map((j) => j.id);
      },
    } as unknown as PgBoss;
    return { boss, inserted };
  }

  it("creates the area run and enqueues one job per dataset", () =>
    withRollback(async (db) => {
      await prepareArea(db);
      const { boss, inserted } = recordingBoss();
      const { id } = await startDatasetImportRun(db, boss, AREA, "test", ["roads"]);
      const [run] = await db.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ scopeType: "area", scopeId: AREA, params: { areaKey: AREA, datasets: ["roads"] } });
      expect(inserted).toEqual([
        { queue: "datasets.import", data: { key: `roads:${AREA}`, dataset: "roads", areaKey: AREA, runId: id, stage: DATASETS_STAGE } },
      ]);
    }));

  it("rejects an unknown area, an unknown dataset and an area without geo object before the run exists", () =>
    withRollback(async (db) => {
      const { boss, inserted } = recordingBoss();
      await expect(startDatasetImportRun(db, boss, "nowhere-test", "test")).rejects.toThrow("Unknown area nowhere-test");
      await expect(startDatasetImportRun(db, boss, "datasets-unsynced", "test")).rejects.toThrow(/no geo object/);
      await expect(
        startDatasetImportRun(db, boss, "datasets-unsynced", "test", ["tides" as never]),
      ).rejects.toThrow("unknown dataset tides");
      expect(await db.select().from(runs).where(like(runs.scopeId, "datasets-unsynced"))).toEqual([]);
      expect(await db.select().from(runs).where(eq(runs.scopeId, "nowhere-test"))).toEqual([]);
      expect(inserted).toEqual([]);
    }));
});

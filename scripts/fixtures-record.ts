import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { unzipSync } from "fflate";
import { searchOrganic } from "../lib/adapters/dataforseo";
import { createFirecrawlConverter } from "../lib/adapters/fetch/firecrawl";
import { createJinaConverter } from "../lib/adapters/fetch/jina";
import { createGeonamesSource } from "../lib/adapters/geonames";
import { fetchTransport, makeResponse, RetryableHttpError, type Transport } from "../lib/adapters/http";
import { fixtureTransport, recordingTransport } from "../lib/adapters/http-fixtures";
import type { Archive } from "../lib/adapters/s3";
import { embedTexts } from "../lib/adapters/voyage";
import { getConfig, type AreaConfig, type DiscoveryConfig } from "../lib/config";
import { areaConfigSchema } from "../lib/config/schemas";
import { createDb, type Db } from "../lib/db/client";
import { areaBbox, syncAreas } from "../lib/domain/gazetteer/areas";
import { ensureTiles } from "../lib/domain/gazetteer/tiles-ensure";
import { bufferBbox, importLandPolygons } from "../lib/domain/gazetteer/land";
import { createRun } from "../lib/domain/runs";
import type { Bbox } from "../lib/domain/tiles";
import { DATASET_KINDS, DATASETS_STAGE, importDataset } from "../lib/pipeline/datasets";
import { GEONAMES_STAGE, importGeonames } from "../lib/pipeline/gazetteer/geonames";
import { importOsm } from "../lib/pipeline/gazetteer/osm";
import { importWikidata } from "../lib/pipeline/gazetteer/wikidata";
import { landImportBbox, readShapefile } from "./import-land-polygons";

const USAGE =
  "usage: fixtures-record.ts --area <key> [--land <path/land_polygons.shp>] [--cache <dir>] [--datasets | --serp [--limit <1-3>]]\n" +
  "       fixtures-record.ts --converters <url> [<url> <url>]\n" +
  "       fixtures-record.ts --voyage";
/** Real DataForSEO searches one `--serp` recording may make. */
const MAX_SERP_CALLS = 3;
/** Pages one `--converters` recording sends to each paid converter (Jina, Firecrawl). */
const MAX_CONVERTER_URLS = 3;
const FIXTURES = "test/fixtures";
const ATTEMPTS = 3;
const RETRY_WAIT_MS = 90_000;

type LandFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

export type AreaRecordArgs = { area: string; land?: string; cache?: string; datasets: boolean; serp: boolean; limit?: number };
export type RecordArgs = AreaRecordArgs | { converters: string[] } | { voyage: true };

/** The two texts of the recorded Voyage answer (`--voyage`); the embedding tests send exactly these. */
export const VOYAGE_RECORDING_TEXTS = [
  "Aegina harbour gives good shelter from the meltemi; anchor in sand at five metres off the town quay.",
  "Die Bucht von Perdika ist bei Nordwind gut geschützt, Ankergrund Sand und Seegras auf sechs Metern.",
] as const;

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * `--area`, `--land`, `--cache`, `--limit` take a value; `--datasets` (record the dataset imports only) and
 * `--serp` (record at most `--limit` ≤ 3 area SERP searches, default 3) take none. `--converters` takes 1–3
 * page URLs and stands alone (no area), as does `--voyage` (one embedding call).
 */
export function parseArgs(argv: string[]): RecordArgs {
  if (argv[0] === "--voyage") {
    if (argv.length !== 1) throw new Error(USAGE);
    return { voyage: true };
  }
  if (argv[0] === "--converters") {
    const urls = argv.slice(1);
    if (urls.length < 1 || urls.length > MAX_CONVERTER_URLS || !urls.every(isHttpUrl)) throw new Error(USAGE);
    return { converters: urls };
  }
  const values = new Map<string, string>();
  let datasets = false;
  let serp = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--converters" || flag === "--voyage") throw new Error(USAGE);
    if (flag === "--datasets" || flag === "--serp") {
      if (flag === "--datasets") datasets = true;
      else serp = true;
      continue;
    }
    const value = argv[++i];
    if (!["--area", "--land", "--cache", "--limit"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values.set(flag, value);
  }
  const area = values.get("--area");
  if (!area || (datasets && serp)) throw new Error(USAGE);
  const rawLimit = values.get("--limit");
  if (rawLimit !== undefined && !serp) throw new Error(USAGE);
  let limit: number | undefined;
  if (serp) {
    limit = rawLimit === undefined ? MAX_SERP_CALLS : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SERP_CALLS) throw new Error(USAGE);
  }
  return { area, land: values.get("--land"), cache: values.get("--cache"), datasets, serp, ...(serp ? { limit } : {}) };
}

/**
 * The area SERP searches a `--serp` recording makes, from the area's configured names (no database): each
 * area template whose language is one of the area's `sourceLanguages` and has a name, the first `limit`.
 */
export function serpRecordingQueries(
  area: AreaConfig,
  discovery: DiscoveryConfig,
  limit: number,
): Array<{ keyword: string; languageCode: string; locationCode: number }> {
  const names = area.names as Record<string, string | undefined>;
  return discovery.templates.area
    .filter((t) => area.sourceLanguages.includes(t.lang) && names[t.lang])
    .map((t) => ({ keyword: t.template.replaceAll("{name}", names[t.lang]!), languageCode: t.lang, locationCode: t.locationCode }))
    .slice(0, Math.min(limit, MAX_SERP_CALLS));
}

/**
 * Records real DataForSEO answers as fixtures. Calls are booked (budget, `external_calls`) in the database of
 * `DATABASE_URL`, the development database: they cost real money, so no scratch database hides them.
 */
async function recordSerp(area: AreaConfig, limit: number): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { discovery } = getConfig();
  const { db, close } = createDb(url);
  try {
    const recording = recordingTransport(fetchTransport);
    for (const q of serpRecordingQueries(area, discovery, limit)) {
      const { items } = await searchOrganic(recording, q, { db, stage: "fixtures:record" }, discovery.serp);
      process.stdout.write(`serp "${q.keyword}" (${q.languageCode}/${q.locationCode}): ${items.length} organic results\n`);
    }
  } finally {
    await close();
  }
}

/**
 * Records real Jina and Firecrawl answers for each URL (one call per service and URL) as fixtures. Like
 * `--serp`, the calls are booked in the database of `DATABASE_URL` (budgets, `external_calls`).
 */
async function recordConverters(urls: string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { fetch } = getConfig();
  const { db, close } = createDb(url);
  const recording = recordingTransport(fetchTransport);
  const converters = [createJinaConverter(recording, fetch.jina), createFirecrawlConverter(recording, fetch.firecrawl)];
  let failed = 0;
  try {
    for (const page of urls) {
      for (const converter of converters) {
        try {
          const r = await converter.convert(
            { url: page, html: null, boilerplateSelectors: [], render: "auto" },
            { db, stage: "fixtures:record" },
          );
          process.stdout.write(
            `${converter.name} ${page}: ${r.markdown.length} chars, title ${JSON.stringify(r.title)}, ${r.costEur.toFixed(6)} EUR, ${r.durationMs} ms\n`,
          );
        } catch (error) {
          failed++;
          process.stdout.write(`${converter.name} ${page}: failed: ${(error as Error).message}\n`);
        }
      }
    }
  } finally {
    await close();
  }
  if (failed > 0) throw new Error(`${failed} converter call(s) failed`);
}

/**
 * Records one real Voyage answer embedding `VOYAGE_RECORDING_TEXTS`, booked in the database of `DATABASE_URL`
 * (budget `voyage`, `external_calls`).
 */
async function recordVoyage(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const { vectors, tokens } = await embedTexts(
      recordingTransport(fetchTransport),
      [...VOYAGE_RECORDING_TEXTS],
      { db, stage: "fixtures:record" },
      getConfig().embeddings,
    );
    process.stdout.write(`voyage: ${vectors.length} vectors of ${vectors[0]?.length} dimensions, ${tokens} tokens\n`);
  } finally {
    await close();
  }
}

/** Only a throwaway database whose name ends in `_scratch` may be written by the recording. */
export function assertScratchUrl(url: string | undefined): string {
  if (!url) throw new Error("DATABASE_URL is not set");
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_scratch")) throw new Error(`DATABASE_URL must name a *_scratch database, got "${name}"`);
  return url;
}

/** A configured area, else the test area `test/fixtures/areas/<key>.json`. */
function loadArea(key: string): AreaConfig {
  const configured = getConfig().areas.find((a) => a.key === key);
  if (configured) return configured;
  const parsed = areaConfigSchema.parse(JSON.parse(readFileSync(path.join(FIXTURES, "areas", `${key}.json`), "utf8")));
  if (parsed.key !== key) throw new Error(`area file ${key}.json has key ${parsed.key}`);
  return parsed;
}

function memoryArchive(): Archive {
  const store = new Map<string, Uint8Array>();
  return {
    async ensureBucket() {},
    async put(key, body) {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async exists(key) {
      return store.has(key);
    },
    async ping() {
      return true;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries a call that failed with `RetryableHttpError` (429, 5xx, timeout, overload). */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof RetryableHttpError) || attempt >= ATTEMPTS) throw error;
      process.stdout.write(`${label}: ${error.message}; retrying in ${RETRY_WAIT_MS / 1000} s\n`);
      await sleep(RETRY_WAIT_MS);
    }
  }
}

/**
 * The network, or with a cache directory: answers recorded there before, else the network, keeping every
 * 200 answer there. A rerun with the same cache re-cuts the fixtures without calling any service.
 */
function sourceTransport(cache: string | undefined): Transport {
  if (!cache) return fetchTransport;
  const replay = fixtureTransport(cache);
  return async (req) => {
    try {
      return await replay(req);
    } catch (error) {
      if (!(error as Error).message.startsWith("no fixture")) throw error;
    }
    const res = await fetchTransport(req);
    if (res.status === 200) await recordingTransport(async () => res, cache)(req);
    return res;
  };
}

/** Elements with more points than this get their lines thinned. */
const MAX_POINTS = 10_000;
/** Douglas-Peucker tolerance in degrees (~200 m). */
const TOLERANCE_DEG = 0.002;

type LatLon = { lat: number; lon: number };

/** Douglas-Peucker on lon/lat; keeps both end points, so rings assembled from member ways stay closed. */
function simplifyLine(points: LatLon[], tolerance: number): LatLon[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const a = points[first]!;
    const b = points[last]!;
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;
    const len = Math.hypot(dx, dy);
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i]!;
      const dist =
        len === 0 ? Math.hypot(p.lon - a.lon, p.lat - a.lat) : Math.abs(dy * (p.lon - a.lon) - dx * (p.lat - a.lat)) / len;
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

type Member = { type: string; ref: number; role: string; geometry?: LatLon[] };
type CompactElement = { geometry?: LatLon[]; members?: Member[] };

const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;

/** Joins lines sharing end points (either direction) into as few lines as possible. */
function joinLines(lines: LatLon[][]): LatLon[][] {
  const rest = [...lines];
  const out: LatLon[][] = [];
  while (rest.length > 0) {
    let line = rest.shift()!;
    for (let joined = true; joined; ) {
      joined = false;
      for (let i = 0; i < rest.length; i++) {
        const other = rest[i]!;
        const [start, end] = [line[0]!, line.at(-1)!];
        if (same(start, end)) break;
        let next: LatLon[] | undefined;
        if (same(end, other[0]!)) next = [...line, ...other.slice(1)];
        else if (same(end, other.at(-1)!)) next = [...line, ...[...other].reverse().slice(1)];
        else if (same(start, other.at(-1)!)) next = [...other, ...line.slice(1)];
        else if (same(start, other[0]!)) next = [...[...other].reverse(), ...line.slice(1)];
        if (next) {
          line = next;
          rest.splice(i, 1);
          joined = true;
          break;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Overpass answers `out geom` with the full geometry of huge relations (the Aegean Sea, the Balkan
 * peninsula: tens of MB). For elements above `MAX_POINTS`, member ways of the same role are joined into
 * rings (`ST_BuildArea` gets the same area) and every line is thinned, so the fixture stays small.
 */
export function compactOverpass(raw: string): string {
  const answer = JSON.parse(raw) as { elements?: CompactElement[] };
  for (const el of answer.elements ?? []) {
    const lines = [el.geometry, ...(el.members ?? []).map((m) => m.geometry)].filter((l) => l !== undefined);
    if (lines.reduce((n, l) => n + l.length, 0) <= MAX_POINTS) continue;
    if (el.geometry) el.geometry = simplifyLine(el.geometry, TOLERANCE_DEG);
    if (!el.members) continue;
    const byRole = new Map<string, Member[]>();
    const others: Member[] = [];
    for (const m of el.members) {
      if (m.type === "way" && m.geometry?.length) byRole.set(m.role, [...(byRole.get(m.role) ?? []), m]);
      else others.push(m);
    }
    el.members = [
      ...[...byRole].flatMap(([role, members]) =>
        joinLines(members.map((m) => m.geometry!)).map((geometry) => ({
          type: "way",
          ref: members[0]!.ref,
          role,
          geometry: simplifyLine(geometry, TOLERANCE_DEG),
        })),
      ),
      ...others,
    ];
  }
  return JSON.stringify(answer);
}

/** Thins successful Overpass answers and minifies Wikidata's before they are recorded and imported. */
function compacting(inner: Transport): Transport {
  return async (req) => {
    const res = await inner(req);
    if (res.status !== 200) return res;
    if (req.service === "overpass") return makeResponse(200, new TextEncoder().encode(compactOverpass(res.text())));
    if (req.service === "wikidata") {
      return makeResponse(200, new TextEncoder().encode(JSON.stringify(JSON.parse(res.text()))));
    }
    return res;
  };
}

async function* featuresOf(collection: GeoJSON.FeatureCollection): AsyncGenerator<LandFeature> {
  for (const f of collection.features) yield f as LandFeature;
}

/** Writes the land polygons in the box as `test/fixtures/land/<area>.geojson` (6 decimals, ~0.1 m). */
async function exportLand(db: Db, areaKey: string, [west, south, east, north]: Bbox): Promise<number> {
  const { rows } = await db.execute<{ geometry: string }>(sql`
    select ST_AsGeoJSON(geom, 6) as geometry from land_polygons
    where geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
    order by ST_XMin(geom), ST_YMin(geom)`);
  const lines = rows.map((r) => `    { "type": "Feature", "properties": {}, "geometry": ${r.geometry} }`);
  await mkdir(path.join(FIXTURES, "land"), { recursive: true });
  await writeFile(
    path.join(FIXTURES, "land", `${areaKey}.geojson`),
    `{\n  "type": "FeatureCollection",\n  "features": [\n${lines.join(",\n")}\n  ]\n}\n`,
  );
  return rows.length;
}

/** The text file `<country>.txt` inside a GeoNames zip. */
function dumpLines(zip: Uint8Array, country: string): string[] {
  const entry = unzipSync(zip, { filter: (f) => f.name === `${country}.txt` })[`${country}.txt`];
  if (!entry) throw new Error(`${country}.txt missing in GeoNames zip`);
  return new TextDecoder().decode(entry).split("\n").filter(Boolean);
}

/**
 * Cuts the downloaded GeoNames dumps to the box: every row inside it (all feature codes, so the fixture
 * still exercises the feature-code filter) and the alternate names of those rows.
 */
async function writeGeonames(downloads: Map<string, Uint8Array>, countries: string[], baseUrl: string, [west, south, east, north]: Bbox) {
  await mkdir(path.join(FIXTURES, "geonames"), { recursive: true });
  const counts: Record<string, { rows: number; alternates: number }> = {};
  for (const country of countries) {
    const main = downloads.get(`${baseUrl}/${country}.zip`);
    const alt = downloads.get(`${baseUrl}/alternatenames/${country}.zip`);
    if (!main || !alt) throw new Error(`GeoNames dumps for ${country} were not downloaded`);
    const rows = dumpLines(main, country).filter((line) => {
      const c = line.split("\t");
      const lat = Number(c[4]);
      const lon = Number(c[5]);
      return lon >= west && lon < east && lat >= south && lat < north;
    });
    const ids = new Set(rows.map((line) => line.split("\t")[0]));
    const alternates = dumpLines(alt, country).filter((line) => ids.has(line.split("\t")[1] ?? ""));
    await writeFile(path.join(FIXTURES, "geonames", `${country}.txt`), `${rows.join("\n")}\n`);
    await writeFile(path.join(FIXTURES, "geonames", `${country}-alternate.txt`), `${alternates.join("\n")}\n`);
    counts[country] = { rows: rows.length, alternates: alternates.length };
  }
  return counts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("voyage" in args) return recordVoyage();
  if ("converters" in args) return recordConverters(args.converters);
  if (args.serp) return recordSerp(loadArea(args.area), args.limit!);
  const url = assertScratchUrl(process.env.DATABASE_URL);
  const area = loadArea(args.area);
  const { gazetteer } = getConfig();
  // The land import box (area box plus `landBufferKm`, snapped to the tile grid): 50 km fetch rays need it.
  const landBox = landImportBbox(area, gazetteer.landBufferKm);
  const queryBox = bufferBbox(areaBbox(area), gazetteer.bboxBufferKm);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  const { db, close } = createDb(url);
  try {
    // Land: from the shapefile (rewriting the fixture), then always from the fixture, so the recording
    // sees exactly the land the integration test imports.
    const landFile = path.join(FIXTURES, "land", `${area.key}.geojson`);
    if (args.land) {
      await importLandPolygons(db, readShapefile(args.land), landBox, "fixture");
      out(`land: ${await exportLand(db, area.key, landBox)} polygons written to ${landFile}`);
    }
    const land = JSON.parse(await readFile(landFile, "utf8")) as GeoJSON.FeatureCollection;
    await importLandPolygons(db, featuresOf(land), landBox, "fixture");

    const areaIds = await syncAreas(db, [area]);
    const { id: runId } = await createRun(db, {
      kind: "stage",
      scope: { type: "area", id: area.key },
      stages: [],
      params: { areaKey: area.key },
      triggeredBy: "fixtures:record",
    });

    const source = sourceTransport(args.cache);
    if (args.datasets) {
      // Dataset imports only: they need the tiles (coast tiles for bathymetry), not the gazetteer.
      out(`tiles: ${JSON.stringify(await ensureTiles(db, area, areaIds))}`);
      const recordingSource = recordingTransport(source);
      const archive = memoryArchive();
      for (const dataset of DATASET_KINDS) {
        const result = await withRetry(dataset, () =>
          importDataset(db, dataset, { area, runId }, { transport: recordingSource, archive }),
        );
        out(`${DATASETS_STAGE} ${dataset}: ${JSON.stringify(result)}`);
      }
      return;
    }
    const recording = recordingTransport(compacting(source));
    const osm = await withRetry("overpass", () =>
      importOsm(db, { area, runId }, { transport: recording, archive: memoryArchive() }),
    );
    out(`osm: ${JSON.stringify(osm)}`);
    const wikidata = await withRetry("wikidata", () => importWikidata(db, { area, runId }, { transport: recording }));
    out(`wikidata: ${JSON.stringify(wikidata)}`);

    // GeoNames dumps are too large for HTTP fixtures: keep the downloads and cut them to the box.
    const downloads = new Map<string, Uint8Array>();
    const capturing: Transport = async (req) => {
      const res = await source(req);
      if (res.status === 200) downloads.set(req.url, res.body);
      return res;
    };
    const geonamesSource = createGeonamesSource({
      transport: capturing,
      archive: memoryArchive(),
      ctx: { db, runId, stage: GEONAMES_STAGE },
      cfg: gazetteer.geonames,
    });
    const geonames = await withRetry("geonames", () => importGeonames(db, { area, runId }, { source: geonamesSource }));
    out(`geonames: ${JSON.stringify(geonames)}`);
    const cut = await writeGeonames(downloads, gazetteer.geonames.countries, gazetteer.geonames.baseUrl, queryBox);
    out(`geonames fixtures: ${JSON.stringify(cut)}`);

    const { rows } = await db.execute<{ type: string; n: number }>(sql`
      select type, count(*)::int as n from geo_objects
      where valid_to is null and origin <> 'manual'
      group by type order by type`);
    out("valid imported objects by type:");
    for (const r of rows) out(`  ${r.type}: ${r.n}`);
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

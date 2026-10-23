import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { unzipSync } from "fflate";
import { searchOrganic } from "../lib/adapters/dataforseo";
import { createConverters } from "../lib/adapters/fetch";
import { createFirecrawlConverter } from "../lib/adapters/fetch/firecrawl";
import { getCrawlTransport } from "../lib/adapters/fetch/guarded";
import { createJinaConverter } from "../lib/adapters/fetch/jina";
import { createGeonamesSource } from "../lib/adapters/geonames";
import { fetchTransport, makeResponse, RetryableHttpError, type Transport } from "../lib/adapters/http";
import { fixtureTransport, recordingTransport } from "../lib/adapters/http-fixtures";
import { fetchSeas } from "../lib/adapters/marine-regions";
import { searchNominatim } from "../lib/adapters/nominatim";
import { buildBoundaryQueries, buildCoarseFeatureQueries, buildRelationQuery, overpassQuery, type OverpassPart } from "../lib/adapters/overpass";
import { demTileNames, fetchDemTile } from "../lib/adapters/copernicus-dem";
import { fetchWmsImage, wmsGrid } from "../lib/adapters/wms";
import { runPdftotext } from "../lib/adapters/pdf";
import { getArchive, type Archive } from "../lib/adapters/s3";
import { createAnthropicClient } from "../lib/ai/anthropic";
import { estimateBatchItemCostsEur } from "../lib/ai/cost";
import { fixtureKey } from "../lib/ai/fixtures";
import { classifyDocumentTask } from "../lib/ai/tasks/classify-document";
import { disambiguateMentionTask } from "../lib/ai/tasks/disambiguate-mention";
import { extractFactsTask } from "../lib/ai/tasks/extract-facts";
import { extractRouteTask } from "../lib/ai/tasks/extract-route";
import type { ModelClient, ModelTask } from "../lib/ai/types";
import sharp from "sharp";
import { createOpenAiImageModel } from "../lib/adapters/openai-image";
import { embedTexts } from "../lib/adapters/voyage";
import { fetchSitelinks } from "../lib/adapters/wikidata";
import { getConfig, type AppConfig, type DiscoveryConfig } from "../lib/config";
import { createDb, type Db } from "../lib/db/client";
import { refuseSimulationEnv } from "../lib/domain/revisit/guard";
import { extractionUnits, subdivisions } from "../lib/db/schema";
import { namesByLanguage } from "../lib/domain/discovery/queries";
import { planUnits } from "../lib/domain/extraction/units";
import { effectiveVersionMeta } from "../lib/domain/mentions/classification";
import { assignSubdivisionTiles } from "../lib/domain/gazetteer/hierarchy";
import { gazetteerScope } from "../lib/domain/gazetteer/scope";
import { ensureSubdivisionTiles } from "../lib/domain/gazetteer/tiles-ensure";
import { subdivisionByKey } from "../lib/domain/subdivisions/store";
import { AEGINA_WEST_BOX, AEGINA_WEST_KEY, insertAeginaWest } from "../test/fixtures/subdivisions/aegina-west";
import { bufferBbox, countryBlocks, importLandPolygons } from "../lib/domain/gazetteer/land";
import { createRun } from "../lib/domain/runs";
import { ensureWhitelistSources, getSource, sourceIdByDomain } from "../lib/domain/sources/store";
import { parseTileId, TILE_SIZE, type Bbox } from "../lib/domain/tiles";
import { coreWindow, wideWindow } from "../lib/domain/images/window";
import { DATASET_KINDS, DATASETS_STAGE, datasetKindsOf, importDataset, type DatasetKind } from "../lib/pipeline/datasets";
import { GEONAMES_STAGE, importGeonames } from "../lib/pipeline/gazetteer/geonames";
import { classifyInputs } from "../lib/pipeline/text/classify";
import { disambiguationInputs } from "../lib/pipeline/text/disambiguate";
import { ensureExtractionRun, unitInputs } from "../lib/pipeline/text/extract";
import { routeSectionInput, sectionsOf } from "../lib/pipeline/text/routes";
import { importOsm } from "../lib/pipeline/gazetteer/osm";
import { importWikidata } from "../lib/pipeline/gazetteer/wikidata";
import { fetchUrl } from "../lib/pipeline/fetch/url";
import { queueArticles, WIKIVOYAGE_DOMAIN } from "../lib/pipeline/sources/wikivoyage";
import { readShapefile } from "./import-land-polygons";

/**
 * The box land polygons are recorded for: the subdivision's box plus `bufferKm`, snapped outward to the tile grid, so
 * `has_coast` of each tile of the subdivision (all tiles of its box lie inside) sees all land touching it.
 */
function landImportBbox(bbox: Bbox, bufferKm: number): Bbox {
  const [w, s, e, n] = bufferBbox(bbox, bufferKm);
  return [
    Math.floor(w / TILE_SIZE) * TILE_SIZE,
    Math.floor(s / TILE_SIZE) * TILE_SIZE,
    Math.ceil(e / TILE_SIZE) * TILE_SIZE,
    Math.ceil(n / TILE_SIZE) * TILE_SIZE,
  ];
}

const USAGE =
  "usage: fixtures-record.ts --subdivision <key> [--land <path/land_polygons.shp>] [--cache <dir>] [--datasets [<kind,…>] | --serp [--limit <1-3>] | --wikivoyage]\n" +
  "       fixtures-record.ts --converters <url> [<url> <url>]\n" +
  "       fixtures-record.ts --coarse <ISO2,…>\n" +
  "       fixtures-record.ts --voyage\n" +
  "       fixtures-record.ts --image\n" +
  "       fixtures-record.ts --nominatim <query> <tileId>\n" +
  "       fixtures-record.ts --imagery <lon> <lat>\n" +
  "       fixtures-record.ts --ai <classify-document|disambiguate-mention|extract-facts|extract-route> [--limit <1-5>] [--max-eur <eur>]";
/** Model tasks `--ai` records real answers of (synchronous calls, at most `MAX_AI_ANSWERS`, at most `--max-eur`). */
export const AI_RECORDING_TASKS = ["classify-document", "disambiguate-mention", "extract-facts", "extract-route"] as const;
export type AiRecordingTask = (typeof AI_RECORDING_TASKS)[number];
const MAX_AI_ANSWERS = 5;
const DEFAULT_AI_MAX_EUR = 1;
/** Real DataForSEO searches one `--serp` recording may make. */
const MAX_SERP_CALLS = 3;
/** Pages one `--converters` recording sends to each paid converter (Jina, Firecrawl). */
const MAX_CONVERTER_URLS = 3;
const FIXTURES = "test/fixtures";
const ATTEMPTS = 3;
const RETRY_WAIT_MS = 90_000;

type LandFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

export type SubdivisionRecordArgs = {
  subdivision: string;
  land?: string;
  cache?: string;
  datasets: boolean;
  /** `--datasets <kind,…>`: only these dataset kinds (default every kind). */
  datasetKinds?: DatasetKind[];
  serp: boolean;
  limit?: number;
  /** Record the Wikivoyage sitelinks and articles. */
  wikivoyage?: true;
};
export type RecordArgs =
  | SubdivisionRecordArgs
  | { converters: string[] }
  | { voyage: true }
  | { image: true }
  | { coarse: string[] }
  | { nominatim: { query: string; tileId: string } }
  | { imagery: { lon: number; lat: number } }
  | { ai: { task: AiRecordingTask; limit: number; maxEur: number } };

/** The two texts of the recorded Voyage answer (`--voyage`); the embedding tests send exactly these. */
export const VOYAGE_RECORDING_TEXTS = [
  "Aegina harbour gives good shelter from the meltemi; anchor in sand at five metres off the town quay.",
  "Die Bucht von Perdika ist bei Nordwind gut geschützt, Ankergrund Sand und Seegras auf sechs Metern.",
] as const;

/**
 * Wikidata items whose Wikivoyage sitelinks `--wikivoyage` records (one `wbgetentities` call): the island of Aegina,
 * the fixture of `lib/pipeline/__tests__/wikivoyage.test.ts`.
 */
export const WIKIVOYAGE_RECORDING_ITEMS = ["Q191082"];
/** Articles `--wikivoyage` fetches (robots.txt and HTML) for the crawl test. */
const MAX_WIKIVOYAGE_ARTICLES = 3;

function isTileId(value: string | undefined): boolean {
  try {
    return value !== undefined && parseTileId(value) !== undefined;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * `--subdivision`, `--land`, `--cache`, `--limit` take a value; `--datasets` (record the dataset imports only, optionally
 * followed by a comma-separated list of dataset kinds),
 * `--serp` (record at most `--limit` ≤ 3 area SERP searches of the subdivision, default 3) and `--wikivoyage` (the Wikivoyage sitelinks
 * and articles) take none. `--converters` takes 1–3 page URLs and stands alone (no subdivision), as does `--voyage` (one
 * embedding call), as does `--nominatim <query> <tileId>` (one Nominatim radius search).
 */
export function parseArgs(argv: string[]): RecordArgs {
  if (argv[0] === "--ai") {
    const task = argv[1] as AiRecordingTask | undefined;
    if (!task || !AI_RECORDING_TASKS.includes(task)) throw new Error(USAGE);
    let limit = MAX_AI_ANSWERS;
    let maxEur = DEFAULT_AI_MAX_EUR;
    const seen = new Set<string>();
    for (let i = 2; i < argv.length; i += 2) {
      const [flag, value] = [argv[i]!, argv[i + 1]];
      if (seen.has(flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
      seen.add(flag);
      if (flag === "--limit") limit = Number(value);
      else if (flag === "--max-eur") maxEur = Number(value);
      else throw new Error(USAGE);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AI_ANSWERS || !Number.isFinite(maxEur) || maxEur <= 0) throw new Error(USAGE);
    return { ai: { task, limit, maxEur } };
  }
  if (argv[0] === "--nominatim") {
    const [query, tileId] = [argv[1]?.trim(), argv[2]];
    if (argv.length !== 3 || !query || query.startsWith("--") || !isTileId(tileId)) throw new Error(USAGE);
    return { nominatim: { query, tileId: tileId! } };
  }
  if (argv[0] === "--imagery") {
    const [lon, lat] = [argv[1], argv[2]].map((v) => (v === undefined || v.trim() === "" ? Number.NaN : Number(v)));
    if (argv.length !== 3 || !(lon! >= -180 && lon! < 180) || !(lat! > -90 && lat! < 90)) throw new Error(USAGE);
    return { imagery: { lon: lon!, lat: lat! } };
  }
  if (argv[0] === "--coarse") {
    const countries = argv[1]?.split(",") ?? [];
    if (argv.length !== 2 || countries.length === 0 || !countries.every((c) => /^[A-Z]{2}$/.test(c))) throw new Error(USAGE);
    return { coarse: countries };
  }
  if (argv[0] === "--voyage") {
    if (argv.length !== 1) throw new Error(USAGE);
    return { voyage: true };
  }
  if (argv[0] === "--image") {
    if (argv.length !== 1) throw new Error(USAGE);
    return { image: true };
  }
  if (argv[0] === "--converters") {
    const urls = argv.slice(1);
    if (urls.length < 1 || urls.length > MAX_CONVERTER_URLS || !urls.every(isHttpUrl)) throw new Error(USAGE);
    return { converters: urls };
  }
  const values = new Map<string, string>();
  let datasets = false;
  let datasetKinds: DatasetKind[] | undefined;
  let serp = false;
  let wikivoyage = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--converters" || flag === "--voyage" || flag === "--image" || flag === "--nominatim" || flag === "--ai" || flag === "--coarse" || flag === "--imagery") throw new Error(USAGE);
    if (flag === "--datasets" || flag === "--serp" || flag === "--wikivoyage") {
      if (flag === "--datasets") {
        datasets = true;
        const list = argv[i + 1];
        if (list !== undefined && !list.startsWith("--")) {
          try {
            datasetKinds = datasetKindsOf({ datasets: list.split(",") });
          } catch {
            throw new Error(USAGE);
          }
          i++;
        }
      } else if (flag === "--serp") serp = true;
      else wikivoyage = true;
      continue;
    }
    const value = argv[++i];
    if (!["--subdivision", "--land", "--cache", "--limit"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values.set(flag, value);
  }
  const subdivision = values.get("--subdivision");
  if (!subdivision || Number(datasets) + Number(serp) + Number(wikivoyage) > 1) throw new Error(USAGE);
  const rawLimit = values.get("--limit");
  if (rawLimit !== undefined && !serp) throw new Error(USAGE);
  let limit: number | undefined;
  if (serp) {
    limit = rawLimit === undefined ? MAX_SERP_CALLS : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SERP_CALLS) throw new Error(USAGE);
  }
  return {
    subdivision,
    land: values.get("--land"),
    cache: values.get("--cache"),
    datasets,
    ...(datasetKinds ? { datasetKinds } : {}),
    serp,
    ...(serp ? { limit } : {}),
    ...(wikivoyage ? { wikivoyage: true as const } : {}),
  };
}

/**
 * The area SERP searches a `--serp` recording makes, from the names of the subdivision's admin region: each area
 * template whose language is one of the subdivision's `sourceLanguages` and has a name, the first `limit`.
 */
export function serpRecordingQueries(
  subdivision: { names: Record<string, string | undefined>; sourceLanguages: string[] },
  discovery: DiscoveryConfig,
  limit: number,
): Array<{ keyword: string; languageCode: string; locationCode: number }> {
  const { names } = subdivision;
  return discovery.templates.area
    .filter((t) => subdivision.sourceLanguages.includes(t.lang) && names[t.lang])
    .map((t) => ({ keyword: t.template.replaceAll("{name}", names[t.lang]!), languageCode: t.lang, locationCode: t.locationCode }))
    .slice(0, Math.min(limit, MAX_SERP_CALLS));
}

/**
 * Records real DataForSEO answers as fixtures. Calls are booked (budget, `external_calls`) in the database of
 * `DATABASE_URL`, the development database: they cost real money, so no scratch database hides them.
 */
async function recordSerp(subdivisionKey: string, limit: number): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { discovery } = getConfig();
  const { db, close } = createDb(url);
  try {
    const scope = await gazetteerScope(db, subdivisionKey);
    const [sub] = await db.select({ geoObjectId: subdivisions.geoObjectId }).from(subdivisions).where(eq(subdivisions.id, scope.subdivisionId));
    const names = (await namesByLanguage(db, [sub!.geoObjectId], scope.sourceLanguages)).get(sub!.geoObjectId);
    const recording = recordingTransport(fetchTransport);
    for (const q of serpRecordingQueries({ names: Object.fromEntries(names ?? []), sourceLanguages: scope.sourceLanguages }, discovery, limit)) {
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

/**
 * Records one real OpenAI image edit (a plain 1536 x 1024 PNG with a tiny prompt, about 0.25 EUR at quality `high`),
 * booked in the database of `DATABASE_URL` (budget `openai`, `external_calls`). The adapter test builds its own
 * fixture by hand; this is for checking the real answer shape.
 */
async function recordImage(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const image = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#3a7ca5" } }).png().toBuffer();
    const result = await createOpenAiImageModel(recordingTransport(fetchTransport)).edit(
      { task: "generate-place-image", image: new Uint8Array(image), prompt: "Turn this plain blue image into a photograph of a calm sea." },
      { db, stage: "fixtures:record" },
    );
    process.stdout.write(`image: ${result.image.byteLength} bytes, ${result.costEur} EUR\n`);
  } finally {
    await close();
  }
}

/**
 * Records one real Nominatim radius search (`query` within `geocode.radiusKm` around the tile), booked in the database
 * of `DATABASE_URL` (`external_calls`, the shared rate bucket of at most one request per second). Free of charge.
 */
async function recordNominatim(query: string, tileId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { geocode } = getConfig().extraction;
  const { db, close } = createDb(url);
  try {
    const hits = await searchNominatim(
      recordingTransport(fetchTransport),
      { query, tileId, radiusKm: geocode.radiusKm, limit: geocode.limit },
      { db, stage: "fixtures:record" },
      geocode,
    );
    process.stdout.write(`nominatim "${query}" around ${tileId}: ${hits.length} hits\n`);
    for (const h of hits) process.stdout.write(`  ${h.osmId} ${h.name} (${h.category}/${h.type}) ${h.distanceM} m\n`);
  } finally {
    await close();
  }
}

/**
 * Records the imagery requests of one place (spec 13): the cadastre grid of its core window (whatever the country),
 * the Sentinel-2 grid of its wide window and the Copernicus DEM tiles under the wide window, into
 * `test/fixtures/http/<source>/`. Free of charge; calls are booked in the database of `DATABASE_URL`. A DEM tile is a
 * COG of up to `maxBytes`: crop it to a small COG with `gdal_translate` before committing the fixture.
 */
async function recordImagery(lon: number, lat: number): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const cfg = getConfig().images;
  const transport = recordingTransport(fetchTransport);
  const { db, close } = createDb(url);
  const ctx = { db, stage: "fixtures:record" };
  try {
    const grids = [
      { source: "ktimatologio" as const, bbox: coreWindow(lon, lat, cfg.window) },
      { source: "sentinel2" as const, bbox: wideWindow(lon, lat, cfg.window) },
    ];
    for (const { source, bbox } of grids) {
      const src = cfg.sources[source];
      for (const cell of wmsGrid(bbox, src.resolutionM, src.maxRequestPx)) {
        const bytes = await fetchWmsImage(
          transport,
          { url: src.url, layer: src.layer, format: src.format, bbox: cell.bbox, width: cell.width, height: cell.height, timeoutSeconds: src.timeoutSeconds, ratePerMinute: src.ratePerMinute },
          ctx,
          source,
        );
        process.stdout.write(`${source} ${cell.tileKey}: ${cell.width}x${cell.height}, ${bytes.byteLength} bytes\n`);
      }
    }
    for (const name of demTileNames(wideWindow(lon, lat, cfg.window))) {
      const bytes = await fetchDemTile(transport, name, ctx, cfg.sources.copernicus_dem);
      process.stdout.write(`copernicus_dem ${name}: ${bytes ? `${bytes.byteLength} bytes` : "no tile"}\n`);
    }
  } finally {
    await close();
  }
}

/**
 * The box the coarse feature parts of a country are recorded for, where a test does not use the country relation's
 * bounds: `gazetteer-coarse.test.ts` stores a synthetic MT polygon, whose box covers all of Malta's land.
 */
const COARSE_FEATURE_BOXES: Record<string, Bbox> = { MT: [14.0, 35.7, 15.1, 36.2] };

/**
 * Records the coarse boundary fixtures of spec 14, part by part as `importCoarse` and `importCoarseFeatures` ask
 * (B15): per country the boundary parts (the country relation, or the configured `countryRelation`, and one query per
 * configured level), the `extra` relations of that country, the coarse feature parts (islands, bays, towns) per
 * `overpass.blockDeg` block of the country relation's bounds (or `COARSE_FEATURE_BOXES`; unlike the pipeline, blocks
 * outside the country polygon are recorded too), and the Marine Regions IHO seas of `mediterranean.marineRegionsMrgids`.
 * Calls are booked in the `*_scratch` database of `DATABASE_URL`.
 */
async function recordCoarse(countries: string[]): Promise<void> {
  const url = assertScratchUrl(process.env.DATABASE_URL);
  const { gazetteer, subdivisions } = getConfig();
  const { db, close } = createDb(url);
  const ctx = { db, stage: "fixtures:record" };
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const timeout = gazetteer.overpass.timeoutSeconds;
  try {
    const recording = recordingTransport(compacting(fetchTransport));
    const ask = (label: string, ql: string) => withRetry(`overpass ${label}`, () => overpassQuery(recording, ql, ctx, gazetteer.overpass));
    for (const country of countries) {
      const entry = subdivisions.countries[country];
      if (!entry) throw new Error(`no subdivision config for country ${country}`);
      const levels = [entry.firstLevel, entry.secondLevel].filter((l): l is number => typeof l === "number");
      const parts: OverpassPart[] = buildBoundaryQueries(country, levels, timeout).filter((q) => !(entry.countryRelation && q.part === "country"));
      if (entry.countryRelation) parts.push({ part: "country-relation", ql: buildRelationQuery([entry.countryRelation], timeout) });
      const extra = subdivisions.extra.filter((e) => e.country === country).map((e) => e.osmRelationId);
      if (extra.length > 0) parts.push({ part: "extra", ql: buildRelationQuery(extra, timeout) });
      let bounds: Bbox | undefined;
      for (const { part, ql } of parts) {
        const { elements } = await ask(`${country} ${part}`, ql);
        out(`boundaries ${country} ${part}: ${elements.length} relations`);
        const own = part === "country" || part === "country-relation" ? elements[0]?.bounds : undefined;
        if (own) bounds = [own.minlon, own.minlat, own.maxlon, own.maxlat];
      }
      const box = COARSE_FEATURE_BOXES[country] ?? bounds;
      if (!box) throw new Error(`no bounds for country ${country}`);
      for (const { part, ql } of buildCoarseFeatureQueries(country, gazetteer.coarse, timeout, countryBlocks(box, gazetteer.overpass.blockDeg))) {
        const { elements } = await ask(`${country} ${part}`, ql);
        out(`features ${country} ${part}: ${elements.length} elements`);
      }
    }
    const mrgids = subdivisions.mediterranean.marineRegionsMrgids;
    const seas = await withRetry("marine regions", () => fetchSeas(recording, mrgids, ctx, gazetteer.marineRegions));
    for (const sea of seas) out(`sea ${sea.mrgid} ${sea.name}: ${sea.geometry.coordinates.length} polygons`);
  } finally {
    await close();
  }
}

class RecordingRollback extends Error {}

const AI_TASKS: Record<AiRecordingTask, ModelTask<unknown, unknown>> = {
  "classify-document": classifyDocumentTask as ModelTask<unknown, unknown>,
  "disambiguate-mention": disambiguateMentionTask as ModelTask<unknown, unknown>,
  "extract-facts": extractFactsTask as ModelTask<unknown, unknown>,
  "extract-route": extractRouteTask as ModelTask<unknown, unknown>,
};

/**
 * Calls the model once per input (synchronously, in order) and writes each answer as `<dir>/<task>/<fixtureKey>.json`
 * with only `task`, `key`, `input`, `output`, `model` and `recordedAt` (no keys, no headers; an `extract-facts` input
 * carries the unit's chunk texts). Stops before an answer whose estimate (`estimateEur`) would take the spend beyond
 * `maxEur`, and as soon as the booked spend reaches it.
 */
export async function recordAiAnswers(
  task: ModelTask<unknown, unknown>,
  inputs: unknown[],
  deps: { client: ModelClient; maxEur: number; estimateEur: (input: unknown) => number; dir: string; now?: () => Date },
): Promise<{ recorded: string[]; spentEur: number; stopped: boolean }> {
  const recorded: string[] = [];
  let spentEur = 0;
  for (const input of inputs) {
    if (spentEur >= deps.maxEur || spentEur + deps.estimateEur(input) > deps.maxEur) return { recorded, spentEur, stopped: true };
    const result = await deps.client.call(task, input, { stage: "fixtures:record" });
    spentEur += result.costEur;
    const key = fixtureKey(task.name, input);
    const file = path.join(deps.dir, task.name, `${key}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    const fixture = { task: task.name, key, input, output: result.output, model: result.model, recordedAt: (deps.now?.() ?? new Date()).toISOString() };
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
    recorded.push(file);
  }
  return { recorded, spentEur, stopped: false };
}

/** Current versions of active documents, in id order (the inputs of `--ai` come from these). */
async function currentVersions(db: Db): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select v.id from documents d join document_versions v on v.id = d.current_version_id
    where d.status = 'active' and d.valid_to is null order by v.id
  `);
  return rows.map((r) => r.id);
}

/**
 * The first `limit` task inputs from the development database, built by the pipeline's own input code: versions
 * (classification), pending ambiguous matches (disambiguation), the first extraction units of the mentions (built in a
 * transaction that is rolled back, so no run or unit stays), the first sections of trip reports (routes).
 */
async function aiRecordingInputs(db: Db, task: AiRecordingTask, limit: number, config: AppConfig): Promise<unknown[]> {
  if (task === "classify-document") {
    const items = await classifyInputs(db, getArchive(), (await currentVersions(db)).slice(0, limit), config);
    return items.map((i) => i.input);
  }
  if (task === "disambiguate-mention") {
    const { rows } = await db.execute<{ id: string }>(sql`select id from ambiguous_matches where status = 'pending' order by id limit ${limit}`);
    const inputs = await disambiguationInputs(db, rows.map((r) => r.id), config);
    return rows.flatMap((r) => (inputs.has(r.id) ? [inputs.get(r.id)] : []));
  }
  if (task === "extract-route") {
    const inputs: unknown[] = [];
    for (const versionId of await currentVersions(db)) {
      if (inputs.length >= limit) break;
      const meta = await effectiveVersionMeta(db, versionId);
      if (meta.docType !== "trip_report") continue;
      const parts = (await sectionsOf(db, getArchive(), [versionId], config)).get(versionId) ?? [];
      for (let section = 1; section <= parts.length && inputs.length < limit; section++) inputs.push(routeSectionInput(parts, section, meta.observedAt, config));
    }
    return inputs;
  }
  const { rows } = await db.execute<{ id: string }>(sql`
    select m.id from mentions m join documents d on d.current_version_id = m.document_version_id
    where d.status = 'active' order by m.document_version_id, m.geo_object_id, m.char_start, m.id
  `);
  const { units } = await planUnits(db, rows.map((r) => r.id), config.extraction.unit);
  let inputs: unknown[] = [];
  await db
    .transaction(async (tx) => {
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: "fixtures" }, stages: [], triggeredBy: "fixtures:record" });
      const { id: extractionRunId } = await ensureExtractionRun(
        tx,
        { runId, task: "extract-facts", model: config.models.tasks["extract-facts"]!.model, promptVersion: config.models.tasks["extract-facts"]!.promptVersion, purpose: "regular" },
        config,
      );
      const picked = units.slice(0, limit);
      const ids =
        picked.length === 0
          ? []
          : (
              await tx
                .insert(extractionUnits)
                .values(picked.map((u) => ({ extractionRunId, documentVersionId: u.documentVersionId, geoObjectId: u.geoObjectId, part: u.part, level: u.level, mentionIds: u.mentionIds, chunkIds: u.chunkIds })))
                .returning({ id: extractionUnits.id })
            ).map((r) => r.id);
      const built = await unitInputs(tx, ids, config);
      inputs = ids.flatMap((id) => (built.has(id) ? [built.get(id)] : []));
      throw new RecordingRollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof RecordingRollback)) throw error;
    });
  return inputs;
}

/**
 * Records up to `limit` real answers of one model task as fixtures (`test/fixtures/ai/<task>/`), from inputs of the
 * development database of `DATABASE_URL`. Synchronous calls through the Anthropic adapter: budget `anthropic` and
 * `external_calls` are booked there, and the recording stops at `maxEur` (a sync call costs the batch estimate without
 * the batch discount).
 */
async function recordAi(args: { task: AiRecordingTask; limit: number; maxEur: number }): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const task = AI_TASKS[args.task];
  const { db, close } = createDb(url);
  try {
    const inputs = await aiRecordingInputs(db, args.task, args.limit, config);
    if (inputs.length === 0) {
      process.stdout.write(`${args.task}: no inputs in the database (run "Texte auswerten" first); nothing recorded\n`);
      return;
    }
    const result = await recordAiAnswers(task, inputs, {
      client: createAnthropicClient(db, config),
      maxEur: args.maxEur,
      estimateEur: (input) => estimateBatchItemCostsEur(config, task, [input])[0]! / config.models.batch.discount,
      dir: path.join(FIXTURES, "ai"),
    });
    for (const file of result.recorded) process.stdout.write(`recorded ${file}\n`);
    process.stdout.write(
      `${args.task}: ${result.recorded.length} of ${inputs.length} answers, ${result.spentEur.toFixed(4)} EUR${result.stopped ? ` (stopped at the ${args.maxEur} EUR ceiling)` : ""}\n`,
    );
  } finally {
    await close();
  }
}

/**
 * Records the Wikivoyage sitelinks of `WIKIVOYAGE_RECORDING_ITEMS` on the subdivision's languages (one `wbgetentities` call)
 * and crawls up to `MAX_WIKIVOYAGE_ARTICLES` of the articles with the crawl's own code (robots.txt and pages through
 * the guarded crawl transport, local converter, no renderer). The database work runs in a transaction of the
 * `DATABASE_URL` database that is rolled back: the calls are free, and the recording leaves no source, document or
 * frontier row behind.
 */
async function recordWikivoyage(subdivisionKey: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    await db
      .transaction(async (tx) => {
        await ensureWhitelistSources(tx);
        const sourceId = await sourceIdByDomain(tx, WIKIVOYAGE_DOMAIN);
        const source = sourceId ? await getSource(tx, sourceId) : null;
        if (!source) throw new Error(`no source for ${WIKIVOYAGE_DOMAIN}`);
        const { id: runId } = await createRun(tx, {
          kind: "stage",
          scope: { type: "subdivision", id: subdivisionKey },
          stages: [],
          params: { subdivisionKey, sourceIds: [source.id] },
          triggeredBy: "fixtures:record",
        });
        const ctx = { db: tx, runId, stage: "fixtures:record", sourceId: source.id };
        const { sourceLanguages } = await gazetteerScope(tx, subdivisionKey);
        const sites = sourceLanguages.map((lang) => `${lang}wikivoyage`);
        const links = await fetchSitelinks(recordingTransport(fetchTransport), WIKIVOYAGE_RECORDING_ITEMS, sites, ctx, config.gazetteer.wikidata);
        const articles = [...links.values()].flat().slice(0, MAX_WIKIVOYAGE_ARTICLES);
        out(`wikidata sitelinks: ${articles.map((a) => a.url).join(", ") || "none"}`);
        await queueArticles(tx, source, articles);
        const crawl = recordingTransport(getCrawlTransport());
        const deps = {
          transport: crawl,
          archive: memoryArchive(),
          converters: createConverters({ transport: crawl, cfg: config.fetch }),
          pdf: { pdftotext: runPdftotext },
          enqueue: async () => 0,
        };
        for (const article of articles) {
          const result = await fetchUrl(tx, { sourceId: source.id, url: article.url, depth: 0 }, deps, ctx);
          out(`${article.url}: ${JSON.stringify(result)}`);
        }
        throw new RecordingRollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RecordingRollback)) throw error;
      });
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

/** Douglas-Peucker tolerance for the IHO sea rings in degrees (~200 m; the seas span hundreds of km). */
const SEA_TOLERANCE_DEG = 0.002;

/**
 * The IHO sea polygons come with 8 decimals and ~14 MB for the configured Mediterranean seas. Every ring is thinned
 * (Douglas-Peucker, end points kept so rings stay closed) and its coordinates rounded to 4 decimals; a ring that
 * collapses below 4 points is dropped, as is a polygon without an exterior ring.
 */
export function compactMarineRegions(raw: string): string {
  const answer = JSON.parse(raw) as { features?: Array<{ geometry?: { type?: string; coordinates?: number[][][][] } | null }> };
  for (const feature of answer.features ?? []) {
    const geometry = feature.geometry;
    if (geometry?.type !== "MultiPolygon" || !geometry.coordinates) continue;
    geometry.coordinates = geometry.coordinates
      .map((polygon) =>
        polygon
          .map((ring) =>
            simplifyLine(
              ring.map(([lon, lat]) => ({ lon: lon!, lat: lat! })),
              SEA_TOLERANCE_DEG,
            ).map((p) => [Math.round(p.lon * 1e4) / 1e4, Math.round(p.lat * 1e4) / 1e4]),
          )
          .filter((ring) => ring.length >= 4),
      )
      .filter((polygon) => polygon.length > 0);
  }
  return JSON.stringify(answer);
}

/** Thins successful Overpass and Marine Regions answers and minifies Wikidata's before they are recorded and imported. */
function compacting(inner: Transport): Transport {
  return async (req) => {
    const res = await inner(req);
    if (res.status !== 200) return res;
    if (req.service === "marine-regions") return makeResponse(200, new TextEncoder().encode(compactMarineRegions(res.text())));
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

/** Writes the land polygons in the box as `test/fixtures/land/<name>.geojson` (6 decimals, ~0.1 m). */
async function exportLand(db: Db, name: string, [west, south, east, north]: Bbox): Promise<number> {
  const { rows } = await db.execute<{ geometry: string }>(sql`
    select ST_AsGeoJSON(geom, 6) as geometry from land_polygons
    where geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
    order by ST_XMin(geom), ST_YMin(geom)`);
  const lines = rows.map((r) => `    { "type": "Feature", "properties": {}, "geometry": ${r.geometry} }`);
  await mkdir(path.join(FIXTURES, "land"), { recursive: true });
  await writeFile(
    path.join(FIXTURES, "land", `${name}.geojson`),
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
  // never in a simulation or on its clone: costs booked there escape the real budget (final review A M-5)
  refuseSimulationEnv(process.env, "fixtures:record");
  const args = parseArgs(process.argv.slice(2));
  if ("ai" in args) return recordAi(args.ai);
  if ("nominatim" in args) return recordNominatim(args.nominatim.query, args.nominatim.tileId);
  if ("imagery" in args) return recordImagery(args.imagery.lon, args.imagery.lat);
  if ("voyage" in args) return recordVoyage();
  if ("image" in args) return recordImage();
  if ("coarse" in args) return recordCoarse(args.coarse);
  if ("converters" in args) return recordConverters(args.converters);
  if (args.serp) return recordSerp(args.subdivision, args.limit!);
  if (args.wikivoyage) return recordWikivoyage(args.subdivision);
  const url = assertScratchUrl(process.env.DATABASE_URL);
  const { gazetteer } = getConfig();
  const out = (line: string) => process.stdout.write(`${line}\n`);

  const { db, close } = createDb(url);
  try {
    // The test subdivision around the aegina-west fixtures is created here (its land comes first); any other key must
    // already be in the scratch database (`subdivisions.build`), which also names the land fixture after its key.
    const isTestSubdivision = args.subdivision === AEGINA_WEST_KEY;
    const existing = await subdivisionByKey(db, args.subdivision);
    const bbox = isTestSubdivision ? AEGINA_WEST_BOX : existing?.bbox;
    if (!bbox) throw new Error(`subdivision ${args.subdivision} is not in the scratch database; build the subdivisions first`);
    // The land import box (subdivision box plus `landBufferKm`, snapped to the tile grid): 50 km fetch rays need it.
    const landBox = landImportBbox(bbox, gazetteer.landBufferKm);
    const queryBox = bufferBbox(bbox, gazetteer.bboxBufferKm);
    const landName = isTestSubdivision ? "aegina-west" : args.subdivision;

    // Land: from the shapefile (rewriting the fixture), then always from the fixture, so the recording
    // sees exactly the land the integration test imports.
    const landFile = path.join(FIXTURES, "land", `${landName}.geojson`);
    if (args.land) {
      await importLandPolygons(db, readShapefile(args.land), landBox, "fixture");
      out(`land: ${await exportLand(db, landName, landBox)} polygons written to ${landFile}`);
    }
    const land = JSON.parse(await readFile(landFile, "utf8")) as GeoJSON.FeatureCollection;
    await importLandPolygons(db, featuresOf(land), landBox, "fixture");

    if (!existing) await insertAeginaWest(db);
    const scope = await gazetteerScope(db, args.subdivision);
    const { id: runId } = await createRun(db, {
      kind: "stage",
      scope: { type: "subdivision", id: scope.key },
      stages: [],
      params: { subdivisionKey: scope.key },
      triggeredBy: "fixtures:record",
    });

    const source = sourceTransport(args.cache);
    if (args.datasets) {
      // Dataset imports only: they need the tiles (coast tiles for bathymetry), not the gazetteer.
      out(`tiles: ${JSON.stringify(await ensureSubdivisionTiles(db, scope.subdivisionId))}`);
      const recordingSource = recordingTransport(source);
      const archive = memoryArchive();
      const kinds = args.datasetKinds ?? [...DATASET_KINDS];
      if (kinds.includes("sitelinks")) {
        // Sitelinks are asked for the subdivision's objects with a Wikidata id: the gazetteer from its recorded fixtures.
        const replay = fixtureTransport();
        await importOsm(db, { scope, runId }, { transport: replay, archive });
        await importWikidata(db, { scope, runId }, { transport: replay });
        out(`tile links: ${(await assignSubdivisionTiles(db, scope.subdivisionId)).links}`);
      }
      for (const dataset of kinds) {
        const result = await withRetry(dataset, () =>
          importDataset(db, dataset, { scope, runId }, { transport: recordingSource, archive }),
        );
        out(`${DATASETS_STAGE} ${dataset}: ${JSON.stringify(result)}`);
      }
      return;
    }
    const recording = recordingTransport(compacting(source));
    const osm = await withRetry("overpass", () =>
      importOsm(db, { scope, runId }, { transport: recording, archive: memoryArchive() }),
    );
    out(`osm: ${JSON.stringify(osm)}`);
    const wikidata = await withRetry("wikidata", () => importWikidata(db, { scope, runId }, { transport: recording }));
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
    const geonames = await withRetry("geonames", () => importGeonames(db, { scope, runId }, { source: geonamesSource }));
    out(`geonames: ${JSON.stringify(geonames)}`);
    const cut = await writeGeonames(downloads, [scope.country], gazetteer.geonames.baseUrl, queryBox);
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
    // drizzle wraps driver errors ("Failed query"); the Postgres message is the cause.
    if (err instanceof Error && err.cause instanceof Error) process.stderr.write(`cause: ${err.cause.message}\n`);
    process.exit(1);
  });
}

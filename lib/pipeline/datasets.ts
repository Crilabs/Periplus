import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Feature, Geometry, LineString, MultiPolygon, Polygon } from "geojson";
import { fetchCoverage, fetchWfsFeatures } from "@/lib/adapters/emodnet";
import type { CallContext, Transport } from "@/lib/adapters/http";
import { buildCablesQuery, buildHarbourStructuresQuery, buildRoadsQuery, overpassQuery, type OverpassElement } from "@/lib/adapters/overpass";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { GazetteerScope } from "@/lib/domain/gazetteer/scope";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { bufferBbox } from "@/lib/domain/gazetteer/land";
import { importBathymetryRaster } from "@/lib/domain/geometry/bathymetry";
import {
  upsertRestrictedAreas,
  type RestrictedFeature,
  type RestrictedKind,
  type UpsertResult,
} from "@/lib/domain/geometry/restrictions";
import { replaceHarbourStructures, type HarbourStructure } from "@/lib/domain/geometry/harbour-structures";
import { replaceRoads, type RoadFeature } from "@/lib/domain/geometry/roads";
import { classifySeabed, replaceSeabed, type SeabedFeature } from "@/lib/domain/geometry/seabed";
import { tileBbox, tileNeighbours, type Bbox } from "@/lib/domain/tiles";
import { createLogger } from "@/lib/logger";
import { ensureSitelinkCounts } from "@/lib/pipeline/sitelinks";
import { seedTileIds } from "@/lib/pipeline/tile-scope";

export const DATASETS_STAGE = "datasets.import";

/** The datasets of the run "Datensätze laden", one job each per subdivision. */
export const DATASET_KINDS = ["bathymetry", "seabed", "restrictions", "vessel_density", "roads", "harbour_structures", "sitelinks"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

export type DatasetImportInput = { scope: GazetteerScope; runId?: string; now?: Date };
export type DatasetImportDeps = { transport: Transport; archive: Archive };

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("datasets.import"));

const isoDate = (now: Date | undefined) => (now ?? new Date()).toISOString().slice(0, 10);

/** First 12 hex digits of the sha256 over `parts`, in order. */
function contentVersion(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\n");
  return hash.digest("hex").slice(0, 12);
}

/** Box of every dataset request: the subdivision's box plus `datasets.bufferKm`. */
function datasetBox(scope: GazetteerScope): Bbox {
  return bufferBbox(scope.bbox, getConfig().datasets.bufferKm);
}

const callContext = (db: Db, input: DatasetImportInput, tileId?: string): CallContext => ({
  db,
  runId: input.runId,
  tileId,
  stage: DATASETS_STAGE,
});

/** `datasets` of run params: omitted = every kind; otherwise a non-empty list of distinct known kinds. */
export function datasetKindsOf(params: Record<string, unknown>): DatasetKind[] {
  const value = params.datasets;
  if (value === undefined) return [...DATASET_KINDS];
  if (!Array.isArray(value) || value.length === 0) throw new Error("datasets must be a non-empty list");
  for (const kind of value) {
    if (!DATASET_KINDS.includes(kind as DatasetKind)) throw new Error(`unknown dataset ${String(kind)}`);
  }
  if (new Set(value).size !== value.length) throw new Error("datasets must not repeat");
  return value as DatasetKind[];
}

/**
 * Bathymetry for the coast tiles of the subdivision and their 8 neighbours: per tile exactly its box from the
 * EMODnet WCS, archived as `datasets/emodnet-bathymetry/<datasetVersion>/<tileId>.tif`. An archived tile is
 * reused without HTTP. All downloads happen before the first raster import (one transaction per tile); a
 * downloaded tile is archived only after its import succeeded, so a body that cannot be imported is never
 * reused and the next run downloads it again.
 */
export async function importBathymetry(
  db: Db,
  input: DatasetImportInput,
  deps: DatasetImportDeps,
): Promise<{ tiles: number; rasterTiles: number; reused: number }> {
  const cfg = getConfig().datasets.bathymetry;
  const coast = await seedTileIds(db, { subdivisionKey: input.scope.key });
  if (coast.length === 0) throw new Error(`subdivision ${input.scope.key} has no coast tiles; build its gazetteer first`);
  const tileIds = [...new Set(coast.flatMap((id) => [id, ...tileNeighbours(id)]))].sort();

  const rasters: Array<{ tileId: string; key: string; bytes: Uint8Array; downloaded: boolean }> = [];
  for (const tileId of tileIds) {
    const key = `datasets/emodnet-bathymetry/${cfg.datasetVersion}/${tileId}.tif`;
    const archived = await deps.archive.get(key);
    const bytes = archived ?? (await fetchCoverage(deps.transport, tileBbox(tileId), callContext(db, input, tileId), cfg));
    rasters.push({ tileId, key, bytes, downloaded: archived === null });
  }

  let rasterTiles = 0;
  for (const { tileId, key, bytes, downloaded } of rasters) {
    const result = await importBathymetryRaster(db, {
      bytes,
      dataset: cfg.dataset,
      datasetVersion: cfg.datasetVersion,
      resolutionM: cfg.resolutionM,
      tileId,
      valueIsElevation: cfg.valueIsElevation,
    });
    rasterTiles += result.rasterTiles;
    if (downloaded) await deps.archive.put(key, bytes, "image/tiff");
  }
  return { tiles: tileIds.length, rasterTiles, reused: rasters.filter((r) => !r.downloaded).length };
}

const isPolygonal = (g: Geometry | null): g is Polygon | MultiPolygon => g?.type === "Polygon" || g?.type === "MultiPolygon";

/**
 * EMODnet EUSeaMap seabed in the subdivision's dataset box. Version = first 12 hex digits of the sha256 over all
 * pages; pages archived as `datasets/emodnet-seabed/<version>/<subdivisionKey>/<n>.json`. Features without a
 * mapped substrate (or without polygon geometry) count as `unmapped`; their values are logged. Then the
 * subdivision's seabed polygons are replaced.
 */
export async function importSeabed(
  db: Db,
  input: DatasetImportInput,
  deps: DatasetImportDeps,
): Promise<{ features: number; unmapped: number; version: string }> {
  const cfg = getConfig().datasets.seabed;
  const box = datasetBox(input.scope);
  const { pages, features } = await fetchWfsFeatures(
    deps.transport,
    {
      service: "emodnet-seabed",
      url: cfg.wfsUrl,
      typeName: cfg.typeName,
      bbox: box,
      pageSize: cfg.pageSize,
      timeoutMs: cfg.timeoutSeconds * 1000,
      ratePerMinute: cfg.ratePerMinute,
      sortBy: cfg.sortBy,
    },
    callContext(db, input),
  );
  const version = contentVersion(pages);
  for (const [n, page] of pages.entries()) {
    await deps.archive.put(`datasets/emodnet-seabed/${version}/${input.scope.key}/${n}.json`, page, "application/json");
  }

  const mapped: SeabedFeature[] = [];
  const unmappedValues = new Map<string, number>();
  for (const [i, f] of features.entries()) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const substrate = classifySeabed(props, cfg);
    if (!substrate || !isPolygonal(f.geometry)) {
      const value = isPolygonal(f.geometry) ? String(props[cfg.substrateField] ?? null) : `geometry ${f.geometry?.type ?? null}`;
      unmappedValues.set(value, (unmappedValues.get(value) ?? 0) + 1);
      continue;
    }
    const habitat = cfg.habitatFields.map((field) => props[field]).find((v) => typeof v === "string") as string | undefined;
    mapped.push({ substrate, habitat: habitat ?? null, sourceRef: String(f.id ?? `${cfg.typeName}#${i}`), geometry: f.geometry });
  }
  const unmapped = features.length - mapped.length;
  if (unmapped > 0) {
    getLog().info({ subdivisionKey: input.scope.key, unmapped, values: Object.fromEntries(unmappedValues) }, "unmapped seabed features skipped");
  }

  await replaceSeabed(db, { subdivisionKey: input.scope.key, datasetVersion: version, box, features: mapped });
  return { features: mapped.length, unmapped, version };
}

/** One source layer of restricted areas before normalisation. */
type RestrictionLayer = {
  layerPrefix: string;
  kind: RestrictedKind;
  bufferM: number;
  sources: Array<{ ref: string; geometry: Geometry; seaOnly: boolean }>;
};

/**
 * Normalises a layer in SQL: lines and points (`bufferM > 0`) become `ST_Buffer(::geography, bufferM)`,
 * polygons are made valid and reduced to their polygon parts; empty results are dropped. Sources marked
 * `seaOnly` that lie entirely on land are dropped. Several sources with the same ref are unioned.
 */
async function normalizeLayer(db: Db, layer: RestrictionLayer): Promise<RestrictedFeature[]> {
  if (layer.sources.length === 0) return [];
  const sources = JSON.stringify(layer.sources.map((s) => ({ ref: s.ref, sea_only: s.seaOnly, geometry: s.geometry })));
  const shape =
    layer.bufferM > 0
      ? sql`ST_Buffer(kept.geom::geography, ${layer.bufferM}::float8)::geometry`
      : sql`ST_CollectionExtract(kept.geom, 3)`;
  const { rows } = await db.execute<{ ref: string; geometry: string }>(sql`
    with src as (
      select f->>'ref' as ref, (f->>'sea_only')::boolean as sea_only,
             ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(f->'geometry'), 4326))) as geom
      from jsonb_array_elements(${sources}::jsonb) f
    ),
    kept as (
      select src.ref, src.geom from src
      where not src.sea_only
         or not coalesce((select ST_Covers(ST_Union(l.geom), src.geom) from land_polygons l where l.geom && src.geom), false)
    ),
    shaped as (select kept.ref, ${shape} as geom from kept)
    select ref, ST_AsGeoJSON(ST_Union(geom)) as geometry
    from shaped
    where not ST_IsEmpty(geom)
    group by ref
    order by ref`);
  return rows.map((r) => ({ kind: layer.kind, sourceRef: r.ref, geometry: JSON.parse(r.geometry) as Polygon | MultiPolygon }));
}

/** Full line of an Overpass way, null without at least two points. */
function wayLine(el: OverpassElement): LineString | null {
  if (el.type !== "way" || !el.geometry || el.geometry.length < 2) return null;
  return { type: "LineString", coordinates: el.geometry.map((p) => [p.lon, p.lat]) };
}

/** Source id of a feature: `props[idField]`, else the GeoJSON feature id; null when neither exists. */
function featureId(f: Feature, idField: string | undefined): string | null {
  const own = idField ? (f.properties as Record<string, unknown> | null)?.[idField] : undefined;
  const id = own ?? f.id;
  return id === undefined || id === null || id === "" ? null : String(id);
}

/**
 * Restricted areas in the subdivision's dataset box: every EMODnet Human Activities layer (pages archived as
 * `datasets/emodnet-human-activities/<YYYY-MM-DD>/<subdivisionKey>/<typeName>-<n>.json`, `sourceRef`
 * `<typeName>/<props[idField] ?? feature.id>`) and OSM submarine cables (archived as
 * `datasets/osm-cables/<YYYY-MM-DD>/<subdivisionKey>.json`, `sourceRef` `osm-cable:way/<id>`, power cables on land
 * dropped). A buffered layer is requested for the box widened by its buffer, so a buffer reaching into the
 * box from outside is found; rows of a layer end only when they intersect the box itself. All requests run
 * before the first write. Returns the upsert counts summed per kind.
 */
export async function importRestrictions(
  db: Db,
  input: DatasetImportInput,
  deps: DatasetImportDeps,
): Promise<Partial<Record<RestrictedKind, UpsertResult>>> {
  const { datasets, gazetteer } = getConfig();
  const ha = datasets.humanActivities;
  const box = datasetBox(input.scope);
  const date = isoDate(input.now);
  const ctx = callContext(db, input);

  const layers: RestrictionLayer[] = [];
  for (const layer of ha.layers) {
    const { pages, features } = await fetchWfsFeatures(
      deps.transport,
      {
        service: "emodnet-human-activities",
        url: ha.wfsUrl,
        typeName: layer.typeName,
        bbox: layer.bufferM > 0 ? bufferBbox(box, layer.bufferM / 1000) : box,
        pageSize: ha.pageSize,
        timeoutMs: ha.timeoutSeconds * 1000,
        ratePerMinute: ha.ratePerMinute,
      },
      ctx,
    );
    for (const [n, page] of pages.entries()) {
      const key = `datasets/emodnet-human-activities/${date}/${input.scope.key}/${layer.typeName}-${n}.json`;
      await deps.archive.put(key, page, "application/json");
    }
    const sources: RestrictionLayer["sources"] = [];
    for (const f of features) {
      const id = featureId(f, layer.idField);
      if (id === null || !f.geometry) {
        getLog().warn({ typeName: layer.typeName, id, geometry: f.geometry?.type ?? null }, "restricted feature without id or geometry skipped");
        continue;
      }
      sources.push({ ref: `${layer.typeName}/${id}`, geometry: f.geometry, seaOnly: false });
    }
    layers.push({ layerPrefix: `${layer.typeName}/`, kind: layer.kind, bufferM: layer.bufferM, sources });
  }

  const cables = datasets.cables;
  const { raw, elements } = await overpassQuery(
    deps.transport,
    buildCablesQuery(bufferBbox(box, cables.bufferM / 1000), gazetteer.overpass.timeoutSeconds),
    ctx,
    gazetteer.overpass,
  );
  await deps.archive.put(`datasets/osm-cables/${date}/${input.scope.key}.json`, raw, "application/json");
  const cableSources: RestrictionLayer["sources"] = [];
  for (const el of elements) {
    const line = wayLine(el);
    if (line) cableSources.push({ ref: `osm-cable:way/${el.id}`, geometry: line, seaOnly: el.tags?.power === "cable" });
  }
  layers.push({ layerPrefix: "osm-cable:", kind: cables.kind, bufferM: cables.bufferM, sources: cableSources });

  const result: Partial<Record<RestrictedKind, UpsertResult>> = {};
  for (const layer of layers) {
    const features = await normalizeLayer(db, layer);
    const counts = await upsertRestrictedAreas(db, { layerPrefix: layer.layerPrefix, box, features, today: date });
    const sum = (result[layer.kind] ??= { inserted: 0, updated: 0, unchanged: 0, ended: 0 });
    sum.inserted += counts.inserted;
    sum.updated += counts.updated;
    sum.unchanged += counts.unchanged;
    sum.ended += counts.ended;
  }
  return result;
}

/**
 * EMODnet vessel density for the subdivision's dataset box (spec 04: download and archive only in M2), archived as
 * `datasets/emodnet-vessel-density/<datasetVersion>/<subdivisionKey>.tif`; an archived file is not downloaded again.
 */
export async function importVesselDensity(
  db: Db,
  input: DatasetImportInput,
  deps: DatasetImportDeps,
): Promise<{ key: string; reused: boolean }> {
  const cfg = getConfig().datasets.vesselDensity;
  const key = `datasets/emodnet-vessel-density/${cfg.datasetVersion}/${input.scope.key}.tif`;
  if (await deps.archive.exists(key)) return { key, reused: true };
  const bytes = await fetchCoverage(deps.transport, datasetBox(input.scope), callContext(db, input), cfg, "emodnet-vessel-density");
  await deps.archive.put(key, bytes, "image/tiff");
  return { key, reused: false };
}

/**
 * OSM roads (`datasets.roads.highways`) in the subdivision's box plus `roads.bufferKm`. Version = first 12 hex digits
 * of the sha256 over the sorted roads (stable while OSM is unchanged); the raw answer is archived as
 * `datasets/osm-roads/<version>/<subdivisionKey>.json`. Then the roads of the box are replaced.
 */
export async function importRoads(
  db: Db,
  input: DatasetImportInput,
  deps: DatasetImportDeps,
): Promise<{ roads: number; removed: number; version: string }> {
  const { datasets, gazetteer } = getConfig();
  const box = bufferBbox(input.scope.bbox, datasets.roads.bufferKm);
  const { raw, elements } = await overpassQuery(
    deps.transport,
    buildRoadsQuery(box, datasets.roads.highways, gazetteer.overpass.timeoutSeconds),
    callContext(db, input),
    gazetteer.overpass,
  );
  const roads: RoadFeature[] = [];
  for (const el of elements) {
    const line = wayLine(el);
    const highway = el.tags?.highway;
    if (line && highway) roads.push({ osmId: `way/${el.id}`, highway, geometry: line });
  }
  roads.sort((a, b) => a.osmId.localeCompare(b.osmId));
  const version = contentVersion([JSON.stringify(roads)]);
  await deps.archive.put(`datasets/osm-roads/${version}/${input.scope.key}.json`, raw, "application/json");
  const { stored, removed } = await replaceRoads(db, { box, datasetVersion: version, roads });
  return { roads: stored, removed, version };
}

/**
 * OSM piers, breakwaters and groynes (`datasets.harbourStructures.manMade`) in the subdivision's box plus `bufferKm`
 * (spec 19): an open way is stored as a line, a closed one as a polygon. Version = first 12 hex digits of the sha256
 * over the sorted structures; the raw answer is archived as `datasets/osm-harbour-structures/<version>/<key>.json`.
 * Then the structures of the box are replaced.
 */
export async function importHarbourStructures(
  db: Db,
  input: DatasetImportInput,
  deps: DatasetImportDeps,
): Promise<{ structures: number; removed: number; version: string }> {
  const { datasets, gazetteer } = getConfig();
  const cfg = datasets.harbourStructures;
  const box = bufferBbox(input.scope.bbox, cfg.bufferKm);
  const { raw, elements } = await overpassQuery(
    deps.transport,
    buildHarbourStructuresQuery(box, cfg.manMade, gazetteer.overpass.timeoutSeconds),
    callContext(db, input),
    gazetteer.overpass,
  );
  const structures: HarbourStructure[] = [];
  for (const el of elements) {
    const line = wayLine(el);
    const manMade = el.tags?.man_made;
    if (!line || !manMade || !cfg.manMade.includes(manMade)) continue;
    const c = line.coordinates;
    const closed = c.length >= 4 && c[0]![0] === c.at(-1)![0] && c[0]![1] === c.at(-1)![1];
    structures.push({ osmId: `way/${el.id}`, manMade, geometry: closed ? { type: "Polygon", coordinates: [c] } : line });
  }
  structures.sort((a, b) => a.osmId.localeCompare(b.osmId));
  const version = contentVersion([JSON.stringify(structures)]);
  await deps.archive.put(`datasets/osm-harbour-structures/${version}/${input.scope.key}.json`, raw, "application/json");
  const { stored, removed } = await replaceHarbourStructures(db, { box, datasetVersion: version, structures });
  return { structures: stored, removed, version };
}

/**
 * Wikidata sitelink counts (importance signal, ruling M5-P1) of the valid, unmerged objects with a `wikidata_id` in
 * the subdivision's tiles, through `ensureSitelinkCounts`: a count fetched within `datasets.sitelinks.reuseDays` is
 * reused without a call, the others are fetched and upserted; an item Wikidata no longer knows counts 0.
 */
export async function importSitelinks(
  db: Db,
  input: DatasetImportInput,
  deps: Pick<DatasetImportDeps, "transport">,
): Promise<{ fetched: number; reused: number }> {
  const tileIds = await subdivisionTileIds(db, input.scope.subdivisionId);
  if (tileIds.length === 0) throw new Error(`subdivision ${input.scope.key} has no tiles; build its gazetteer first`);
  const { rows } = await db.execute<{ qid: string }>(sql`
    select distinct o.wikidata_id as qid
    from geo_objects o
    join tile_geo_objects tg on tg.geo_object_id = o.id
    join tiles t on t.id = tg.tile_id
    where t.id in (select value from jsonb_array_elements_text(${JSON.stringify(tileIds)}::jsonb)) and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
      and o.wikidata_id is not null and o.merged_into_id is null
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
    order by o.wikidata_id`);
  const { fetched, reused } = await ensureSitelinkCounts(db, rows.map((r) => r.qid), deps, callContext(db, input), input.now ?? new Date());
  return { fetched, reused };
}

/** Runs the import of one dataset kind for one subdivision. */
export async function importDataset(
  db: Db,
  dataset: DatasetKind,
  input: DatasetImportInput,
  deps: DatasetImportDeps,
): Promise<Record<string, unknown>> {
  switch (dataset) {
    case "bathymetry":
      return importBathymetry(db, input, deps);
    case "seabed":
      return importSeabed(db, input, deps);
    case "restrictions":
      return importRestrictions(db, input, deps);
    case "vessel_density":
      return importVesselDensity(db, input, deps);
    case "roads":
      return importRoads(db, input, deps);
    case "harbour_structures":
      return importHarbourStructures(db, input, deps);
    case "sitelinks":
      return importSitelinks(db, input, deps);
  }
}

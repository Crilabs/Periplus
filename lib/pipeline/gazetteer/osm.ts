import { sql } from "drizzle-orm";
import type { Transport } from "@/lib/adapters/http";
import { buildGazetteerQuery, overpassQueryRetrying, type OverpassElement } from "@/lib/adapters/overpass";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { GazetteerScope } from "@/lib/domain/gazetteer/scope";
import { bufferBbox, landCoverage } from "@/lib/domain/gazetteer/land";
import { classifyOsm, osmNames } from "@/lib/domain/gazetteer/osm-classify";
import { assertSeasPresent, nearSea } from "@/lib/domain/gazetteer/sea-distance";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { createLogger } from "@/lib/logger";

export const OSM_STAGE = "gazetteer.osm";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("gazetteer.osm"));

/** OSM tag keys kept in `geo_objects.tags`; `seamark:*` by prefix. */
const KEPT_TAGS = new Set([
  "place",
  "natural",
  "leisure",
  "harbour",
  "mooring",
  "historic",
  "tourism",
  "amenity",
  "shop",
  "man_made",
  "wikidata",
  "website",
  "contact:website",
  "harbour:category",
]);

export function keptTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).filter(([k]) => KEPT_TAGS.has(k) || k.startsWith("seamark:")));
}

/** Multipolygon member roles that carry rings; older relations leave the role empty. */
const RING_ROLES = new Set(["outer", "inner", ""]);

type Coord = { lat: number; lon: number };
const position = (c: Coord): GeoJSON.Position => [c.lon, c.lat];

/**
 * Node → point; way → polygon when closed, else line; relation → its `outer`, `inner` and role-less
 * member ways as lines (`ST_BuildArea` turns inner rings into holes). Null when there is no geometry.
 */
export function elementGeometry(el: OverpassElement): GeoObjectDraft["geometry"] | null {
  if (el.type === "node") {
    return el.lat === undefined || el.lon === undefined ? null : { type: "Point", coordinates: [el.lon, el.lat] };
  }
  if (el.type === "way") {
    if (!el.geometry?.length) return null;
    const coords = el.geometry.map(position);
    const first = coords[0]!;
    const last = coords.at(-1)!;
    const closed = coords.length >= 4 && first[0] === last[0] && first[1] === last[1];
    return closed ? { type: "Polygon", coordinates: [coords] } : { type: "LineString", coordinates: coords };
  }
  const lines = (el.members ?? [])
    .filter((m) => RING_ROLES.has(m.role) && m.geometry?.length)
    .map((m): GeoJSON.LineString => ({ type: "LineString", coordinates: m.geometry!.map(position) }));
  return lines.length > 0 ? { lines } : null;
}

/** Number of member way points of a relation; 0 for nodes and ways. */
export function relationPoints(el: OverpassElement): number {
  return el.type === "relation" ? (el.members ?? []).reduce((n, m) => n + (m.geometry?.length ?? 0), 0) : 0;
}

/**
 * The geometry lies within `distanceM` of non-land: its geography buffer of `distanceM` is not fully
 * covered by the union of the land polygons around it. Cut lines between land pieces (the split
 * dataset, clipping at box edges) therefore do not count as coast.
 */
export async function nearCoast(db: Db, geometry: GeoObjectDraft["geometry"], distanceM: number): Promise<boolean> {
  const g = geomFromGeoJson(
    "lines" in geometry ? { type: "MultiLineString", coordinates: geometry.lines.map((l) => l.coordinates) } : geometry,
  );
  // Index prefilter: distanceM / 50 km per degree over-covers longitude degrees up to ~60° latitude.
  const { rows } = await db.execute<{ near: boolean }>(sql`
    SELECT NOT COALESCE((
      SELECT ST_Covers(ST_Union(l.geom), ST_Buffer(${g}::geography, ${distanceM})::geometry)
      FROM land_polygons l
      WHERE l.geom && ST_Expand(${g}, ${distanceM / 50_000})
    ), false) AS near`);
  return rows[0]!.near;
}

/** One point of a geometry (a node, else the first vertex), enough for a distance of kilometres. */
function samplePoint(geometry: GeoObjectDraft["geometry"]): { lon: number; lat: number } {
  if ("lines" in geometry) return { lon: geometry.lines[0]!.coordinates[0]![0]!, lat: geometry.lines[0]!.coordinates[0]![1]! };
  let c: unknown = (geometry as GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon).coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  const [lon, lat] = c as number[];
  return { lon: lon!, lat: lat! };
}

/**
 * Stage `gazetteer.osm` (Spec 03, step 1): queries Overpass for the subdivision box plus `bboxBufferKm`,
 * archives the raw answer under `datasets/overpass/<subdivision key>/<YYYY-MM-DD>.json` and upserts every
 * classified, named element in one transaction (all or nothing). Settlements are kept only within
 * `coastDistanceM` of the water, POIs only within `poiCoastDistanceKm` of an IHO sea. An element whose geometry cannot be repaired is logged and skipped.
 * Requires land polygons for the box.
 */
export async function importOsm(
  db: Db,
  input: { scope: GazetteerScope; runId: string; now?: Date },
  deps: { transport: Transport; archive: Archive; sleep?: (ms: number) => Promise<void> },
): Promise<{ created: number; updated: number; skipped: number; names: number }> {
  const { scope, runId } = input;
  const { gazetteer, categories } = getConfig();
  const bbox = bufferBbox(scope.bbox, gazetteer.bboxBufferKm);

  if ((await landCoverage(db, bbox)) === 0) {
    throw new Error(`land polygons missing for ${scope.key} – run npm run import:land-polygons`);
  }

  await assertSeasPresent(db, bbox, gazetteer.poiCoastDistanceKm, scope.key);

  // Fetch outside the import transaction: a rollback must not drop the external_calls row.
  const ql = buildGazetteerQuery(bbox, categories, gazetteer.overpass.timeoutSeconds);
  const { raw, elements } = await overpassQueryRetrying(deps.transport, ql, { db, runId, stage: OSM_STAGE }, gazetteer.overpass, { part: "osm", sleep: deps.sleep });
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  await deps.archive.put(`datasets/overpass/${scope.key}/${date}.json`, raw, "application/json");

  return db.transaction(async (tx) => {
    const result = { created: 0, updated: 0, skipped: 0, names: 0 };
    const seaPoints = elements.flatMap((el) => {
      const geometry = classifyOsm(el.tags ?? {}, categories, el.type)?.type === "poi" ? elementGeometry(el) : null;
      return geometry ? [{ key: `${el.type}/${el.id}`, ...samplePoint(geometry) }] : [];
    });
    const poiNearSea = await nearSea(tx, seaPoints, gazetteer.poiCoastDistanceKm);
    for (const el of elements) {
      const tags = el.tags ?? {};
      const cls = classifyOsm(tags, categories, el.type);
      const geometry = cls && elementGeometry(el);
      if (!cls || !geometry) {
        result.skipped++;
        continue;
      }
      const points = relationPoints(el);
      if (points > gazetteer.overpass.maxRelationPoints) {
        getLog().warn({ osmId: `${el.type}/${el.id}`, points }, "skipped osm relation above overpass.maxRelationPoints");
        result.skipped++;
        continue;
      }
      if (cls.type === "settlement" && !(await nearCoast(tx, geometry, gazetteer.coastDistanceM))) {
        result.skipped++;
        continue;
      }
      const osmId = `${el.type}/${el.id}`;
      if (cls.type === "poi" && !poiNearSea.has(osmId)) {
        result.skipped++;
        continue;
      }
      const r = await upsertGeoObject(tx, {
        ...cls,
        origin: "osm",
        osmId,
        tags: keptTags(tags),
        geometry,
        names: osmNames(tags),
      });
      if ("skipped" in r) {
        getLog().warn({ osmId, reason: r.skipped }, "skipped osm element with unusable geometry");
        result.skipped++;
        continue;
      }
      if (r.created) result.created++;
      else if (r.changed) result.updated++;
      result.names += r.names;
    }
    return result;
  });
}

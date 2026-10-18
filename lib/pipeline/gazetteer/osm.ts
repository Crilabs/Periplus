import { sql } from "drizzle-orm";
import type { Transport } from "@/lib/adapters/http";
import { buildGazetteerQuery, overpassQuery, type OverpassElement } from "@/lib/adapters/overpass";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { areaBbox } from "@/lib/domain/gazetteer/areas";
import { bufferBbox, landCoverage } from "@/lib/domain/gazetteer/land";
import { classifyOsm, osmNames } from "@/lib/domain/gazetteer/osm-classify";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";

export const OSM_STAGE = "gazetteer.osm";

/** OSM tag keys kept in `geo_objects.tags`; `seamark:*` by prefix. */
const KEPT_TAGS = new Set(["place", "natural", "leisure", "harbour", "mooring", "historic", "tourism", "amenity", "shop", "wikidata"]);

function keptTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).filter(([k]) => KEPT_TAGS.has(k) || k.startsWith("seamark:")));
}

type Coord = { lat: number; lon: number };
const position = (c: Coord): GeoJSON.Position => [c.lon, c.lat];

/**
 * Node → point; way → polygon when closed, else line; relation → its `outer` member ways as lines.
 * Null when the element carries no geometry.
 */
function elementGeometry(el: OverpassElement): GeoObjectDraft["geometry"] | null {
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
    .filter((m) => m.role === "outer" && m.geometry?.length)
    .map((m): GeoJSON.LineString => ({ type: "LineString", coordinates: m.geometry!.map(position) }));
  return lines.length > 0 ? { lines } : null;
}

/** The geometry lies within `distanceM` of the coastline (the land polygons' boundary), measured on the geography. */
async function nearCoast(db: Db, geometry: GeoObjectDraft["geometry"], distanceM: number): Promise<boolean> {
  const g = geomFromGeoJson(
    "lines" in geometry ? { type: "MultiLineString", coordinates: geometry.lines.map((l) => l.coordinates) } : geometry,
  );
  // Index prefilter: distanceM / 50 km per degree over-covers longitude degrees up to ~60° latitude.
  const { rows } = await db.execute<{ near: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM land_polygons l
      WHERE l.geom && ST_Expand(${g}, ${distanceM / 50_000})
        AND ST_DWithin(${g}::geography, ST_Boundary(l.geom)::geography, ${distanceM})
    ) AS near`);
  return rows[0]!.near;
}

/**
 * Stage `gazetteer.osm` (Spec 03, step 1): queries Overpass for the area box plus `bboxBufferKm`,
 * archives the raw answer under `datasets/overpass/<area>/<YYYY-MM-DD>.json` and upserts every
 * classified, named element in one transaction (all or nothing). Settlements are kept only within
 * `coastDistanceM` of the coastline. Requires land polygons for the box.
 */
export async function importOsm(
  db: Db,
  input: { area: AreaConfig; runId: string; now?: Date },
  deps: { transport: Transport; archive: Archive },
): Promise<{ created: number; updated: number; skipped: number; names: number }> {
  const { area, runId } = input;
  const { gazetteer, categories } = getConfig();
  const bbox = bufferBbox(areaBbox(area), gazetteer.bboxBufferKm);

  if ((await landCoverage(db, bbox)) === 0) {
    throw new Error(`land polygons missing for ${area.key} – run npm run import:land-polygons`);
  }

  // Fetch outside the import transaction: a rollback must not drop the external_calls row.
  const ql = buildGazetteerQuery(bbox, categories, gazetteer.overpass.timeoutSeconds);
  const { raw, elements } = await overpassQuery(deps.transport, ql, { db, runId, stage: OSM_STAGE }, gazetteer.overpass);
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  await deps.archive.put(`datasets/overpass/${area.key}/${date}.json`, raw, "application/json");

  return db.transaction(async (tx) => {
    const result = { created: 0, updated: 0, skipped: 0, names: 0 };
    for (const el of elements) {
      const tags = el.tags ?? {};
      const cls = classifyOsm(tags, categories, el.type);
      const geometry = cls && elementGeometry(el);
      if (!cls || !geometry) {
        result.skipped++;
        continue;
      }
      if (cls.type === "settlement" && !(await nearCoast(tx, geometry, gazetteer.coastDistanceM))) {
        result.skipped++;
        continue;
      }
      const r = await upsertGeoObject(tx, {
        ...cls,
        origin: "osm",
        osmId: `${el.type}/${el.id}`,
        tags: keptTags(tags),
        geometry,
        names: osmNames(tags),
      });
      if (r.created) result.created++;
      else if (r.changed) result.updated++;
      result.names += r.names;
    }
    return result;
  });
}

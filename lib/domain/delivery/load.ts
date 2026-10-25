import { inArray, sql, type SQL } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { DeliveryConfig, ImagesConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import type { GeoObjectType, HighlightCategory, PlaceKind, PlaceStatus } from "@/lib/db/schema/geo";
import { berthStates } from "@/lib/db/schema/research-state";
import type { DocType } from "@/lib/db/schema/sources";
import { decideBerth, loadEvidence } from "@/lib/domain/research/confirmation";
import { popularityForPlaces } from "@/lib/domain/consolidation/derived/popularity";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { deliveryNames } from "@/lib/domain/gazetteer/names";
import { countingSelectionsAt } from "@/lib/domain/highlights/selections";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { imageBlockedBy, imageSources } from "@/lib/domain/images/delivery-gate";
import { utmSridFor } from "@/lib/domain/geometry/projection";
import { latestProfiles, validAtAlias } from "@/lib/domain/timeline";
import type {
  BerthStateRow,
  DeliverableImage,
  LonLat,
  NearbyObject,
  PassageSource,
  PoiSource,
  RegionSource,
  SourceRefRow,
  SpotName,
  SpotSource,
  SubdivisionScope,
} from "./types";

/*
 * Loads what a delivery of one subdivision consists of (spec 08, spec 14), on the build date `today`: the places
 * delivered as spots, merged places, POIs, regions and passages whose geo object belongs to the subdivision
 * (`geo_objects.subdivision_id`, the nearest land; never the tile label, so a harbour in a tile labelled with the
 * neighbour is still delivered here). A spot comes with its berth state (contract 4.0) and the things on land its
 * state names; POIs, regions and passages with their latest profile, names and documents; the scope tiles with their
 * state and the sailing areas (Reviere) that touch them. One query per kind of object; lists sorted by public id
 * (passages by geo object id).
 */

const METRES_PER_NM = 1852;

/** Language tag of a delivered transliteration: Greek in Latin script (BCP 47). */
export const TRANSLITERATION_LANG = "el-Latn";

export class SubdivisionNotFound extends Error {
  constructor(readonly subdivisionId: string) {
    super(`subdivision ${subdivisionId} is no valid subdivision`);
    this.name = "SubdivisionNotFound";
  }
}

/**
 * One bound array parameter cast to `type` (`text[]`, `uuid[]`, `int[]`): the driver serializes and escapes the
 * values, so a comma, brace or quote never splits an element (a JS array inside `sql` would expand to a value list).
 */
export const arrayParam = (values: Array<string | number>, type: "text" | "uuid" | "int") =>
  sql`${sql.param(values)}::${sql.raw(type)}[]`;

const round = (n: number, digits: number) => Number(n.toFixed(digits));
const point = (lon: number, lat: number): LonLat => ({ lon: Number(lon), lat: Number(lat) });
const byPublicId = <T extends { publicId: string }>(a: T, b: T) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0);

export async function loadSubdivisionScope(
  db: Db,
  subdivisionId: string,
  cfg: DeliveryConfig,
  today: string,
  imagesCfg: ImagesConfig = getConfig().images,
): Promise<SubdivisionScope> {
  const tileIds = await subdivisionTileIds(db, subdivisionId);
  const tileArray = arrayParam(tileIds, "text");
  const loaded = await loadSubdivision(db, subdivisionId, tileArray, today);
  const tiles = await loadTiles(db, subdivisionId, tileArray, cfg, today);

  // Sequential: the build runs in one transaction, whose connection takes one query at a time.
  const spotRows = await loadSpotRows(db, subdivisionId, cfg, today);
  const merged = await loadMerged(db, subdivisionId);
  const poiRows = await loadPoiRows(db, subdivisionId, today);
  const regionRows = await loadRegionRows(db, subdivisionId, cfg, today);
  const passages = await loadPassages(db, subdivisionId, today);
  const areaRows = await loadAreas(db, tileArray, today);

  const states = await loadStates(db, spotRows.map((r) => r.placeId));
  const evidence = await loadEvidence(db, spotRows.map((r) => r.placeId));
  const confirmationCfg = getConfig().research.confirmation;
  const nearbyObjectRows = await loadNearbyObjects(db, [...states.values()].flatMap((st) => st.nearby.map((n) => n.geoObjectId)), today);
  const objectIds = [...spotRows, ...poiRows, ...regionRows].map((r) => r.geoObjectId);
  const profiles = await latestProfiles(db, [...objectIds, ...passages.map((p) => p.geoObjectId)]);
  const names = await loadNames(db, [loaded.geoObjectId, ...areaRows.map((a) => a.geoObjectId), ...objectIds, ...nearbyObjectRows.map((o) => o.geoObjectId)], today);
  const popularity = await popularityForPlaces(db, spotRows.map((r) => r.geoObjectId), today, cfg.popularity.neighbourhoodNm);
  const withProfile = poiRows.map((r) => r.geoObjectId).filter((id) => profiles.has(id));
  const summaries = await loadSummaries(db, withProfile, profiles);
  const sources = await loadSources(db, withProfile, profiles);
  const images = await loadPlaceImages(db, [...spotRows, ...poiRows].map((r) => r.geoObjectId), today, imagesCfg);

  const nearbyObjects = new Map(nearbyObjectRows.map((o): [string, NearbyObject] => [o.geoObjectId, { ...o, names: names.get(o.geoObjectId) ?? [] }]));
  const spots: SpotSource[] = spotRows.map((r) => {
    const state = states.get(r.placeId) ?? null;
    return {
      ...r,
      names: names.get(r.geoObjectId) ?? [],
      state,
      independentSources: decideBerth(r.kind, evidence.get(r.placeId) ?? [], confirmationCfg).independentSources.length,
      nearbyObjects: (state?.nearby ?? []).flatMap((n) => nearbyObjects.get(n.geoObjectId) ?? []),
      popularity: popularity.get(r.geoObjectId) ?? null,
      images: images.get(r.geoObjectId) ?? [],
    };
  });
  const pois: PoiSource[] = poiRows.map((r) => ({
    ...r,
    profile: profiles.get(r.geoObjectId) ?? null,
    summary: summaries.get(r.geoObjectId) ?? null,
    sources: sources.get(r.geoObjectId) ?? [],
    images: images.get(r.geoObjectId) ?? [],
  }));
  const regions: RegionSource[] = regionRows.map((r) => ({
    ...r,
    names: (names.get(r.geoObjectId) ?? []).map(({ lang, name }) => ({ lang, name })),
    profile: profiles.get(r.geoObjectId) ?? null,
  }));
  const { geoObjectId, ...subdivision } = loaded;
  return {
    subdivision: { ...subdivision, names: (names.get(geoObjectId) ?? []).map(({ lang, name }) => ({ lang, name })) },
    areas: areaRows.map((a) => ({
      publicId: a.publicId,
      key: a.key,
      names: (names.get(a.geoObjectId) ?? []).map(({ lang, name }) => ({ lang, name })),
    })),
    tiles,
    spots: spots.sort(byPublicId),
    merged,
    pois: pois.sort(byPublicId),
    regions: regions.sort(byPublicId),
    passages: passages.map((p) => ({ ...p, profile: profiles.get(p.geoObjectId) ?? null })),
  };
}

async function loadSubdivision(
  db: Db,
  subdivisionId: string,
  tileArray: SQL,
  today: string,
): Promise<Omit<SubdivisionScope["subdivision"], "names"> & { geoObjectId: string }> {
  const { rows } = await db.execute<{
    public_id: string;
    key: string;
    geo_object_id: string;
    polygon: GeoJSON.Geometry;
    west: number;
    south: number;
    east: number;
    north: number;
  }>(sql`
    select s.public_id, s.key, s.geo_object_id,
           ST_AsGeoJSON(s.geom, 5)::json as polygon,
           ext.west, ext.south, ext.east, ext.north
    from subdivisions s
    cross join lateral (
      select ST_XMin(e) as west, ST_YMin(e) as south, ST_XMax(e) as east, ST_YMax(e) as north
      -- the scope tiles; a subdivision without tiles falls back to its own box
      from (
        select coalesce(
          (select ST_Extent(t.bbox)::geometry from tiles t where t.id = any(${tileArray})),
          ST_Envelope(s.geom)
        ) as e
      ) x
    ) ext
    where s.id = ${subdivisionId} and ${validAtAlias("s", today)}
  `);
  const row = rows[0];
  if (!row) throw new SubdivisionNotFound(subdivisionId);
  if (row.polygon.type !== "Polygon" && row.polygon.type !== "MultiPolygon") {
    throw new Error(`subdivision ${subdivisionId} has a ${row.polygon.type} geometry, expected a polygon`);
  }
  const bbox = [row.west, row.south, row.east, row.north].map((n) => round(Number(n), 5)) as [number, number, number, number];
  return {
    id: subdivisionId,
    geoObjectId: row.geo_object_id,
    publicId: row.public_id,
    key: row.key,
    name: (await deliveryNames(db, [row.geo_object_id], today)).get(row.geo_object_id) ?? "",
    polygon: row.polygon,
    bbox,
  };
}

/** Places delivered as spots: valid, a delivered status, a public id, unmerged, on the land of the subdivision. */
function spotFilter(subdivisionId: string, cfg: DeliveryConfig, today: string): SQL {
  return sql`${validAtAlias("p", today)} and p.public_id is not null and p.merged_into_id is null
    and p.status::text = any(${arrayParam(cfg.spots.statuses, "text")})
    and exists (select 1 from geo_objects o
                where o.id = p.geo_object_id and o.merged_into_id is null and o.subdivision_id = ${subdivisionId}
                  and ${validAtAlias("o", today)})`;
}

async function loadTiles(db: Db, subdivisionId: string, tileArray: SQL, cfg: DeliveryConfig, today: string): Promise<SubdivisionScope["tiles"]> {
  const { rows } = await db.execute<{ id: string; last_run_at: string | Date | null; states_as_of: string | null }>(sql`
    select t.id, t.last_run_at,
      (select max((bs.updated_at at time zone 'UTC')::date)
         from places p
         join berth_states bs on bs.place_id = p.id
         where p.tile_id = t.id and ${spotFilter(subdivisionId, cfg, today)})::text as states_as_of
    from tiles t
    where t.id = any(${tileArray})
    order by t.id
  `);
  return rows.map((r) => ({
    id: r.id,
    lastRunAt: r.last_run_at === null ? null : new Date(r.last_run_at).toISOString(),
    statesAsOf: r.states_as_of,
  }));
}

type SpotRow = Omit<SpotSource, "names" | "state" | "independentSources" | "nearbyObjects" | "popularity" | "images">;

async function loadSpotRows(db: Db, subdivisionId: string, cfg: DeliveryConfig, today: string): Promise<SpotRow[]> {
  const anchorConfidence = getConfig().geometry.anchorArea.positionConfidence;
  const { rows } = await db.execute<{
    place_id: string;
    geo_object_id: string;
    public_id: string;
    kind: PlaceKind;
    status: PlaceStatus;
    status_reason: string | null;
    lon: number;
    lat: number;
    anchor_lon: number | null;
    anchor_lat: number | null;
    osm_id: string | null;
    wikidata_id: string | null;
  }>(sql`
    select p.id as place_id, p.geo_object_id, p.public_id, p.kind, p.status, p.status_reason,
           ST_X(p.position) as lon, ST_Y(p.position) as lat,
           ST_X(p.anchor_position) as anchor_lon, ST_Y(p.anchor_position) as anchor_lat,
           g.osm_id, g.wikidata_id
    from places p
    join geo_objects g on g.id = p.geo_object_id
    where ${spotFilter(subdivisionId, cfg, today)}
    order by p.public_id
  `);
  const names = await deliveryNames(db, rows.map((r) => r.geo_object_id), today);
  return rows.map((r) => ({
    placeId: r.place_id,
    geoObjectId: r.geo_object_id,
    publicId: r.public_id,
    kind: r.kind,
    status: r.status,
    statusReason: r.status_reason,
    position: point(r.lon, r.lat),
    anchor: r.anchor_lon === null || r.anchor_lat === null ? null : { ...point(r.anchor_lon, r.anchor_lat), confidence: anchorConfidence },
    name: names.get(r.geo_object_id) ?? "",
    osmId: r.osm_id,
    wikidataId: r.wikidata_id,
  }));
}

/** The berth states of the places, by place id (`berth_states`, one row per place). */
async function loadStates(db: Db, placeIds: string[]): Promise<Map<string, BerthStateRow>> {
  if (placeIds.length === 0) return new Map();
  const rows = await db.select().from(berthStates).where(inArray(berthStates.placeId, placeIds));
  return new Map(rows.map((r) => [r.placeId, r]));
}

/** The geo objects the states' `nearby` entries name: public id (null without), valid and unmerged on `today`, and position. */
async function loadNearbyObjects(db: Db, geoObjectIds: string[], today: string): Promise<Array<Omit<NearbyObject, "names">>> {
  const ids = [...new Set(geoObjectIds)];
  if (ids.length === 0) return [];
  const { rows } = await db.execute<{ id: string; public_id: string | null; lon: number; lat: number }>(sql`
    select o.id, o.public_id, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from geo_objects o
    where o.id = any(${arrayParam(ids, "uuid")}) and o.merged_into_id is null and ${validAtAlias("o", today)}
  `);
  const names = await deliveryNames(db, rows.map((r) => r.id), today);
  return rows.map((r) => ({ geoObjectId: r.id, publicId: r.public_id, name: names.get(r.id) ?? "", position: point(r.lon, r.lat) }));
}

/**
 * Places of the subdivision with a public id that were merged into another place: the final target, following
 * `places.merged_into_id` to an unmerged place with a public id (ruling M6-P14). A merged place belongs to the
 * subdivision of its own geo object, else (never assigned) to that of the final target.
 */
async function loadMerged(db: Db, subdivisionId: string): Promise<SubdivisionScope["merged"]> {
  const { rows } = await db.execute<{ public_id: string; target_public_id: string }>(sql`
    with recursive chain(start_id, target_id, depth) as (
      select p.id, p.merged_into_id, 1
      from places p
      where p.public_id is not null and p.merged_into_id is not null
      union all
      select c.start_id, n.merged_into_id, c.depth + 1
      from chain c join places n on n.id = c.target_id
      where n.merged_into_id is not null and c.depth < 100
    ),
    final as (select distinct on (start_id) start_id, target_id from chain order by start_id, depth desc)
    select s.public_id, tg.public_id as target_public_id
    from final f
    join places s on s.id = f.start_id
    join places tg on tg.id = f.target_id
    join geo_objects sg on sg.id = s.geo_object_id
    join geo_objects tgg on tgg.id = tg.geo_object_id
    where tg.public_id is not null and tg.merged_into_id is null
      and coalesce(sg.subdivision_id, tgg.subdivision_id) = ${subdivisionId}
    order by s.public_id
  `);
  return rows.map((r) => ({ publicId: r.public_id, mergedIntoPublicId: r.target_public_id }));
}

type PoiRow = Omit<PoiSource, "profile" | "summary" | "sources" | "images">;

/**
 * The highlights of the subdivision (spec 16): POIs of the subdivision that a place of the subdivision selected
 * (`highlight_selections`, only rows that count on `today`), each with every such selecting place and its distance.
 * Unselected POI candidates are never loaded.
 */
async function loadPoiRows(db: Db, subdivisionId: string, today: string): Promise<PoiRow[]> {
  const { rows } = await db.execute<{
    geo_object_id: string;
    public_id: string;
    category: HighlightCategory;
    lon: number;
    lat: number;
    osm_id: string | null;
    wikidata_id: string | null;
    selected_by: Array<{ placeGeoObjectId: string; distanceKm: number }>;
  }>(sql`
    select o.id as geo_object_id, o.public_id, o.category,
           ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat, o.osm_id, o.wikidata_id,
           json_agg(json_build_object('placeGeoObjectId', hs.place_geo_object_id, 'distanceKm', hs.distance_km)
                    order by hs.place_geo_object_id) as selected_by
    from ${countingSelectionsAt(today)}
    where o.type = 'poi' and o.public_id is not null and o.category is not null
      and o.subdivision_id = ${subdivisionId} and po.subdivision_id = ${subdivisionId}
    group by o.id
    order by o.public_id
  `);
  const names = await deliveryNames(db, rows.map((r) => r.geo_object_id), today);
  return rows.map((r) => ({
    geoObjectId: r.geo_object_id,
    publicId: r.public_id,
    category: r.category,
    name: names.get(r.geo_object_id) ?? "",
    position: point(r.lon, r.lat),
    osmId: r.osm_id,
    wikidataId: r.wikidata_id,
    selectedBy: r.selected_by.map((x) => ({ placeGeoObjectId: x.placeGeoObjectId, distanceKm: Number(x.distanceKm) })),
  }));
}

type RegionRow = Omit<RegionSource, "names" | "profile" | "sources">;

async function loadRegionRows(db: Db, subdivisionId: string, cfg: DeliveryConfig, today: string): Promise<RegionRow[]> {
  const { rows } = await db.execute<{
    geo_object_id: string;
    public_id: string;
    type: GeoObjectType;
    lon: number;
    lat: number;
    areal: boolean;
    area_m2: number | null;
    ancestors: string[];
  }>(sql`
    select o.id as geo_object_id, o.public_id, o.type,
           ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat,
           GeometryType(o.geom) in ('POLYGON', 'MULTIPOLYGON') as areal,
           case when GeometryType(o.geom) in ('POLYGON', 'MULTIPOLYGON') then ST_Area(o.geom::geography) end as area_m2,
           array(
             with recursive up(id, parent_id, depth) as (
               select a.id, a.parent_id, 1 from geo_objects a where a.id = o.parent_id
               union all
               select a.id, a.parent_id, up.depth + 1 from up join geo_objects a on a.id = up.parent_id where up.depth < 50
             )
             select up.id::text from up order by up.depth
           ) as ancestors
    from geo_objects o
    where o.type::text = any(${arrayParam(cfg.regions.types, "text")}) and o.public_id is not null
      and o.merged_into_id is null and ${validAtAlias("o", today)} and o.subdivision_id = ${subdivisionId}
    order by o.public_id
  `);
  const polygons = await simplifiedPolygons(
    db,
    rows.filter((r) => r.areal).map((r) => ({ id: r.geo_object_id, srid: utmSridFor(Number(r.lon), Number(r.lat)) })),
    cfg.regions.simplifyToleranceM,
  );
  const names = await deliveryNames(db, rows.map((r) => r.geo_object_id), today);
  return rows.map((r) => ({
    geoObjectId: r.geo_object_id,
    publicId: r.public_id,
    type: r.type,
    name: names.get(r.geo_object_id) ?? "",
    polygon: polygons.get(r.geo_object_id)?.polygon ?? null,
    center: point(r.lon, r.lat),
    radiusNm: polygons.has(r.geo_object_id)
      ? round(polygons.get(r.geo_object_id)!.maxDistanceM / METRES_PER_NM, 1)
      : cfg.regions.pointRadiusNm,
    areaKm2: r.area_m2 === null ? null : Number(r.area_m2) / 1e6,
    parentGeoObjectIds: r.ancestors,
  }));
}

type SimplifiedPolygon = { polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon; maxDistanceM: number };

/**
 * Region polygons simplified with `toleranceM` in their UTM zone, as GeoJSON with 5 decimals, and the largest distance
 * from the centroid to a vertex of the simplified polygon (the radius; within `toleranceM` of the full geometry's, at a
 * fraction of the cost for a large island).
 */
async function simplifiedPolygons(
  db: Db,
  regions: Array<{ id: string; srid: number }>,
  toleranceM: number,
): Promise<Map<string, SimplifiedPolygon>> {
  if (regions.length === 0) return new Map();
  const { rows } = await db.execute<{ id: string; polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon; max_distance_m: number }>(sql`
    select o.id, ST_AsGeoJSON(s.geom, 5)::json as polygon,
           (select max(ST_Distance(o.centroid::geography, d.geom::geography)) from ST_DumpPoints(s.geom) d) as max_distance_m
    from unnest(${arrayParam(regions.map((r) => r.id), "uuid")}, ${arrayParam(regions.map((r) => r.srid), "int")}) as x(id, srid)
    join geo_objects o on o.id = x.id
    cross join lateral (
      select ST_Transform(ST_SimplifyPreserveTopology(ST_Transform(o.geom, x.srid), ${toleranceM}), 4326) as geom
    ) s
  `);
  return new Map(rows.map((r) => [r.id, { polygon: r.polygon, maxDistanceM: Number(r.max_distance_m) }]));
}

async function loadPassages(db: Db, subdivisionId: string, today: string): Promise<Array<Omit<PassageSource, "profile">>> {
  const { rows } = await db.execute<{ geo_object_id: string; type: PassageSource["type"]; lon: number; lat: number }>(sql`
    select o.id as geo_object_id, o.type, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from geo_objects o
    where o.type in ('cape', 'strait', 'channel') and o.merged_into_id is null and ${validAtAlias("o", today)}
      and o.subdivision_id = ${subdivisionId}
    order by o.id
  `);
  const names = await deliveryNames(db, rows.map((r) => r.geo_object_id), today);
  return rows.map((r) => ({ geoObjectId: r.geo_object_id, type: r.type, name: names.get(r.geo_object_id) ?? "", point: point(r.lon, r.lat) }));
}

/** The sailing areas (Reviere, geo objects of type `area` with a public id) linked to the scope tiles. */
async function loadAreas(db: Db, tileArray: SQL, today: string): Promise<Array<{ geoObjectId: string; publicId: string; key: string }>> {
  const { rows } = await db.execute<{ id: string; public_id: string; config_key: string | null }>(sql`
    select o.id, o.public_id, o.config_key
    from geo_objects o
    where o.type = 'area' and o.public_id is not null and o.merged_into_id is null and ${validAtAlias("o", today)}
      and exists (select 1 from tile_geo_objects tg where tg.geo_object_id = o.id and tg.tile_id = any(${tileArray}))
    order by o.public_id
  `);
  return rows.map((r) => ({ geoObjectId: r.id, publicId: r.public_id, key: r.config_key ?? r.public_id }));
}

/**
 * Valid names without fallbacks (copies of the English name), sorted by language and name, one per (language, name).
 * The ELOT 743 transliteration of a Greek name is delivered as `el-Latn` (BCP 47: Greek in Latin script), unless the
 * object has the same name already from a source (gesamt-review DAT-1).
 */
async function loadNames(db: Db, geoObjectIds: string[], today: string): Promise<Map<string, SpotName[]>> {
  const { rows } = await db.execute<{ geo_object_id: string; language: string; name: string; script: SpotName["script"] }>(sql`
    select distinct on (n.geo_object_id, x.language, n.name) n.geo_object_id, x.language, n.name, n.script
    from geo_names n
    cross join lateral (
      select case when n.origin = 'transliteration' then ${TRANSLITERATION_LANG}::text else n.language end as language
    ) x
    where n.geo_object_id = any(${arrayParam(geoObjectIds, "uuid")}) and ${validAtAlias("n", today)}
      and n.origin <> 'fallback'
      and not (n.origin = 'transliteration' and exists (
        select 1 from geo_names s
        where s.geo_object_id = n.geo_object_id and s.name = n.name and s.origin not in ('transliteration', 'fallback')
          and ${validAtAlias("s", today)}
      ))
    order by n.geo_object_id, x.language, n.name, n.script
  `);
  const names = new Map<string, SpotName[]>();
  for (const r of rows) {
    const list = names.get(r.geo_object_id) ?? [];
    list.push({ lang: r.language, name: r.name, script: r.script });
    names.set(r.geo_object_id, list);
  }
  return names;
}

/**
 * The `ok` summary of each object's latest profile version, highest prompt version first (ruling M6-P9), then the newest
 * (a „Summary neu erzeugen“ adds one beside the old, ruling M6-H-R1).
 */
async function loadSummaries(
  db: Db,
  geoObjectIds: string[],
  profiles: Map<string, ProfileSnapshot>,
): Promise<Map<string, string>> {
  if (geoObjectIds.length === 0) return new Map();
  const versions = geoObjectIds.map((id) => profiles.get(id)!.version);
  const { rows } = await db.execute<{ geo_object_id: string; text: string }>(sql`
    select distinct on (s.geo_object_id) s.geo_object_id, s.text
    from unnest(${arrayParam(geoObjectIds, "uuid")}, ${arrayParam(versions, "int")}) as x(geo_object_id, version)
    join profile_summaries s on s.geo_object_id = x.geo_object_id and s.profile_version = x.version
    where s.status = 'ok'
    order by s.geo_object_id, s.prompt_version desc, s.created_at desc, s.id desc
  `);
  return new Map(rows.map((r) => [r.geo_object_id, r.text]));
}

/** A fact id (uuid); input ids of computations and POIs (`computation:…`, `poi:…`) name no document. */
const FACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMAGE_SLOT = /^(?:title|view-[1-9]\d*)$/;
const round2 = (n: number) => Number(n.toFixed(2));

/**
 * The deliverable current images of the geo objects on `today` (spec 13), best first: rank, then sort order, then slot.
 * An image is deliverable only when every source of its render's tiles has `images.delivery[source] === true`
 * (`imageBlockedBy`; a blank tile is no source), it has a license and an attribution, and its slot is a contract slot.
 * An object without a deliverable image has no entry.
 */
export async function loadPlaceImages(
  db: Db,
  geoObjectIds: string[],
  today: string,
  cfg: Pick<ImagesConfig, "delivery">,
): Promise<Map<string, DeliverableImage[]>> {
  const out = new Map<string, DeliverableImage[]>();
  if (geoObjectIds.length === 0) return out;
  const { rows } = await db.execute<{
    id: string;
    geo_object_id: string;
    kind: DeliverableImage["kind"];
    slot: string;
    sort_order: number;
    rank: number;
    file_key: string;
    width: number;
    height: number;
    alt: string;
    light: DeliverableImage["light"];
    observed_at: string | null;
    license: string | null;
    attribution: string | null;
    lon: number | null;
    lat: number | null;
    camera_height_m: number | null;
    view_bearing_deg: number | null;
    camera_tilt_deg: number | null;
    camera_fov_deg: number | null;
  }>(sql`
    select i.id, i.geo_object_id, i.kind, i.slot, i.sort_order, i.rank, i.file_key, i.width, i.height, i.alt, i.light,
           i.observed_at::text as observed_at, i.license, i.attribution,
           ST_X(i.camera_position) as lon, ST_Y(i.camera_position) as lat, i.camera_height_m, i.view_bearing_deg,
           i.camera_tilt_deg, i.camera_fov_deg
    from place_images i
    where i.geo_object_id = any(${arrayParam(geoObjectIds, "uuid")}) and ${validAtAlias("i", today)}
    order by i.rank, i.sort_order, i.slot
  `);
  const sources = await imageSources(db, rows.map((r) => r.id));
  for (const r of rows) {
    if (!IMAGE_SLOT.test(r.slot) || !r.license || !r.attribution) continue;
    if (imageBlockedBy(sources.get(r.id) ?? [], cfg.delivery).length > 0) continue;
    const located =
      r.lon !== null && r.lat !== null && r.camera_height_m !== null && r.view_bearing_deg !== null && r.camera_tilt_deg !== null && r.camera_fov_deg !== null;
    const image: DeliverableImage = {
      id: r.id,
      slot: r.slot,
      sortOrder: r.sort_order,
      rank: r.rank,
      kind: r.kind,
      fileKey: r.file_key,
      width: r.width,
      height: r.height,
      alt: r.alt,
      light: r.light,
      observedAt: r.observed_at,
      license: r.license,
      attribution: r.attribution,
      camera: located
        ? {
            position: [round(Number(r.lon), 5), round(Number(r.lat), 5)],
            heightM: round2(Number(r.camera_height_m)),
            viewBearingDeg: round2(Number(r.view_bearing_deg)) % 360,
            tiltDeg: round2(Number(r.camera_tilt_deg)),
            fovDeg: round2(Number(r.camera_fov_deg)),
          }
        : null,
    };
    const list = out.get(r.geo_object_id);
    if (list) list.push(image);
    else out.set(r.geo_object_id, [image]);
  }
  return out;
}

/**
 * The facts a profile value rests on: for a list attribute the ids of its delivered entries (`entryFactIds`, the flat
 * `factIds` also hold facts of entries a review removed), else `factIds`.
 */
function valueFactIds(p: ProfileSnapshot["provenance"][string]): string[] {
  const ids = p.entryFactIds ? Object.values(p.entryFactIds).flat() : (p.factIds ?? []);
  return ids.filter((id) => FACT_ID.test(id));
}

/**
 * The documents behind each object's profile: the facts the values rest on (`valueFactIds`) that rest on a mention,
 * via the mention's version to its document; a gone document is marked `gone` (left out of `sources`, still checked
 * against the forbidden domains, final review M-1). Per URL the newest effective observation date and that version's
 * effective document type (classification first, ruling M6-P10); never a quote.
 */
async function loadSources(
  db: Db,
  geoObjectIds: string[],
  profiles: Map<string, ProfileSnapshot>,
): Promise<Map<string, SourceRefRow[]>> {
  const pairs: Array<[string, string]> = [];
  for (const id of geoObjectIds) {
    const factIds = new Set(Object.values(profiles.get(id)!.provenance).flatMap(valueFactIds));
    for (const factId of factIds) pairs.push([id, factId]);
  }
  if (pairs.length === 0) return new Map();
  const { rows } = await db.execute<{ geo_object_id: string; url: string; doc_type: DocType; observed_at: string; gone: boolean }>(sql`
    select distinct on (x.geo_object_id, d.url) x.geo_object_id, d.url, d.status = 'gone' as gone,
           coalesce(v.classified_doc_type, v.doc_type) as doc_type,
           coalesce(v.classified_observed_at, v.observed_at)::text as observed_at
    from unnest(${arrayParam(pairs.map((p) => p[0]), "uuid")}, ${arrayParam(pairs.map((p) => p[1]), "uuid")})
      as x(geo_object_id, fact_id)
    join facts f on f.id = x.fact_id
    join mentions m on m.id = f.mention_id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    order by x.geo_object_id, d.url, coalesce(v.classified_observed_at, v.observed_at) desc, v.fetched_at desc
  `);
  const sources = new Map<string, SourceRefRow[]>();
  for (const r of rows) {
    const list = sources.get(r.geo_object_id) ?? [];
    list.push({ url: r.url, docType: r.doc_type, observedAt: r.observed_at, ...(r.gone ? { gone: true } : {}) });
    sources.set(r.geo_object_id, list);
  }
  return sources;
}

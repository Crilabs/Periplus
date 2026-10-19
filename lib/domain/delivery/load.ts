import { sql, type SQL } from "drizzle-orm";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import type { GeoObjectType, PlaceKind, PlaceStatus, PoiCategory } from "@/lib/db/schema/geo";
import type { DocType } from "@/lib/db/schema/sources";
import { popularityForArea } from "@/lib/domain/consolidation/derived/popularity";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { utmSridFor } from "@/lib/domain/geometry/projection";
import { latestProfiles } from "@/lib/domain/timeline";
import type {
  AreaScope,
  LonLat,
  PassageSource,
  PoiSource,
  RegionSource,
  SourceRefRow,
  SpotName,
  SpotSource,
} from "./types";

/*
 * Loads what a delivery of one area consists of (spec 08), on the build date `today`: the area's valid tiles, the
 * places of those tiles delivered as spots (partition by `places.tile_id`), merged places, POIs whose centroid lies in
 * one of the tiles, regions and passages assigned to the tiles (`tile_geo_objects`), each with its latest profile,
 * names and documents. One query per kind of object; lists sorted by public id (passages by geo object id).
 */

const METRES_PER_NM = 1852;

export class AreaNotFound extends Error {
  constructor(readonly areaGeoObjectId: string) {
    super(`area ${areaGeoObjectId} is no valid area with a public id`);
    this.name = "AreaNotFound";
  }
}

/** `<alias>` is valid on `today`: `valid_from <= today < valid_to` (as `validAt`, for raw-SQL aliases). */
function validOn(alias: string, today: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.valid_from <= ${today}::date and (${a}.valid_to is null or ${a}.valid_to > ${today}::date))`;
}

/** A Postgres array literal for `::uuid[]` / `::text[]` parameters. */
const arrayLiteral = (values: string[]) => `{${values.join(",")}}`;

const round = (n: number, digits: number) => Number(n.toFixed(digits));
const point = (lon: number, lat: number): LonLat => ({ lon: Number(lon), lat: Number(lat) });
const byPublicId = <T extends { publicId: string }>(a: T, b: T) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0);

export async function loadAreaScope(
  db: Db,
  areaGeoObjectId: string,
  cfg: DeliveryConfig,
  today: string,
): Promise<AreaScope> {
  const area = await loadArea(db, areaGeoObjectId, today);
  const tiles = await loadTiles(db, areaGeoObjectId, cfg, today);
  const tileIds = tiles.map((t) => t.id);
  const tileArray = arrayLiteral(tileIds);

  // Sequential: the build runs in one transaction, whose connection takes one query at a time.
  const spotRows = await loadSpotRows(db, areaGeoObjectId, cfg, today);
  const merged = await loadMerged(db, areaGeoObjectId, today);
  const poiRows = await loadPoiRows(db, tileArray, today);
  const regionRows = await loadRegionRows(db, tileArray, cfg, today);
  const passages = await loadPassages(db, tileArray, today);

  const objectIds = [...spotRows, ...poiRows, ...regionRows].map((r) => r.geoObjectId);
  const profiles = await latestProfiles(db, objectIds);
  const names = await loadNames(db, [areaGeoObjectId, ...objectIds], today);
  const popularity = await popularityForArea(db, areaGeoObjectId, today);
  const withProfile = [...spotRows, ...poiRows].map((r) => r.geoObjectId).filter((id) => profiles.has(id));
  const summaries = await loadSummaries(db, withProfile, profiles);
  const sources = await loadSources(db, withProfile, profiles);

  const spots: SpotSource[] = spotRows.map((r) => ({
    ...r,
    names: names.get(r.geoObjectId) ?? [],
    profile: profiles.get(r.geoObjectId) ?? null,
    summary: summaries.get(r.geoObjectId) ?? null,
    popularity: popularity.get(r.geoObjectId) ?? null,
    sources: sources.get(r.geoObjectId) ?? [],
  }));
  const pois: PoiSource[] = poiRows.map((r) => ({
    ...r,
    profile: profiles.get(r.geoObjectId) ?? null,
    summary: summaries.get(r.geoObjectId) ?? null,
    sources: sources.get(r.geoObjectId) ?? [],
  }));
  const regions: RegionSource[] = regionRows.map((r) => ({
    ...r,
    names: (names.get(r.geoObjectId) ?? []).map(({ lang, name }) => ({ lang, name })),
    profile: profiles.get(r.geoObjectId) ?? null,
  }));
  return {
    area: { ...area, names: (names.get(areaGeoObjectId) ?? []).map(({ lang, name }) => ({ lang, name })) },
    tiles,
    spots: spots.sort(byPublicId),
    merged,
    pois: pois.sort(byPublicId),
    regions: regions.sort(byPublicId),
    passages,
  };
}

async function loadArea(db: Db, areaId: string, today: string): Promise<Omit<AreaScope["area"], "names">> {
  const { rows } = await db.execute<{
    public_id: string;
    config_key: string | null;
    name: string | null;
    polygon: GeoJSON.Geometry;
    west: number;
    south: number;
    east: number;
    north: number;
  }>(sql`
    select o.public_id, o.config_key, ${displayNameSql(sql`o.id`)} as name,
           ST_AsGeoJSON(o.geom, 5)::json as polygon,
           ext.west, ext.south, ext.east, ext.north
    from geo_objects o
    cross join lateral (
      select ST_XMin(e) as west, ST_YMin(e) as south, ST_XMax(e) as east, ST_YMax(e) as north
      -- the area's tiles; an area without tiles falls back to its own box
      from (
        select coalesce(
          (select ST_Extent(t.bbox)::geometry from tiles t where t.area_id = o.id and ${validOn("t", today)}),
          ST_Envelope(o.geom)
        ) as e
      ) x
    ) ext
    where o.id = ${areaId} and o.type = 'area' and o.public_id is not null and ${validOn("o", today)}
  `);
  const row = rows[0];
  if (!row) throw new AreaNotFound(areaId);
  if (row.polygon.type !== "Polygon" && row.polygon.type !== "MultiPolygon") {
    throw new Error(`area ${areaId} has a ${row.polygon.type} geometry, expected a polygon`);
  }
  const bbox = [row.west, row.south, row.east, row.north].map((n) => round(Number(n), 5)) as [number, number, number, number];
  return {
    geoObjectId: areaId,
    publicId: row.public_id,
    key: row.config_key ?? row.public_id,
    name: row.name ?? "",
    polygon: row.polygon,
    bbox,
  };
}

/** Places delivered as spots: valid, a delivered status, a public id, unmerged, in a valid tile of the area. */
function spotFilter(areaId: string, cfg: DeliveryConfig, today: string): SQL {
  return sql`${validOn("p", today)} and p.public_id is not null and p.merged_into_id is null
    and p.status::text = any(${arrayLiteral(cfg.spots.statuses)}::text[])
    and exists (select 1 from tiles t where t.id = p.tile_id and t.area_id = ${areaId} and ${validOn("t", today)})
    and exists (select 1 from geo_objects o where o.id = p.geo_object_id and o.merged_into_id is null and ${validOn("o", today)})`;
}

async function loadTiles(db: Db, areaId: string, cfg: DeliveryConfig, today: string): Promise<AreaScope["tiles"]> {
  const { rows } = await db.execute<{ id: string; last_run_at: string | Date | null; profiles_as_of: string | null }>(sql`
    select t.id, t.last_run_at,
      (select max(lp.valid_from)
         from places p
         cross join lateral (
           select pr.valid_from from profiles pr where pr.geo_object_id = p.geo_object_id order by pr.version desc limit 1
         ) lp
         where p.tile_id = t.id and ${spotFilter(areaId, cfg, today)})::text as profiles_as_of
    from tiles t
    where t.area_id = ${areaId} and ${validOn("t", today)}
    order by t.id
  `);
  return rows.map((r) => ({
    id: r.id,
    lastRunAt: r.last_run_at === null ? null : new Date(r.last_run_at).toISOString(),
    profilesAsOf: r.profiles_as_of,
  }));
}

type SpotRow = Omit<SpotSource, "names" | "profile" | "summary" | "popularity" | "sources">;

async function loadSpotRows(db: Db, areaId: string, cfg: DeliveryConfig, today: string): Promise<SpotRow[]> {
  const { rows } = await db.execute<{
    place_id: string;
    geo_object_id: string;
    public_id: string;
    kind: PlaceKind;
    status: PlaceStatus;
    status_reason: string | null;
    lon: number;
    lat: number;
    name: string | null;
    osm_id: string | null;
    wikidata_id: string | null;
  }>(sql`
    select p.id as place_id, p.geo_object_id, p.public_id, p.kind, p.status, p.status_reason,
           ST_X(p.position) as lon, ST_Y(p.position) as lat,
           ${displayNameSql(sql`p.geo_object_id`)} as name, g.osm_id, g.wikidata_id
    from places p
    join geo_objects g on g.id = p.geo_object_id
    where ${spotFilter(areaId, cfg, today)}
    order by p.public_id
  `);
  return rows.map((r) => ({
    placeId: r.place_id,
    geoObjectId: r.geo_object_id,
    publicId: r.public_id,
    kind: r.kind,
    status: r.status,
    statusReason: r.status_reason,
    position: point(r.lon, r.lat),
    name: r.name ?? "",
    osmId: r.osm_id,
    wikidataId: r.wikidata_id,
  }));
}

/**
 * Places of the area's tiles with a public id that were merged into another place: the final target, following
 * `places.merged_into_id` to an unmerged place with a public id (ruling M6-P14).
 */
async function loadMerged(db: Db, areaId: string, today: string): Promise<AreaScope["merged"]> {
  const { rows } = await db.execute<{ public_id: string; target_public_id: string }>(sql`
    with recursive chain(start_id, target_id, depth) as (
      select p.id, p.merged_into_id, 1
      from places p
      join tiles t on t.id = p.tile_id and t.area_id = ${areaId} and ${validOn("t", today)}
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
    where tg.public_id is not null and tg.merged_into_id is null
    order by s.public_id
  `);
  return rows.map((r) => ({ publicId: r.public_id, mergedIntoPublicId: r.target_public_id }));
}

type PoiRow = Omit<PoiSource, "profile" | "summary" | "sources">;

async function loadPoiRows(db: Db, tileArray: string, today: string): Promise<PoiRow[]> {
  const { rows } = await db.execute<{
    geo_object_id: string;
    public_id: string;
    category: PoiCategory;
    name: string | null;
    lon: number;
    lat: number;
    osm_id: string | null;
    wikidata_id: string | null;
  }>(sql`
    select o.id as geo_object_id, o.public_id, o.category, ${displayNameSql(sql`o.id`)} as name,
           ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat, o.osm_id, o.wikidata_id
    from geo_objects o
    where o.type = 'poi' and o.public_id is not null and o.category is not null and o.merged_into_id is null
      and ${validOn("o", today)} and tile_id_for(o.centroid) = any(${tileArray}::text[])
    order by o.public_id
  `);
  return rows.map((r) => ({
    geoObjectId: r.geo_object_id,
    publicId: r.public_id,
    category: r.category,
    name: r.name ?? "",
    position: point(r.lon, r.lat),
    osmId: r.osm_id,
    wikidataId: r.wikidata_id,
  }));
}

type RegionRow = Omit<RegionSource, "names" | "profile">;

async function loadRegionRows(db: Db, tileArray: string, cfg: DeliveryConfig, today: string): Promise<RegionRow[]> {
  const { rows } = await db.execute<{
    geo_object_id: string;
    public_id: string;
    type: GeoObjectType;
    name: string | null;
    lon: number;
    lat: number;
    areal: boolean;
    max_distance_m: number | null;
    area_m2: number | null;
    ancestors: string[];
  }>(sql`
    select o.id as geo_object_id, o.public_id, o.type, ${displayNameSql(sql`o.id`)} as name,
           ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat,
           GeometryType(o.geom) in ('POLYGON', 'MULTIPOLYGON') as areal,
           case when GeometryType(o.geom) in ('POLYGON', 'MULTIPOLYGON') then
             (select max(ST_Distance(o.centroid::geography, d.geom::geography)) from ST_DumpPoints(o.geom) d)
           end as max_distance_m,
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
    where o.type::text = any(${arrayLiteral(cfg.regions.types)}::text[]) and o.public_id is not null
      and o.merged_into_id is null and ${validOn("o", today)}
      and exists (select 1 from tile_geo_objects tg where tg.geo_object_id = o.id and tg.tile_id = any(${tileArray}::text[]))
    order by o.public_id
  `);
  const polygons = await simplifiedPolygons(
    db,
    rows.filter((r) => r.areal).map((r) => ({ id: r.geo_object_id, srid: utmSridFor(Number(r.lon), Number(r.lat)) })),
    cfg.regions.simplifyToleranceM,
  );
  return rows.map((r) => ({
    geoObjectId: r.geo_object_id,
    publicId: r.public_id,
    type: r.type,
    name: r.name ?? "",
    polygon: polygons.get(r.geo_object_id) ?? null,
    center: point(r.lon, r.lat),
    radiusNm: r.max_distance_m === null ? cfg.regions.pointRadiusNm : round(Number(r.max_distance_m) / METRES_PER_NM, 1),
    areaKm2: r.area_m2 === null ? null : Number(r.area_m2) / 1e6,
    parentGeoObjectIds: r.ancestors,
  }));
}

/** Region polygons simplified with `toleranceM` in their UTM zone, as GeoJSON with 5 decimals. */
async function simplifiedPolygons(
  db: Db,
  regions: Array<{ id: string; srid: number }>,
  toleranceM: number,
): Promise<Map<string, GeoJSON.Polygon | GeoJSON.MultiPolygon>> {
  if (regions.length === 0) return new Map();
  const { rows } = await db.execute<{ id: string; polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon }>(sql`
    select o.id, ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(ST_Transform(o.geom, x.srid), ${toleranceM}), 4326), 5)::json as polygon
    from unnest(${arrayLiteral(regions.map((r) => r.id))}::uuid[], ${`{${regions.map((r) => r.srid).join(",")}}`}::int[]) as x(id, srid)
    join geo_objects o on o.id = x.id
  `);
  return new Map(rows.map((r) => [r.id, r.polygon]));
}

async function loadPassages(db: Db, tileArray: string, today: string): Promise<PassageSource[]> {
  const { rows } = await db.execute<{ geo_object_id: string; type: PassageSource["type"]; name: string | null; lon: number; lat: number }>(sql`
    select o.id as geo_object_id, o.type, ${displayNameSql(sql`o.id`)} as name, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from geo_objects o
    where o.type in ('cape', 'strait', 'channel') and o.merged_into_id is null and ${validOn("o", today)}
      and exists (select 1 from tile_geo_objects tg where tg.geo_object_id = o.id and tg.tile_id = any(${tileArray}::text[]))
    order by o.id
  `);
  return rows.map((r) => ({ geoObjectId: r.geo_object_id, type: r.type, name: r.name ?? "", point: point(r.lon, r.lat) }));
}

/** Valid names without transliterations and fallbacks, sorted by language and name, one per (language, name). */
async function loadNames(db: Db, geoObjectIds: string[], today: string): Promise<Map<string, SpotName[]>> {
  const { rows } = await db.execute<{ geo_object_id: string; language: string; name: string; script: SpotName["script"] }>(sql`
    select distinct on (n.geo_object_id, n.language, n.name) n.geo_object_id, n.language, n.name, n.script
    from geo_names n
    where n.geo_object_id = any(${arrayLiteral(geoObjectIds)}::uuid[]) and ${validOn("n", today)}
      and n.origin not in ('transliteration', 'fallback')
    order by n.geo_object_id, n.language, n.name, n.script
  `);
  const names = new Map<string, SpotName[]>();
  for (const r of rows) {
    const list = names.get(r.geo_object_id) ?? [];
    list.push({ lang: r.language, name: r.name, script: r.script });
    names.set(r.geo_object_id, list);
  }
  return names;
}

/** The `ok` summary of each object's latest profile version, highest prompt version first (ruling M6-P9). */
async function loadSummaries(
  db: Db,
  geoObjectIds: string[],
  profiles: Map<string, ProfileSnapshot>,
): Promise<Map<string, string>> {
  if (geoObjectIds.length === 0) return new Map();
  const versions = geoObjectIds.map((id) => profiles.get(id)!.version);
  const { rows } = await db.execute<{ geo_object_id: string; text: string }>(sql`
    select distinct on (s.geo_object_id) s.geo_object_id, s.text
    from unnest(${arrayLiteral(geoObjectIds)}::uuid[], ${`{${versions.join(",")}}`}::int[]) as x(geo_object_id, version)
    join profile_summaries s on s.geo_object_id = x.geo_object_id and s.profile_version = x.version
    where s.status = 'ok'
    order by s.geo_object_id, s.prompt_version desc
  `);
  return new Map(rows.map((r) => [r.geo_object_id, r.text]));
}

/**
 * The documents behind each object's profile: the facts of `provenance[*].factIds` that rest on a mention, via the
 * mention's version to its document. Per URL the newest effective observation date and that version's effective
 * document type (classification first, ruling M6-P10); never a quote.
 */
async function loadSources(
  db: Db,
  geoObjectIds: string[],
  profiles: Map<string, ProfileSnapshot>,
): Promise<Map<string, SourceRefRow[]>> {
  const pairs: Array<[string, string]> = [];
  for (const id of geoObjectIds) {
    const factIds = new Set(Object.values(profiles.get(id)!.provenance).flatMap((p) => p.factIds ?? []));
    for (const factId of factIds) pairs.push([id, factId]);
  }
  if (pairs.length === 0) return new Map();
  const { rows } = await db.execute<{ geo_object_id: string; url: string; doc_type: DocType; observed_at: string }>(sql`
    select distinct on (x.geo_object_id, d.url) x.geo_object_id, d.url,
           coalesce(v.classified_doc_type, v.doc_type) as doc_type,
           coalesce(v.classified_observed_at, v.observed_at)::text as observed_at
    from unnest(${arrayLiteral(pairs.map((p) => p[0]))}::uuid[], ${arrayLiteral(pairs.map((p) => p[1]))}::uuid[])
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
    list.push({ url: r.url, docType: r.doc_type, observedAt: r.observed_at });
    sources.set(r.geo_object_id, list);
  }
  return sources;
}

import { sql } from "drizzle-orm";
import type { CoastCollection, CoastFeature } from "@/contract";
import type { Db } from "@/lib/db/client";
import { utmSridFor } from "@/lib/domain/geometry/projection";
import { onGrid, simplified, sortFeatures } from "../coast";

/*
 * `coast.geojson` of a radius package (spec 18, "Was im Paket steht"): the coast files of the subdivision packages,
 * united and cut to the circle buffered by `coast.marginNm` (on the sphere, PostGIS geography). Land is the union of
 * every land polygon, simplified in the UTM zone of the circle centre and cut at the buffer; the coastline the merged
 * union of every coastline cut at the buffer; restricted areas once per geometry, reason and source, cut at the buffer.
 * Five decimals, polygons valid on that grid with counter-clockwise outer rings, sorted as `buildCoast` sorts.
 */

const METRES_PER_NM = 1852;

type Row = { kind: CoastFeature["properties"]["kind"]; reason: string | null; source: string | null; geometry: CoastFeature["geometry"] };

export async function clipCoast(
  db: Db,
  collections: CoastCollection[],
  circle: GeoJSON.Polygon,
  marginNm: number,
  toleranceM: number,
): Promise<CoastCollection> {
  const features = collections.flatMap((c) => c.features);
  if (features.length === 0) return { type: "FeatureCollection", features: [] };
  const ring = circle.coordinates[0]!;
  const lons = ring.map((p) => p[0]!);
  const lats = ring.map((p) => p[1]!);
  const srid = utmSridFor((Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2);

  const { rows } = await db.execute<Row>(sql`
    with c as (
      select ST_SetSRID(ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(circle)}), 4326)::geography, ${marginNm * METRES_PER_NM}::float8)::geometry, 4326) as g
    ),
    src as (
      select e->'properties'->>'kind' as kind, e->'properties'->>'reason' as reason, e->'properties'->>'source' as source,
             e->'geometry' as geojson, ST_SetSRID(ST_GeomFromGeoJSON(e->>'geometry'), 4326) as g
      from jsonb_array_elements(${JSON.stringify(features)}::jsonb) e
    ),
    near as (select src.* from src, c where src.g && c.g and ST_Intersects(src.g, c.g)),
    land_u as (select ST_Union(ST_MakeValid(g)) as g from near where kind = 'land'),
    land as (
      select ST_CollectionExtract(${onGrid(sql`ST_CollectionExtract(ST_Intersection(${simplified(sql`land_u.g`, srid, toleranceM)}, c.g), 3)`)}, 3) as g
      from land_u, c where land_u.g is not null
    ),
    coast_u as (select ST_LineMerge(ST_Union(g)) as g from near where kind = 'coastline'),
    coastline as (
      select ST_CollectionExtract(ST_SnapToGrid(ST_CollectionExtract(ST_Intersection(coast_u.g, c.g), 2), 1e-5::float8), 2) as g
      from coast_u, c where coast_u.g is not null
    ),
    restricted as (
      select distinct on (near.geojson, near.reason, near.source) near.reason, near.source,
             case when ST_CoveredBy(near.g, c.g) then near.g else ST_CollectionExtract(ST_Intersection(ST_MakeValid(near.g), c.g), 3) end as g
      from near, c where near.kind = 'restrictedArea'
      order by near.geojson, near.reason, near.source
    ),
    parts as (
      select 'land' as kind, null::text as reason, null::text as source, d.geom as g from land cross join lateral ST_Dump(land.g) d
      union all
      select 'coastline', null, null, d.geom from coastline cross join lateral ST_Dump(coastline.g) d
      union all
      select 'restrictedArea', r.reason, r.source, d.geom
      from restricted r cross join lateral ST_Dump(ST_CollectionExtract(${onGrid(sql`r.g`)}, 3)) d
      where not ST_IsEmpty(r.g)
    )
    select kind, reason, source, ST_AsGeoJSON(ST_ForcePolygonCCW(g), 5)::json as geometry
    from parts
    where not ST_IsEmpty(g) and (GeometryType(g) <> 'LINESTRING' or ST_NPoints(g) >= 2)
  `);

  // land and coastline carry the newest import date and its source among the packages' land and coastline
  const osm = features
    .filter((f) => f.properties.kind !== "restrictedArea")
    .map((f) => f.properties as Extract<CoastFeature["properties"], { kind: "land" | "coastline" }>)
    .sort((a, b) => (a.extractedAt < b.extractedAt ? 1 : a.extractedAt > b.extractedAt ? -1 : 0))[0];
  const out: CoastFeature[] = rows.map((r) => {
    if (r.kind === "restrictedArea") {
      return { type: "Feature", geometry: r.geometry, properties: { kind: "restrictedArea", reason: r.reason, source: r.source } } as CoastFeature;
    }
    return { type: "Feature", geometry: r.geometry, properties: { kind: r.kind, source: osm!.source, extractedAt: osm!.extractedAt } } as CoastFeature;
  });
  return { type: "FeatureCollection", features: sortFeatures(out) };
}

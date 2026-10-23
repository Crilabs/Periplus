import { sql, type SQL } from "drizzle-orm";
import type { CoastCollection, CoastFeature } from "@/contract";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { restrictedAreas, type RestrictedKind } from "@/lib/db/schema/geo";
import { utmSridFor } from "@/lib/domain/geometry/projection";
import { validAt } from "@/lib/domain/timeline";
import { RESTRICTED_REASON } from "./vocab";

/*
 * `coast.geojson` (spec 08, Teil B "Küste"): land polygons and coastline of the area box plus `coast.marginNm`, from
 * `land_polygons` (OSM, ODbL) simplified with `coast.simplifyToleranceM` in the UTM zone of the box centre, and the
 * restricted areas valid on `asOf` the routing must avoid (their polygonal parts, simplified alike). Coordinates with
 * five decimals, polygons valid on that grid with counter-clockwise outer rings (RFC 7946); features sorted by kind
 * (land, coastline, restricted area), then west to east and south to north, so equal inputs give equal files.
 */

const METRES_PER_NM = 1852;
/** The coastline leaves out what lies within this distance of the box edge: the cut edges of the land (metres). */
const EDGE_INSET_M = 1;
/** Densify the box edge before projecting it, so it stays the box edge in UTM (degrees). */
const EDGE_SEGMENT_DEG = 0.001;
/** Grid of the delivered coordinates (five decimals). */
const GRID_DEG = 1e-5;
/** The smallest pre-clip pad (degrees). */
const MIN_PRE_CLIP_PAD_DEG = 0.01;

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Length of one degree of latitude at `lat` on the WGS84 ellipsoid (metres). */
const metresPerDegreeLat = (lat: number) => 111_132.92 - 559.82 * Math.cos(2 * rad(lat)) + 1.175 * Math.cos(4 * rad(lat));
/** Length of one degree of longitude at `lat` on the WGS84 ellipsoid (metres). */
const metresPerDegreeLon = (lat: number) => 111_412.84 * Math.cos(rad(lat)) - 93.5 * Math.cos(3 * rad(lat));

const floor5 = (n: number) => Math.floor(Number((n * 1e5).toFixed(6))) / 1e5;
const ceil5 = (n: number) => Math.ceil(Number((n * 1e5).toFixed(6))) / 1e5;

/**
 * `bbox` widened by `marginNm` (1852 m each) on every side, at least that far at the poleward edge, rounded outwards
 * to five decimals (`[west, south, east, north]`).
 */
export function coastBox([west, south, east, north]: [number, number, number, number], marginNm: number): [number, number, number, number] {
  const m = marginNm * METRES_PER_NM;
  const dSouth = m / metresPerDegreeLat(south);
  const dNorth = m / metresPerDegreeLat(north);
  const maxLat = Math.min(89, Math.max(Math.abs(south - dSouth), Math.abs(north + dNorth)));
  const dLon = m / metresPerDegreeLon(maxLat);
  return [floor5(west - dLon), floor5(south - dSouth), ceil5(east + dLon), ceil5(north + dNorth)];
}

/**
 * Land and restricted areas are cut to the box plus this pad before simplifying, so far-away land is never simplified
 * (degrees): at least three tolerances at the poleward edge, so simplification never moves the pre-cut edges into the
 * box (review M-4).
 */
export function preClipPadDeg(toleranceM: number, maxAbsLat: number): number {
  return Math.max(MIN_PRE_CLIP_PAD_DEG, (3 * toleranceM) / metresPerDegreeLon(Math.min(89, maxAbsLat)));
}

/** Valid on the five-decimal grid: snapped, or reduced to the grid where snapping would break it (review M-3). */
export const onGrid = (g: SQL): SQL =>
  sql`(select case when ST_IsValid(s.g) then s.g else ST_ReducePrecision(${g}, ${GRID_DEG}::float8) end
       from (select ST_SnapToGrid(${g}, ${GRID_DEG}::float8) as g) s)`;
/** Simplified in the UTM zone, back in WGS84 and made valid (simplify and reprojection can break rings; review M-3). */
export const simplified = (g: SQL, srid: number, toleranceM: number): SQL =>
  sql`ST_MakeValid(ST_Transform(ST_SimplifyPreserveTopology(ST_Transform(${g}, ${srid}::int), ${toleranceM}::float8), 4326))`;

const KIND_ORDER = { land: 0, coastline: 1, restrictedArea: 2 } as const;

export async function buildCoast(
  db: Db,
  input: { bbox: [number, number, number, number]; cfg: DeliveryConfig["coast"]; asOf: string },
): Promise<CoastCollection> {
  const [w, s, e, n] = coastBox(input.bbox, input.cfg.marginNm);
  const srid = utmSridFor((w + e) / 2, (s + n) / 2);
  const tolerance = input.cfg.simplifyToleranceM;
  const pad = preClipPadDeg(tolerance, Math.max(Math.abs(s), Math.abs(n)));
  const box = sql`ST_MakeEnvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326)`;

  // Land: the union of the land polygons, simplified in UTM, then cut exactly at the box (the cut edges lie on the
  // box edge in WGS84); coastline: the land's boundary inside the box shrunk by EDGE_INSET_M, i.e. without the cut
  // edges. Simplifying before the cut keeps the cut edges on the box edge and every vertex within the tolerance.
  const { rows: landRows } = await db.execute<{ kind: "land" | "coastline"; geometry: CoastFeature["geometry"]; extracted_at: string }>(sql`
    with b as (select ${box} as g),
    src as (
      select l.geom, l.created_at from land_polygons l, b where l.geom && b.g and ST_Intersects(l.geom, b.g)
    ),
    meta as (select (max(created_at) at time zone 'UTC')::date::text as extracted_at from src),
    u as (select ST_Union(ST_Intersection(ST_MakeValid(src.geom), ST_Expand(b.g, ${pad}::float8))) as g from src, b),
    cut as (
      select ST_CollectionExtract(ST_Intersection(${simplified(sql`u.g`, srid, tolerance)}, b.g), 3) as g
      from u, b where u.g is not null
    ),
    land as (select ST_CollectionExtract(${onGrid(sql`cut.g`)}, 3) as g from cut),
    inner_box as (
      select ST_Transform(ST_Buffer(ST_Transform(ST_Segmentize(b.g, ${EDGE_SEGMENT_DEG}::float8), ${srid}::int), ${-EDGE_INSET_M}::float8), 4326) as g
      from b
    ),
    coastline as (
      select ST_LineMerge(ST_CollectionExtract(ST_Intersection(ST_Boundary(land.g), inner_box.g), 2)) as g from land, inner_box
    ),
    parts as (
      select 'land' as kind, d.geom as g from land cross join lateral ST_Dump(land.g) d
      union all
      select 'coastline', d.geom from coastline cross join lateral ST_Dump(coastline.g) d
    )
    select p.kind, ST_AsGeoJSON(ST_ForcePolygonCCW(p.g), 5)::json as geometry, meta.extracted_at
    from parts p, meta
    where not ST_IsEmpty(p.g)
  `);

  // Restricted areas: the polygonal parts (review M-5) of the valid areas, cut to the padded box, simplified like the
  // land (review M-9); an area inside the box as it is, one crossing the edge cut at the box. Ordered by id, so
  // areas with equal geometry, reason and source keep one order (review M-1).
  const { rows: restrictedRows } = await db.execute<{ kind: RestrictedKind; source: string; geometry: CoastFeature["geometry"] }>(sql`
    with b as (select ${box} as g),
    src as (
      select restricted_areas.id, restricted_areas.kind,
             coalesce(restricted_areas.source_ref, ${input.cfg.restrictedSourceDefault}) as source,
             ST_CollectionExtract(ST_MakeValid(restricted_areas.geom), 3) as g
      from restricted_areas, b
      where restricted_areas.geom && b.g and ST_Intersects(restricted_areas.geom, b.g) and ${validAt(restrictedAreas, input.asOf)}
    ),
    padded as (
      select src.id, src.kind, src.source,
             case when ST_CoveredBy(src.g, p.g) then src.g else ST_CollectionExtract(ST_Intersection(src.g, p.g), 3) end as g
      from src, (select ST_Expand(b.g, ${pad}::float8) as g from b) p
    ),
    simple as (
      select padded.id, padded.kind, padded.source, ST_CollectionExtract(${simplified(sql`padded.g`, srid, tolerance)}, 3) as g
      from padded where not ST_IsEmpty(padded.g)
    ),
    cut as (
      select simple.id, simple.kind, simple.source,
             case when ST_CoveredBy(simple.g, b.g) then simple.g else ST_CollectionExtract(ST_Intersection(simple.g, b.g), 3) end as g
      from simple, b where not ST_IsEmpty(simple.g)
    ),
    gridded as (select cut.id, cut.kind, cut.source, ST_CollectionExtract(${onGrid(sql`cut.g`)}, 3) as g from cut where not ST_IsEmpty(cut.g))
    select kind, source, ST_AsGeoJSON(ST_ForcePolygonCCW(g), 5)::json as geometry
    from gridded where not ST_IsEmpty(g)
    order by id
  `);

  const features: CoastFeature[] = [
    ...landRows.map((r) => ({
      type: "Feature" as const,
      geometry: r.geometry,
      properties: { kind: r.kind, source: input.cfg.source, extractedAt: r.extracted_at },
    })),
    ...restrictedRows.map((r) => ({
      type: "Feature" as const,
      geometry: r.geometry,
      properties: { kind: "restrictedArea" as const, reason: RESTRICTED_REASON[r.kind], source: r.source },
    })),
  ];
  return { type: "FeatureCollection", features: sortFeatures(features) };
}

/**
 * West-to-east, then south-to-north extent of the rounded geometry; the serialized geometry, then a restricted area's
 * reason and source break ties (review M-1); the sort is stable, so the query's id order decides the rest.
 */
export function sortFeatures(features: CoastFeature[]): CoastFeature[] {
  const keyed = features.map((f) => {
    let xMin = Number.POSITIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    for (const [x, y] of flatPositions(f.geometry.coordinates)) {
      if (x! < xMin) xMin = x!;
      if (y! < yMin) yMin = y!;
    }
    const props = f.properties;
    const tie = props.kind === "restrictedArea" ? `${props.reason}\u0000${props.source}` : "";
    return { f, kind: KIND_ORDER[props.kind], xMin, yMin, text: JSON.stringify(f.geometry), tie };
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  keyed.sort((a, b) => a.kind - b.kind || a.xMin - b.xMin || a.yMin - b.yMin || cmp(a.text, b.text) || cmp(a.tie, b.tie));
  return keyed.map((k) => k.f);
}

/** Every `[lon, lat]` position of a GeoJSON coordinate array, at any depth. */
function flatPositions(coordinates: unknown): number[][] {
  if (!Array.isArray(coordinates)) return [];
  if (typeof coordinates[0] === "number") return [coordinates as number[]];
  return coordinates.flatMap(flatPositions);
}

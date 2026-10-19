import { sql } from "drizzle-orm";
import type { CoastCollection, CoastFeature } from "@/contract";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import type { RestrictedKind } from "@/lib/db/schema/geo";
import { utmSridFor } from "@/lib/domain/geometry/projection";
import { RESTRICTED_REASON } from "./vocab";

/*
 * `coast.geojson` (spec 08, Teil B "Küste"): land polygons and coastline of the area box plus `coast.marginNm`, from
 * `land_polygons` (OSM, ODbL) simplified with `coast.simplifyToleranceM` in the UTM zone of the box centre, and the
 * restricted areas valid on `asOf` the routing must avoid. Coordinates with five decimals; features sorted by kind
 * (land, coastline, restricted area), then west to east and south to north, so equal inputs give equal files.
 */

const NM_PER_DEGREE_LAT = 60;
/** The coastline leaves out what lies within this distance of the box edge: the cut edges of the land (metres). */
const EDGE_INSET_M = 1;
/** Densify the box edge before projecting it, so it stays the box edge in UTM (degrees). */
const EDGE_SEGMENT_DEG = 0.001;
/** Land outside this pad around the box is never simplified (degrees; far larger than the tolerance). */
const PRE_CLIP_PAD_DEG = 0.01;

const floor5 = (n: number) => Math.floor(Number((n * 1e5).toFixed(6))) / 1e5;
const ceil5 = (n: number) => Math.ceil(Number((n * 1e5).toFixed(6))) / 1e5;

/**
 * `bbox` widened by `marginNm` on every side, at least that far at the poleward edge, rounded outwards to five
 * decimals (`[west, south, east, north]`).
 */
export function coastBox([west, south, east, north]: [number, number, number, number], marginNm: number): [number, number, number, number] {
  const dLat = marginNm / NM_PER_DEGREE_LAT;
  const maxLat = Math.min(89, Math.max(Math.abs(south), Math.abs(north)) + dLat);
  const dLon = marginNm / (NM_PER_DEGREE_LAT * Math.cos((maxLat * Math.PI) / 180));
  return [floor5(west - dLon), floor5(south - dLat), ceil5(east + dLon), ceil5(north + dLat)];
}

const KIND_ORDER = { land: 0, coastline: 1, restrictedArea: 2 } as const;

export async function buildCoast(
  db: Db,
  input: { bbox: [number, number, number, number]; cfg: DeliveryConfig["coast"]; asOf: string },
): Promise<CoastCollection> {
  const [w, s, e, n] = coastBox(input.bbox, input.cfg.marginNm);
  const srid = utmSridFor((w + e) / 2, (s + n) / 2);
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
    land as (
      select ST_CollectionExtract(ST_Intersection(
               ST_Transform(ST_SimplifyPreserveTopology(ST_Transform(u.g, ${srid}::int), ${input.cfg.simplifyToleranceM}::float8), 4326),
               b.g), 3) as g
      from (select ST_Union(ST_Intersection(src.geom, ST_Expand(b.g, ${PRE_CLIP_PAD_DEG}::float8))) as g from src, b) u, b
      where u.g is not null
    ),
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
    select p.kind, ST_AsGeoJSON(p.g, 5)::json as geometry, meta.extracted_at
    from parts p, meta
    where not ST_IsEmpty(p.g)
  `);

  const { rows: restrictedRows } = await db.execute<{ kind: RestrictedKind; source: string; geometry: CoastFeature["geometry"] }>(sql`
    with b as (select ${box} as g),
    cut as (
      select r.kind, coalesce(r.source_ref, ${input.cfg.restrictedSourceDefault}) as source,
             -- an area inside the box as it is; one crossing the edge cut at the box (polygons and lines only)
             case
               when ST_Dimension(r.geom) = 0 then null
               when ST_CoveredBy(r.geom, b.g) then r.geom
               when ST_Dimension(r.geom) = 2 then ST_CollectionExtract(ST_Intersection(r.geom, b.g), 3)
               else ST_CollectionExtract(ST_Intersection(r.geom, b.g), 2)
             end as g
      from restricted_areas r, b
      where r.geom && b.g and ST_Intersects(r.geom, b.g)
        and r.valid_from <= ${input.asOf}::date and (r.valid_to is null or r.valid_to > ${input.asOf}::date)
    )
    select kind, source, ST_AsGeoJSON(g, 5)::json as geometry from cut where g is not null and not ST_IsEmpty(g)
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

/** West-to-east, then south-to-north extent of the rounded geometry; the serialized geometry breaks ties. */
function sortFeatures(features: CoastFeature[]): CoastFeature[] {
  const keyed = features.map((f) => {
    let xMin = Number.POSITIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    for (const [x, y] of flatPositions(f.geometry.coordinates)) {
      if (x! < xMin) xMin = x!;
      if (y! < yMin) yMin = y!;
    }
    return { f, kind: KIND_ORDER[f.properties.kind], xMin, yMin, text: JSON.stringify(f.geometry) };
  });
  keyed.sort((a, b) => a.kind - b.kind || a.xMin - b.xMin || a.yMin - b.yMin || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return keyed.map((k) => k.f);
}

/** Every `[lon, lat]` position of a GeoJSON coordinate array, at any depth. */
function flatPositions(coordinates: unknown): number[][] {
  if (!Array.isArray(coordinates)) return [];
  if (typeof coordinates[0] === "number") return [coordinates as number[]];
  return coordinates.flatMap(flatPositions);
}

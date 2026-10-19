import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import type { LonLat } from "@/lib/domain/geometry/water";

/**
 * Synthetic coasts for geometry tests: metres relative to E 500000 / N 3900000 in EPSG:32634
 * (≈ 21.0° E / 35.23° N, outside the pilot box). Write them only inside `withRollback`.
 */
export const SYNTHETIC_SRID = 32634;
const BASE_E = 500000;
const BASE_N = 3900000;

const coord = (x: number, y: number) => `${BASE_E + x} ${BASE_N + y}`;

/** WKT point at (x, y) metres from the reference point (EPSG:32634). */
export function utm(x: number, y: number): string {
  return `POINT(${coord(x, y)})`;
}

/** WKT rectangle x0…x1 × y0…y1 metres from the reference point (EPSG:32634). */
export function rect(x0: number, y0: number, x1: number, y1: number): string {
  return `POLYGON((${[coord(x0, y0), coord(x1, y0), coord(x1, y1), coord(x0, y1), coord(x0, y0)].join(", ")}))`;
}

const utmGeom = (wkt: string) => sql`ST_GeomFromText(${wkt}, ${SYNTHETIC_SRID}::int)`;

/** WKT circle of radius `r` metres around (x, y), `ST_Buffer(…, r, 'quad_segs=64')` (EPSG:32634). */
export async function circle(tx: Db, x: number, y: number, r: number): Promise<string> {
  const { rows } = await tx.execute<{ wkt: string }>(
    sql`select ST_AsText(ST_Buffer(${utmGeom(utm(x, y))}, ${r}::float8, 'quad_segs=64')) as wkt`,
  );
  return rows[0]!.wkt;
}

/** WKT of `a` minus `b` (both EPSG:32634 WKT). */
export async function difference(tx: Db, a: string, b: string): Promise<string> {
  const { rows } = await tx.execute<{ wkt: string }>(sql`select ST_AsText(ST_Difference(${utmGeom(a)}, ${utmGeom(b)})) as wkt`);
  return rows[0]!.wkt;
}

/** Inserts each EPSG:32634 WKT polygon into `land_polygons`, transformed to WGS84. */
export async function insertLand(tx: Db, wktUtm: string[], version = "synthetic-1"): Promise<void> {
  for (const wkt of wktUtm) {
    await tx.execute(
      sql`insert into land_polygons (id, geom, dataset_version)
          values (gen_random_uuid(), ST_Transform(${utmGeom(wkt)}, 4326), ${version})`,
    );
  }
}

/** WGS84 position of (x, y) metres from the reference point. */
export async function lonLatOf(tx: Db, x: number, y: number): Promise<LonLat> {
  const { rows } = await tx.execute<{ lon: number; lat: number }>(
    sql`select ST_X(p) as lon, ST_Y(p) as lat from (select ST_Transform(${utmGeom(utm(x, y))}, 4326) as p) t`,
  );
  return { lon: Number(rows[0]!.lon), lat: Number(rows[0]!.lat) };
}

/** Position (x, y) in metres from the reference point of a WGS84 position. */
export async function utmOf(tx: Db, p: LonLat): Promise<{ x: number; y: number }> {
  const { rows } = await tx.execute<{ x: number; y: number }>(sql`
    select ST_X(q) - ${BASE_E}::float8 as x, ST_Y(q) - ${BASE_N}::float8 as y
    from (select ST_Transform(ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326), ${SYNTHETIC_SRID}::int) as q) t`);
  return { x: Number(rows[0]!.x), y: Number(rows[0]!.y) };
}

/** Distance in metres (EPSG:32634) from a WGS84 position to the nearest land polygon, null without land. */
export async function distanceToLand(tx: Db, p: LonLat): Promise<number | null> {
  const { rows } = await tx.execute<{ d: number | null }>(sql`
    select min(ST_Distance(ST_Transform(l.geom, ${SYNTHETIC_SRID}::int),
      ST_Transform(ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326), ${SYNTHETIC_SRID}::int))) as d
    from land_polygons l
    where l.geom && ST_Expand(ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326), 1)`);
  return rows[0]!.d === null ? null : Number(rows[0]!.d);
}

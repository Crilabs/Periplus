import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { WeatherPoint } from "@/contract";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { utmSridFor } from "@/lib/domain/geometry/projection";
import { round5 } from "./geo";
import type { LonLat, PassageSource, RegionSource } from "./types";

/*
 * `weather-points.json` (spec 08, Teil B): points on open water the app may query for weather. Region (with a
 * polygon): the centre of the largest circle in the water of the polygon, land subtracted, in the UTM zone; an island
 * (no water in its polygon) in its polygon buffered by `weather.regionBufferNm`; strait or channel: the point of its geometry nearest its centroid; cape: `capeOffsetNm`
 * seaward of the cape, on the bearing from the centroid of the land within `capeLandRadiusM` to the cape. A point
 * without water is left out, as is an object without a name; both are reported in `dropped`.
 */

const METRES_PER_NM = 1852;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Region types whose polygon gets a region point (a channel's comes from its passage). */
const REGION_POINT_TYPES = new Set(["island", "archipelago", "coast_section", "gulf"]);

type Kind = WeatherPoint["kind"];

export type DroppedWeatherPoint = { geoObjectId: string; kind: Kind; reason: "no_name" | "no_water" };

/** `wp_` + the first 26 Crockford base-32 characters of sha256(`<geoObjectId>:<kind>`): stable across builds. */
export function weatherPointId(geoObjectId: string, kind: Kind): string {
  const digest = createHash("sha256").update(`${geoObjectId}:${kind}`).digest();
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += CROCKFORD[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 26) break;
  }
  return `wp_${out}`;
}

const pointSql = (p: LonLat): SQL => sql`ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326)`;
/** Whether any land polygon covers the point (WGS84). */
const onLand = (point: SQL): SQL =>
  sql`exists (select 1 from land_polygons l where l.geom && ${point} and ST_Intersects(l.geom, ${point}))`;

type Row = { lon: number | null; lat: number | null };
const toPoint = (r: Row | undefined): LonLat | null =>
  r && r.lon !== null && r.lat !== null ? { lon: round5(Number(r.lon)), lat: round5(Number(r.lat)) } : null;

/**
 * The centre of the largest circle in the water of the region (spec 08 "im Regionspolygon", ruling M6-C-R2): the
 * polygon minus land when at least `minWaterShare` of it is water (gulf, archipelago, coast section), else (an island,
 * whose polygon is land) the polygon buffered by `bufferNm` minus land; null when no water is left. Land is cut to
 * the buffer before the union, so a mainland next to the region stays small.
 */
async function regionPoint(
  db: Db,
  polygon: NonNullable<RegionSource["polygon"]>,
  center: LonLat,
  cfg: Pick<DeliveryConfig["weather"], "regionBufferNm" | "regionMinWaterShare">,
): Promise<LonLat | null> {
  const srid = utmSridFor(center.lon, center.lat);
  const { rows } = await db.execute<Row>(sql`
    with r as (select ST_Transform(${geomFromGeoJson(polygon)}, ${srid}::int) as g),
    buf as (select b.g, ST_Transform(b.g, 4326) as g4326 from (select ST_Buffer(r.g, ${cfg.regionBufferNm * METRES_PER_NM}::float8) as g from r) b),
    land as (
      -- cut in UTM, where the buffer's edges are straight: a cut in WGS84 would leave slivers of false water; only the
      -- polygonal part of each cut (a row touching the buffer edge yields a line), so the union is never mixed
      select ST_Union(ST_CollectionExtract(ST_Intersection(ST_Transform(l.geom, ${srid}::int), buf.g), 3)) as g
      from land_polygons l, buf
      where l.geom && buf.g4326 and ST_Intersects(l.geom, buf.g4326)
    ),
    inside as (select ST_CollectionExtract(coalesce(ST_Difference(r.g, land.g), r.g), 3) as g, ST_Area(r.g) as area from r, land),
    water as (
      select case when ST_Area(inside.g) >= ${cfg.regionMinWaterShare}::float8 * inside.area and not ST_IsEmpty(inside.g) then inside.g
                  else ST_CollectionExtract(coalesce(ST_Difference(buf.g, land.g), buf.g), 3) end as g
      from inside, buf, land
    ),
    c as (select ST_Transform((ST_MaximumInscribedCircle(water.g)).center, 4326) as p from water where not ST_IsEmpty(water.g))
    select ST_X(p) as lon, ST_Y(p) as lat from c
  `);
  return toPoint(rows[0]);
}

/** The point of the strait's or channel's geometry nearest its centroid, if on water. */
async function channelPoint(db: Db, geoObjectId: string): Promise<LonLat | null> {
  const { rows } = await db.execute<Row>(sql`
    with c as (select ST_ClosestPoint(o.geom, ST_Centroid(o.geom)) as p from geo_objects o where o.id = ${geoObjectId})
    select ST_X(p) as lon, ST_Y(p) as lat from c where not ${onLand(sql`c.p`)}
  `);
  return toPoint(rows[0]);
}

/**
 * `offsetNm` seaward of the cape: on the bearing from the centroid of the land within `landRadiusM` to the cape; no
 * land around (no bearing) or a point on land → null.
 */
async function capePoint(db: Db, cape: LonLat, landRadiusM: number, offsetNm: number): Promise<LonLat | null> {
  const { rows } = await db.execute<Row>(sql`
    with k as (select ${pointSql(cape)} as p, ST_Buffer(${pointSql(cape)}::geography, ${landRadiusM}::float8)::geometry as circle),
    land as (
      select ST_Centroid(ST_Union(ST_Intersection(l.geom, k.circle))) as c
      from land_polygons l, k
      where l.geom && k.circle and ST_Intersects(l.geom, k.circle)
    ),
    bearing as (select ST_Azimuth(land.c::geography, k.p::geography) as az from land, k where land.c is not null),
    w as (select ST_Project(k.p::geography, ${offsetNm * METRES_PER_NM}::float8, bearing.az)::geometry as p from k, bearing where bearing.az is not null)
    select ST_X(p) as lon, ST_Y(p) as lat from w where not ${onLand(sql`w.p`)}
  `);
  return toPoint(rows[0]);
}

export async function buildWeatherPoints(
  db: Db,
  input: {
    regions: RegionSource[];
    passages: PassageSource[];
    regionIdFor: (p: LonLat) => string | null;
    cfg: DeliveryConfig["weather"];
  },
): Promise<{ points: WeatherPoint[]; dropped: DroppedWeatherPoint[] }> {
  const points: WeatherPoint[] = [];
  const dropped: DroppedWeatherPoint[] = [];
  const add = (geoObjectId: string, kind: Kind, name: string, position: LonLat | null, regionId: (p: LonLat) => string | null) => {
    if (position === null) dropped.push({ geoObjectId, kind, reason: "no_water" });
    else points.push({ id: weatherPointId(geoObjectId, kind), name, position, kind, regionId: regionId(position) });
  };

  // Sequential: the build runs in one transaction, whose connection takes one query at a time.
  for (const r of input.regions) {
    if (!r.polygon || !REGION_POINT_TYPES.has(r.type)) continue;
    if (r.name.trim() === "") {
      dropped.push({ geoObjectId: r.geoObjectId, kind: "region", reason: "no_name" });
      continue;
    }
    // the point stands for its region, also when it lies in an island's buffer
    add(r.geoObjectId, "region", r.name, await regionPoint(db, r.polygon, r.center, input.cfg), () => r.publicId);
  }
  for (const p of input.passages) {
    const kind: Kind = p.type === "cape" ? "cape" : "channel";
    if (p.name.trim() === "") {
      dropped.push({ geoObjectId: p.geoObjectId, kind, reason: "no_name" });
      continue;
    }
    const position =
      kind === "cape"
        ? await capePoint(db, p.point, input.cfg.capeLandRadiusM, input.cfg.capeOffsetNm)
        : await channelPoint(db, p.geoObjectId);
    add(p.geoObjectId, kind, p.name, position, input.regionIdFor);
  }
  points.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { points, dropped };
}

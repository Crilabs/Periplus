import { sql } from "drizzle-orm";
import type { ImagesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { PlaceKind } from "@/lib/db/schema";
import { latestComputations } from "@/lib/domain/facts/computations";

/** What the title image of a place is planned from (spec 13). */
export type PlaceImageInput = {
  geoObjectId: string;
  publicId: string | null;
  kind: PlaceKind;
  /** Centre of the place (`anchor_position`, else `position`): the camera target of the open-water view. */
  lon: number;
  lat: number;
  /** ISO 3166-1 alpha-2 of the subdivision, `null` while the object has none. */
  country: string | null;
  subdivisionKey: string | null;
  /** `opening_bearing.bearingDeg` of the newest shelter computation. */
  openingBearing: number | null;
  /** `outputs.rays` of the newest fetch computation (fetch in metres per ray, ray i at bearing `i · 360 / length`). */
  rays: number[] | null;
  /** Nearest town within `light.townRadiusM`; only for anchorages and mooring fields. */
  town: { geoObjectId: string; lon: number; lat: number } | null;
};

type PlaceRow = {
  public_id: string | null;
  kind: PlaceKind;
  lon: number;
  lat: number;
  country: string | null;
  subdivision_key: string | null;
};

type TownRow = { id: string; lon: number; lat: number };

/**
 * The input of the current place of `geoObjectId`, or `null` without one. The town is the nearest current settlement
 * whose OSM `place` tag is in `light.townPlaces`, within `light.townRadiusM` of the centre (geodesic, on the
 * settlement's point on surface); it is looked up only for anchorages and mooring fields.
 */
export async function loadPlaceImageInput(
  db: Db,
  geoObjectId: string,
  cfg: Pick<ImagesConfig, "light">,
): Promise<PlaceImageInput | null> {
  const { rows } = await db.execute<PlaceRow>(sql`
    select p.public_id, p.kind,
           ST_X(coalesce(p.anchor_position, p.position)) as lon, ST_Y(coalesce(p.anchor_position, p.position)) as lat,
           s.country, s.key as subdivision_key
    from places p
    join geo_objects o on o.id = p.geo_object_id
    left join subdivisions s on s.id = o.subdivision_id
    where p.geo_object_id = ${geoObjectId} and p.valid_to is null and p.merged_into_id is null
    order by p.created_at desc
    limit 1`);
  const place = rows[0];
  if (!place) return null;
  const lon = Number(place.lon);
  const lat = Number(place.lat);

  let town: PlaceImageInput["town"] = null;
  if (place.kind === "anchorage" || place.kind === "mooring_field") {
    const centre = sql`ST_SetSRID(ST_MakePoint(${lon}::float8, ${lat}::float8), 4326)::geography`;
    // bounding box for the centroid GIST index; 110 km per degree is less than any real degree, so it never cuts off
    const dLat = cfg.light.townRadiusM / 110_000;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    const placeTags = `{${cfg.light.townPlaces.map((p) => `"${p.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
    const { rows: towns } = await db.execute<TownRow>(sql`
      select o.id, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
      from geo_objects o
      where o.type = 'settlement' and o.valid_to is null and o.merged_into_id is null and o.id <> ${geoObjectId}
        and o.tags->>'place' = any(${placeTags}::text[])
        and o.centroid && ST_MakeEnvelope(${lon - dLon}::float8, ${lat - dLat}::float8, ${lon + dLon}::float8, ${lat + dLat}::float8, 4326)
        and ST_DWithin(o.centroid::geography, ${centre}, ${cfg.light.townRadiusM}::float8)
      order by ST_Distance(o.centroid::geography, ${centre}), o.id
      limit 1`);
    const t = towns[0];
    if (t) town = { geoObjectId: t.id, lon: Number(t.lon), lat: Number(t.lat) };
  }

  const stored = await latestComputations(db, geoObjectId);
  const opening = stored.get("shelter")?.facts.find((f) => f.attribute === "opening_bearing")?.value as
    | { bearingDeg: number | null; widthDeg: number }
    | undefined;
  const rays = stored.get("fetch")?.outputs.rays;

  return {
    geoObjectId,
    publicId: place.public_id,
    kind: place.kind,
    lon,
    lat,
    country: place.country,
    subdivisionKey: place.subdivision_key,
    openingBearing: opening?.bearingDeg ?? null,
    rays: Array.isArray(rays) && rays.length > 0 ? rays.map(Number) : null,
    town,
  };
}

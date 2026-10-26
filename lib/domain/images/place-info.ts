import { sql } from "drizzle-orm";
import type { ImagesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, subdivisions, type PlaceKind } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { loadPlaceImageInput } from "./place-input";

/**
 * What the admin sees of the place an image belongs to (spec 13, UI-Anteil: the review panel and the image tab):
 * the inputs of the image type label (`imageTypeLabel`), the name, the ids, the points the camera rules start from
 * and the nearest town (`light.townPlaces`; whether it lies in the image decides the evening light, spec 19).
 */
export type ImagePlaceInfo = {
  geoObjectId: string;
  placeId: string;
  publicId: string | null;
  /** The current display name; `null` without one (the UI says „ohne Namen“). */
  name: string | null;
  kind: PlaceKind;
  subdivision: { key: string; name: string | null } | null;
  /** The centre the camera rules start from: the anchor point (`anchor: true`), else the place's position. */
  centre: { lon: number; lat: number; anchor: boolean };
  /** The named cove (the place's position) when it lies apart from the anchor point (`PlaceImageInput.cove`). */
  cove: { lon: number; lat: number } | null;
  /** The nearest town within `light.townRadiusM`, with its name and its distance from the centre in metres. */
  town: { geoObjectId: string; name: string | null; distanceM: number } | null;
};

type Row = { place_id: string; name: string | null; has_anchor: boolean; subdivision_key: string | null; subdivision_name: string | null };

/** The place info of the current place of `geoObjectId` (`loadPlaceImageInput` plus names and ids), or `null` without one. */
export async function loadImagePlaceInfo(db: Db, geoObjectId: string, cfg: Pick<ImagesConfig, "light" | "composition">): Promise<ImagePlaceInfo | null> {
  const input = await loadPlaceImageInput(db, geoObjectId, cfg);
  if (!input) return null;
  const { rows } = await db.execute<Row>(sql`
    select ${places.id} as place_id, ${displayNameSql(places.geoObjectId)} as name, ${places.anchorPosition} is not null as has_anchor,
           ${subdivisions.key} as subdivision_key, ${displayNameSql(subdivisions.geoObjectId)} as subdivision_name
    from ${places}
    join ${geoObjects} on ${geoObjects.id} = ${places.geoObjectId}
    left join ${subdivisions} on ${subdivisions.id} = ${geoObjects.subdivisionId}
    where ${places.geoObjectId} = ${geoObjectId} and ${places.validTo} is null and ${places.mergedIntoId} is null
    order by ${places.createdAt} desc
    limit 1`);
  const row = rows[0];
  if (!row) return null;

  let town: ImagePlaceInfo["town"] = null;
  if (input.town) {
    const { rows: t } = await db.execute<{ name: string | null; distance_m: number | string }>(sql`
      select ${displayNameSql(sql`${input.town.geoObjectId}::uuid`)} as name,
             ST_Distance(ST_SetSRID(ST_MakePoint(${input.lon}::float8, ${input.lat}::float8), 4326)::geography,
                         ST_SetSRID(ST_MakePoint(${input.town.lon}::float8, ${input.town.lat}::float8), 4326)::geography) as distance_m`);
    town = { geoObjectId: input.town.geoObjectId, name: t[0]?.name ?? null, distanceM: Number(t[0]!.distance_m) };
  }
  return {
    geoObjectId,
    placeId: row.place_id,
    publicId: input.publicId,
    name: row.name,
    kind: input.kind,
    subdivision: row.subdivision_key === null ? null : { key: row.subdivision_key, name: row.subdivision_name },
    centre: { lon: input.lon, lat: input.lat, anchor: row.has_anchor },
    cove: input.cove === null ? null : { lon: input.cove[0], lat: input.cove[1] },
    town,
  };
}

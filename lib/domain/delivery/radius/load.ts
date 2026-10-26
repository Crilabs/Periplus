import { sql } from "drizzle-orm";
import type { CoastCollection, CoverageEntry, RegionsFile, Spot, SpotsFile, WeatherPointsFile } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { deliveryNames } from "@/lib/domain/gazetteer/names";
import { validAtAlias } from "@/lib/db/valid-at";
import { isImageFile, readJsonFile, readManifest, validDelivery } from "../read";
import type { SourcePackage } from "./types";

/*
 * What a radius package is built from (spec 18, "Woraus es gebaut wird", "Lücken"): the home marina as its
 * subdivision's current valid package delivers it, the active subdivisions the circle touches with their current valid
 * data version (or missing), and the stored files of those packages.
 */

/**
 * The home marina `publicId` as the current valid package of its subdivision delivers it, with that subdivision's id.
 * The subdivision is the one of the spot's latest not removed contract version (`delivered_objects`), valid today and
 * active. Null when that package does not hold the spot, or holds it with another kind than `marina`, excluded or
 * merged into another spot.
 */
export async function resolveHomeMarina(db: Db, archive: Archive, publicId: string): Promise<{ spot: Spot; subdivisionId: string } | null> {
  const { rows } = await db.execute<{ subdivision_id: string }>(sql`
    select o.subdivision_id
    from delivered_objects o
    join subdivisions s on s.id = o.subdivision_id
    where o.public_id = ${publicId} and o.object_type = 'spot' and not o.removed
      and s.status = 'active' and ${validAtAlias("s")}
    order by o.profile_version desc
    limit 1
  `);
  const subdivisionId = rows[0]?.subdivision_id;
  if (!subdivisionId) return null;
  const delivery = await validDelivery(db, subdivisionId);
  if (!delivery) return null;
  const spot = (await readJsonFile<SpotsFile>(archive, delivery, "spots.json")).spots.find((s) => s.id === publicId);
  if (!spot || !isHomeMarina(spot)) return null;
  return { spot, subdivisionId };
}

/** A home marina (spec 18): a delivered spot of kind `marina` that is not excluded and not merged into another spot. */
export function isHomeMarina(spot: Spot): boolean {
  return spot.kind === "marina" && !spot.exclude?.excluded && !spot.mergedInto;
}

export type RadiusCoverage = {
  delivered: Array<{ subdivisionId: string; entry: CoverageEntry & { status: "delivered" } }>;
  missing: Array<CoverageEntry & { status: "missing" }>;
  /** Valid coast tiles labelled with a missing subdivision that intersect the circle, sorted. */
  missingTiles: string[];
};

/**
 * The subdivisions valid today whose polygon intersects `touching`, sorted by key: an active one is delivered with the
 * data version of its current valid package or missing without one; a subdivision that is not active (excluded) is
 * missing even with an old valid package (spec 18, "Lücken"). And the valid coast tiles of the missing ones that
 * intersect `circle`.
 *
 * `touching` is the circle widened by `gazetteer.subdivisionRadiusM`: a spot belongs to the subdivision whose land is
 * nearest within that distance (`setSubdivisions`), so a spot inside the circle can belong to a subdivision whose
 * polygon lies just outside it.
 */
export async function radiusCoverage(db: Db, circle: GeoJSON.Polygon, touching: GeoJSON.Polygon): Promise<RadiusCoverage> {
  const geom = sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(circle)}), 4326)`;
  const wide = sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(touching)}), 4326)`;
  const { rows } = await db.execute<{ id: string; public_id: string; key: string; geo_object_id: string; data_version: number | null }>(sql`
    select s.id, s.public_id, s.key, s.geo_object_id, case when s.status = 'active' then d.data_version end as data_version
    from subdivisions s
    left join lateral (
      select d.data_version from deliveries d
      where d.subdivision_id = s.id and d.status = 'valid'
      order by d.data_version desc
      limit 1
    ) d on true
    where ${validAtAlias("s")} and s.geom && ${wide} and ST_Intersects(s.geom, ${wide})
    order by s.key, s.id
  `);
  const names = await deliveryNames(db, rows.map((r) => r.geo_object_id));
  const delivered: RadiusCoverage["delivered"] = [];
  const missing: RadiusCoverage["missing"] = [];
  for (const r of rows) {
    const base = { id: r.public_id, key: r.key, name: names.get(r.geo_object_id) ?? r.key };
    if (r.data_version === null) missing.push({ ...base, status: "missing", dataVersion: null });
    else delivered.push({ subdivisionId: r.id, entry: { ...base, status: "delivered", dataVersion: r.data_version } });
  }
  const missingIds = rows.filter((r) => r.data_version === null).map((r) => r.id);
  const missingTiles =
    missingIds.length === 0
      ? []
      : (
          await db.execute<{ id: string }>(sql`
            select t.id from tiles t
            where t.subdivision_id = any(${sql.param(missingIds)}::uuid[]) and t.has_coast and ${validAtAlias("t")}
              and t.bbox && ${geom} and ST_Intersects(t.bbox, ${geom})
            order by t.id
          `)
        ).rows.map((r) => r.id);
  return { delivered, missing, missingTiles };
}

/**
 * The subdivision's valid package of `entry.dataVersion` as read from the archive: its objects, tiles, areas,
 * licences and image files (by the manifest), its coast and its storage prefix (images are copied from there).
 */
export async function loadSourcePackage(
  db: Db,
  archive: Archive,
  subdivisionId: string,
  entry: CoverageEntry,
): Promise<SourcePackage & { coast: CoastCollection; prefix: string }> {
  if (entry.status !== "delivered" || entry.dataVersion === null) throw new Error(`subdivision ${entry.key} has no package to read`);
  const delivery = await validDelivery(db, subdivisionId, entry.dataVersion);
  if (!delivery) throw new Error(`subdivision ${entry.key} has no valid package ${entry.dataVersion}`);
  const manifest = await readManifest(archive, delivery);
  const [spots, regions, points, coast] = await Promise.all([
    readJsonFile<SpotsFile>(archive, delivery, "spots.json"),
    readJsonFile<RegionsFile>(archive, delivery, "regions.json"),
    readJsonFile<WeatherPointsFile>(archive, delivery, "weather-points.json"),
    readJsonFile<CoastCollection>(archive, delivery, "coast.geojson"),
  ]);
  return {
    coverage: { ...entry, status: "delivered" },
    generatedAt: manifest.generatedAt,
    spots: spots.spots,
    regions: regions.regions,
    weatherPoints: points.points,
    tiles: manifest.tiles,
    areas: manifest.areas,
    licenses: manifest.licenses,
    imageFiles: manifest.files.filter((f) => isImageFile(f.name)),
    coast,
    prefix: delivery.storagePrefix!,
  };
}

import { desc, eq, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { CoverageEntry, Manifest } from "@/contract/v3_0";
import type { Db } from "@/lib/db/client";
import { radiusPackageRequests, radiusPackages } from "@/lib/db/schema/radius";
import { getRadiusPackage, readRadiusFile, type RadiusPackageRow } from "./build";

/*
 * What the admin sees of radius packages (spec 18, Admin-UI): the preview of a package for a marina and a trip length,
 * the list of cached packages with their request counts, and the features of the map. Reads and builds through
 * `getRadiusPackage`; never writes anything of its own.
 */

export const RADIUS_PACKAGES_PAGE_SIZE = 50;

/** Map colours per feature role, light enough for the dark base map; the page's legend uses the same. */
export const ROLE_COLORS = { delivered: "#4ade80", missing: "#facc15", circle: "#60a5fa", marina: "#f87171" } as const;

export type RadiusPreview = { row: RadiusPackageRow; manifest: Manifest; totalBytes: number };

/** The package a client would get for `marina` and `days` (built if not yet cached; no API client), its manifest and its total size. */
export async function previewRadius(
  db: Db,
  archive: Archive,
  marina: string,
  days: number,
): Promise<RadiusPreview | "marina_not_found" | "invalid_days"> {
  const row = await getRadiusPackage(db, archive, { marina, days, kind: "package" });
  if (typeof row === "string") return row;
  const bytes = await readRadiusFile(archive, row, "manifest.json");
  if (bytes === null) throw new Error(`radius package ${row.key} has no manifest.json`);
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  const totalBytes = Object.values(row.fileHashes).reduce((sum, h) => sum + h.bytes, 0);
  return { row, manifest, totalBytes };
}

export type RadiusPackageListRow = {
  key: string;
  marina: string;
  days: number;
  generatedAt: string;
  requests: number;
  coverage: CoverageEntry[];
};

/** The cached radius packages, newest first, with the number of requests recorded on each (`page` from 1). */
export async function listRadiusPackages(db: Db, page: number): Promise<RadiusPackageListRow[]> {
  const requests = sql<number>`count(${radiusPackageRequests.id})::int`;
  const rows = await db
    .select({
      key: radiusPackages.key,
      marina: radiusPackages.homeMarinaPublicId,
      days: radiusPackages.days,
      generatedAt: radiusPackages.generatedAt,
      coverage: radiusPackages.coverage,
      requests,
    })
    .from(radiusPackages)
    .leftJoin(radiusPackageRequests, eq(radiusPackageRequests.radiusPackageId, radiusPackages.id))
    .groupBy(radiusPackages.id)
    .orderBy(desc(radiusPackages.generatedAt), desc(radiusPackages.id))
    .limit(RADIUS_PACKAGES_PAGE_SIZE)
    .offset((Math.max(1, page) - 1) * RADIUS_PACKAGES_PAGE_SIZE);
  return rows.map((r) => ({ ...r, generatedAt: r.generatedAt.toISOString() }));
}

/**
 * Map features of a radius manifest, with the roles `MiniMap` colours: the circle, the home marina, and every touched
 * subdivision as `delivered` or `missing` (polygons from the database).
 */
export async function radiusMapFeatures(db: Db, manifest: Manifest): Promise<GeoJSON.FeatureCollection> {
  const scope = manifest.scope;
  if (scope.type !== "radius") throw new Error("not a radius manifest");
  const features: GeoJSON.Feature[] = [];
  const polygons = new Map<string, GeoJSON.Geometry>();
  const ids = manifest.coverage.map((c) => c.id);
  const { rows } = await db.execute<{ public_id: string; geom: string }>(sql`
    select public_id, ST_AsGeoJSON(geom) as geom from subdivisions where public_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
  for (const r of rows) polygons.set(r.public_id, JSON.parse(r.geom) as GeoJSON.Geometry);
  for (const c of manifest.coverage) {
    const geometry = polygons.get(c.id);
    if (geometry) features.push({ type: "Feature", geometry, properties: { role: c.status, name: c.name, color: ROLE_COLORS[c.status] } });
  }
  features.push({ type: "Feature", geometry: scope.circle as GeoJSON.Geometry, properties: { role: "circle", color: ROLE_COLORS.circle } });
  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [scope.center.lon, scope.center.lat] },
    properties: { role: "marina", name: scope.homeMarina.name, color: ROLE_COLORS.marina },
  });
  return { type: "FeatureCollection", features };
}

import { sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_FILES, type ContractFile } from "@/contract";
import type { Db } from "@/lib/db/client";
import { deliveredObjects, deliveries, geoNames, subdivisions, tiles } from "@/lib/db/schema";
import { newPublicId } from "@/lib/domain/ids";
import { manifestSubdivision } from "@/lib/domain/delivery/read";
import { contentTypeOf, serializeFile, sha256Hex } from "@/lib/domain/delivery/serialize";
import type { DeliveryPackage } from "@/lib/domain/delivery/types";
import { insertTestSubdivision, insertTestTile } from "@/test/text";
import { AREA_ID, HIGHLIGHT, REGION, SPOT_A, SPOT_M, SUBDIVISION_ID, validPackage, WEATHER_POINT } from "./package";

/*
 * Radius package tests (spec 18): subdivision packages stored as a build would store them, without a build. A second
 * active subdivision east of the delivery fixture (21.5–22.0° E × 35.0–35.25° N, beside the fixture's 21.0–21.5° E),
 * whose package is `validPackage()` with its own ids, moved east (`eastPackage`).
 */

/** Fixed ids of the second subdivision and its package (valid Crockford base 32, `01J9ZE…`, beside the fixture's `01J9ZD…`). */
export const EAST = {
  subdivisionId: "sd_01J9ZE00000000000000000001",
  key: "XT-DELIVERY-EAST",
  name: "Testlandesteil Ost",
  tileId: "q025:807:500",
  spot: "sp_01J9ZE00000000000000000001",
  marina: "sp_01J9ZE00000000000000000002",
  highlight: "hl_01J9ZE00000000000000000001",
  region: "rg_01J9ZE00000000000000000001",
  weatherPoint: "wp_01J9ZE00000000000000000001",
  area: "ar_01J9ZE00000000000000000001",
} as const;

export type SecondSubdivision = { id: string; publicId: string; key: string; name: string; tileId: string };

/**
 * A second active subdivision east of the delivery fixture (21.5–22.0° E × 35.0–35.25° N) with a German name and one
 * coast tile labelled with it (`q025:807:500`, 21.75–22.0° E). `withRollback` only.
 */
export async function insertSecondSubdivision(tx: Db): Promise<SecondSubdivision> {
  return insertNamedSubdivision(tx, { publicId: EAST.subdivisionId, key: EAST.key, name: EAST.name, box: [21.5, 35.0, 22.0, 35.25], tileId: EAST.tileId });
}

/** An active subdivision over `box` with a fixed public id, a German name and (optionally) one coast tile labelled with it. */
export async function insertNamedSubdivision(
  tx: Db,
  o: { publicId: string; key: string; name: string; box: [number, number, number, number]; tileId?: string },
): Promise<SecondSubdivision> {
  const { id, geoObjectId } = await insertTestSubdivision(tx, o.key, o.box);
  await tx.update(subdivisions).set({ publicId: o.publicId }).where(sql`${subdivisions.id} = ${id}`);
  await tx.insert(geoNames).values({
    geoObjectId,
    name: o.name,
    nameNormalized: o.name.toLowerCase(),
    language: "de",
    script: "latin",
    origin: "manual",
  });
  if (o.tileId) {
    await insertTestTile(tx, o.tileId);
    await tx.update(tiles).set({ subdivisionId: id, hasCoast: true }).where(sql`${tiles.id} = ${o.tileId}`);
  }
  return { id, publicId: o.publicId, key: o.key, name: o.name, tileId: o.tileId ?? "" };
}

type LonLat = { lon: number; lat: number };
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Every position moved by `d` (`{lat, lon}` objects and GeoJSON `[lon, lat]` pairs). */
function shifted<T>(value: T, d: LonLat): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return [round5(v[0] + d.lon), round5(v[1] + d.lat)];
      return v.map(walk);
    }
    if (v !== null && typeof v === "object") {
      const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      if (typeof o.lon === "number" && typeof o.lat === "number") return { ...o, lon: round5(o.lon + d.lon), lat: round5(o.lat + d.lat) };
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

export type PackageIds = {
  subdivision: { publicId: string; key: string; name: string };
  spot: string;
  marina: string;
  highlight: string;
  region: string;
  weatherPoint: string;
  area: string;
  tileId: string;
};

/**
 * `validPackage()` as the first package of another subdivision: its ids replaced by `ids`, every position moved by
 * `shift` (default 0.5° east: the anchorage at 21.55° E / 35.195° N, 13.5 nm from the fixture's marina), its tile
 * `ids.tileId` (run 2040-05-01), no `changes.json`. `storeSubdivisionPackage` sets the data version.
 */
export function eastPackage(ids: PackageIds = { ...EAST, subdivision: { publicId: EAST.subdivisionId, key: EAST.key, name: EAST.name } }, shift: LonLat = { lon: 0.5, lat: 0 }): DeliveryPackage {
  const base = validPackage();
  delete base.files["changes.json"];
  const replace: Array<[string, string]> = [
    [SUBDIVISION_ID, ids.subdivision.publicId],
    ["XT-NISIDA", ids.subdivision.key],
    [SPOT_A, ids.spot],
    [SPOT_M, ids.marina],
    [HIGHLIGHT, ids.highlight],
    [REGION, ids.region],
    [WEATHER_POINT, ids.weatherPoint],
    [AREA_ID, ids.area],
  ];
  let text = JSON.stringify(base);
  for (const [from, to] of replace) text = text.split(from).join(to);
  const pkg = shifted(JSON.parse(text) as DeliveryPackage, shift);
  const s = pkg.manifest.scope;
  if (s.type !== "subdivision") throw new Error("unreachable");
  s.subdivision.name = ids.subdivision.name;
  pkg.manifest.coverage = [{ id: ids.subdivision.publicId, key: ids.subdivision.key, name: ids.subdivision.name, status: "delivered", dataVersion: 1 }];
  pkg.manifest.bbox = [round5(20.9 + shift.lon), round5(35.1 + shift.lat), round5(21.3 + shift.lon), round5(35.4 + shift.lat)];
  pkg.manifest.tiles = [{ id: ids.tileId, lastRunAt: "2040-05-01T00:00:00.000Z", profilesAsOf: "2040-05-01" }];
  // spot A's external ids belong to the fixture's A
  for (const spot of pkg.files["spots.json"].spots) if (spot.externalRefs) spot.externalRefs = { ...spot.externalRefs, osmId: null };
  return pkg;
}

/** Fresh random ids for `eastPackage` (a committed package must not reuse fixed ids). */
export function randomPackageIds(subdivision: PackageIds["subdivision"], tileId: string): PackageIds {
  return {
    subdivision,
    spot: newPublicId("sp"),
    marina: newPublicId("sp"),
    highlight: newPublicId("hl"),
    region: newPublicId("rg"),
    weatherPoint: `wp_${newPublicId("sp").slice(3)}`,
    area: newPublicId("ar"),
    tileId,
  };
}

/**
 * Stores `pkg` as the valid package `dataVersion` of the subdivision, as a build would: data version and generation
 * time set in manifest, coverage and every file envelope, the manifest's `files` from the serialized files and
 * `images`, every file under `deliveries/<key>/<dataVersion>/`, the `deliveries` row and a `delivered_objects` row per
 * spot, highlight and region version not recorded yet. No build, no validation. Returns the delivery id and prefix.
 */
export async function storeSubdivisionPackage(
  tx: Db,
  archive: Archive,
  input: { subdivisionId: string; pkg: DeliveryPackage; dataVersion: number; images?: Record<string, Uint8Array>; generatedAt?: Date },
): Promise<{ deliveryId: string; prefix: string; pkg: DeliveryPackage }> {
  const pkg = structuredClone(input.pkg);
  const generatedAt = (input.generatedAt ?? new Date("2040-06-01T06:00:00Z")).toISOString();
  const scope = pkg.manifest.scope;
  if (scope.type !== "subdivision") throw new Error("a subdivision package has a subdivision scope");
  scope.dataVersion = input.dataVersion;
  scope.previousDataVersion = input.dataVersion > 1 ? input.dataVersion - 1 : null;
  pkg.manifest.coverage = pkg.manifest.coverage.map((c) => ({ ...c, dataVersion: input.dataVersion }));
  pkg.manifest.generatedAt = generatedAt;
  for (const file of Object.values(pkg.files)) {
    if ("scope" in file) Object.assign(file, { scope: { type: "subdivision", id: scope.subdivision.id, dataVersion: input.dataVersion }, generatedAt });
  }
  const images = input.images ?? {};
  const listed = CONTRACT_FILES.filter((f): f is Exclude<ContractFile, "manifest.json"> => f !== "manifest.json" && pkg.files[f as keyof DeliveryPackage["files"]] !== undefined);
  pkg.manifest.files = [
    ...listed.map((name) => {
      const bytes = serializeFile(pkg.files[name as keyof DeliveryPackage["files"]]);
      return { name, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    }),
    ...Object.entries(images)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, bytes]) => ({ name, sha256: sha256Hex(bytes), bytes: bytes.byteLength })),
  ];
  pkg.manifest.objectCounts = {
    spots: pkg.files["spots.json"].spots.length,
    highlights: pkg.files["highlights.json"].highlights.length,
    regions: pkg.files["regions.json"].regions.length,
    weatherPoints: pkg.files["weather-points.json"].points.length,
    coastFeatures: pkg.files["coast.geojson"].features.length,
    changes: pkg.files["changes.json"]?.changes.length ?? 0,
  };

  const prefix = `deliveries/${manifestSubdivision(pkg.manifest)!.key}/${input.dataVersion}/`;
  const fileHashes: Record<string, { sha256: string; bytes: number }> = {};
  const put = async (name: string, bytes: Uint8Array) => {
    fileHashes[name] = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    await archive.put(prefix + name, bytes, contentTypeOf(name));
  };
  await put("manifest.json", serializeFile(pkg.manifest));
  for (const name of listed) await put(name, serializeFile(pkg.files[name as keyof DeliveryPackage["files"]]));
  for (const [name, bytes] of Object.entries(images)) await put(name, bytes);

  const [row] = await tx
    .insert(deliveries)
    .values({
      subdivisionId: input.subdivisionId,
      dataVersion: input.dataVersion,
      schemaVersion: pkg.manifest.schemaVersion,
      generatedAt: new Date(generatedAt),
      status: "valid",
      storagePrefix: prefix,
      fileHashes,
      objectCounts: pkg.manifest.objectCounts,
      bbox: pkg.manifest.bbox,
      validationReport: {},
      changeSnapshot: sql`pg_current_snapshot()`,
      changeXmin: sql`pg_snapshot_xmin(pg_current_snapshot())`,
    })
    .returning({ id: deliveries.id });
  const deliveryId = row!.id;
  const versions = [
    ...pkg.files["spots.json"].spots.map((o) => ({ type: "spot" as const, o })),
    ...pkg.files["highlights.json"].highlights.map((o) => ({ type: "highlight" as const, o })),
    ...pkg.files["regions.json"].regions.map((o) => ({ type: "region" as const, o })),
  ];
  for (const { type, o } of versions) {
    await tx
      .insert(deliveredObjects)
      .values({
        subdivisionId: input.subdivisionId,
        objectType: type,
        publicId: o.id,
        profileVersion: o.profileVersion,
        contentHash: `test-${o.profileVersion}`,
        validFrom: o.validFrom,
        firstDeliveryId: deliveryId,
      })
      .onConflictDoNothing();
  }
  return { deliveryId, prefix, pkg };
}

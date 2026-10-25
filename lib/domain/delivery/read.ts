import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_FILES, IMAGE_FILE_PATTERN, type ContractFile, type Manifest, type Spot, type SpotsFile } from "@/contract";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { deliveries } from "@/lib/db/schema/deliveries";
import { deliveryNames } from "@/lib/domain/gazetteer/names";
import { validAtAlias } from "@/lib/domain/timeline";
import type { DeliveryRow } from "./build";
import { sha256Hex } from "./serialize";

/*
 * What the delivery API reads (spec 08, spec 14): subdivisions, their valid packages and the stored files. Only `valid` deliveries are
 * ever served; a rejected package stays in S3 for diagnosis. S3 is read only through the delivery archive seam
 * (`deliveryArchive`, ruling M6-P18).
 */

export { deliveryArchive, setDeliveryArchive } from "./archive";

export type ResolvedSubdivision = { id: string; publicId: string; key: string; name: string };

export type SubdivisionListEntry = {
  id: string;
  key: string;
  name: string;
  country: string;
  dataVersion: number | null;
  bbox: number[] | null;
  generatedAt: string | null;
};

/** A valid subdivision (`sd_…` or key, e.g. `GR-I`), as the delivery API addresses it; null for an unknown one. */
export async function resolveSubdivision(db: Db, ref: string): Promise<ResolvedSubdivision | null> {
  const { rows } = await db.execute<{ id: string; public_id: string; key: string; geo_object_id: string }>(sql`
    select s.id, s.public_id, s.key, s.geo_object_id
    from subdivisions s
    where ${validAtAlias("s")} and (s.public_id = ${ref} or s.key = ${ref})
    order by (s.public_id = ${ref}) desc, s.id
    limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  const name = (await deliveryNames(db, [row.geo_object_id])).get(row.geo_object_id) ?? "";
  return { id: row.id, publicId: row.public_id, key: row.key, name };
}

/**
 * Every valid active subdivision, with data version, build time and bbox of its latest valid delivery (null before
 * the first one), ordered by key. Reads the `deliveries` row only, never S3: one broken package cannot fail the whole
 * list. A row built before `deliveries.bbox` existed lists its bbox as null.
 */
export async function listSubdivisions(db: Db): Promise<SubdivisionListEntry[]> {
  const { rows } = await db.execute<{
    public_id: string;
    key: string;
    country: string;
    geo_object_id: string;
    data_version: number | null;
    generated_at: string | Date | null;
    bbox: [number, number, number, number] | null;
  }>(sql`
    select s.public_id, s.key, s.country, s.geo_object_id, d.data_version, d.generated_at, d.bbox
    from subdivisions s
    left join lateral (
      select d.data_version, d.generated_at, d.bbox from deliveries d
      where d.subdivision_id = s.id and d.status = 'valid'
      order by d.data_version desc
      limit 1
    ) d on true
    where s.status = 'active' and ${validAtAlias("s")}
    order by s.key
  `);
  const names = await deliveryNames(db, rows.map((r) => r.geo_object_id));
  return rows.map((r) => ({
    id: r.public_id,
    key: r.key,
    name: names.get(r.geo_object_id) ?? "",
    country: r.country,
    dataVersion: r.data_version,
    bbox: r.bbox,
    generatedAt: r.generated_at === null ? null : new Date(r.generated_at).toISOString(),
  }));
}

const MAX_INT = 2_147_483_647;

/** The subdivision's valid delivery of `dataVersion`, without one the highest; null when there is none. */
export async function validDelivery(db: Db, subdivisionId: string, dataVersion?: number): Promise<DeliveryRow | null> {
  // beyond the integer column's range no delivery exists
  if (dataVersion !== undefined && !(Number.isSafeInteger(dataVersion) && dataVersion >= 1 && dataVersion <= MAX_INT)) return null;
  const [row] = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.subdivisionId, subdivisionId),
        eq(deliveries.status, "valid"),
        dataVersion === undefined ? undefined : eq(deliveries.dataVersion, dataVersion),
      ),
    )
    .orderBy(desc(deliveries.dataVersion))
    .limit(1);
  return row ?? null;
}

/**
 * The files a delivery has: the contract files in contract order, then its image files (`images/<public id>-<slot>.jpg`, contract 2.1, sorted by name). Both the API (`currentPackage`)
 * and the admin package page link every one of them.
 */
export function deliveryFiles(row: DeliveryRow): string[] {
  const contract = CONTRACT_FILES.filter((f) => Object.hasOwn(row.fileHashes, f));
  const images = Object.keys(row.fileHashes).filter(isImageFile).sort();
  return [...contract, ...images];
}

/**
 * The stored bytes of one file (a contract file or a package image) of a valid delivery, null when the delivery has no such file. A stored file that does
 * not match its recorded sha256 throws: the API never serves bytes other than the manifest describes.
 */
export async function readDeliveryFile(archive: Archive, row: DeliveryRow, file: string): Promise<Uint8Array | null> {
  return row.status === "valid" ? readStoredFile(archive, row, file) : null;
}

/**
 * The stored bytes of one file of any stored delivery, a rejected one too (admin diagnosis, never the API): null for an
 * `unchanged` row or a file the row does not list; a missing object or bytes that do not match the recorded sha256
 * throw.
 */
export async function readStoredFile(archive: Archive, row: DeliveryRow, file: string): Promise<Uint8Array | null> {
  if (row.storagePrefix === null || !Object.hasOwn(row.fileHashes, file)) return null;
  const key = `${row.storagePrefix}${file}`;
  const bytes = await archive.get(key);
  if (bytes === null) throw new Error(`package file ${key} of delivery ${row.id} is missing`);
  if (sha256Hex(bytes) !== row.fileHashes[file]!.sha256) throw new Error(`package file ${key} of delivery ${row.id} does not match its hash`);
  return bytes;
}

/** The parsed manifest of a valid delivery. */
export async function readManifest(archive: Archive, row: DeliveryRow): Promise<Manifest> {
  return readJsonFile<Manifest>(archive, row, "manifest.json");
}

/** The subdivision a manifest describes, with its data version; null for a radius package. */
export function manifestSubdivision(m: Pick<Manifest, "scope">): { id: string; key: string; dataVersion: number } | null {
  return m.scope.type === "subdivision" ? { id: m.scope.subdivision.id, key: m.scope.subdivision.key, dataVersion: m.scope.dataVersion } : null;
}

/** A JSON file of a valid delivery, parsed; throws when the delivery lacks it. */
export async function readJsonFile<T>(archive: Archive, row: DeliveryRow, file: string): Promise<T> {
  const bytes = await readDeliveryFile(archive, row, file);
  if (bytes === null) throw new Error(`delivery ${row.id} has no ${file}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * A data version as the API accepts it, for `?dataVersion=` and `?since=` alike: a positive integer without sign or
 * leading zeros (`^[1-9]\d*$`), else null (also for a missing parameter). A value beyond the current version is the
 * caller's to reject.
 */
export function parseDataVersion(value: string | null): number | null {
  return value !== null && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** True for a file name of the contract (`spots.json` …); anything else, a traversal included, is no package file. */
export function isContractFile(value: string): value is ContractFile {
  return (CONTRACT_FILES as readonly string[]).includes(value);
}

/**
 * `images/<public id>-<slot>.jpg` of a package (contract 2.1, `IMAGE_FILE_PATTERN`); anything else, a traversal included,
 * is no image file. The routes serve one from its file name `<public id>-<slot>.jpg`.
 */
export function isImageFile(value: string): boolean {
  return IMAGE_FILE_PATTERN.test(value);
}

/** `Cache-Control: private, max-age=<n>` of API answers (`delivery.api.cacheMaxAgeSeconds`). */
export function cacheMaxAgeSeconds(): number {
  return getConfig().delivery.api.cacheMaxAgeSeconds;
}

/** File name of the package (a contract file or `images/…`) → its API URL, pinned to the data version. */
export type PackageLinks = Record<string, string>;

/**
 * The subdivision's current package (`GET /subdivisions/{subdivision}/package`): its manifest plus `links` to every
 * file it has (`deliveryFiles`: the contract files and the image files), pinned to its data version. Null for an
 * unknown subdivision or one without a valid delivery. `schemaVersion` is the stored delivery's own contract version
 * (an older package keeps the version it was built with).
 */
export async function currentPackage(
  db: Db,
  archive: Archive,
  subdivisionRef: string,
): Promise<{ body: Manifest & { links: PackageLinks }; dataVersion: number; schemaVersion: string } | null> {
  const subdivision = await resolveSubdivision(db, subdivisionRef);
  const row = subdivision && (await validDelivery(db, subdivision.id));
  if (!subdivision || !row) return null;
  const manifest = await readManifest(archive, row);
  const links: PackageLinks = Object.fromEntries(
    deliveryFiles(row).map((f) => [f, `/api/v4/subdivisions/${subdivision.publicId}/package/${f}?dataVersion=${row.dataVersion}`]),
  );
  return { body: { ...manifest, links }, dataVersion: row.dataVersion!, schemaVersion: row.schemaVersion };
}

/**
 * One file of the subdivision's valid package of `dataVersion` (default the current one), byte for byte as stored, with
 * its recorded sha256 (checked against the bytes; the route's ETag, so they are not hashed twice). Null for an unknown
 * subdivision, an unknown version or a file the package does not have. `schemaVersion` is the stored delivery's own.
 */
export async function packageFile(
  db: Db,
  archive: Archive,
  subdivisionRef: string,
  file: string,
  dataVersion?: number,
): Promise<{ bytes: Uint8Array; sha256: string; dataVersion: number; schemaVersion: string } | null> {
  const subdivision = await resolveSubdivision(db, subdivisionRef);
  const row = subdivision && (await validDelivery(db, subdivision.id, dataVersion));
  if (!subdivision || !row) return null;
  const bytes = await readDeliveryFile(archive, row, file);
  // readDeliveryFile checked the bytes against this hash
  return bytes === null ? null : { bytes, sha256: row.fileHashes[file]!.sha256, dataVersion: row.dataVersion!, schemaVersion: row.schemaVersion };
}

/**
 * The spot `publicId` as delivered on `asOf` (`YYYY-MM-DD`; without it the latest), with the data version and
 * subdivision (`sd_…`) and the id of the delivery that introduced that version; null when no package delivered it then.
 *
 * Spot versions count per public id across subdivisions (ruling M6-P13): a spot that moves to another subdivision
 * continues its versions there, and its old subdivision later reports it `removed` with a higher version. So per
 * subdivision only the subdivision's latest version on that date counts, and the spot is gone only when it is removed
 * (or absent) in every subdivision; else the highest version a subdivision still delivers wins. Only subdivisions
 * valid today count, as for every other endpoint (`resolveSubdivision`); the pilot packages of contract 1.0 (rows
 * without a subdivision) are no answer. Its content is read from that version's first delivery. A spot moved away from
 * a subdivision that has not rebuilt since still counts there with its last version, which that subdivision's
 * current package still delivers.
 */
export async function spotAsOf(
  db: Db,
  archive: Archive,
  publicId: string,
  asOf?: string,
): Promise<{ spot: Spot; dataVersion: number; subdivision: string; deliveryId: string } | null> {
  const { rows } = await db.execute<{ first_delivery_id: string; subdivision_public_id: string }>(sql`
    with latest as (
      select distinct on (o.subdivision_id) o.subdivision_id, o.profile_version, o.removed, o.first_delivery_id
      from delivered_objects o
      where o.public_id = ${publicId} and o.object_type = 'spot' and o.subdivision_id is not null
        ${asOf === undefined ? sql`` : sql`and o.valid_from <= ${asOf}::date`}
      order by o.subdivision_id, o.profile_version desc
    )
    select l.first_delivery_id, s.public_id as subdivision_public_id
    from latest l
    join subdivisions s on s.id = l.subdivision_id
    where not l.removed
      and ${validAtAlias("s")}
    order by l.profile_version desc
    limit 1
  `);
  const found = rows[0];
  if (!found) return null;
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, found.first_delivery_id));
  const spot = (await readJsonFile<SpotsFile>(archive, row!, "spots.json")).spots.find((s) => s.id === publicId);
  if (!spot) throw new Error(`spot ${publicId} is not in spots.json of delivery ${row!.id}`);
  return { spot, dataVersion: row!.dataVersion!, subdivision: found.subdivision_public_id, deliveryId: row!.id };
}

const isoDate = z.iso.date();

/** True for a calendar date `YYYY-MM-DD` that exists (`2026-02-30` does not). */
export function isCalendarDate(value: string): boolean {
  if (!isoDate.safeParse(value).success) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const SPOT_ID = /^sp_[0-9A-HJKMNP-TV-Z]{26}$/;

/** True for a spot id `sp_<ulid>`. */
export function isSpotId(value: string): boolean {
  return SPOT_ID.test(value);
}

import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_FILES, type ChangeEntry, type ChangesFile, type ContractFile, type Manifest, type Spot, type SpotsFile } from "@/contract";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { deliveries } from "@/lib/db/schema/deliveries";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { deliveryArchive } from "./archive";
import type { DeliveryRow } from "./build";
import { mergeChanges } from "./changes";
import { sha256Hex } from "./serialize";

/*
 * What the delivery API reads (spec 08): areas, their valid packages and the stored files. Only `valid` deliveries are
 * ever served; a rejected package stays in S3 for diagnosis. S3 is read only through the delivery archive seam
 * (`deliveryArchive`, ruling M6-P18).
 */

export { deliveryArchive, setDeliveryArchive } from "./archive";

export type ResolvedArea = { geoObjectId: string; publicId: string; key: string; name: string };

export type AreaListEntry = {
  id: string;
  key: string;
  name: string;
  dataVersion: number | null;
  bbox: number[] | null;
  generatedAt: string | null;
};

/** A valid area (geo object of type `area` with a public id, valid today), by public id (`ar_…`) or config key. */
export async function resolveArea(db: Db, ref: string): Promise<ResolvedArea | null> {
  const { rows } = await db.execute<{ id: string; public_id: string; config_key: string | null; name: string | null }>(sql`
    select o.id, o.public_id, o.config_key, ${displayNameSql(sql`o.id`)} as name
    from geo_objects o
    where o.type = 'area' and o.public_id is not null
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
      and (o.public_id = ${ref} or o.config_key = ${ref})
    order by (o.public_id = ${ref}) desc, o.id
    limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  return { geoObjectId: row.id, publicId: row.public_id, key: row.config_key ?? row.public_id, name: row.name ?? "" };
}

/**
 * Every valid area with a public id, with data version and build time of its latest valid delivery and the bbox of
 * that package's manifest (null before the first one). Ordered by public id.
 */
export async function listAreas(db: Db, archive: Archive = deliveryArchive()): Promise<AreaListEntry[]> {
  const { rows } = await db.execute<{
    id: string;
    public_id: string;
    config_key: string | null;
    name: string | null;
    delivery_id: string | null;
  }>(sql`
    select o.id, o.public_id, o.config_key, ${displayNameSql(sql`o.id`)} as name, d.id as delivery_id
    from geo_objects o
    left join lateral (
      select d.id from deliveries d
      where d.area_id = o.id and d.status = 'valid'
      order by d.data_version desc
      limit 1
    ) d on true
    where o.type = 'area' and o.public_id is not null
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
    order by o.public_id
  `);
  const out: AreaListEntry[] = [];
  for (const r of rows) {
    const entry: AreaListEntry = {
      id: r.public_id,
      key: r.config_key ?? r.public_id,
      name: r.name ?? "",
      dataVersion: null,
      bbox: null,
      generatedAt: null,
    };
    if (r.delivery_id !== null) {
      const [row] = await db.select().from(deliveries).where(eq(deliveries.id, r.delivery_id));
      const manifest = await readManifest(archive, row!);
      entry.dataVersion = row!.dataVersion;
      entry.generatedAt = row!.generatedAt.toISOString();
      entry.bbox = manifest.bbox;
    }
    out.push(entry);
  }
  return out;
}

const MAX_INT = 2_147_483_647;

/** The area's valid delivery of `dataVersion`, without one the highest; null when there is none. */
export async function validDelivery(db: Db, areaGeoObjectId: string, dataVersion?: number): Promise<DeliveryRow | null> {
  // beyond the integer column's range no delivery exists
  if (dataVersion !== undefined && !(Number.isSafeInteger(dataVersion) && dataVersion >= 1 && dataVersion <= MAX_INT)) return null;
  const [row] = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.areaId, areaGeoObjectId),
        eq(deliveries.status, "valid"),
        dataVersion === undefined ? undefined : eq(deliveries.dataVersion, dataVersion),
      ),
    )
    .orderBy(desc(deliveries.dataVersion))
    .limit(1);
  return row ?? null;
}

/** The files a delivery has, in contract order (`changes.json` only from the second package on). */
export function deliveryFiles(row: DeliveryRow): ContractFile[] {
  return CONTRACT_FILES.filter((f) => Object.hasOwn(row.fileHashes, f));
}

/**
 * The stored bytes of one file of a valid delivery, null when the delivery has no such file. A stored file that does
 * not match its recorded sha256 throws: the API never serves bytes other than the manifest describes.
 */
export async function readDeliveryFile(archive: Archive, row: DeliveryRow, file: ContractFile): Promise<Uint8Array | null> {
  if (row.status !== "valid" || row.storagePrefix === null || !Object.hasOwn(row.fileHashes, file)) return null;
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

/** A JSON file of a valid delivery, parsed; throws when the delivery lacks it. */
export async function readJsonFile<T>(archive: Archive, row: DeliveryRow, file: ContractFile): Promise<T> {
  const bytes = await readDeliveryFile(archive, row, file);
  if (bytes === null) throw new Error(`delivery ${row.id} has no ${file}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** A data version as the API accepts it (`^[1-9]\d*$`), else null. */
export function parseDataVersion(value: string): number | null {
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** True for a file name of the contract (`spots.json` …); anything else, a traversal included, is no package file. */
export function isContractFile(value: string): value is ContractFile {
  return (CONTRACT_FILES as readonly string[]).includes(value);
}

/** `Cache-Control: private, max-age=<n>` of API answers (`delivery.api.cacheMaxAgeSeconds`). */
export function cacheMaxAgeSeconds(): number {
  return getConfig().delivery.api.cacheMaxAgeSeconds;
}

export type PackageLinks = Partial<Record<ContractFile, string>>;

/**
 * The area's current package (`GET /areas/{area}/package`): its manifest plus `links` to every file it has, pinned to
 * its data version. Null for an unknown area or one without a valid delivery.
 */
export async function currentPackage(
  db: Db,
  archive: Archive,
  areaRef: string,
): Promise<{ body: Manifest & { links: PackageLinks }; dataVersion: number } | null> {
  const area = await resolveArea(db, areaRef);
  const row = area && (await validDelivery(db, area.geoObjectId));
  if (!area || !row) return null;
  const manifest = await readManifest(archive, row);
  const links: PackageLinks = Object.fromEntries(
    deliveryFiles(row).map((f) => [f, `/api/v1/areas/${area.publicId}/package/${f}?dataVersion=${row.dataVersion}`]),
  );
  return { body: { ...manifest, links }, dataVersion: row.dataVersion! };
}

/**
 * One file of the area's valid package of `dataVersion` (default the current one), byte for byte as stored. Null for
 * an unknown area, an unknown version or a file the package does not have.
 */
export async function packageFile(
  db: Db,
  archive: Archive,
  areaRef: string,
  file: ContractFile,
  dataVersion?: number,
): Promise<{ bytes: Uint8Array; dataVersion: number } | null> {
  const area = await resolveArea(db, areaRef);
  const row = area && (await validDelivery(db, area.geoObjectId, dataVersion));
  if (!area || !row) return null;
  const bytes = await readDeliveryFile(archive, row, file);
  return bytes === null ? null : { bytes, dataVersion: row.dataVersion! };
}

/**
 * The changes of the area's packages after `since` up to the current one, merged per object (`mergeChanges` over the
 * stored `changes.json` of versions `since + 1 … current`, the windows the packages were built from, ruling M6-D-R3).
 * `since` equal to the current version gives no changes; below 1 or above the current version is `invalid_since`.
 */
export async function changesSince(
  db: Db,
  archive: Archive,
  areaGeoObjectId: string,
  since: number,
): Promise<{ dataVersion: number; changes: ChangeEntry[] } | "invalid_since" | "not_found"> {
  const current = await validDelivery(db, areaGeoObjectId);
  if (!current) return "not_found";
  const dataVersion = current.dataVersion!;
  if (!Number.isSafeInteger(since) || since < 1 || since > dataVersion) return "invalid_since";
  if (since === dataVersion) return { dataVersion, changes: [] };
  const rows = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.areaId, areaGeoObjectId),
        eq(deliveries.status, "valid"),
        gt(deliveries.dataVersion, since),
        lte(deliveries.dataVersion, dataVersion),
      ),
    )
    .orderBy(asc(deliveries.dataVersion));
  if (rows.length !== dataVersion - since) {
    throw new Error(`area ${areaGeoObjectId} lacks valid deliveries between ${since + 1} and ${dataVersion}`);
  }
  const lists: ChangeEntry[][] = [];
  for (const row of rows) lists.push((await readJsonFile<ChangesFile>(archive, row, "changes.json")).changes);
  return { dataVersion, changes: mergeChanges(lists) };
}

/**
 * The spot `publicId` as delivered on `asOf` (`YYYY-MM-DD`; without it the latest), with the data version of the
 * package that introduced that version; null when no package delivered it then.
 *
 * Spot versions count per public id across areas (ruling M6-P13): a spot that moves to another area continues its
 * versions there, and its old area later reports it `removed` with a higher version. So per area only the area's
 * latest version on that date counts, and the spot is gone only when it is removed (or absent) in every area; else the
 * highest version an area still delivers wins. Its content is read from that version's first delivery.
 */
export async function spotAsOf(db: Db, archive: Archive, publicId: string, asOf?: string): Promise<{ spot: Spot; dataVersion: number } | null> {
  const { rows } = await db.execute<{ first_delivery_id: string }>(sql`
    with latest as (
      select distinct on (o.area_id) o.area_id, o.profile_version, o.removed, o.first_delivery_id
      from delivered_objects o
      where o.public_id = ${publicId} and o.object_type = 'spot'
        ${asOf === undefined ? sql`` : sql`and o.valid_from <= ${asOf}::date`}
      order by o.area_id, o.profile_version desc
    )
    select l.first_delivery_id from latest l
    where not l.removed
    order by l.profile_version desc
    limit 1
  `);
  const found = rows[0];
  if (!found) return null;
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, found.first_delivery_id));
  const spot = (await readJsonFile<SpotsFile>(archive, row!, "spots.json")).spots.find((s) => s.id === publicId);
  if (!spot) throw new Error(`spot ${publicId} is not in spots.json of delivery ${row!.id}`);
  return { spot, dataVersion: row!.dataVersion! };
}

/** `since` as the API accepts it: digits only, else null (a value out of range is `invalid_since` later). */
export function parseSince(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
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

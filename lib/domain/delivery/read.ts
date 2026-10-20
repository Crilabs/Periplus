import { and, desc, eq, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_FILES, type ContractFile, type Manifest } from "@/contract";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { deliveries } from "@/lib/db/schema/deliveries";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { deliveryArchive } from "./archive";
import type { DeliveryRow } from "./build";
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

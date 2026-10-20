import { count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_FILES, type ChangeEntry, type ChangesFile, type ContractFile } from "@/contract";
import type { Db } from "@/lib/db/client";
import { deliveries, geoObjects, places, type DeliveryStatus } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import type { DeliveryRow } from "./build";
import { readStoredFile } from "./read";
import { contentTypeOf } from "./serialize";
import type { CheckName, Finding, ValidationReport } from "./validate";

/*
 * What the admin sees of deliveries (spec 08, plan Task 13): the list per area, one delivery with its report, changes
 * and files (rejected packages too, for diagnosis) and a file as download.
 * Reads only; never builds, never writes S3.
 */

export const DELIVERIES_PAGE_SIZE = 50;

export type DeliveryAreaHead = {
  geoObjectId: string;
  key: string;
  name: string;
  current: { dataVersion: number; generatedAt: Date } | null;
};

export type DeliveryListRow = {
  id: string;
  areaName: string;
  status: DeliveryStatus;
  dataVersion: number | null;
  generatedAt: Date;
  failedChecks: CheckName[];
  objectCounts: Record<string, number>;
  runId: string | null;
};

/** The checks of a stored report that found a violation, in report order. */
function failedChecks(report: unknown): CheckName[] {
  const checks = (report as Partial<ValidationReport> | null)?.checks;
  return Array.isArray(checks) ? checks.filter((c) => !c.ok).map((c) => c.name) : [];
}

/**
 * The valid areas with a public id, each with its current (latest valid) package, ordered by name, and one page (50,
 * newest first) of the deliveries of all areas or of `areaId`.
 */
export async function listDeliveries(
  db: Db,
  filter: { areaId?: string; page: number },
): Promise<{ areas: DeliveryAreaHead[]; rows: DeliveryListRow[]; total: number }> {
  const { rows: areaRows } = await db.execute<{
    id: string;
    public_id: string;
    config_key: string | null;
    name: string | null;
    data_version: number | null;
    generated_at: string | Date | null;
  }>(sql`
    select o.id, o.public_id, o.config_key, ${displayNameSql(sql`o.id`)} as name, d.data_version, d.generated_at
    from geo_objects o
    left join lateral (
      select d.data_version, d.generated_at from deliveries d
      where d.area_id = o.id and d.status = 'valid'
      order by d.data_version desc
      limit 1
    ) d on true
    where o.type = 'area' and o.public_id is not null
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
    order by name nulls last, o.public_id
  `);
  const areas = areaRows.map((r) => ({
    geoObjectId: r.id,
    key: r.config_key ?? r.public_id,
    name: r.name ?? r.config_key ?? r.public_id,
    current: r.data_version === null ? null : { dataVersion: r.data_version, generatedAt: new Date(r.generated_at!) },
  }));

  const where = filter.areaId ? eq(deliveries.areaId, filter.areaId) : undefined;
  const page = Math.max(1, Math.floor(filter.page));
  const list = await db
    .select({
      id: deliveries.id,
      areaName: displayNameSql(deliveries.areaId),
      areaPublicId: geoObjects.publicId,
      status: deliveries.status,
      dataVersion: deliveries.dataVersion,
      generatedAt: deliveries.generatedAt,
      validationReport: deliveries.validationReport,
      objectCounts: deliveries.objectCounts,
      runId: deliveries.runId,
    })
    .from(deliveries)
    .innerJoin(geoObjects, eq(geoObjects.id, deliveries.areaId))
    .where(where)
    .orderBy(desc(deliveries.createdAt), desc(deliveries.generatedAt), desc(deliveries.id))
    .limit(DELIVERIES_PAGE_SIZE)
    .offset((page - 1) * DELIVERIES_PAGE_SIZE);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(deliveries).where(where);
  return {
    areas,
    rows: list.map((r) => ({
      id: r.id,
      areaName: r.areaName ?? r.areaPublicId ?? r.id,
      status: r.status,
      dataVersion: r.dataVersion,
      generatedAt: r.generatedAt,
      failedChecks: failedChecks(r.validationReport),
      objectCounts: r.objectCounts,
      runId: r.runId,
    })),
    total: Number(n),
  };
}

export type DeliveryDetail = {
  row: DeliveryRow;
  areaName: string;
  areaPublicId: string;
  report: ValidationReport;
  /** `changes.json` of the package (also of a rejected one, as its diff to the previous package); null without one. */
  changes: ChangeEntry[] | null;
  files: Array<{ name: ContractFile; sha256: string; bytes: number }>;
  /** Public id of an object named in the report or the changes → its admin page (`/places/…`, `/geo/…`). */
  objectLinks: Record<string, string>;
};

const decoder = new TextDecoder();

/** One delivery with its validation report, changes and files; null for an unknown id. */
export async function deliveryDetail(db: Db, archive: Archive, id: string): Promise<DeliveryDetail | null> {
  const [found] = await db
    .select({ row: deliveries, areaName: displayNameSql(deliveries.areaId), areaPublicId: geoObjects.publicId })
    .from(deliveries)
    .innerJoin(geoObjects, eq(geoObjects.id, deliveries.areaId))
    .where(eq(deliveries.id, id));
  if (!found) return null;
  const { row } = found;
  const report = row.validationReport as ValidationReport;
  const bytes = await readStoredFile(archive, row, "changes.json");
  const changes = bytes === null ? null : (JSON.parse(decoder.decode(bytes)) as ChangesFile).changes;
  const files = CONTRACT_FILES.filter((f) => Object.hasOwn(row.fileHashes, f)).map((name) => ({ name, ...row.fileHashes[name]! }));
  const named = new Set<string>();
  const findings: Finding[] = [...(report.checks ?? []).flatMap((c) => c.findings), ...(report.warnings ?? [])];
  for (const f of findings) if (f.objectId) named.add(f.objectId);
  for (const c of changes ?? []) named.add(c.objectId);
  return {
    row,
    areaName: found.areaName ?? found.areaPublicId ?? row.areaId,
    areaPublicId: found.areaPublicId ?? row.areaId,
    report,
    changes,
    files,
    objectLinks: await objectLinks(db, [...named]),
  };
}

/** Admin page of each public id: a spot's place page, else the geo object's page; ids without an object are left out. */
async function objectLinks(db: Db, publicIds: string[]): Promise<Record<string, string>> {
  if (publicIds.length === 0) return {};
  const links: Record<string, string> = {};
  const spotIds = publicIds.filter((p) => p.startsWith("sp_"));
  if (spotIds.length > 0) {
    // a public id is never reused: the place that carries it, valid or not
    const rows = await db.select({ id: places.id, publicId: places.publicId }).from(places).where(inArray(places.publicId, spotIds));
    for (const r of rows) links[r.publicId!] = `/places/${r.id}`;
  }
  const otherIds = publicIds.filter((p) => !p.startsWith("sp_"));
  if (otherIds.length > 0) {
    const rows = await db.select({ id: geoObjects.id, publicId: geoObjects.publicId }).from(geoObjects).where(inArray(geoObjects.publicId, otherIds));
    for (const r of rows) links[r.publicId!] = `/geo/${r.id}`;
  }
  return links;
}

/**
 * One stored file of a delivery as a download (rejected packages too): bytes, content type and the file name
 * `<ar_id>-<dataVersion | rejected>-<file>`. Null for an unknown delivery or a file it does not have.
 */
export async function deliveryDownload(
  db: Db,
  archive: Archive,
  id: string,
  file: ContractFile,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string } | null> {
  const [found] = await db
    .select({ row: deliveries, areaPublicId: geoObjects.publicId })
    .from(deliveries)
    .innerJoin(geoObjects, eq(geoObjects.id, deliveries.areaId))
    .where(eq(deliveries.id, id));
  if (!found) return null;
  const bytes = await readStoredFile(archive, found.row, file);
  if (bytes === null) return null;
  const version = found.row.dataVersion === null ? "rejected" : String(found.row.dataVersion);
  return { bytes, contentType: contentTypeOf(file), filename: `${found.areaPublicId}-${version}-${file}` };
}

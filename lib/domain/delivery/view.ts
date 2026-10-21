import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { ChangeEntry, ChangesFile, Spot, SpotBody } from "@/contract";
import type { Db } from "@/lib/db/client";
import { deliveredObjects, deliveries, geoObjects, places, subdivisions, type DeliveryStatus } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import type { DeliveryRow } from "./build";
import { draftSubdivision, type OmittedSpot } from "./draft";
import { deliveryFiles, readStoredFile, spotAsOf } from "./read";
import { contentTypeOf } from "./serialize";
import type { CheckName, Finding, ValidationReport } from "./validate";
import { contentHash } from "./versioning";

/*
 * What the admin sees of deliveries (spec 08, spec 14): the list per subdivision, one delivery with its report,
 * changes and files (rejected packages too, for diagnosis), a file as download, and the place page's delivery tab.
 * Reads only; never builds, never writes S3.
 */

export const DELIVERIES_PAGE_SIZE = 50;

export type DeliverySubdivisionHead = {
  id: string;
  key: string;
  name: string;
  current: { dataVersion: number; generatedAt: Date } | null;
};

export type DeliveryListRow = {
  id: string;
  /** The subdivision's name; a package of the pilot (contract 1.0) shows its configured area's name. */
  scopeName: string;
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
 * The valid active subdivisions that can have a package (a valid tile labelled with them, or a package already),
 * each with its current (latest valid) package, ordered by name, and one page (50,
 * newest first) of the deliveries of all subdivisions or of `subdivisionId`. Pilot packages (contract 1.0, area only)
 * stay in the list of all.
 */
export async function listDeliveries(
  db: Db,
  filter: { subdivisionId?: string; page: number },
): Promise<{ subdivisions: DeliverySubdivisionHead[]; rows: DeliveryListRow[]; total: number }> {
  const { rows: headRows } = await db.execute<{
    id: string;
    key: string;
    name: string | null;
    data_version: number | null;
    generated_at: string | Date | null;
  }>(sql`
    select s.id, s.key, ${displayNameSql(sql`s.geo_object_id`)} as name, d.data_version, d.generated_at
    from subdivisions s
    left join lateral (
      select d.data_version, d.generated_at from deliveries d
      where d.subdivision_id = s.id and d.status = 'valid'
      order by d.data_version desc
      limit 1
    ) d on true
    where s.status = 'active'
      and s.valid_from <= current_date and (s.valid_to is null or s.valid_to > current_date)
      and (exists (select 1 from tiles t where t.subdivision_id = s.id and t.valid_to is null)
           or exists (select 1 from deliveries d where d.subdivision_id = s.id))
    order by name nulls last, s.key
  `);
  const heads = headRows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name ?? r.key,
    current: r.data_version === null ? null : { dataVersion: r.data_version, generatedAt: new Date(r.generated_at!) },
  }));

  const where = filter.subdivisionId ? eq(deliveries.subdivisionId, filter.subdivisionId) : undefined;
  const page = Math.max(1, Math.floor(filter.page));
  const list = await db
    .select({
      id: deliveries.id,
      subdivisionName: displayNameSql(subdivisions.geoObjectId),
      subdivisionKey: subdivisions.key,
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
    .leftJoin(subdivisions, eq(subdivisions.id, deliveries.subdivisionId))
    .leftJoin(geoObjects, eq(geoObjects.id, deliveries.areaId))
    .where(where)
    .orderBy(desc(deliveries.createdAt), desc(deliveries.generatedAt), desc(deliveries.id))
    .limit(DELIVERIES_PAGE_SIZE)
    .offset((page - 1) * DELIVERIES_PAGE_SIZE);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(deliveries).where(where);
  return {
    subdivisions: heads,
    rows: list.map((r) => ({
      id: r.id,
      scopeName: r.subdivisionName ?? r.subdivisionKey ?? r.areaName ?? r.areaPublicId ?? r.id,
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
  /** The subdivision's name; a pilot package (contract 1.0) shows its configured area's name. */
  scopeName: string;
  /** The subdivision's `sd_` id (a pilot package: the area's `ar_` id). */
  scopePublicId: string;
  report: ValidationReport;
  /** `changes.json` of the package (also of a rejected one, as its diff to the previous package); null without one. */
  changes: ChangeEntry[] | null;
  /** Why `changes.json` could not be read (missing in S3 or not matching its hash); null when it could. */
  archiveError: string | null;
  /** Every stored file (`deliveryFiles`: the contract files, then the image files `images/…`) with its recorded hash. */
  files: Array<{ name: string; sha256: string; bytes: number }>;
  /** Public id of an object named in the report or the changes → its admin page (`/places/…`, `/geo/…`). */
  objectLinks: Record<string, string>;
};

const decoder = new TextDecoder();

/** One delivery with its validation report, changes and files; null for an unknown id. */
export async function deliveryDetail(db: Db, archive: Archive, id: string): Promise<DeliveryDetail | null> {
  const [found] = await db
    .select({
      row: deliveries,
      subdivisionName: displayNameSql(subdivisions.geoObjectId),
      subdivisionPublicId: subdivisions.publicId,
      areaName: displayNameSql(deliveries.areaId),
      areaPublicId: geoObjects.publicId,
    })
    .from(deliveries)
    .leftJoin(subdivisions, eq(subdivisions.id, deliveries.subdivisionId))
    .leftJoin(geoObjects, eq(geoObjects.id, deliveries.areaId))
    .where(eq(deliveries.id, id));
  if (!found) return null;
  const { row } = found;
  const scopePublicId = found.subdivisionPublicId ?? found.areaPublicId ?? row.id;
  const report = row.validationReport as ValidationReport;
  let changes: ChangeEntry[] | null = null;
  let archiveError: string | null = null;
  try {
    const bytes = await readStoredFile(archive, row, "changes.json");
    changes = bytes === null ? null : (JSON.parse(decoder.decode(bytes)) as ChangesFile).changes;
  } catch (e) {
    // a lost or altered file must not hide the report: the page says so instead
    archiveError = e instanceof Error ? e.message : String(e);
  }
  const files = deliveryFiles(row).map((name) => ({ name, ...row.fileHashes[name]! }));
  const named = new Set<string>();
  const findings: Finding[] = [...(report.checks ?? []).flatMap((c) => c.findings), ...(report.warnings ?? [])];
  for (const f of findings) if (f.objectId) named.add(f.objectId);
  for (const c of changes ?? []) named.add(c.objectId);
  return {
    row,
    scopeName: found.subdivisionName ?? found.areaName ?? scopePublicId,
    scopePublicId,
    report,
    changes,
    archiveError,
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
 * `<sd_id>-<dataVersion | rejected>-<file>` (a pilot package: its `ar_` id). Null for an unknown delivery or a file it does not have.
 */
export async function deliveryDownload(
  db: Db,
  archive: Archive,
  id: string,
  file: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string } | null> {
  const [found] = await db
    .select({ row: deliveries, subdivisionPublicId: subdivisions.publicId, areaPublicId: geoObjects.publicId })
    .from(deliveries)
    .leftJoin(subdivisions, eq(subdivisions.id, deliveries.subdivisionId))
    .leftJoin(geoObjects, eq(geoObjects.id, deliveries.areaId))
    .where(eq(deliveries.id, id));
  if (!found) return null;
  const bytes = await readStoredFile(archive, found.row, file);
  if (bytes === null) return null;
  const version = found.row.dataVersion === null ? "rejected" : String(found.row.dataVersion);
  return { bytes, contentType: contentTypeOf(file), filename: `${found.subdivisionPublicId ?? found.areaPublicId ?? found.row.id}-${version}-${file.replace("/", "-")}` };
}

/**
 * Why the next package would not deliver the place as a spot of its own: a `mapSpot` omission; a merged place whose
 * final target the package delivers (`merged`: carried with `mergedInto` when the subdivision's previous package had
 * it, ruling M6-P14) or does not deliver (`merged_removed`: an event `removed`); or no spot of its subdivision's
 * package at all.
 */
export type PreviewOmission = OmittedSpot["reason"] | "no_subdivision" | "merged" | "merged_removed" | "not_in_package";

export type PlaceDelivery = {
  delivered: { spot: Spot; dataVersion: number; deliveryId: string } | null;
  /** `mergedInto`: the final target's public id of a merged place. */
  preview: { spot: SpotBody; differs: boolean } | { omitted: PreviewOmission; mergedInto?: string } | null;
  history: Array<{ profileVersion: number; validFrom: string; removed: boolean; deliveryId: string }>;
};

/**
 * The place page's delivery tab: the spot as last delivered (`spotAsOf`), the spot the next package of the place's
 * subdivision would deliver (`draftSubdivision` on `today`, default the database's date; the build's own assembly, ruling M6-P27:
 * no S3, no versions), whether it differs from the delivered one (`contentHash` without the version fields), and every
 * contract version of the spot. A place without public id has nothing to show.
 */
export async function placeDelivery(db: Db, archive: Archive, placeId: string, opts: { today?: string } = {}): Promise<PlaceDelivery> {
  // the database's date, as `spotAsOf` and the validity of the geo rows (review minor 6)
  const today = opts.today ?? (await db.execute<{ d: string }>(sql`select current_date::text as d`)).rows[0]!.d;
  // the subdivision of the place's land (`geo_objects.subdivision_id`), not its tile's label; also of an ended object
  // (a merged place's object ends with the merge, and its subdivision's package still reports it, as `loadMerged`)
  const { rows } = await db.execute<{ public_id: string | null; subdivision_id: string | null }>(sql`
    select p.public_id, (select o.subdivision_id from geo_objects o where o.id = p.geo_object_id) as subdivision_id
    from places p where p.id = ${placeId}
  `);
  const place = rows[0];
  if (!place?.public_id) return { delivered: null, preview: null, history: [] };
  const publicId = place.public_id;

  const found = await spotAsOf(db, archive, publicId);
  const delivered = found && { spot: found.spot, dataVersion: found.dataVersion, deliveryId: found.deliveryId };
  const history = await db
    .select({
      profileVersion: deliveredObjects.profileVersion,
      validFrom: deliveredObjects.validFrom,
      removed: deliveredObjects.removed,
      deliveryId: deliveredObjects.firstDeliveryId,
    })
    .from(deliveredObjects)
    .where(and(eq(deliveredObjects.publicId, publicId), eq(deliveredObjects.objectType, "spot")))
    .orderBy(desc(deliveredObjects.profileVersion));

  let preview: PlaceDelivery["preview"];
  if (place.subdivision_id === null) {
    preview = { omitted: "no_subdivision" };
  } else {
    const draft = await draftSubdivision(db, place.subdivision_id, today);
    const spot = draft.spots.find((s) => s.body.id === publicId);
    const omitted = draft.omittedSpots.find((s) => s.id === publicId);
    if (spot) {
      const deliveredHash = delivered ? deliveredContentHash(delivered.spot) : null;
      preview = { spot: spot.body, differs: deliveredHash !== contentHash(spot.body) };
    } else if (omitted) {
      preview = { omitted: omitted.reason };
    } else {
      const merged = draft.scope.merged.find((m) => m.publicId === publicId);
      preview = merged
        ? { omitted: draft.spots.some((x) => x.body.id === merged.mergedIntoPublicId) ? "merged" : "merged_removed", mergedInto: merged.mergedIntoPublicId }
        : { omitted: "not_in_package" };
    }
  }
  return { delivered, preview, history };
}

/** The content hash of a delivered spot: its stored body without the version fields, as the build hashes it. */
function deliveredContentHash(spot: Spot): string {
  const body: Record<string, unknown> = { ...spot };
  delete body.profileVersion;
  delete body.validFrom;
  return contentHash(body);
}

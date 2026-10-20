import { and, desc, eq, sql, type InferSelectModel } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Archive } from "@/lib/adapters/s3";
import {
  CONTRACT_FILES,
  SCHEMA_VERSION,
  type ChangeEntry,
  type ContractFile,
  type Highlight,
  type Manifest,
  type Region,
  type Spot,
  type SpotBody,
} from "@/contract";
import { getConfig } from "@/lib/config";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { deliveredObjects, deliveries, type DeliveryStatus } from "@/lib/db/schema/deliveries";
import { findArchiveCopies } from "@/lib/domain/documents/archive-copies";
import { newId } from "@/lib/domain/ids";
import { buildChanges, eventSeverities } from "./changes";
import { buildCoast } from "./coast";
import { draftSubdivision, type SubdivisionDraft } from "./draft";
import { contentDigest, contentTypeOf, serializeFile, sha256Hex } from "./serialize";
import { currentSnapshot, openBuildSnapshot, type BuildSnapshot } from "./snapshot";
import type { DeliveryPackage, SubdivisionScope } from "./types";
import { undeliveredSafety } from "./map-region";
import { buildWarnings, spotsInMilitaryAreas, validatePackage, type ValidationReport } from "./validate";
import { assignVersions, latestDelivered, type ObjectDraft, type RemovedObject, type VersionedObject } from "./versioning";
import { buildWeatherPoints } from "./weather-points";

/*
 * Builds one subdivision's package (spec 08 "Paket", spec 14 "Paket je Landesteil"): reads everything from one
 * snapshot, maps, versions, validates, stores the files in S3 and writes the `deliveries` row with the contract
 * versions it introduced. A valid package with a change gets the next data version under
 * `deliveries/<subdivision-key>/<dataVersion>/`; a rejected one is stored for diagnosis under
 * `deliveries/<subdivision-key>/rejected/<deliveryId>/` without a data version (also when its content equals the
 * previous package); a valid build without any change is recorded as `unchanged` and stores nothing.
 */

export type DeliveryRow = InferSelectModel<typeof deliveries>;

/** The subdivision's latest valid package as stored: its row, its objects by id and the contents of coast and weather points. */
export type PreviousPackage = {
  delivery: DeliveryRow;
  spots: Map<string, Spot>;
  highlights: Map<string, Highlight>;
  regions: Map<string, Region>;
  /** sha256 per stored file (`deliveries.file_hashes`). */
  fileHashes: Record<string, string>;
  /** `contentDigest` of the coast features and of the weather points (ruling M6-P12). */
  coastDigest: string;
  weatherDigest: string;
};

export type BuildOptions = {
  runId?: string;
  /** The build time: `generatedAt`, and its UTC date is the build date (validity, popularity, `validFrom`). */
  now?: Date;
  triggeredBy?: string;
  cfg?: DeliveryConfig;
  /** Test seam: changes the loaded scope before mapping. */
  scopeTransform?: (scope: SubdivisionScope) => SubdivisionScope;
  /** Test seam: runs after the uploads and rows, before the commit. */
  beforeCommit?: () => Promise<void>;
  /** Test seam: runs in the read transaction right after its snapshot is taken, before any read. */
  afterSnapshot?: (tx: Db) => Promise<void>;
  /**
   * Test only: `db` is the caller's transaction (`withRollback`), and the build reads in it under its current
   * snapshot. That transaction is READ COMMITTED and read-write, so the one-snapshot guarantee (ruling M6-D-R3) does
   * not hold: never for production callers. Without this option a transaction handle throws; with it the pool does.
   */
  inCallerTransaction?: boolean;
};

export type BuildResult = { deliveryId: string; status: DeliveryStatus; dataVersion: number | null; report: ValidationReport };

const decoder = new TextDecoder();

/** The latest valid package of the subdivision with its files from `storage_prefix`; null before the first one. */
export async function previousPackage(db: Db, archive: Archive, subdivisionId: string): Promise<PreviousPackage | null> {
  const [delivery] = await db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.subdivisionId, subdivisionId), eq(deliveries.status, "valid")))
    .orderBy(desc(deliveries.dataVersion))
    .limit(1);
  if (!delivery) return null;
  const read = async <T>(file: ContractFile): Promise<T> => {
    const key = `${delivery.storagePrefix!}${file}`;
    const bytes = await archive.get(key);
    if (bytes === null) throw new Error(`package file ${key} of delivery ${delivery.id} is missing`);
    return JSON.parse(decoder.decode(bytes)) as T;
  };
  const spots = await read<{ spots: Spot[] }>("spots.json");
  const highlights = await read<{ highlights: Highlight[] }>("highlights.json");
  const regions = await read<{ regions: Region[] }>("regions.json");
  const coast = await read<{ features: unknown[] }>("coast.geojson");
  const weather = await read<{ points: unknown[] }>("weather-points.json");
  return {
    delivery,
    spots: new Map(spots.spots.map((s) => [s.id, s])),
    highlights: new Map(highlights.highlights.map((h) => [h.id, h])),
    regions: new Map(regions.regions.map((r) => [r.id, r])),
    fileHashes: Object.fromEntries(Object.entries(delivery.fileHashes).map(([file, h]) => [file, h.sha256])),
    coastDigest: contentDigest(coast.features),
    weatherDigest: contentDigest(weather.points),
  };
}

/** What the build read and made from one snapshot. */
type Assembly = {
  previous: PreviousPackage | null;
  pkg: DeliveryPackage;
  report: ValidationReport;
  objects: VersionedObject[];
  removed: RemovedObject[];
  unchanged: boolean;
  dataVersion: number;
};

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const VERSION_FIELDS = new Set(["profileVersion", "validFrom"]);
/** A delivered object without its version fields: the contract body its content hash is taken over. */
const withoutVersion = <T extends { profileVersion: number; validFrom: string }>(o: T): Omit<T, "profileVersion" | "validFrom"> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !VERSION_FIELDS.has(k))) as Omit<T, "profileVersion" | "validFrom">;

/**
 * Merged places of the previous package (ruling M6-P14): carried with their last content and `mergedInto` = the final
 * target when the target is delivered in this package (highlight ids cut to the delivered ones, a region no longer
 * delivered dropped), otherwise left out, so they are removed, with a warning.
 */
function carryMerged(draft: SubdivisionDraft, previous: PreviousPackage | null): { carried: SpotBody[]; notCarried: Array<{ id: string; into: string }> } {
  const carried: SpotBody[] = [];
  const notCarried: Array<{ id: string; into: string }> = [];
  if (!previous) return { carried, notCarried };
  const spotIds = new Set(draft.spots.map((s) => s.body.id));
  const highlightIds = new Set(draft.highlights.map((h) => h.body.id));
  const regionIds = new Set(draft.regions.map((r) => r.body.id));
  for (const m of draft.scope.merged) {
    const last = previous.spots.get(m.publicId);
    if (!last) continue;
    if (!spotIds.has(m.mergedIntoPublicId)) {
      notCarried.push({ id: m.publicId, into: m.mergedIntoPublicId });
      continue;
    }
    const body = withoutVersion(last);
    carried.push({
      ...body,
      ...(body.highlightIds ? { highlightIds: body.highlightIds.filter((id) => highlightIds.has(id)) } : {}),
      ...(body.regionId != null && !regionIds.has(body.regionId) ? { regionId: null } : {}),
      mergedInto: m.mergedIntoPublicId,
    });
  }
  return { carried, notCarried };
}

/** Reads and assembles the package from one snapshot and validates it (no write). */
async function assemble(
  tx: Db,
  snapshot: BuildSnapshot,
  input: { archive: Archive; subdivisionId: string; today: string; generatedAt: string; cfg: DeliveryConfig; scopeTransform?: (s: SubdivisionScope) => SubdivisionScope },
): Promise<Assembly> {
  const { cfg, today } = input;
  const consolidation = await consolidationConfigFor(tx);
  const previous = await previousPackage(tx, input.archive, input.subdivisionId);
  const draft = await draftSubdivision(tx, input.subdivisionId, today, {
    cfg,
    radiusNm: consolidation.importance.radiusNm,
    poiConfidence: consolidation.poiConfidence,
    scopeTransform: input.scopeTransform,
  });
  const latest = await latestDelivered(tx, input.subdivisionId);
  const { carried, notCarried } = carryMerged(draft, previous);

  const drafts: ObjectDraft[] = [
    ...draft.spots.map((s): ObjectDraft => ({ type: "spot", id: s.body.id, geoObjectId: s.geoObjectId, body: s.body })),
    ...carried.map((body): ObjectDraft => ({ type: "spot", id: body.id, geoObjectId: latest.get(body.id)?.geoObjectId ?? null, body })),
    ...draft.highlights.map((h): ObjectDraft => ({ type: "highlight", id: h.body.id, geoObjectId: h.geoObjectId, body: h.body })),
    ...draft.regions.map((r): ObjectDraft => ({ type: "region", id: r.body.id, geoObjectId: r.geoObjectId, body: r.body })),
  ];
  const { objects, removed } = assignVersions(drafts, latest, today);

  const coast = await buildCoast(tx, { bbox: draft.scope.subdivision.bbox, cfg: cfg.coast, asOf: today });
  const weather = await buildWeatherPoints(tx, {
    regions: draft.deliveredRegions,
    passages: draft.scope.passages,
    regionIdFor: draft.regionIdFor,
    cfg: cfg.weather,
  });

  const unchanged =
    previous !== null &&
    removed.length === 0 &&
    objects.every((o) => o.status === "same") &&
    contentDigest(coast.features) === previous.coastDigest &&
    contentDigest(weather.points) === previous.weatherDigest;
  const previousVersion = previous?.delivery.dataVersion ?? null;
  const dataVersion = (previousVersion ?? 0) + 1;

  let changes: ChangeEntry[] | null = null;
  if (previous) {
    const changedIds = [...objects.filter((o) => o.status !== "same"), ...removed].flatMap((o) => (o.geoObjectId ? [o.geoObjectId] : []));
    const eventSeverity = await eventSeverities(tx, changedIds, {
      fromSnapshot: previous.delivery.changeSnapshot,
      toSnapshot: snapshot.snapshot,
    });
    const previousBodies = new Map<string, object>([...previous.spots, ...previous.highlights, ...previous.regions]);
    changes = buildChanges({ objects, removed, previousBodies, eventSeverity, cfg: cfg.severity });
  }

  const envelope = { schemaVersion: SCHEMA_VERSION, subdivision: draft.scope.subdivision.publicId, dataVersion, generatedAt: input.generatedAt } as const;
  const versioned = (type: VersionedObject["type"]) =>
    objects
      .filter((o) => o.type === type)
      .map((o) => ({ ...o.body, profileVersion: o.profileVersion, validFrom: o.validFrom }))
      .sort(byId);
  const files: DeliveryPackage["files"] = {
    "spots.json": { ...envelope, spots: versioned("spot") as Spot[] },
    "highlights.json": { ...envelope, highlights: versioned("highlight") as Highlight[] },
    "regions.json": { ...envelope, regions: versioned("region") as Region[] },
    "coast.geojson": coast,
    "weather-points.json": { ...envelope, points: weather.points },
    ...(changes !== null && previousVersion !== null
      ? { "changes.json": { ...envelope, previousDataVersion: previousVersion, changes } }
      : {}),
  };
  const manifest = buildManifest(draft.scope, files, { dataVersion, previousDataVersion: previousVersion, generatedAt: input.generatedAt, cfg });
  const pkg: DeliveryPackage = { manifest, files };

  const report = await validatePackage(pkg, {
    previous: previous
      ? {
          dataVersion: previousVersion!,
          // the previous package's objects only (merged ones it carried included)
          versions: new Map(
            [...previous.spots.values(), ...previous.highlights.values(), ...previous.regions.values()].map((o) => [o.id, o.profileVersion]),
          ),
        }
      : null,
    findCopies: async (text) => (await findArchiveCopies(tx, text)).longestRun,
    forbiddenSources: [
      ...draft.spots.filter((s) => s.forbiddenSources.length > 0).map((s) => ({ file: "spots.json" as const, objectId: s.body.id, urls: s.forbiddenSources })),
      ...draft.highlightForbiddenSources.map((h) => ({ file: "highlights.json" as const, objectId: h.id, urls: h.urls })),
      ...draft.regionForbiddenSources.map((r) => ({ file: "regions.json" as const, objectId: r.id, urls: r.urls })),
    ],
    cfg,
    radiusNm: consolidation.importance.radiusNm,
    warnings: buildWarnings({
      spots: draft.spots.map((s) => ({ id: s.body.id, warnings: s.warnings })),
      omittedSpots: draft.omittedSpots,
      mergedNotCarried: notCarried,
      droppedHighlights: draft.droppedHighlights,
      droppedRegions: draft.droppedRegions,
      droppedWeatherPoints: weather.dropped,
      undeliveredSafety: undeliveredSafety(draft.deliveredRegions, draft.scope.passages),
      militaryAreaSpots: spotsInMilitaryAreas(files["spots.json"].spots, coast),
    }),
  });
  return { previous, pkg, report, objects, removed, unchanged, dataVersion };
}

/** The manifest (Teil B): subdivision, touching areas, versions, tiles, counts, licences from the configuration, and every other file's hash. */
function buildManifest(
  scope: SubdivisionScope,
  files: DeliveryPackage["files"],
  o: { dataVersion: number; previousDataVersion: number | null; generatedAt: string; cfg: DeliveryConfig },
): Manifest {
  const listed = CONTRACT_FILES.filter((f): f is Exclude<ContractFile, "manifest.json"> => f !== "manifest.json" && files[f as keyof typeof files] !== undefined);
  return {
    schemaVersion: SCHEMA_VERSION,
    subdivision: {
      id: scope.subdivision.publicId,
      key: scope.subdivision.key,
      name: scope.subdivision.name,
      names: scope.subdivision.names,
      // 2D positions with 5 decimals from ST_AsGeoJSON (loader)
      polygon: scope.subdivision.polygon as Manifest["subdivision"]["polygon"],
    },
    areas: scope.areas.map((a) => ({ id: a.publicId, key: a.key, names: a.names })),
    dataVersion: o.dataVersion,
    previousDataVersion: o.previousDataVersion,
    generatedAt: o.generatedAt,
    bbox: scope.subdivision.bbox,
    tiles: scope.tiles.map((t) => ({ id: t.id, lastRunAt: t.lastRunAt, profilesAsOf: t.profilesAsOf })),
    objectCounts: {
      spots: files["spots.json"].spots.length,
      highlights: files["highlights.json"].highlights.length,
      regions: files["regions.json"].regions.length,
      weatherPoints: files["weather-points.json"].points.length,
      coastFeatures: files["coast.geojson"].features.length,
      changes: files["changes.json"]?.changes.length ?? 0,
    },
    licenses: o.cfg.licenses.map((l) => ({ name: l.name, attribution: l.attribution, url: l.url, files: [...l.files], fields: [...l.fields] })),
    files: listed.map((name) => {
      const bytes = serializeFile(files[name]);
      return { name, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    }),
  };
}

/**
 * Builds and records the package of one subdivision in one transaction under the subdivision lock
 * (`pg_advisory_xact_lock(hashtext('delivery:' || subdivisionId))`, waiting at most `build.lockTimeoutMs`), so two
 * builds of a subdivision never make two data versions. Pass the pool handle: all reads come from one snapshot (ruling M6-D-R3), a
 * REPEATABLE READ read-only transaction opened after the lock (`openBuildSnapshot`), whose snapshot is stored as
 * `change_snapshot`. A build therefore holds two pool connections (the lock transaction and the read one); keep the
 * `delivery.build` concurrency of all workers well below the pool size (docs/runbook.md, "Pakete bauen"). A caller's
 * transaction only with the test option `inCallerTransaction`. The package is validated before it counts as
 * unchanged: a failing check rejects it even when its content equals the previous package. Then the uploads, the
 * `deliveries` row and its contract versions (ruling M6-P16); the commit is the commit point, so a failed commit
 * leaves files without a row, and the retry writes the same keys.
 */
export async function buildDelivery(db: Db, archive: Archive, subdivisionId: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const cfg = opts.cfg ?? getConfig().delivery;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const generatedAt = now.toISOString();
  // known before the files are stored: a rejected package lies under its delivery id
  const deliveryId = newId();
  const inCallerTransaction = db instanceof PgTransaction;
  if (inCallerTransaction !== (opts.inCallerTransaction === true)) {
    throw new Error(
      inCallerTransaction
        ? "buildDelivery needs the pool handle: a caller's transaction breaks the one-snapshot build (test option inCallerTransaction)"
        : "inCallerTransaction needs a transaction handle",
    );
  }

  return db.transaction(async (wtx) => {
    // a build waiting for the lock holds this connection: give up after `build.lockTimeoutMs`, the job is retried
    const { rows } = await wtx.execute<{ previous: string }>(
      sql`select current_setting('lock_timeout') as previous, set_config('lock_timeout', ${`${cfg.build.lockTimeoutMs}ms`}, true)`,
    );
    await wtx.execute(sql`select pg_advisory_xact_lock(hashtext(${`delivery:${subdivisionId}`}))`);
    await wtx.execute(sql`select set_config('lock_timeout', ${rows[0]!.previous}, true)`);
    const read = async (tx: Db, snapshot: BuildSnapshot) => {
      await opts.afterSnapshot?.(tx);
      return assemble(tx, snapshot, { archive, subdivisionId, today, generatedAt, cfg, scopeTransform: opts.scopeTransform });
    };
    const { snapshot, result: a } = inCallerTransaction
      ? await (async () => {
          const snapshot = await currentSnapshot(wtx);
          return { snapshot, result: await read(wtx, snapshot) };
        })()
      : await openBuildSnapshot(db, read);

    // validation first: content that has not changed but now fails a check is rejected, not silently unchanged
    const status: DeliveryStatus = !a.report.ok ? "rejected" : a.unchanged ? "unchanged" : "valid";
    const row = {
      id: deliveryId,
      subdivisionId,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      status,
      objectCounts: a.pkg.manifest.objectCounts,
      bbox: a.pkg.manifest.bbox,
      validationReport: a.report,
      previousDeliveryId: a.previous?.delivery.id ?? null,
      changeSnapshot: snapshot.snapshot,
      changeXmin: snapshot.xmin,
      runId: opts.runId ?? null,
      triggeredBy: opts.triggeredBy ?? null,
    };

    if (status === "unchanged") {
      await wtx.insert(deliveries).values({ ...row, dataVersion: null, storagePrefix: null });
    } else {
      const key = a.pkg.manifest.subdivision.key;
      const storagePrefix = status === "valid" ? `deliveries/${key}/${a.dataVersion}/` : `deliveries/${key}/rejected/${deliveryId}/`;
      const fileHashes: Record<string, { sha256: string; bytes: number }> = {};
      const stored: Array<[ContractFile, unknown]> = [
        ["manifest.json", a.pkg.manifest],
        ...(Object.entries(a.pkg.files) as Array<[ContractFile, unknown]>),
      ];
      for (const [file, data] of stored) {
        const bytes = serializeFile(data);
        fileHashes[file] = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
        await archive.put(`${storagePrefix}${file}`, bytes, contentTypeOf(file));
      }
      await wtx.insert(deliveries).values({ ...row, dataVersion: status === "valid" ? a.dataVersion : null, storagePrefix, fileHashes });
      if (status === "valid") await recordVersions(wtx, subdivisionId, deliveryId, a, today);
    }
    await opts.beforeCommit?.();
    return { deliveryId, status, dataVersion: status === "valid" ? a.dataVersion : null, report: a.report };
  });
}

/** The contract versions the package introduced: created and updated objects, and the removed ones (`removed`). */
async function recordVersions(tx: Db, subdivisionId: string, deliveryId: string, a: Assembly, today: string): Promise<void> {
  const rows = [
    ...a.objects
      .filter((o) => o.status !== "same")
      .map((o) => ({
        subdivisionId,
        objectType: o.type,
        publicId: o.id,
        geoObjectId: o.geoObjectId,
        profileVersion: o.profileVersion,
        contentHash: o.contentHash,
        validFrom: o.validFrom,
        removed: false,
        firstDeliveryId: deliveryId,
      })),
    ...a.removed.map((r) => ({
      subdivisionId,
      objectType: r.type,
      publicId: r.id,
      geoObjectId: r.geoObjectId,
      profileVersion: r.profileVersion,
      contentHash: "removed",
      validFrom: today,
      removed: true,
      firstDeliveryId: deliveryId,
    })),
  ];
  if (rows.length > 0) await tx.insert(deliveredObjects).values(rows);
}

import { and, desc, eq, sql, type InferSelectModel } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_FILES, SCHEMA_VERSION, type ContractFile, type Manifest, type Region, type Spot, type SpotBody } from "@/contract";
import { getConfig } from "@/lib/config";
import type { DeliveryConfig, ImagesConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { deliveredObjects, deliveries, type DeliveryStatus } from "@/lib/db/schema/deliveries";
import { findArchiveCopies } from "@/lib/domain/documents/archive-copies";
import { newId } from "@/lib/domain/ids";
import { imageAttributionTexts } from "@/lib/domain/images/delivery-gate";
import { buildCoast } from "./coast";
import { draftSubdivision, type SubdivisionDraft } from "./draft";
import type { ImageFile } from "./map-image";
import { manifestSubdivision } from "./read";
import { contentDigest, contentTypeOf, serializeFile, sha256Hex } from "./serialize";
import { currentSnapshot, openBuildSnapshot } from "./snapshot";
import type { DeliveryPackage, SubdivisionScope } from "./types";
import { undeliveredSafety } from "./map-region";
import { buildWarnings, spotsInMilitaryAreas, validatePackage, type ValidationReport } from "./validate";
import { assignVersions, latestDelivered, type ObjectDraft, type RemovedObject, type VersionedObject } from "./versioning";
import { buildWeatherPoints } from "./weather-points";

/*
 * Builds one subdivision's package (spec 08 "Paket", spec 14 "Paket je Landesteil", contract 4.0: spots from berth
 * states, regions, weather points, coast; no highlights, no change feed): reads everything from one snapshot, maps,
 * versions, validates, stores the files in S3 and writes the `deliveries` row with the object versions it introduced. A valid package with a change gets the next data version under
 * `deliveries/<subdivision-key>/<dataVersion>/`; a rejected one is stored for diagnosis under
 * `deliveries/<subdivision-key>/rejected/<deliveryId>/` without a data version (also when its content equals the
 * previous package); a valid build without any change is recorded as `unchanged` and stores nothing.
 */

export type DeliveryRow = InferSelectModel<typeof deliveries>;

/** The subdivision's latest valid package as stored: its row, its objects by id and the contents of coast and weather points. */
export type PreviousPackage = {
  delivery: DeliveryRow;
  /** The spots and regions of the stored package; empty for a package of another contract version (its objects have other shapes). */
  spots: Map<string, Spot>;
  regions: Map<string, Region>;
  /** sha256 per stored file (`deliveries.file_hashes`). */
  fileHashes: Record<string, string>;
  /** `contentDigest` of the coast features and of the weather points (ruling M6-P12). */
  coastDigest: string;
  weatherDigest: string;
};

export type BuildOptions = {
  runId?: string;
  /** The build time: `generatedAt`, and its UTC date is the build date (validity, popularity, the date of a new object version). */
  now?: Date;
  triggeredBy?: string;
  cfg?: DeliveryConfig;
  /** The images configuration: which sources' images are delivered (`images.delivery`), the source attributions. */
  imagesCfg?: ImagesConfig;
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
  // a package of an older contract version never counts as the base of this one (objects carry other fields)
  const sameContract = delivery.schemaVersion === SCHEMA_VERSION;
  const spots = sameContract ? await read<{ spots: Spot[] }>("spots.json") : { spots: [] };
  const regions = sameContract ? await read<{ regions: Region[] }>("regions.json") : { regions: [] };
  const coast = await read<{ features: unknown[] }>("coast.geojson");
  const weather = await read<{ points: unknown[] }>("weather-points.json");
  return {
    delivery,
    spots: new Map(spots.spots.map((s) => [s.id, s])),
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
  /** The delivered image files and their bytes, by package file name. */
  imageBytes: Map<string, Uint8Array>;
};

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The spot as the file carries it: the body with `asOf` in its schema position (before the free parts). */
function withAsOf(body: SpotBody, asOf: string | null): Spot {
  const { gaps, facts, landingPoints, nearby, ...head } = body;
  return { ...head, asOf, gaps, facts, landingPoints, nearby };
}

/**
 * Merged places of the previous package (ruling M6-P14): carried with their last content and `mergedInto` = the final
 * target when the target is delivered in this package (a region no longer delivered dropped), otherwise left out, so
 * they are removed, with a warning.
 */
function carryMerged(
  draft: SubdivisionDraft,
  previous: PreviousPackage | null,
): { carried: Array<{ body: SpotBody; asOf: string | null }>; notCarried: Array<{ id: string; into: string }> } {
  const carried: Array<{ body: SpotBody; asOf: string | null }> = [];
  const notCarried: Array<{ id: string; into: string }> = [];
  if (!previous) return { carried, notCarried };
  const spotIds = new Set(draft.spots.map((s) => s.body.id));
  const regionIds = new Set(draft.regions.map((r) => r.body.id));
  for (const m of draft.scope.merged) {
    const last = previous.spots.get(m.publicId);
    if (!last) continue;
    if (!spotIds.has(m.mergedIntoPublicId)) {
      notCarried.push({ id: m.publicId, into: m.mergedIntoPublicId });
      continue;
    }
    const { asOf, ...body } = last;
    // a merged spot has no images of its own, and the package holds no file for it
    delete body.images;
    carried.push({
      body: {
        ...body,
        ...(body.regionId != null && !regionIds.has(body.regionId) ? { regionId: null } : {}),
        mergedInto: m.mergedIntoPublicId,
      },
      asOf,
    });
  }
  return { carried, notCarried };
}

/** Reads and assembles the package from one snapshot and validates it (no write). */
async function assemble(
  tx: Db,
  input: {
    archive: Archive;
    subdivisionId: string;
    today: string;
    generatedAt: string;
    cfg: DeliveryConfig;
    imagesCfg: ImagesConfig;
    scopeTransform?: (s: SubdivisionScope) => SubdivisionScope },
): Promise<Assembly> {
  const { cfg, imagesCfg, today } = input;
  const previous = await previousPackage(tx, input.archive, input.subdivisionId);
  const draft = await draftSubdivision(tx, input.subdivisionId, today, {
    cfg,
    images: imagesCfg,
    scopeTransform: input.scopeTransform,
  });
  const imageBytes = await readImageFiles(input.archive, draft.imageFiles);
  const latest = await latestDelivered(tx, input.subdivisionId);
  const { carried, notCarried } = carryMerged(draft, previous);

  const drafts: ObjectDraft[] = [
    ...draft.spots.map((s): ObjectDraft => ({ type: "spot", id: s.body.id, geoObjectId: s.geoObjectId, body: s.body })),
    ...carried.map(({ body }): ObjectDraft => ({ type: "spot", id: body.id, geoObjectId: latest.get(body.id)?.geoObjectId ?? null, body })),
    ...draft.regions.map((r): ObjectDraft => ({ type: "region", id: r.body.id, geoObjectId: r.geoObjectId, body: r.body })),
  ];
  const { objects, removed } = assignVersions(drafts, latest, today);
  const asOfBySpot = new Map<string, string | null>([...draft.spots.map((s): [string, string | null] => [s.body.id, s.asOf]), ...carried.map((c): [string, string | null] => [c.body.id, c.asOf])]);

  const coast = await buildCoast(tx, { bbox: draft.scope.subdivision.bbox, cfg: cfg.coast, asOf: today });
  const weather = await buildWeatherPoints(tx, {
    regions: draft.deliveredRegions,
    passages: draft.scope.passages,
    regionIdFor: draft.regionIdFor,
    cfg: cfg.weather,
  });

  const unchanged =
    previous !== null &&
    // a new contract version always makes a new package, even for unchanged content
    previous.delivery.schemaVersion === SCHEMA_VERSION &&
    removed.length === 0 &&
    objects.every((o) => o.status === "same") &&
    contentDigest(coast.features) === previous.coastDigest &&
    contentDigest(weather.points) === previous.weatherDigest &&
    // an image's bytes may change while its object does not (a new picture for the same slot)
    [...imageBytes].every(([file, bytes]) => previous.fileHashes[file] === sha256Hex(bytes));
  const previousVersion = previous?.delivery.dataVersion ?? null;
  const dataVersion = (previousVersion ?? 0) + 1;

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    scope: { type: "subdivision", id: draft.scope.subdivision.publicId, dataVersion },
    generatedAt: input.generatedAt,
  } as const;
  const bodies = (type: VersionedObject["type"]) =>
    objects
      .filter((o) => o.type === type)
      .map((o) => o.body)
      .sort(byId);
  const files: DeliveryPackage["files"] = {
    "spots.json": { ...envelope, spots: (bodies("spot") as SpotBody[]).map((b) => withAsOf(b, asOfBySpot.get(b.id) ?? null)) },
    "regions.json": { ...envelope, regions: bodies("region") as Region[] },
    "coast.geojson": coast,
    "weather-points.json": { ...envelope, points: weather.points },
  };
  const manifest = buildManifest(draft.scope, files, imageBytes, { dataVersion, previousDataVersion: previousVersion, generatedAt: input.generatedAt, cfg });
  const pkg: DeliveryPackage = { manifest, files };

  const report = await validatePackage(pkg, {
    previous: previous ? { dataVersion: previousVersion! } : null,
    findCopies: async (text) => (await findArchiveCopies(tx, text)).longestRun,
    cfg,
    imageAttribution: imageAttributionTexts(imagesCfg),
    warnings: buildWarnings({
      spots: draft.spots.map((s) => ({ id: s.body.id, warnings: s.warnings })),
      omittedSpots: draft.omittedSpots,
      mergedNotCarried: notCarried,
      droppedRegions: draft.droppedRegions,
      droppedWeatherPoints: weather.dropped,
      undeliveredSafety: undeliveredSafety(draft.deliveredRegions, draft.scope.passages),
      militaryAreaSpots: spotsInMilitaryAreas(files["spots.json"].spots, coast),
    }),
  });
  return { previous, pkg, report, objects, removed, unchanged, dataVersion, imageBytes };
}

/** The bytes of the images the package delivers, by package file name; an image missing in the archive fails the build (retried). */
async function readImageFiles(archive: Archive, files: ImageFile[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const { file, fileKey } of files) {
    const bytes = await archive.get(fileKey);
    if (bytes === null) throw new Error(`image ${fileKey} of ${file} is missing in the archive`);
    out.set(file, bytes);
  }
  return out;
}

/** The manifest (Teil B): subdivision, touching areas, versions, tiles, counts, licences from the configuration, and every other file's hash. */
function buildManifest(
  scope: SubdivisionScope,
  files: DeliveryPackage["files"],
  imageBytes: Map<string, Uint8Array>,
  o: { dataVersion: number; previousDataVersion: number | null; generatedAt: string; cfg: DeliveryConfig },
): Manifest {
  const listed = CONTRACT_FILES.filter((f): f is Exclude<ContractFile, "manifest.json"> => f !== "manifest.json" && files[f as keyof typeof files] !== undefined);
  return {
    schemaVersion: SCHEMA_VERSION,
    scope: {
      type: "subdivision",
      subdivision: {
        id: scope.subdivision.publicId,
        key: scope.subdivision.key,
        name: scope.subdivision.name,
        names: scope.subdivision.names,
        // 2D positions with 5 decimals from ST_AsGeoJSON (loader)
        polygon: scope.subdivision.polygon as Extract<Manifest["scope"], { type: "subdivision" }>["subdivision"]["polygon"],
      },
      dataVersion: o.dataVersion,
      previousDataVersion: o.previousDataVersion,
    },
    coverage: [{ id: scope.subdivision.publicId, key: scope.subdivision.key, name: scope.subdivision.name, status: "delivered", dataVersion: o.dataVersion }],
    areas: scope.areas.map((a) => ({ id: a.publicId, key: a.key, names: a.names })),
    generatedAt: o.generatedAt,
    bbox: scope.subdivision.bbox,
    tiles: scope.tiles.map((t) => ({ id: t.id, lastRunAt: t.lastRunAt, statesAsOf: t.statesAsOf })),
    objectCounts: {
      spots: files["spots.json"].spots.length,
      regions: files["regions.json"].regions.length,
      weatherPoints: files["weather-points.json"].points.length,
      coastFeatures: files["coast.geojson"].features.length,
    },
    licenses: o.cfg.licenses.map((l) => ({ name: l.name, attribution: l.attribution, url: l.url, files: [...l.files], fields: [...l.fields] })),
    files: [
      ...listed.map((name) => {
        const bytes = serializeFile(files[name]);
        return { name, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
      }),
      ...[...imageBytes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => ({ name, sha256: sha256Hex(bytes), bytes: bytes.byteLength })),
    ],
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
  const imagesCfg = opts.imagesCfg ?? getConfig().images;
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
    const read = async (tx: Db) => {
      await opts.afterSnapshot?.(tx);
      return assemble(tx, { archive, subdivisionId, today, generatedAt, cfg, imagesCfg, scopeTransform: opts.scopeTransform });
    };
    const { snapshot, result: a } = inCallerTransaction
      ? await (async () => {
          const snapshot = await currentSnapshot(wtx);
          return { snapshot, result: await read(wtx) };
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
      const key = manifestSubdivision(a.pkg.manifest)!.key;
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
      for (const [file, bytes] of a.imageBytes) {
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

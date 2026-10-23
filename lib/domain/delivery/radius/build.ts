import { eq, sql, type InferSelectModel } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_FILES, CONTRACT_SCHEMAS, SCHEMA_VERSION, type ContractFile, type CoverageEntry, type Manifest } from "@/contract";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { radiusPackageRequests, radiusPackages } from "@/lib/db/schema/radius";
import { contentTypeOf, serializeFile, sha256Hex } from "../serialize";
import { clipCoast } from "./coast";
import { composeRadiusPackage } from "./compose";
import { circlePolygon, radiusNm } from "./geometry";
import { loadSourcePackage, radiusCoverage, resolveHomeMarina } from "./load";
import type { ComposedRadius } from "./types";

/*
 * Radius packages built on request and cached (spec 18, "Bau auf Anfrage mit Zwischenspeicher"): a package is fixed by
 * marina, days, radius, contract version and the data version of every touched subdivision (missing ones included),
 * so those make its key. The first request for a key builds it under `pg_advisory_xact_lock(hashtext('radius:' ||
 * key))`, stores its files under `deliveries/radius/<marina>/<days>/<key>/` and writes the `radius_packages` row;
 * every later request reads that row. Every file is checked against its contract schema and the package's references
 * before the row is written: a failing check throws, no package is stored silently.
 */

export type RadiusPackageRow = InferSelectModel<typeof radiusPackages>;
export type RadiusRequestKind = "package" | "file" | "changes";

type FileHashes = Record<string, { sha256: string; bytes: number }>;

/**
 * The cache key: the first 16 hex characters of the sha256 over `marina|days|radiusNm|schemaVersion|` and the coverage
 * sorted by key, each entry `id:dataVersion` (`id:missing` for a missing subdivision), joined by `|`.
 */
export function radiusPackageKey(input: { marina: string; days: number; radiusNm: number; coverage: CoverageEntry[]; schemaVersion: string }): string {
  const coverage = [...input.coverage]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((c) => `${c.id}:${c.dataVersion ?? "missing"}`)
    .join("|");
  const text = `${input.marina}|${input.days}|${input.radiusNm}|${input.schemaVersion}|${coverage}`;
  return sha256Hex(new TextEncoder().encode(text)).slice(0, 16);
}

export async function radiusPackageByKey(db: Db, key: string): Promise<RadiusPackageRow | null> {
  const [row] = await db.select().from(radiusPackages).where(eq(radiusPackages.key, key)).limit(1);
  return row ?? null;
}

/**
 * The radius package for a home marina and a trip of `days` days, built on the first request for its key: the stored
 * row, `"invalid_days"` for days outside `radius.minDays…maxDays` (or not an integer), `"marina_not_found"` for a spot
 * that is no delivered marina in its subdivision's current package. Records one `radius_package_requests` row.
 */
export async function getRadiusPackage(
  db: Db,
  archive: Archive,
  req: { marina: string; days: number; apiClientId?: string; kind?: RadiusRequestKind; now?: Date },
): Promise<RadiusPackageRow | "marina_not_found" | "invalid_days"> {
  const cfg = getConfig().delivery;
  let r: number;
  try {
    r = radiusNm(req.days, cfg.radius);
  } catch (e) {
    if (e instanceof RangeError) return "invalid_days";
    throw e;
  }
  const home = await resolveHomeMarina(db, archive, req.marina);
  if (!home) return "marina_not_found";
  const circle = circlePolygon(home.spot.position, r);
  const coverage = await radiusCoverage(db, circle);
  // the marina's subdivision is always touched; without its package the marina is not delivered
  if (!coverage.delivered.some((d) => d.subdivisionId === home.subdivisionId)) return "marina_not_found";
  const entries = [...coverage.delivered.map((d) => d.entry), ...coverage.missing];
  const key = radiusPackageKey({ marina: req.marina, days: req.days, radiusNm: r, coverage: entries, schemaVersion: SCHEMA_VERSION });

  const row =
    (await radiusPackageByKey(db, key)) ??
    (await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`radius:${key}`}))`);
      // a concurrent request may have built it while this one waited for the lock
      const built = await radiusPackageByKey(tx, key);
      if (built) return built;
      const now = req.now ?? new Date();
      const prefix = `deliveries/radius/${req.marina}/${req.days}/${key}/`;
      const packages = (
        await Promise.all(coverage.delivered.map((d) => loadSourcePackage(tx, archive, d.subdivisionId, d.entry)))
      ).sort((a, b) => (a.coverage.key < b.coverage.key ? -1 : a.coverage.key > b.coverage.key ? 1 : 0));
      const composed = composeRadiusPackage(
        {
          key,
          homeMarina: home.spot,
          days: req.days,
          radiusNm: r,
          generatedAt: now.toISOString(),
          packages,
          missing: coverage.missing,
          missingTiles: coverage.missingTiles,
        },
        cfg,
      );
      const coast = await clipCoast(tx, packages.map((p) => p.coast), circle, cfg.coast.marginNm, cfg.coast.simplifyToleranceM);
      const files = { ...composed.files, "coast.geojson": coast };

      // the images, copied byte for byte from the subdivision package their object's version came from
      const images = new Map<string, Uint8Array>();
      for (const image of composed.imageFiles) {
        const from = packages.find((p) => p.imageFiles.some((f) => f.name === image.name && f.sha256 === image.sha256));
        const bytes = from ? await archive.get(`${from.prefix}${image.name}`) : null;
        if (bytes === null) throw new Error(`image ${image.name} of radius package ${key} is missing in its subdivision package`);
        if (sha256Hex(bytes) !== image.sha256) throw new Error(`image ${image.name} of radius package ${key} does not match its hash`);
        images.set(image.name, bytes);
      }

      const manifest = radiusManifest(composed, files, images);
      checkPackage(key, manifest, files);

      const fileHashes: FileHashes = {};
      const stored: Array<[string, Uint8Array]> = [
        ["manifest.json", serializeFile(manifest)],
        ...Object.entries(files).map(([name, data]): [string, Uint8Array] => [name, serializeFile(data)]),
        ...images,
      ];
      for (const [name, bytes] of stored) {
        fileHashes[name] = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
        await archive.put(`${prefix}${name}`, bytes, contentTypeOf(name));
      }
      const [inserted] = await tx
        .insert(radiusPackages)
        .values({
          key,
          homeMarinaPublicId: req.marina,
          days: req.days,
          radiusNm: r,
          coverage: manifest.coverage,
          schemaVersion: SCHEMA_VERSION,
          generatedAt: now,
          storagePrefix: prefix,
          fileHashes,
          objectCounts: manifest.objectCounts,
          warnings: composed.warnings,
        })
        .returning();
      return inserted!;
    }));
  await db.insert(radiusPackageRequests).values({ radiusPackageId: row.id, apiClientId: req.apiClientId ?? null, kind: req.kind ?? "package" });
  return row;
}

type RadiusFiles = ComposedRadius["files"] & { "coast.geojson": Awaited<ReturnType<typeof clipCoast>> };

/** The full manifest: the composed draft with the object counts (no changes) and every file's hash, in contract order, then the images. */
function radiusManifest(composed: ComposedRadius, files: RadiusFiles, images: Map<string, Uint8Array>): Manifest {
  const d = composed.manifestDraft;
  const listed = CONTRACT_FILES.filter((f): f is keyof RadiusFiles => Object.hasOwn(files, f));
  return {
    schemaVersion: d.schemaVersion,
    scope: d.scope,
    coverage: d.coverage,
    areas: d.areas,
    generatedAt: d.generatedAt,
    bbox: d.bbox,
    tiles: d.tiles,
    objectCounts: {
      spots: files["spots.json"].spots.length,
      highlights: files["highlights.json"].highlights.length,
      regions: files["regions.json"].regions.length,
      weatherPoints: files["weather-points.json"].points.length,
      coastFeatures: files["coast.geojson"].features.length,
      changes: 0,
    },
    licenses: d.licenses,
    files: [
      ...listed.map((name) => {
        const bytes = serializeFile(files[name]);
        return { name, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
      }),
      ...[...images].map(([name, bytes]) => ({ name, sha256: sha256Hex(bytes), bytes: bytes.byteLength })),
    ],
  };
}

/**
 * Every file against its contract schema, and every reference inside the package (spec 08 Teil B): each `spotIds` entry
 * of a highlight or region and each `mergedInto` of a spot names an included spot, each `highlightIds` entry of a spot an
 * included highlight, each `regionId` of a spot, highlight or weather point and each `parentId` of a region an included
 * region. Throws on the first failing file or the list of broken references.
 */
function checkPackage(key: string, manifest: Manifest, files: RadiusFiles): void {
  const all: Array<[ContractFile, unknown]> = [["manifest.json", manifest], ...(Object.entries(files) as Array<[ContractFile, unknown]>)];
  for (const [file, data] of all) {
    const parsed = CONTRACT_SCHEMAS[file].safeParse(data);
    if (!parsed.success) {
      throw new Error(`radius package ${key}: ${file} fails its schema: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
    }
  }
  const spotIds = new Set(files["spots.json"].spots.map((s) => s.id));
  const highlightIds = new Set(files["highlights.json"].highlights.map((h) => h.id));
  const regionIds = new Set(files["regions.json"].regions.map((r) => r.id));
  const broken: string[] = [];
  const region = (owner: string, id: string | null | undefined) => {
    if (id != null && !regionIds.has(id)) broken.push(`${owner} → ${id}`);
  };
  const spots = (owner: string, ids: string[]) => ids.forEach((id) => spotIds.has(id) || broken.push(`${owner} → ${id}`));
  for (const s of files["spots.json"].spots) {
    region(s.id, s.regionId);
    (s.highlightIds ?? []).forEach((id) => highlightIds.has(id) || broken.push(`${s.id} → ${id}`));
    if (s.mergedInto != null && !spotIds.has(s.mergedInto)) broken.push(`${s.id} → ${s.mergedInto}`);
  }
  for (const h of files["highlights.json"].highlights) {
    spots(h.id, h.spotIds);
    region(h.id, h.regionId);
  }
  for (const r of files["regions.json"].regions) {
    spots(r.id, r.spotIds);
    region(r.id, r.parentId);
  }
  for (const p of files["weather-points.json"].points) region(p.id, p.regionId);
  if (broken.length > 0) throw new Error(`radius package ${key}: references outside the package: ${broken.join(", ")}`);
}

/**
 * The stored bytes of one file of a radius package; null for a file the package does not list. A missing object or
 * bytes that do not match the recorded sha256 throw (as `readStoredFile`).
 */
export async function readRadiusFile(archive: Archive, row: RadiusPackageRow, file: string): Promise<Uint8Array | null> {
  if (!Object.hasOwn(row.fileHashes, file)) return null;
  const key = `${row.storagePrefix}${file}`;
  const bytes = await archive.get(key);
  if (bytes === null) throw new Error(`radius package file ${key} is missing`);
  if (sha256Hex(bytes) !== row.fileHashes[file]!.sha256) throw new Error(`radius package file ${key} does not match its hash`);
  return bytes;
}

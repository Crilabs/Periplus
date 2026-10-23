import type { Manifest } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { radiusPackageByKey, readRadiusFile, recordRadiusRequest, type RadiusPackageRow } from "./build";

/*
 * What the radius routes answer (spec 18, spec 14): the manifest with links and one stored file pinned to a package key.
 */

export type RadiusRef = { marina: string; days: number };

/** The trip length of a query value: the number, `NaN` for a missing or non-numeric one (`getRadiusPackage` rejects it as `invalid_days`). */
export function parseDays(value: string | null): number {
  return value === null || value.trim() === "" ? Number.NaN : Number(value);
}

/** File name → API URL, pinned to the package `key`. */
export function radiusLinks(row: RadiusPackageRow): Record<string, string> {
  const query = `marina=${encodeURIComponent(row.homeMarinaPublicId)}&days=${row.days}&key=${row.key}`;
  return Object.fromEntries(Object.keys(row.fileHashes).sort().map((f) => [f, `/api/v3/radius/package/${f}?${query}`]));
}

export async function radiusManifest(archive: Archive, row: RadiusPackageRow): Promise<Manifest & { links: Record<string, string> }> {
  const bytes = await readRadiusFile(archive, row, "manifest.json");
  if (bytes === null) throw new Error(`radius package ${row.key} has no manifest.json`);
  return { ...(JSON.parse(new TextDecoder().decode(bytes)) as Manifest), links: radiusLinks(row) };
}

/**
 * One file of the package `key` for `marina` and `days`: `invalid_key` when the key is missing or belongs to another
 * marina or trip length, null for a file the package does not list. The package is the pinned one, never rebuilt or
 * replaced by the current one; records the request on it as kind `file`.
 */
export async function radiusFile(
  db: Db,
  archive: Archive,
  req: RadiusRef & { key: string | null; file: string; apiClientId?: string },
): Promise<{ bytes: Uint8Array; sha256: string; schemaVersion: string } | "invalid_key" | null> {
  const pinned = req.key ? await radiusPackageByKey(db, req.key) : null;
  if (!pinned || pinned.homeMarinaPublicId !== req.marina || pinned.days !== req.days) return "invalid_key";
  const bytes = await readRadiusFile(archive, pinned, req.file);
  if (bytes === null) return null;
  await recordRadiusRequest(db, pinned.id, req.apiClientId, "file");
  return { bytes, sha256: pinned.fileHashes[req.file]!.sha256, schemaVersion: pinned.schemaVersion };
}

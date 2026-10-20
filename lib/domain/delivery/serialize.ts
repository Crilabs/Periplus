import { createHash } from "node:crypto";

/*
 * How a package file is written (spec 08): pure, no database, no S3 (ruling M6-P18), so the API can serve the bytes
 * the build stored and hash them alike.
 */

/** A package file: `JSON.stringify(data, null, 2)` plus a newline, UTF-8. Objects keep their (schema) key order. */
export function serializeFile(data: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
}

/** sha256 hex of a file's bytes, as in the manifest and `deliveries.file_hashes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The content of `coast.geojson` (its features) or `weather-points.json` (its points) without the envelope fields, as
 * a hash (ruling M6-P12): an unchanged build compares contents, never file bytes that carry the version and date.
 */
export function contentDigest(list: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(list)), "utf8").digest("hex");
}

/** Keys sorted at every depth (as `canonicalJson`, kept here so this module imports nothing of the app). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeys(obj[k])]));
  }
  return v;
}

/** The content type a package file is stored and served with. */
export function contentTypeOf(file: string): string {
  if (file.endsWith(".jpg")) return "image/jpeg";
  return file.endsWith(".geojson") ? "application/geo+json" : "application/json";
}

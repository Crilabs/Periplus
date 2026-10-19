import { writeFileSync } from "node:fs";

/** Paths (`$.places.Perdika.swell`) of the values JSON cannot hold: NaN, ±Infinity and undefined. */
export function nonJsonValues(value: unknown, path = "$"): string[] {
  if (value === undefined) return [path];
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonJsonValues(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => nonJsonValues(v, `${path}.${k}`));
  }
  return [];
}

/**
 * Writes golden values (`UPDATE_GOLDEN=1`). Refused under CI — golden values are reviewed locally, never regenerated
 * by the pipeline that checks them — and for values JSON would store as null (a missing fact gives NaN or undefined).
 */
export function writeGoldenFile(file: string, values: unknown, env: Record<string, string | undefined> = process.env): void {
  if (env.CI) throw new Error("UPDATE_GOLDEN is refused under CI: regenerate the golden values locally and review the diff");
  const invalid = nonJsonValues(values);
  if (invalid.length > 0) throw new Error(`golden values without a value: ${invalid.join(", ")}`);
  writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { areaImportFileSchema } from "@/lib/config/schemas";

export type AreaFile = z.infer<typeof areaImportFileSchema>;
export type ImportedArea = AreaFile["areas"][number];

/** The country a file name `<CC>.json` stands for, null for any other name. */
const FILE_NAME = /^([A-Z]{2})\.json$/;

/**
 * Validates a bot delivery file; `source` (the file name) names it in the error. A file named `<CC>.json` must carry
 * `country` CC: its areas would otherwise be imported, and ended, under another country.
 */
export function parseAreaFile(json: unknown, source: string): AreaFile {
  const parsed = areaImportFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Ungültige Revier-Datei ${source}: ${issues}`);
  }
  const named = FILE_NAME.exec(basename(source))?.[1];
  if (named && parsed.data.country !== named) {
    throw new Error(`Ungültige Revier-Datei ${source}: country ${parsed.data.country}, der Dateiname nennt ${named}`);
  }
  return parsed.data;
}

function readAreaFile(dir: string, name: string): AreaFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch (error) {
    throw new Error(`Ungültige Revier-Datei ${name}: ${(error as Error).message}`, { cause: error });
  }
  return parseAreaFile(raw, name);
}

/**
 * All `*.json` files of `dir`, sorted by file name. Each must be named `<CC>.json` after its country, so a country
 * has exactly one file (`loadAreaFile` finds it without reading the others).
 */
export async function loadAreaFiles(dir = "config/area-imports"): Promise<AreaFile[]> {
  const names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const files: AreaFile[] = [];
  const countries = new Set<string>();
  for (const name of names) {
    if (!FILE_NAME.test(name)) throw new Error(`Ungültige Revier-Datei ${name}: der Name muss <Land>.json sein (z. B. GR.json)`);
    const file = readAreaFile(dir, name);
    if (countries.has(file.country)) throw new Error(`Ungültige Revier-Datei ${name}: zweite Datei für ${file.country}`);
    countries.add(file.country);
    files.push(file);
  }
  return files;
}

/** The file of `country` (`<country>.json` in `dir`), null when there is none. Other files are not read. */
export async function loadAreaFile(country: string, dir = "config/area-imports"): Promise<AreaFile | null> {
  const name = `${country}.json`;
  if (!FILE_NAME.test(name) || !existsSync(join(dir, name))) return null;
  return readAreaFile(dir, name);
}

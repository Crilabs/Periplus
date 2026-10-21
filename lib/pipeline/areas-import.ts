import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { loadAreaFile } from "@/lib/domain/areas/file";
import { importAllAreaFiles, importAreaFile, type AreaImportReport } from "@/lib/domain/areas/import";

/**
 * Stage `areas.import` of a subdivision build: re-imports the bot file of the subdivision's country so members waiting
 * on a later gazetteer resolve.
 */
export const AREA_IMPORT_STAGE = "areas.import";

/**
 * Imports, as of today, the bot file of `country` (`<country>.json`; none there: no report, other countries' files
 * are not read) or, without `country`, every file of `config/area-imports` (or `dir`); one report per file.
 */
export async function runAreaImport(
  db: Db,
  cfg: AppConfig,
  opts: { dir?: string; country?: string } = {},
): Promise<AreaImportReport[]> {
  const today = new Date().toISOString().slice(0, 10);
  if (opts.country === undefined) return importAllAreaFiles(db, cfg, today, opts.dir);
  const file = await loadAreaFile(opts.country, opts.dir);
  if (!file) return [];
  return [await db.transaction((tx) => importAreaFile(tx, file, cfg, today))];
}

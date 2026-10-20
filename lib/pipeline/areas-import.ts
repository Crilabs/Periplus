import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { importAllAreaFiles, type AreaImportReport } from "@/lib/domain/areas/import";

/** Stage `areas.import` of a subdivision build: re-imports the bot files so members waiting on a later gazetteer resolve. */
export const AREA_IMPORT_STAGE = "areas.import";

/** Imports every file of `config/area-imports` (or `dir`) as of today; one report per file. */
export async function runAreaImport(db: Db, cfg: AppConfig, dir?: string): Promise<AreaImportReport[]> {
  return importAllAreaFiles(db, cfg, new Date().toISOString().slice(0, 10), dir);
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, type AppConfig } from "../lib/config";
import { createDb, type Db } from "../lib/db/client";
import { parseAreaFile } from "../lib/domain/areas/file";
import { importAreaFile, importAllAreaFiles, type AreaImportReport } from "../lib/domain/areas/import";

// Starts the import of the Revier-Bot files from the IDE (spec 14, „Änderung 21.10.2026“):
//   npm run areas:import -- [--file config/area-imports/GR.json] [--dry-run]
// On the server: dc run --rm worker node --import tsx scripts/import-areas.ts

const USAGE = "usage: import-areas.ts [--file <file.json>] [--dry-run]";

export function parseArgs(argv: string[]): { file: string | null; dryRun: boolean } {
  let file: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--file" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) file = argv[++i]!;
    else throw new Error(USAGE);
  }
  return { file, dryRun };
}

export function formatReport(r: AreaImportReport): string[] {
  const list = (keys: string[]) => (keys.length > 0 ? ` (${keys.join(", ")})` : "");
  const lines = [
    `${r.country}: created ${r.created.length}${list(r.created)}, updated ${r.updated.length}${list(r.updated)}, unchanged ${r.unchanged.length}, ended ${r.ended.length}${list(r.ended)}`,
  ];
  for (const w of r.waiting) lines.push(`  waiting ${w.key}: ${w.resolved} resolved, unresolved: ${w.unresolved.join(", ") || "-"}`);
  for (const u of r.unknownSubdivisions) lines.push(`  unknown subdivision ${u.subdivision} in ${u.key}`);
  for (const c of r.conflicts) lines.push(`  conflict ${c.key}: area of ${c.otherCountry}, skipped`);
  return lines;
}

class DryRun extends Error {}

/** Imports the given file or all files of `dir`; `dryRun` rolls everything back. Returns the reports. */
export async function runImport(
  db: Db,
  args: { file: string | null; dryRun: boolean },
  cfg: AppConfig,
  today: string,
  dir?: string,
): Promise<AreaImportReport[]> {
  let reports: AreaImportReport[] = [];
  const work = async (tx: Db) => {
    if (args.file) {
      const file = parseAreaFile(JSON.parse(readFileSync(args.file, "utf8")), path.basename(args.file));
      reports = [await importAreaFile(tx, file, cfg, today)];
    } else {
      reports = await importAllAreaFiles(tx, cfg, today, dir);
    }
    if (args.dryRun) throw new DryRun();
  };
  try {
    await db.transaction(work);
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  return reports;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const reports = await runImport(db, args, getConfig(), today);
    for (const report of reports) for (const line of formatReport(report)) process.stdout.write(`${line}\n`);
    if (args.dryRun) process.stdout.write("dry run: nothing written\n");
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

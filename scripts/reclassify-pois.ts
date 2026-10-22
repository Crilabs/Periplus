import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { reclassifyPois } from "../lib/domain/gazetteer/poi-reclassify";

// Re-applies config/categories.json to the stored OSM POIs (spec 16 A):
//   npm run pois:reclassify -- [--dry-run]
// It starts nothing: afterwards the rollout reruns consolidation for the affected places.

const USAGE = "usage: reclassify-pois.ts [--dry-run]";

export function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else throw new Error(USAGE);
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const r = await reclassifyPois(db, getConfig().categories, args);
    process.stdout.write(`cleared ${r.cleared}, changed ${r.changed}, places to reconsolidate ${r.geoObjectIds.length}\n`);
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

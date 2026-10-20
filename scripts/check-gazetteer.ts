import path from "node:path";
import { fileURLToPath } from "node:url";
import { areaByKey } from "../lib/config";
import { createDb } from "../lib/db/client";
import { checkGazetteer } from "../lib/domain/acceptance/gazetteer";
import { areaBbox } from "../lib/domain/gazetteer/areas";

// The check itself lives in lib/domain (gesamt review UI-16); this file is its command line.

export * from "../lib/domain/acceptance/gazetteer";

const USAGE = "usage: check-gazetteer.ts --area <key>";

export function parseArgs(argv: string[]): { area: string } {
  if (argv.length !== 2 || argv[0] !== "--area" || argv[1].startsWith("--")) throw new Error(USAGE);
  return { area: argv[1] };
}

async function main(): Promise<void> {
  const { area: key } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const area = areaByKey(key);
  const { db, close } = createDb(url);
  try {
    const r = await checkGazetteer(db, area.tileBbox ?? areaBbox(area));
    process.stdout.write(`tiles with coast: ${r.tilesWithCoast}\n`);
    process.stdout.write(`open candidate tasks: ${r.openCandidateTasks}\n`);
    process.stdout.write(`objects without de/en/el names: ${r.missing.length}\n`);
    for (const m of r.missing) {
      process.stdout.write(`  ${m.type} ${m.name} [${m.id}] has: ${m.languages.join(",") || "-"}\n`);
    }
    if (r.missing.length > 0) process.exitCode = 1;
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

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../lib/db/client";
import { checkGeometry } from "../lib/domain/geometry/check";

const USAGE = "usage: check-geometry.ts --area <key>";

export function parseArgs(argv: string[]): { area: string } {
  if (argv.length !== 2 || argv[0] !== "--area" || argv[1].startsWith("--")) throw new Error(USAGE);
  return { area: argv[1] };
}

async function main(): Promise<void> {
  const { area } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const r = await checkGeometry(db, area);
    process.stdout.write(`places: ${r.places}\n`);
    process.stdout.write(`complete: ${r.complete}\n`);
    process.stdout.write(`depth gaps (counted as complete): ${r.depthGaps.length}\n`);
    for (const g of r.depthGaps) process.stdout.write(`  ${g.name} [${g.placeId}] ${g.reason}\n`);
    process.stdout.write(`places with missing values: ${r.missing.length}\n`);
    for (const m of r.missing) process.stdout.write(`  ${m.name} [${m.placeId}] missing: ${m.missing.join(", ")}\n`);
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

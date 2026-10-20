import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../lib/db/client";
import { checkProfiles, profileCheckFailures } from "../lib/domain/acceptance/profiles";
import type { FactLevel } from "../lib/domain/facts/schema-types";

// The check itself lives in lib/domain (gesamt review UI-16); this file is its command line.

export * from "../lib/domain/acceptance/profiles";

const USAGE = "usage: check-profiles.ts --area <key>";

export function parseArgs(argv: string[]): { area: string } {
  if (argv.length !== 2 || argv[0] !== "--area" || argv[1]!.startsWith("--")) throw new Error(USAGE);
  return { area: argv[1]! };
}

const LEVEL_WORDS: Record<FactLevel, string> = { place: "place", area: "area", island: "island", cape_strait: "cape/strait", poi: "poi" };

async function main(): Promise<void> {
  const { area } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    const r = await checkProfiles(db, area);
    out(`objects (confirmed places; areas, islands, capes/straits, POIs): ${r.objects}`);
    out(`with profile: ${r.withProfile}`);
    out(`without profile: ${r.missing.length}`);
    for (const m of r.missing) out(`  ${m.name ?? "(ohne Namen)"} [${m.geoObjectId}] ${LEVEL_WORDS[m.level]}`);
    out(`profiles with an attribute without provenance, rule or cited input: ${r.withoutProvenance.length}`);
    for (const id of r.withoutProvenance) out(`  ${id}`);
    out(`open conflicts: ${r.openConflicts}, open uncertain changes: ${r.openUncertain}`);
    out(`summaries of the newest versions: ok ${r.summaries.ok}, empty ${r.summaries.empty}`);
    out(`profile as of a date: ${r.asOfCheck ? "ok" : "FAILED"}`);
    const failures = profileCheckFailures(r);
    for (const f of failures) out(`FAIL: ${f}`);
    if (failures.length > 0) process.exitCode = 1;
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

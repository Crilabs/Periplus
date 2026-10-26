import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSnapshots, type PilotSnapshot } from "../lib/domain/subdivisions/migration";

// Compares the pilot snapshots before and after `migrate-subdivisions` (runbook „Umstellung auf Landesteile“): exit 0
// only if every pilot place and fact is unchanged. No database.

const USAGE = "usage: check-subdivision-migration.ts --before <a.json> --after <b.json>";

export function parseArgs(argv: string[]): { before: string; after: string } {
  if (argv.length !== 4 || argv[0] !== "--before" || argv[2] !== "--after" || argv[1]!.startsWith("--") || argv[3]!.startsWith("--")) {
    throw new Error(USAGE);
  }
  return { before: argv[1]!, after: argv[3]! };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as PilotSnapshot;
  const problems = compareSnapshots(read(args.before), read(args.after));
  for (const p of problems) process.stdout.write(`FAIL: ${p}\n`);
  if (problems.length > 0) process.exitCode = 1;
  else process.stdout.write("OK: Pilotkacheln unverändert (Orte, Facts)\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

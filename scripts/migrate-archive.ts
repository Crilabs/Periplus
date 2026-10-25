import path from "node:path";
import { fileURLToPath } from "node:url";
import { getArchive } from "../lib/adapters/s3";
import { createDb } from "../lib/db/client";
import { exportArchive, formatReport, importArchive } from "../lib/pipeline/archive-copy";

// Copies the archive between environments through a directory (see docs/runbook.md „Archiv übernehmen“).
// The logic lives in lib/pipeline/archive-copy.ts; this file is its command line.

export type Args = { command: "export" | "import"; dir: string; dryRun: boolean };

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "import") throw new Error(USAGE);
  const flag = command === "export" ? "--out" : "--in";
  let dir: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === flag) dir = rest[++i];
    else if (a === "--dry-run" && command === "import") dryRun = true;
    else throw new Error(USAGE);
  }
  if (!dir) throw new Error(USAGE);
  return { command, dir: path.resolve(dir), dryRun };
}

const USAGE = "usage: migrate-archive.ts export --out <dir> | import --in <dir> [--dry-run]";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  const log = (line: string) => process.stdout.write(line + "\n");
  try {
    const archive = getArchive();
    if (args.command === "export") {
      await exportArchive({ db, archive, dir: args.dir, log });
    } else {
      if (!args.dryRun) await archive.ensureBucket();
      const report = await importArchive({ db, archive, dir: args.dir, dryRun: args.dryRun, log });
      log(formatReport(report));
      if (report.objectErrors.length > 0) process.exitCode = 1;
    }
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

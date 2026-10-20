import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../lib/db/client";
import { migrateSubdivisions, snapshotPilot } from "../lib/domain/subdivisions/migration";

// The migration itself lives in lib/domain/subdivisions/migration.ts; this file is its command line (runbook
// „Umstellung auf Landesteile“): `snapshot --out <file>` before and after, `migrate` in between.

const USAGE = "usage: migrate-subdivisions.ts snapshot --out <file.json> | migrate";

export function parseArgs(argv: string[]): { command: "snapshot"; out: string } | { command: "migrate" } {
  if (argv.length === 1 && argv[0] === "migrate") return { command: "migrate" };
  if (argv.length === 3 && argv[0] === "snapshot" && argv[1] === "--out" && !argv[2]!.startsWith("--")) return { command: "snapshot", out: argv[2]! };
  throw new Error(USAGE);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    if (args.command === "snapshot") {
      const snapshot = await snapshotPilot(db);
      writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`);
      out(`pilot tiles: ${snapshot.tiles.length}, places: ${snapshot.tiles.reduce((n, t) => n + t.places.length, 0)} → ${args.out}`);
    } else {
      const r = await db.transaction((tx) => migrateSubdivisions(tx));
      out(`tiles ensured: ${r.tiles}, objects assigned: ${r.objects}, seas: ${r.seas}, parents: ${r.parents}, comparison set: ${r.comparison}, seabed polygons: ${r.seabed}`);
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

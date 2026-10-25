import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { autoDecideOpenPairTasks } from "../lib/domain/gazetteer/merge";
import { refuseSimulationEnv } from "../lib/domain/revisit/guard";

/*
 * Decides the open pair tasks („Dasselbe Objekt?“) that the rule `autoPairDecision` knows the answer to, once for the
 * tasks opened before the rule existed; new pairs are decided when they are found.
 */

async function main(): Promise<void> {
  refuseSimulationEnv(process.env, "auto-decide-pairs");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    const result = await autoDecideOpenPairTasks(db, config.gazetteer.merge);
    out(`same: ${result.same}, distinct: ${result.distinct}, dismissed: ${result.dismissed}, left open: ${result.open}`);
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

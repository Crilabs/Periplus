import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { createBoss } from "../lib/jobs/boss";
import { ensureQueues } from "../lib/jobs/queues";
import { startConsolidationRun, type ConsolidationScope, type StartConsolidationInput } from "../lib/pipeline/consolidation/run";
import { RunScopeNotReady } from "../lib/pipeline/tile-scope";

/*
 * Starts a consolidation run from the command line, for the scopes without a button in M5: a whole area, the
 * comparison set of an area, and the evaluation run of a candidate rules version (spec 10 regression; comparison and
 * activation on /quality come with M7). Tiles and single places have „Konsolidieren“ / „Profil neu berechnen“.
 */

const USAGE =
  "usage: consolidate.ts (--area <key> | --tile <id> | --comparison-set <areaKey>) [--evaluation --rules <version>]";

export type ConsolidateArgs = Pick<StartConsolidationInput, "scope" | "evaluation" | "rulesVersion">;

/**
 * Exactly one scope flag; `--evaluation` needs `--rules <version>` (the candidate version), and `--rules` is only
 * allowed with `--evaluation` (a regular run always takes the active version). A repeated flag is refused, not
 * silently overridden by its last value (bundle J review M-4).
 */
export function parseArgs(argv: string[]): ConsolidateArgs {
  const scopes: ConsolidationScope[] = [];
  let evaluation = false;
  let rulesVersion: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === "--evaluation") {
      evaluation = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (flag === "--area") scopes.push({ areaKey: value });
    else if (flag === "--tile") scopes.push({ tileId: value });
    else if (flag === "--comparison-set") scopes.push({ comparisonSetArea: value });
    else if (flag === "--rules") rulesVersion = value;
    else throw new Error(USAGE);
  }
  if (scopes.length !== 1 || evaluation !== (rulesVersion !== undefined)) throw new Error(USAGE);
  return evaluation ? { scope: scopes[0]!, evaluation: true, rulesVersion } : { scope: scopes[0]! };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const boss = createBoss(url, { supervise: false, schedule: false });
  await boss.start();
  try {
    await ensureQueues(boss, config.queues);
    try {
      const { id } = await startConsolidationRun(db, boss, { ...args, triggeredBy: "consolidate" }, config);
      out(`consolidation run ${id} started${args.evaluation ? ` (evaluation of rules ${args.rulesVersion})` : ""}; follow it on /runs/${id}`);
    } catch (error) {
      if (!(error instanceof RunScopeNotReady)) throw error;
      out(`not started (${error.reason}): ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await boss.stop({ graceful: true });
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { refuseSimulationEnv } from "../lib/domain/revisit/guard";
import { ComparisonTooExpensive, createModelComparisonWithinBudget } from "../lib/domain/extraction/comparison";
import { createBoss } from "../lib/jobs/boss";
import { ensureQueues } from "../lib/jobs/queues";
import { startModelComparisonRun } from "../lib/pipeline/text/run";
import { RunScopeNotReady } from "../lib/pipeline/tile-scope";

const USAGE = "usage: compare-models.ts --label <label> [--max-eur <eur>] [--start]";
/**
 * Default ceiling of the cost estimate (EUR, both models): the default sample of 200 units estimates at about 13 EUR
 * (ruling M4-J-R1), so the primary command passes without a flag.
 */
export const DEFAULT_MAX_EUR = 15;

export type CompareModelsArgs = { label: string; maxEur: number; start: boolean };

/** `--label` (required, ≤ 80 characters), `--max-eur` (positive, default 15), `--start` (start the run at once). */
export function parseArgs(argv: string[]): CompareModelsArgs {
  let label: string | undefined;
  let maxEur = DEFAULT_MAX_EUR;
  let start = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--start") {
      start = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (flag === "--label") label = value.trim();
    else if (flag === "--max-eur") {
      maxEur = Number(value);
      if (!Number.isFinite(maxEur) || maxEur <= 0) throw new Error(USAGE);
    } else throw new Error(USAGE);
  }
  if (!label || label.length > 80) throw new Error(USAGE);
  return { label, maxEur, start };
}

/**
 * `--start` of a created comparison: starts its run and prints where to follow it; a refusal (`RunScopeNotReady`, e.g.
 * above today's `anthropic` headroom) prints the reason and that the comparison stays, with its id and where to start
 * it later. Returns whether the run started.
 */
export async function startCreatedComparison(
  comparisonId: string,
  start: () => Promise<{ id: string }>,
  out: (line: string) => void,
): Promise<boolean> {
  try {
    const { id } = await start();
    out(`run ${id} started; follow it on /runs/${id}, then rate the deviations on /compare/models?comparison=${comparisonId}`);
    return true;
  } catch (error) {
    if (!(error instanceof RunScopeNotReady)) throw error;
    out(`not started (${error.reason}): ${error.message}`);
    out(`comparison ${comparisonId} stays; start it later on /compare/models?comparison=${comparisonId} ("Lauf starten")`);
    return false;
  }
}

/**
 * Creates the model comparison in the database of `DATABASE_URL` (the sample of `config/extraction.json`
 * `comparison`), prints units, sources, document types, shortfall and the cost estimate, and refuses (nothing stays)
 * when the estimate is above `--max-eur`. `--start` then starts the comparison run (batch API, budget `anthropic`).
 */
async function main(): Promise<void> {
  // never in a simulation or on its clone: costs booked there escape the real budget (final review A M-5)
  refuseSimulationEnv(process.env, "compare:models");
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    let created;
    try {
      created = await createModelComparisonWithinBudget(db, { label: args.label, createdBy: "compare:models", maxEur: args.maxEur, cfg: config });
    } catch (error) {
      if (error instanceof ComparisonTooExpensive) {
        out(`refused: ${error.message}; nothing was created (raise --max-eur to allow it)`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    out(`comparison ${created.id} "${args.label}": models ${config.models.comparison.models.join(", ")}`);
    out(`units: ${created.units}, sources: ${created.sources}, document types: ${created.docTypes.join(", ") || "none"}`);
    out(`shortfall: ${created.shortfall.length === 0 ? "none" : created.shortfall.join(", ")}`);
    out(`cost estimate: ${created.estimateEur.toFixed(2)} EUR (both models, batch; maximum ${args.maxEur.toFixed(2)} EUR)`);
    if (!args.start) {
      out("not started: start it on /compare/models (\"Lauf starten\") or run again with --start");
      return;
    }
    const boss = createBoss(url, { supervise: false, schedule: false });
    await boss.start();
    try {
      await ensureQueues(boss, config.queues);
      const started = await startCreatedComparison(
        created.id,
        () => startModelComparisonRun(db, boss, { comparisonId: created.id, triggeredBy: "compare:models" }, config),
        out,
      );
      if (!started) process.exitCode = 1;
    } finally {
      await boss.stop({ graceful: true });
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

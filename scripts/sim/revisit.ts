import path from "node:path";
import { fileURLToPath } from "node:url";
import { getArchive } from "../../lib/adapters/s3";
import { getConfig } from "../../lib/config";
import { createDb } from "../../lib/db/client";
import { requireSimulationEnv } from "../../lib/domain/revisit/guard";
import { revisitPreflight, scenarioMismatch, SIM_TRIGGERED_BY } from "../../lib/domain/revisit/preflight";
import { loadScenario } from "../../lib/domain/revisit/scenario";
import { getRun } from "../../lib/domain/runs";
import { getEnv } from "../../lib/env";
import { createBoss } from "../../lib/jobs/boss";
import { ensureQueues } from "../../lib/jobs/queues";
import { startRevisitRun } from "../../lib/pipeline/revisit-run";
import { RunScopeNotReady } from "../../lib/pipeline/tile-scope";

/*
 * `npm run sim:revisit -- --subdivision <key> --scenario <path> [--max-pages <n>]` (spec 10, plan Task 13): starts a simulated
 * revisit of the subdivision in the simulation clone and waits for it. A second call is the second fetch (a `gone` page turns
 * gone at its second miss). Refused before anything is written: no simulation environment (`requireSimulationEnv`, first
 * of all), a scenario other than `PERIPLUS_SIMULATION` of this call (the worker's when both use one env file), no clone (`sim_meta`), foreign jobs in the
 * queue, a scenario entry the revisit cannot apply, no valid package of the subdivision to compare against. A real pilot
 * scenario quotes third-party pages and lives under the git-ignored `data/sim/` (ruling M7-F-R3), never in the repo.
 * The checks live in `lib/domain/revisit/preflight.ts`; this file only parses, starts and waits.
 */

const USAGE = "usage: sim/revisit.ts --subdivision <key> --scenario <path> [--max-pages <n>]";

export type SimRevisitArgs = { subdivision: string; scenario: string; maxPages?: number };

/** `--subdivision` and `--scenario` are required, `--max-pages` a positive integer; a repeated or unknown flag is refused. */
export function parseArgs(argv: string[]): SimRevisitArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!["--subdivision", "--scenario", "--max-pages"].includes(flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (values[flag] !== undefined) throw new Error(USAGE);
    values[flag] = value;
  }
  const subdivision = values["--subdivision"];
  const scenario = values["--scenario"];
  if (!subdivision || !scenario) throw new Error(USAGE);
  if (values["--max-pages"] === undefined) return { subdivision, scenario };
  const maxPages = Number(values["--max-pages"]);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(USAGE);
  return { subdivision, scenario, maxPages };
}

const POLL_MS = 5_000;
/** How long `sim:revisit` waits for its run (a stuck run is left to `/runs`). */
export const POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

type RunStatus = { status: string; running?: { stage: string; done: number; total: number } } | null;

/**
 * Polls the run until it is finished or failed, or `timeoutMs` passed: `finished`, `failed`, `missing` (the run is
 * gone) or `timeout` (still running: watch it on /runs). Every poll writes a progress line.
 */
export async function waitForRun(
  status: () => Promise<RunStatus>,
  out: (line: string) => void,
  opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<"finished" | "failed" | "missing" | "timeout"> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    await sleep(pollMs);
    const run = await status();
    out(`  ${run?.status ?? "?"}${run?.running ? ` – ${run.running.stage} ${run.running.done}/${run.running.total}` : ""}`);
    if (!run) return "missing";
    if (run.status === "finished" || run.status === "failed") return run.status;
    if (now() >= deadline) return "timeout";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  const sim = requireSimulationEnv(env, "sim:revisit");
  const mismatch = scenarioMismatch(args.scenario, sim);
  if (mismatch) throw new Error(mismatch);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const config = getConfig();
  const scenario = await loadScenario(args.scenario);
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    const problems = await revisitPreflight(db, getArchive(), { subdivisionKey: args.subdivision, scenario, maxPages: args.maxPages });
    if (problems.length > 0) {
      out("Revisit nicht gestartet:");
      for (const p of problems) out(`  - ${p}`);
      process.exitCode = 1;
      return;
    }
    const boss = createBoss(env.DATABASE_URL, { supervise: false, schedule: false });
    await boss.start();
    let runId: string;
    try {
      await ensureQueues(boss, config.queues);
      try {
        ({ id: runId } = await startRevisitRun(db, boss, { subdivisionKey: args.subdivision, triggeredBy: SIM_TRIGGERED_BY, maxPages: args.maxPages }));
      } catch (error) {
        if (!(error instanceof RunScopeNotReady)) throw error;
        out(`Revisit nicht gestartet (${error.reason}): ${error.message}`);
        process.exitCode = 1;
        return;
      }
    } finally {
      await boss.stop({ graceful: true });
    }
    out(`Revisit-Lauf ${runId} gestartet (Szenario ${scenario.name}, Datenbank ${sim.database}, Präfix ${sim.writePrefix})`);
    const end = await waitForRun(async () => {
      const run = await getRun(db, runId);
      if (!run) return null;
      const running = run.stages.find((s) => s.status === "running");
      return { status: run.status, ...(running ? { running: { stage: running.stage, done: running.done, total: running.total } } : {}) };
    }, out);
    const said = { finished: "beendet", failed: "fehlgeschlagen", missing: "nicht gefunden", timeout: `läuft nach ${POLL_TIMEOUT_MS / 3_600_000} h noch – auf /runs weiter beobachten` }[end];
    out(`Revisit-Lauf ${runId}: ${said}`);
    if (end !== "finished") process.exitCode = 1;
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

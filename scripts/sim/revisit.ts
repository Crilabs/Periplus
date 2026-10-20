import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getArchive, type Archive } from "../../lib/adapters/s3";
import { getConfig } from "../../lib/config";
import { createDb, type Db } from "../../lib/db/client";
import { requireSimulationEnv, type SimulationSettings } from "../../lib/domain/revisit/guard";
import { loadScenario, preflightScenario, type RevisitScenario } from "../../lib/domain/revisit/scenario";
import { readSimMeta } from "../../lib/domain/revisit/verify";
import { getRun } from "../../lib/domain/runs";
import { getEnv } from "../../lib/env";
import { createBoss } from "../../lib/jobs/boss";
import { ensureQueues } from "../../lib/jobs/queues";
import { startRevisitRun } from "../../lib/pipeline/revisit-run";
import { RunScopeNotReady } from "../../lib/pipeline/tile-scope";

/*
 * `npm run sim:revisit -- --area <key> --scenario <path> [--max-pages <n>]` (spec 10, plan Task 13): starts a simulated
 * revisit of the area in the simulation clone and waits for it. A second call is the second fetch (a `gone` page turns
 * gone at its second miss). Refused before anything is written: no simulation environment (`requireSimulationEnv`, first
 * of all), a scenario other than `PERIPLUS_SIMULATION` of this call (the worker's when both use one env file), no clone (`sim_meta`), foreign jobs in the
 * queue, a scenario entry the revisit cannot apply, no valid package of the area to compare against. A real pilot
 * scenario quotes third-party pages and lives under the git-ignored `data/sim/` (ruling M7-F-R3), never in the repo.
 */

/** `triggered_by` of the runs this CLI starts: their jobs are not foreign to the next call. */
export const SIM_TRIGGERED_BY = "sim:revisit";

const USAGE = "usage: sim/revisit.ts --area <key> --scenario <path> [--max-pages <n>]";

export type SimRevisitArgs = { area: string; scenario: string; maxPages?: number };

/** `--area` and `--scenario` are required, `--max-pages` a positive integer; a repeated or unknown flag is refused. */
export function parseArgs(argv: string[]): SimRevisitArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!["--area", "--scenario", "--max-pages"].includes(flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (values[flag] !== undefined) throw new Error(USAGE);
    values[flag] = value;
  }
  const area = values["--area"];
  const scenario = values["--scenario"];
  if (!area || !scenario) throw new Error(USAGE);
  if (values["--max-pages"] === undefined) return { area, scenario };
  const maxPages = Number(values["--max-pages"]);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(USAGE);
  return { area, scenario, maxPages };
}

/**
 * pg-boss jobs waiting, retrying or running (`created`, `retry`, `active`) that belong to no queued or running run this
 * CLI started (`SIM_TRIGGERED_BY`): work cloned mid-flight or started by hand would mix into the revisit's change
 * events (rulings M7-P27, M7-P30). Leftover jobs of an earlier sim run that has failed or finished are foreign too
 * (ruling M7-G-R4): only a live sim run owns its jobs.
 */
export async function foreignJobs(db: Db): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pgboss.job j
    where j.state in ('created', 'retry', 'active')
      and not exists (
        select 1 from runs r
        where r.id::text = j.data ->> 'runId' and r.triggered_by = ${SIM_TRIGGERED_BY} and r.status in ('queued', 'running')
      )
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Why `--scenario` cannot run (null: it can): it must be the scenario of `PERIPLUS_SIMULATION` in this call's
 * environment, which is the worker's only when both start from the same env file (the run book says so).
 */
export function scenarioMismatch(scenarioArg: string, sim: SimulationSettings): string | null {
  if (path.resolve(scenarioArg) === path.resolve(sim.scenarioPath)) return null;
  return `--scenario ${scenarioArg} ist nicht das Szenario aus PERIPLUS_SIMULATION dieses Aufrufs (${sim.scenarioPath}); Sim-Worker und sim:revisit aus derselben Env-Datei starten`;
}

/**
 * What stands against a simulated revisit, in German (empty: it may start): no simulation clone (`sim_meta`), foreign
 * jobs (`foreignJobs`), each scenario entry the preflight refuses (`preflightScenario` with the run's `maxPages`), and
 * no valid package of the area (the asOf check needs the state before the revisit).
 */
export async function revisitPreflight(
  db: Db,
  archive: Archive,
  input: { areaKey: string; scenario: RevisitScenario; maxPages?: number },
): Promise<string[]> {
  const problems: string[] = [];
  if (!(await readSimMeta(db))) problems.push("keine Sim-Datenbank – scripts/sim/clone.sh");
  const foreign = await foreignJobs(db);
  if (foreign > 0) problems.push(`${foreign} fremde Jobs in der Warteschlange (wartend, wiederholt oder laufend) – erst abwarten oder beenden`);
  for (const r of await preflightScenario(db, archive, input.scenario, { maxPages: input.maxPages })) {
    if (!r.ok) problems.push(`Szenario-Eintrag ${r.entryId}: ${r.error}`);
  }
  const { rows } = await db.execute(sql`
    select 1 from deliveries d join geo_objects a on a.id = d.area_id and a.type = 'area'
    where a.config_key = ${input.areaKey} and d.status = 'valid' limit 1
  `);
  if (rows.length === 0) problems.push(`erst Paket bauen: Revier ${input.areaKey} hat keine gültige Lieferung`);
  return problems;
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
    const problems = await revisitPreflight(db, getArchive(), { areaKey: args.area, scenario, maxPages: args.maxPages });
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
        ({ id: runId } = await startRevisitRun(db, boss, { areaKey: args.area, triggeredBy: SIM_TRIGGERED_BY, maxPages: args.maxPages }, config));
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
    const said = { finished: "finished", failed: "failed", missing: "nicht gefunden", timeout: `läuft nach ${POLL_TIMEOUT_MS / 3_600_000} h noch – auf /runs weiter beobachten` }[end];
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

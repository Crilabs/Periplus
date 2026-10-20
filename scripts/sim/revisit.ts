import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getArchive, type Archive } from "../../lib/adapters/s3";
import { getConfig } from "../../lib/config";
import { createDb, type Db } from "../../lib/db/client";
import { assertSimulationEnv } from "../../lib/domain/revisit/guard";
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
 * gone at its second miss). Refused before anything is written: no simulation environment (`assertSimulationEnv`, first
 * of all), a scenario other than the worker's (`PERIPLUS_SIMULATION`), no clone (`sim_meta`), foreign jobs in the
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
 * pg-boss jobs waiting, retrying or running (`created`, `retry`, `active`) that belong to no run this CLI started
 * (`SIM_TRIGGERED_BY`): work cloned mid-flight or started by hand would mix into the revisit's change events
 * (rulings M7-P27, M7-P30).
 */
export async function foreignJobs(db: Db): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pgboss.job j
    where j.state in ('created', 'retry', 'active')
      and not exists (select 1 from runs r where r.id::text = j.data ->> 'runId' and r.triggered_by = ${SIM_TRIGGERED_BY})
  `);
  return Number(rows[0]?.n ?? 0);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  const sim = assertSimulationEnv(env);
  if (!sim) throw new Error("sim:revisit läuft nur in einer Simulation: PERIPLUS_SIMULATION, DATABASE_URL auf periplus_sim und S3_WRITE_PREFIX setzen");
  if (path.resolve(args.scenario) !== path.resolve(sim.scenarioPath)) {
    throw new Error(`--scenario ${args.scenario} ist nicht das Szenario des Workers (PERIPLUS_SIMULATION=${sim.scenarioPath})`);
  }
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
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const run = await getRun(db, runId);
      const running = run?.stages.find((s) => s.status === "running");
      out(`  ${run?.status ?? "?"}${running ? ` – ${running.stage} ${running.done}/${running.total}` : ""}`);
      if (!run || run.status === "finished" || run.status === "failed") {
        out(`Revisit-Lauf ${runId}: ${run?.status ?? "nicht gefunden"}`);
        if (run?.status !== "finished") process.exitCode = 1;
        return;
      }
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

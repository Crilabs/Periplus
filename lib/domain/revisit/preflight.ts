import path from "node:path";
import { sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import type { SimulationSettings } from "./guard";
import { preflightScenario, type RevisitScenario } from "./scenario";
import { readSimMeta } from "./verify";

/*
 * What stands against a simulated revisit before `sim:revisit` starts one (spec 10, plan Task 13; moved out of the CLI,
 * final review B M-6). Messages are German: Christian reads them in the CLI output.
 */

/** `triggered_by` of the runs `sim:revisit` starts: their jobs are not foreign to the next call. */
export const SIM_TRIGGERED_BY = "sim:revisit";

/**
 * pg-boss jobs waiting, retrying or running (`created`, `retry`, `active`) that belong to no queued or running run
 * `sim:revisit` started (`SIM_TRIGGERED_BY`): work cloned mid-flight or started by hand would mix into the revisit's
 * change events (rulings M7-P27, M7-P30). Leftover jobs of an earlier sim run that has failed or finished are foreign
 * too (ruling M7-G-R4): only a live sim run owns its jobs.
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
 * no valid package of the subdivision (the asOf check needs the state before the revisit).
 */
export async function revisitPreflight(
  db: Db,
  archive: Archive,
  input: { subdivisionKey: string; scenario: RevisitScenario; maxPages?: number },
): Promise<string[]> {
  const problems: string[] = [];
  if (!(await readSimMeta(db))) problems.push("keine Sim-Datenbank – scripts/sim/clone.sh");
  const foreign = await foreignJobs(db);
  if (foreign > 0) problems.push(`${foreign} fremde Jobs in der Warteschlange (wartend, wiederholt oder laufend) – erst abwarten oder beenden`);
  for (const r of await preflightScenario(db, archive, input.scenario, { maxPages: input.maxPages })) {
    if (!r.ok) problems.push(`Szenario-Eintrag ${r.entryId}: ${r.error}`);
  }
  const { rows } = await db.execute(sql`
    -- TODO(plan 14a task 10): deliveries are per subdivision then (deliveries.subdivision_id); until then by area key
    select 1 from deliveries d join geo_objects a on a.id = d.area_id and a.type = 'area'
    where a.config_key = ${input.subdivisionKey} and d.status = 'valid' limit 1
  `);
  if (rows.length === 0) problems.push(`erst Paket bauen: Landesteil ${input.subdivisionKey} hat keine gültige Lieferung`);
  return problems;
}

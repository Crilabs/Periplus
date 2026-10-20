import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Archive } from "../../lib/adapters/s3";
import { createDb, type Db } from "../../lib/db/client";
import { deliveryArchive, spotAsOf } from "../../lib/domain/delivery/read";
import { requireSimulationEnv } from "../../lib/domain/revisit/guard";
import { loadScenario, type RevisitScenario } from "../../lib/domain/revisit/scenario";
import { asOfPlan, checkAsOf, readSimMeta, verifyRevisit, type AsOfCheck, type RevisitVerification } from "../../lib/domain/revisit/verify";
import { getEnv } from "../../lib/env";

/*
 * `npm run sim:verify -- --area <key> --scenario <path> [--base-url <url> --key pk_… [--spot sp_…]] [--out <json>]`
 * (spec 10, plan Task 13): compares the change feed of the simulation clone since the clone (`sim_meta.from_seq`) with
 * the scenario („10 von 10 erwartet, 0 zusätzliche“) and, with `--base-url`, asks the simulation's API for a spot as of
 * the day before the revisit (it must answer the old version). Exit 0 only when the verification passes and the asOf
 * check (if asked for) is ok. The API key is never printed or written.
 */

const USAGE = "usage: sim/verify.ts --area <key> --scenario <path> [--base-url <url> --key <pk_…> [--spot <sp_…>]] [--out <file.json>]";

export type SimVerifyArgs = { area: string; scenario: string; baseUrl?: string; key?: string; spot?: string; out?: string };

const FLAGS = { "--area": "area", "--scenario": "scenario", "--base-url": "baseUrl", "--key": "key", "--spot": "spot", "--out": "out" } as const;

/** `--area` and `--scenario` are required; `--base-url` and `--key` go together, `--spot` only with them. */
export function parseArgs(argv: string[]): SimVerifyArgs {
  const args: Partial<SimVerifyArgs> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!Object.hasOwn(FLAGS, flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    const key = FLAGS[flag as keyof typeof FLAGS];
    if (args[key] !== undefined) throw new Error(USAGE);
    args[key] = value;
  }
  if (!args.area || !args.scenario) throw new Error(USAGE);
  if ((args.baseUrl === undefined) !== (args.key === undefined)) throw new Error(USAGE);
  if (args.spot !== undefined && args.baseUrl === undefined) throw new Error(USAGE);
  return args as SimVerifyArgs;
}

export type AsOfReport =
  | { ok: false; reason: string }
  | { ok: boolean; asOf: string; spot: string; before: { dataVersion: number }; after: { dataVersion: number }; check: AsOfCheck };

export type SimVerifyReport = {
  area: string;
  scenario: string;
  clonedAt: string;
  fromSeq: number;
  verification: RevisitVerification;
  asOf: AsOfReport | null;
  /** External calls of the simulation database since the clone (ruling M7-P15: reported apart from the pilot runs). */
  costs: { totalEur: number; byService: Record<string, { calls: number; eur: number }> };
  passes: boolean;
};

/** The first `sp_` subject of an expectation the verification matched (ruling M7-P18), else null. */
function changedSpot(scenario: RevisitScenario, v: RevisitVerification): string | null {
  for (const entry of scenario.entries) {
    const result = v.entries.find((e) => e.id === entry.id);
    if (!result || result.events.matched === 0) continue;
    const spot = entry.expect.events.find((e) => e.subject.startsWith("sp_"));
    if (spot) return spot.subject;
  }
  return null;
}

async function asOfReport(
  db: Db,
  archive: Archive,
  args: SimVerifyArgs & { baseUrl: string; key: string },
  scenario: RevisitScenario,
  v: RevisitVerification,
  doFetch?: typeof fetch,
): Promise<AsOfReport> {
  const plan = await asOfPlan(db, args.area);
  if ("reason" in plan) return { ok: false, reason: plan.reason };
  const spot = args.spot ?? changedSpot(scenario, v);
  if (!spot) return { ok: false, reason: "Kein Spot mit erkannter Änderung – --spot angeben" };
  const before = await spotAsOf(db, archive, spot, plan.asOf);
  if (!before) return { ok: false, reason: `Spot ${spot} war am ${plan.asOf} nicht geliefert` };
  // the expectation is bound to the plan: the spot as a package before the revisit delivered it (ruling M7-G-R3)
  if (before.dataVersion > plan.before.dataVersion) return { ok: false, reason: `asOf ${plan.asOf} liefert für ${spot} einen Stand nach dem Revisit` };
  const after = await spotAsOf(db, archive, spot);
  if (!after || after.dataVersion === before.dataVersion) return { ok: false, reason: `Spot ${spot} hat sich im Revisit nicht geändert` };
  const check = await checkAsOf({
    baseUrl: args.baseUrl,
    key: args.key,
    spotId: spot,
    asOf: plan.asOf,
    expectBefore: { dataVersion: before.dataVersion, spot: before.spot },
    fetch: doFetch,
  });
  return { ok: check.ok, asOf: plan.asOf, spot, before: { dataVersion: before.dataVersion }, after: { dataVersion: after.dataVersion }, check };
}

async function simCosts(db: Db, since: Date): Promise<SimVerifyReport["costs"]> {
  const { rows } = await db.execute<{ service: string; calls: number; eur: string }>(sql`
    select service, count(*)::int as calls, coalesce(sum(cost_eur), 0)::text as eur
    from external_calls where at >= ${since.toISOString()}::timestamptz group by service order by service
  `);
  const byService = Object.fromEntries(rows.map((r) => [r.service, { calls: Number(r.calls), eur: Number(r.eur) }]));
  return { totalEur: rows.reduce((sum, r) => sum + Number(r.eur), 0), byService };
}

/** The table printed for a report (German, as the run book quotes it). */
export function renderReport(r: SimVerifyReport): string[] {
  const v = r.verification;
  const lines = [`Revisit-Prüfung ${r.area} (Szenario ${r.scenario}, Ereignisse ab seq ${r.fromSeq}):`];
  for (const e of v.entries) {
    lines.push(
      `  ${e.ok ? "ok    " : "FEHLER"} ${e.id}  Dokument ${e.document.actual}${e.document.actual === e.document.expected ? "" : ` (erwartet ${e.document.expected})`}  Ereignisse ${e.events.matched}/${e.events.expected}  ${e.url}`,
    );
  }
  lines.push(`${v.correct} von ${v.expected} erwartet, ${v.unexpected.length} zusätzliche`);
  for (const u of v.unexpected) {
    lines.push(`  zusätzlich seq ${u.seq}: ${u.subject ?? "?"} ${u.attribute ?? "(Objekt)"} ${u.type} ${u.severity} ${JSON.stringify(u.oldValue)} → ${JSON.stringify(u.newValue)}`);
  }
  if (r.asOf) {
    lines.push(
      "check" in r.asOf
        ? `asOf ${r.asOf.asOf} für ${r.asOf.spot}: ${r.asOf.ok ? "ok" : "FEHLER"} (HTTP ${r.asOf.check.status}, Datenversion ${r.asOf.check.dataVersion ?? "–"}, erwartet ${r.asOf.before.dataVersion}, neu ${r.asOf.after.dataVersion}${r.asOf.check.reason ? `; ${r.asOf.check.reason}` : ""})`
        : `asOf: FEHLER – ${r.asOf.reason}`,
    );
  }
  lines.push(`Kosten der Simulation seit dem Klon: ${r.costs.totalEur.toFixed(2)} EUR`);
  lines.push(r.passes ? "Bestanden." : "Nicht bestanden.");
  return lines;
}

/**
 * The verification of a simulated revisit: `sim_meta` (else refused: no simulation clone), refused while a revisit run
 * of the area is queued or running, `verifyRevisit` from its `from_seq`, with `--base-url` the asOf check (`asOfPlan`,
 * the spot of `--spot` or the first changed one, ruling M7-P18: a spot whose data version did not change is refused;
 * the spot as of `asOf` must come from a package before the revisit, and the API must answer that spot, ruling
 * M7-G-R3), the clone's external costs. Passes when the verification
 * passes and the asOf check, if asked for, is ok.
 */
export async function simVerify(db: Db, archive: Archive, args: SimVerifyArgs, opts: { fetch?: typeof fetch; scenario?: RevisitScenario } = {}): Promise<SimVerifyReport> {
  const meta = await readSimMeta(db);
  if (!meta) throw new Error("keine Sim-Datenbank – scripts/sim/clone.sh");
  // a revisit still at work writes more events: a pass now could be premature (ruling M7-G-R3)
  const { rows: live } = await db.execute<{ id: string }>(sql`
    select id from runs where kind = 'revisit' and scope_type = 'area' and scope_id = ${args.area} and status in ('queued', 'running')
    order by created_at limit 1
  `);
  if (live[0]) throw new Error(`Revisit-Lauf ${live[0].id} läuft noch – erst abwarten (/runs)`);
  const scenario = opts.scenario ?? (await loadScenario(args.scenario));
  const verification = await verifyRevisit(db, scenario, { fromSeq: meta.fromSeq, areaKey: args.area });
  const asOf =
    args.baseUrl !== undefined && args.key !== undefined
      ? await asOfReport(db, archive, { ...args, baseUrl: args.baseUrl, key: args.key }, scenario, verification, opts.fetch)
      : null;
  return {
    area: args.area,
    scenario: scenario.name,
    clonedAt: meta.clonedAt.toISOString(),
    fromSeq: meta.fromSeq,
    verification,
    asOf,
    costs: await simCosts(db, meta.clonedAt),
    passes: verification.passes && (asOf === null || asOf.ok),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  // First of all: only in a simulation (reverse check, ruling M7-F-R2), never against the real database (M7-G-R4).
  requireSimulationEnv(env, "sim:verify");
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    const report = await simVerify(db, deliveryArchive(), args);
    for (const line of renderReport(report)) process.stdout.write(`${line}\n`);
    if (args.out) {
      await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
      await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`Bericht: ${args.out}\n`);
    }
    process.exitCode = report.passes ? 0 : 1;
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

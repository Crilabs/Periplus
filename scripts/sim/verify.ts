import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../lib/db/client";
import { deliveryArchive } from "../../lib/domain/delivery/read";
import { requireSimulationEnv } from "../../lib/domain/revisit/guard";
import { simVerify, type SimVerifyReport } from "../../lib/domain/revisit/sim-verify";
import { getEnv } from "../../lib/env";

export type { SimVerifyReport };

/*
 * `npm run sim:verify -- --subdivision <key> --scenario <path> [--base-url http://localhost:<port> [--spot sp_…]] [--out <json>]`
 * (spec 10, plan Task 13): compares the change feed of the simulation clone since the clone (`sim_meta.from_seq`) with
 * the scenario („10 von 10 erwartet, 0 zusätzliche“) and, with `--base-url`, asks the local simulation web for a spot as
 * of the day before the revisit (it must answer the old version). The API key comes from `PERIPLUS_API_KEY` (in
 * `.env.sim` or exported), never from the command line (shell history, final review A M-4); it is never printed or
 * written. Exit 0 only when the verification passes and the asOf check (if asked for) is ok. The logic lives in
 * `lib/domain/revisit/sim-verify.ts`.
 */

const USAGE = "usage: sim/verify.ts --subdivision <key> --scenario <path> [--base-url <http://localhost:…> [--spot <sp_…>]] [--out <file.json>] (API key in PERIPLUS_API_KEY)";

export type SimVerifyArgs = { subdivision: string; scenario: string; baseUrl?: string; key?: string; spot?: string; out?: string };

const FLAGS = { "--subdivision": "subdivision", "--scenario": "scenario", "--base-url": "baseUrl", "--spot": "spot", "--out": "out" } as const;

/**
 * `--subdivision` and `--scenario` are required; `--spot` only with `--base-url`, which needs the key in
 * `env.PERIPLUS_API_KEY`. `--key` is refused: a key on the command line lands in the shell history.
 */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): SimVerifyArgs {
  const args: Partial<SimVerifyArgs> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag === "--key") throw new Error("--key gibt es nicht: den Schlüssel über PERIPLUS_API_KEY übergeben (.env.sim oder export), nie auf der Kommandozeile");
    if (!Object.hasOwn(FLAGS, flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    const key = FLAGS[flag as keyof typeof FLAGS];
    if (args[key] !== undefined) throw new Error(USAGE);
    args[key] = value;
  }
  if (!args.subdivision || !args.scenario) throw new Error(USAGE);
  if (args.spot !== undefined && args.baseUrl === undefined) throw new Error(USAGE);
  if (args.baseUrl !== undefined) {
    const key = env.PERIPLUS_API_KEY;
    if (!key) throw new Error("--base-url braucht den API-Schlüssel der Simulation in PERIPLUS_API_KEY (.env.sim oder export)");
    args.key = key;
  }
  return args as SimVerifyArgs;
}

/** The table printed for a report (German, as the run book quotes it). */
export function renderReport(r: SimVerifyReport): string[] {
  const v = r.verification;
  const lines = [`Revisit-Prüfung ${r.subdivision} (Szenario ${r.scenario}, Ereignisse ab seq ${r.fromSeq}):`];
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
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

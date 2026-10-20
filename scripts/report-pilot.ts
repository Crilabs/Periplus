import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { parseSimVerifyReport, renderPilotReport, type PilotReportInput } from "../lib/domain/quality/reports";
import { measurementByLabel, type MeasurementView } from "../lib/domain/quality/snapshot";
import { getEnv } from "../lib/env";
import { pilotDocPath } from "./report-costs";

/*
 * `npm run report:pilot -- --subdivision <key> --first <label> --second <label> [--revisit <sim:verify json>]
 * [--cost-report <path>] [--consumer-ok --data-version <n>]` (spec 10, plan Task 16): the pilot report — success
 * criteria with the measured values, the metric table, the simulated revisit, review effort, tile size — written to
 * `docs/pilot/<YYYY-MM-DD>-pilotbericht.md`, pointing at the cost report: `--cost-report` (must exist), else the cost
 * report of the same day when it exists, else no file link (M7-H-R1, M-6). `--consumer-ok` records that
 * the consumer read package `--data-version` without post-processing (`delivery:consume`). Reads the stored
 * measurements only; free.
 */

const USAGE =
  "usage: report-pilot.ts --subdivision <key> --first <label> --second <label> [--revisit <sim-verify.json>] [--cost-report <path>] [--consumer-ok --data-version <n>]";

export type ReportPilotArgs = { subdivision: string; first: string; second: string; revisit?: string; costReport?: string; consumer?: { dataVersion: number } };

const VALUE_FLAGS = {
  "--subdivision": "subdivision",
  "--first": "first",
  "--second": "second",
  "--revisit": "revisit",
  "--cost-report": "costReport",
  "--data-version": "dataVersion",
} as const;

/** `--subdivision`, `--first`, `--second` are required; `--consumer-ok` (no value) and `--data-version` go together. */
export function parseArgs(argv: string[]): ReportPilotArgs {
  const values: Partial<Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>> = {};
  let consumerOk = false;
  for (let i = 0; i < argv.length; ) {
    const flag = argv[i]!;
    if (flag === "--consumer-ok") {
      if (consumerOk) throw new Error(USAGE);
      consumerOk = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (!Object.hasOwn(VALUE_FLAGS, flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    const key = VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS];
    if (values[key] !== undefined) throw new Error(USAGE);
    values[key] = value;
    i += 2;
  }
  const { subdivision, first, second, revisit, costReport, dataVersion } = values;
  if (!subdivision || !first || !second) throw new Error(USAGE);
  if (consumerOk !== (dataVersion !== undefined)) throw new Error(USAGE);
  const args: ReportPilotArgs = { subdivision, first, second, ...(revisit ? { revisit } : {}), ...(costReport ? { costReport } : {}) };
  if (dataVersion !== undefined) {
    const n = Number(dataVersion);
    if (!Number.isInteger(n) || n < 1) throw new Error(USAGE);
    args.consumer = { dataVersion: n };
  }
  return args;
}

/** The tile size of a measurement (`places_per_tile` details), null when it measured no coast tile. */
export function tilesOf(m: MeasurementView): PilotReportInput["tiles"] {
  const row = m.metrics.places_per_tile;
  if (!row || row.value === null) return null;
  const d = row.details as { median?: number; min?: number; max?: number; outsideTarget?: string[] };
  return { median: Number(d.median ?? row.value), min: Number(d.min ?? 0), max: Number(d.max ?? 0), outside: d.outsideTarget ?? [] };
}

const fileExists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * The cost report the pilot report links to (M7-H-R1, M-6): `--cost-report` when given (refused when the file is
 * missing), else today's `docs/pilot/<date>-kostenbericht.md` when it exists, else none (the report then names
 * `npm run report:costs`). Never a dead link.
 */
export async function costReportLink(given: string | undefined, today: string, exists: (file: string) => Promise<boolean> = fileExists): Promise<string | undefined> {
  if (given !== undefined) {
    if (!(await exists(given))) throw new Error(`Kostenbericht ${given} nicht gefunden (erst npm run report:costs)`);
    return given;
  }
  return (await exists(today)) ? today : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sim = args.revisit ? parseSimVerifyReport(await readFile(args.revisit, "utf8"), args.revisit) : null;
  const costReportFile = await costReportLink(args.costReport, pilotDocPath("kostenbericht"));
  const { db, close } = createDb(getEnv().DATABASE_URL);
  let first: MeasurementView | null;
  let second: MeasurementView | null;
  try {
    first = await measurementByLabel(db, args.subdivision, args.first);
    second = await measurementByLabel(db, args.subdivision, args.second);
  } finally {
    await close();
  }
  if (!first || !second) throw new Error(`Keine Messung „${!first ? args.first : args.second}“ für den Landesteil ${args.subdivision} – erst auf /quality messen`);
  const markdown = renderPilotReport({
    subdivisionKey: args.subdivision,
    first,
    second,
    targets: getConfig().quality,
    revisit: sim?.verification ?? null,
    asOf: sim?.asOf ?? null,
    consumer: args.consumer ? { ok: true, dataVersion: args.consumer.dataVersion } : null,
    tiles: tilesOf(second),
    ...(costReportFile ? { costReportFile } : {}),
  });
  const out = pilotDocPath("pilotbericht");
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, markdown);
  process.stdout.write(`Pilotbericht: ${out}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { parseSimVerifyReport, renderPilotReport, type PilotReportInput } from "../lib/domain/quality/reports";
import { measurementByLabel, type MeasurementView } from "../lib/domain/quality/snapshot";
import { getEnv } from "../lib/env";
import { pilotDocPath } from "./report-costs";

/*
 * `npm run report:pilot -- --area <key> --first <label> --second <label> [--revisit <sim:verify json>]
 * [--consumer-ok --data-version <n>]` (spec 10, plan Task 16): the pilot report — success criteria with the measured
 * values, the metric table, the simulated revisit, review effort, tile size — written to
 * `docs/pilot/<YYYY-MM-DD>-pilotbericht.md`, pointing at the cost report of the same day. `--consumer-ok` records that
 * the consumer read package `--data-version` without post-processing (`delivery:consume`). Reads the stored
 * measurements only; free.
 */

const USAGE =
  "usage: report-pilot.ts --area <key> --first <label> --second <label> [--revisit <sim-verify.json>] [--consumer-ok --data-version <n>]";

export type ReportPilotArgs = { area: string; first: string; second: string; revisit?: string; consumer?: { dataVersion: number } };

const VALUE_FLAGS = { "--area": "area", "--first": "first", "--second": "second", "--revisit": "revisit", "--data-version": "dataVersion" } as const;

/** `--area`, `--first`, `--second` are required; `--consumer-ok` (no value) and `--data-version` go together. */
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
  const { area, first, second, revisit, dataVersion } = values;
  if (!area || !first || !second) throw new Error(USAGE);
  if (consumerOk !== (dataVersion !== undefined)) throw new Error(USAGE);
  const args: ReportPilotArgs = { area, first, second, ...(revisit ? { revisit } : {}) };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sim = args.revisit ? parseSimVerifyReport(await readFile(args.revisit, "utf8"), args.revisit) : null;
  const { db, close } = createDb(getEnv().DATABASE_URL);
  let first: MeasurementView | null;
  let second: MeasurementView | null;
  try {
    first = await measurementByLabel(db, args.area, args.first);
    second = await measurementByLabel(db, args.area, args.second);
  } finally {
    await close();
  }
  if (!first || !second) throw new Error(`Keine Messung „${!first ? args.first : args.second}“ für das Revier ${args.area} – erst auf /quality messen`);
  const markdown = renderPilotReport({
    areaKey: args.area,
    first,
    second,
    targets: getConfig().quality,
    revisit: sim?.verification ?? null,
    asOf: sim?.asOf ?? null,
    consumer: args.consumer ? { ok: true, dataVersion: args.consumer.dataVersion } : null,
    tiles: tilesOf(second),
    costReportFile: pilotDocPath("kostenbericht"),
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../lib/db/client";
import { costReport, parseSimVerifyReport, renderCostReport } from "../lib/domain/quality/reports";
import { getEnv } from "../lib/env";

/*
 * `npm run report:costs -- --area <key> --first <label> [--second <label>] [--revisit <sim:verify json>]` (spec 10,
 * plan Task 16): the cost report of the measured runs with the Mediterranean extrapolation, written to
 * `docs/pilot/<YYYY-MM-DD>-kostenbericht.md`. `--revisit` adds the simulation's spend from `sim:verify --out` apart
 * (ruling M7-P15). Reads the stored measurements only; free.
 */

const USAGE = "usage: report-costs.ts --area <key> --first <label> [--second <label>] [--revisit <sim-verify.json>]";

export type ReportCostsArgs = { area: string; first: string; second?: string; revisit?: string };

const FLAGS = { "--area": "area", "--first": "first", "--second": "second", "--revisit": "revisit" } as const;

/** `--area` and `--first` are required; every flag once; values never start with `--`. */
export function parseArgs(argv: string[]): ReportCostsArgs {
  const args: Partial<ReportCostsArgs> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!Object.hasOwn(FLAGS, flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    const key = FLAGS[flag as keyof typeof FLAGS];
    if (args[key] !== undefined) throw new Error(USAGE);
    args[key] = value;
  }
  if (!args.area || !args.first) throw new Error(USAGE);
  return args as ReportCostsArgs;
}

/** `docs/pilot/<YYYY-MM-DD>-<name>.md` of the UTC day of `now`. */
export const pilotDocPath = (name: string, now: Date = new Date()) => `docs/pilot/${now.toISOString().slice(0, 10)}-${name}.md`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const simulation = args.revisit ? parseSimVerifyReport(await readFile(args.revisit, "utf8"), args.revisit).costs : undefined;
  const { db, close } = createDb(getEnv().DATABASE_URL);
  let markdown: string;
  try {
    markdown = renderCostReport(await costReport(db, { areaKey: args.area, firstLabel: args.first, secondLabel: args.second, simulation }));
  } finally {
    await close();
  }
  const out = pilotDocPath("kostenbericht");
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, markdown);
  process.stdout.write(`Kostenbericht: ${out}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

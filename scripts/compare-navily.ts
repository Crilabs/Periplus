import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { requireSubdivision } from "../lib/domain/subdivisions/store";
import {
  comparePlace,
  datasetImportCosts,
  geometryRunStats,
  loadNavilySpots,
  navilySampleConfig,
  ownValuesForComparisonSet,
  renderReport,
} from "../lib/domain/quality/navily-sample";
import { notWrittenNote, renderNavilyRunSection, runNavilyComparison } from "../lib/domain/quality/navily-run";

// Grundprinzip 9: the Navily file is read at runtime from the given path only; nothing of it is stored or printed.

const USAGE =
  "usage: compare-navily.ts --subdivision <key> [--navily <path>] [--accept-proposals] [--out <file>] (or NAVILY_SPOTS_PATH)";

export type CompareArgs = { subdivision: string; navily: string; out: string; acceptProposals: boolean };

const SWITCHES = { "--accept-proposals": "acceptProposals" } as const;

/**
 * `--subdivision` is required; the Navily path comes from `--navily`, else `NAVILY_SPOTS_PATH`; `--out` defaults to the dated
 * pilot report; `--accept-proposals` (no value) records the assistant's proposals.
 */
export function parseArgs(argv: string[], env: Record<string, string | undefined>, today: Date): CompareArgs {
  const values: Record<string, string> = {};
  const switches = { acceptProposals: false };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i]!;
    if (Object.hasOwn(SWITCHES, flag)) {
      const key = SWITCHES[flag as keyof typeof SWITCHES];
      if (switches[key]) throw new Error(USAGE);
      switches[key] = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (!["--subdivision", "--navily", "--out"].includes(flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (values[flag] !== undefined) throw new Error(USAGE);
    values[flag] = value;
    i += 2;
  }
  const subdivision = values["--subdivision"];
  const navily = values["--navily"] ?? env.NAVILY_SPOTS_PATH;
  if (!subdivision) throw new Error(USAGE);
  if (!navily) throw new Error(`no Navily file: pass --navily <path> or set NAVILY_SPOTS_PATH\n${USAGE}`);
  const out = values["--out"] ?? path.join("docs", "pilot", `${today.toISOString().slice(0, 10)}-m2-stichprobe.md`);
  return { subdivision, navily, out, ...switches };
}

async function main(): Promise<void> {
  const now = new Date();
  const args = parseArgs(process.argv.slice(2), process.env, now);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const cfg = navilySampleConfig();
  const spots = await loadNavilySpots(args.navily);
  const { db, close } = createDb(url);
  try {
    await requireSubdivision(db, args.subdivision);
    const own = await ownValuesForComparisonSet(db, args.subdivision);
    const verdicts = own.map((o) =>
      comparePlace(o, spots, { radiusM: cfg.radiusM, protectedThreshold: getConfig().quality.navily.protectedThreshold }),
    );
    const run = await runNavilyComparison(db, {
      subdivisionKey: args.subdivision,
      spots,
      acceptProposals: args.acceptProposals,
      now,
    });
    const report = renderReport({
      subdivisionKey: args.subdivision,
      generatedAt: now,
      verdicts,
      runtime: await geometryRunStats(db, args.subdivision),
      costs: await datasetImportCosts(db, args.subdivision),
    });
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, `${report.trimEnd()}\n\n${renderNavilyRunSection(run, args.acceptProposals)}`);

    const compared = verdicts.filter((v) => v.verdict !== "ohne Geometrie").length;
    process.stdout.write(`report: ${args.out}\n`);
    process.stdout.write(`places in comparison set: ${verdicts.length}, compared with geometry: ${compared}\n`);
    process.stdout.write(`navily coverage: ${run.coverage.matched} of ${run.coverage.spots} spots in the subdivision matched\n`);
    process.stdout.write(
      args.acceptProposals
        ? `results written: ${run.written}, review tasks: ${run.tasks}, kept manual outcomes: ${run.skippedManual}\n`
        : `${notWrittenNote()}\n`,
    );
    if (compared < cfg.minPlaces) {
      process.stderr.write(`only ${compared} places with geometry compared, ${cfg.minPlaces} required\n`);
      process.exitCode = 1;
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

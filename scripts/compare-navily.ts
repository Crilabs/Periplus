import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { areaByKey, getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
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
  "usage: compare-navily.ts --area <key> [--navily <path>] [--accept-proposals] [--coverage] [--out <file>] (or NAVILY_SPOTS_PATH)";

export type CompareArgs = { area: string; navily: string; out: string; acceptProposals: boolean; coverage: boolean };

const SWITCHES = { "--accept-proposals": "acceptProposals", "--coverage": "coverage" } as const;

/**
 * `--area` is required; the Navily path comes from `--navily`, else `NAVILY_SPOTS_PATH`; `--out` defaults to the dated
 * pilot report; `--accept-proposals` (no value) records the assistant's proposals; `--coverage` (no value) stores the
 * Navily coverage with the area's newest measurement.
 */
export function parseArgs(argv: string[], env: Record<string, string | undefined>, today: Date): CompareArgs {
  const values: Record<string, string> = {};
  const switches = { acceptProposals: false, coverage: false };
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
    if (!["--area", "--navily", "--out"].includes(flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (values[flag] !== undefined) throw new Error(USAGE);
    values[flag] = value;
    i += 2;
  }
  const area = values["--area"];
  const navily = values["--navily"] ?? env.NAVILY_SPOTS_PATH;
  if (!area) throw new Error(USAGE);
  if (!navily) throw new Error(`no Navily file: pass --navily <path> or set NAVILY_SPOTS_PATH\n${USAGE}`);
  const out = values["--out"] ?? path.join("docs", "pilot", `${today.toISOString().slice(0, 10)}-m2-stichprobe.md`);
  return { area, navily, out, ...switches };
}

async function main(): Promise<void> {
  const now = new Date();
  const args = parseArgs(process.argv.slice(2), process.env, now);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  areaByKey(args.area);
  const cfg = navilySampleConfig();
  const spots = await loadNavilySpots(args.navily);
  const { db, close } = createDb(url);
  try {
    const own = await ownValuesForComparisonSet(db, args.area);
    const verdicts = own.map((o) =>
      comparePlace(o, spots, { radiusM: cfg.radiusM, protectedThreshold: getConfig().quality.navily.protectedThreshold }),
    );
    const run = await runNavilyComparison(db, {
      areaKey: args.area,
      spots,
      acceptProposals: args.acceptProposals,
      writeCoverage: args.coverage,
      now,
    });
    const report = renderReport({
      areaKey: args.area,
      generatedAt: now,
      verdicts,
      runtime: await geometryRunStats(db, args.area),
      costs: await datasetImportCosts(db, args.area),
    });
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, `${report.trimEnd()}\n\n${renderNavilyRunSection(run, args.acceptProposals)}`);

    const compared = verdicts.filter((v) => v.verdict !== "ohne Geometrie").length;
    process.stdout.write(`report: ${args.out}\n`);
    process.stdout.write(`places in comparison set: ${verdicts.length}, compared with geometry: ${compared}\n`);
    process.stdout.write(`navily coverage: ${run.coverage.matched} of ${run.coverage.spots} spots in the area matched\n`);
    if (run.snapshotRunId) {
      process.stdout.write(`navily coverage ${run.coverageWritten ? "stored with" : "already stored with"} measurement run ${run.snapshotRunId}\n`);
    }
    process.stdout.write(
      args.acceptProposals
        ? `results written: ${run.written}, review tasks: ${run.tasks}, kept manual outcomes: ${run.skippedManual}\n`
        : `${notWrittenNote(run)}\n`,
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

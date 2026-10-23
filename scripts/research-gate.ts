import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, type AppConfig } from "../lib/config";
import { createDb, type Db } from "../lib/db/client";
import { loadNavilySpots, type NavilySpot } from "../lib/domain/quality/navily-sample";
import { syncConflictTasks } from "../lib/domain/research/gate-conflicts";
import { gateOutcome, measureGate, renderGateLists, renderGateReport } from "../lib/domain/research/gate-report";

// Grundprinzip 9: the Navily file is read at runtime only; the committed report holds counts, the per-item lists go to --out-dir outside the repo.

const USAGE =
  "usage: research-gate.ts --subdivision <key> [--navily <path>] [--out-dir <dir>] [--report <file>] [--sync-conflicts] (or NAVILY_SPOTS_PATH)";

/** The committed report, relative to the repository root. */
export const DEFAULT_REPORT = path.join("docs", "pilot", "neuausrichtung", "n3-tor.md");

/** The repository root (`git rev-parse --show-toplevel`), else the working directory. */
export function repoRootOf(cwd: string = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

export type GateArgs = { subdivision: string; navily: string; outDir: string; report: string; syncConflicts: boolean };

/** `--out-dir` defaults to a directory in the system temp dir; `--report` to the committed report in `repoRoot`. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>, repoRoot: string = repoRootOf()): GateArgs {
  const values: Record<string, string> = {};
  let syncConflicts = false;
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i]!;
    if (flag === "--sync-conflicts") {
      if (syncConflicts) throw new Error(USAGE);
      syncConflicts = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (!["--subdivision", "--navily", "--out-dir", "--report"].includes(flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (values[flag] !== undefined) throw new Error(USAGE);
    values[flag] = value;
    i += 2;
  }
  const subdivision = values["--subdivision"];
  const navily = values["--navily"] ?? env.NAVILY_SPOTS_PATH;
  if (!subdivision) throw new Error(USAGE);
  if (!navily) throw new Error(`no Navily file: pass --navily <path> or set NAVILY_SPOTS_PATH\n${USAGE}`);
  return { subdivision, navily, outDir: values["--out-dir"] ?? path.join(os.tmpdir(), "periplus-n3-tor"), report: values["--report"] ?? path.join(repoRoot, DEFAULT_REPORT), syncConflicts };
}

/** `p` made absolute with symlinks resolved as far as it exists: the deepest existing ancestor is resolved, the rest appended. */
async function resolvedPath(p: string): Promise<string> {
  let existing = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(p);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `dir` is `root` or inside it, after resolving symlinks; case-insensitive on macOS. */
export async function isInsideRepo(dir: string, root: string): Promise<boolean> {
  const fold = (x: string) => (process.platform === "darwin" ? x.toLowerCase() : x);
  const rel = path.relative(fold(await resolvedPath(root)), fold(await resolvedPath(dir)));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * Measures the gate, writes the report and the lists, optionally syncs the conflict tasks; returns the lines to print
 * (counts and the outcome only). The lists never go into the repository (`repoRoot`): such an `--out-dir` is refused.
 */
export async function runGate(
  db: Db,
  args: GateArgs,
  spots: NavilySpot[],
  cfg: AppConfig,
  opts: { now: Date; repoRoot: string },
): Promise<string[]> {
  if (await isInsideRepo(args.outDir, opts.repoRoot)) throw new Error("--out-dir must be outside the repository: the lists hold values of the reference");
  const m = await measureGate(db, { subdivisionKey: args.subdivision, spots }, cfg);
  await mkdir(path.dirname(args.report), { recursive: true });
  await writeFile(args.report, renderGateReport(m, opts.now));
  await mkdir(args.outDir, { recursive: true });
  for (const [threshold, csv] of renderGateLists(m)) await writeFile(path.join(args.outDir, `n3-tor-n${threshold}.csv`), csv);
  const lines = [
    `report: ${args.report}`,
    `lists: ${args.outDir}`,
    `spots in ${args.subdivision}: ${m.spotCount}`,
    `confirmed without rule backing (N=${m.deliveredThreshold}): ${m.unbacked.length}`,
    gateOutcome(m),
  ];
  if (args.syncConflicts) {
    const threshold = m.conflictThreshold;
    const synced = await syncConflictTasks(db, threshold === null ? [] : (m.conflicts.get(threshold) ?? []), threshold ?? cfg.research.gate.thresholds[0]!, m.scopePlaceIds);
    lines.push(`conflict tasks (N=${threshold ?? "-"}): ${synced.created} created, ${synced.open} open`);
  }
  return lines;
}

async function main(): Promise<void> {
  const repoRoot = repoRootOf();
  const args = parseArgs(process.argv.slice(2), process.env, repoRoot);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const spots = await loadNavilySpots(args.navily);
  const { db, close } = createDb(url);
  try {
    const lines = await runGate(db, args, spots, getConfig(), { now: new Date(), repoRoot });
    process.stdout.write(`${lines.join("\n")}\n`);
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

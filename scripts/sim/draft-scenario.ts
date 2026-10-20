import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getArchive } from "../../lib/adapters/s3";
import { createDb } from "../../lib/db/client";
import { draftScenario, type ScenarioDraft } from "../../lib/domain/revisit/draft";
import { requireSimulationEnv } from "../../lib/domain/revisit/guard";
import { getEnv } from "../../lib/env";

/*
 * `npm run sim:draft-scenario -- --subdivision <key> --out data/sim/<file>.json [--seed <n>]` (spec 10, plan Task 15): drafts
 * the ten entries of a simulated revisit from the simulation clone's archive (`draftScenario`) and writes them for
 * Christian to review by hand before `sim:revisit`. Only in a simulation (`requireSimulationEnv`, first of all), only
 * under the git-ignored `data/sim/` (the draft quotes third-party sentences verbatim, ruling M7-F-R3), never over an
 * existing file (a reviewed scenario stays).
 */

/** Where drafts go: git-ignored, never committed. */
export const DRAFT_DIR = "data/sim";

const USAGE = "usage: sim/draft-scenario.ts --subdivision <key> --out data/sim/<file>.json [--seed <n>]";

export type DraftArgs = { subdivision: string; out: string; seed: number };

const FLAGS = ["--subdivision", "--out", "--seed"];

/** `--subdivision` and `--out` (a `.json` file under `data/sim/`) are required; `--seed` a non-negative integer, default 1. */
export function parseArgs(argv: string[], cwd = process.cwd()): DraftArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || value === undefined || value.startsWith("--") || values[flag] !== undefined) throw new Error(USAGE);
    values[flag] = value;
  }
  const subdivision = values["--subdivision"];
  const out = values["--out"];
  if (!subdivision || !out) throw new Error(USAGE);
  const relative = path.relative(path.resolve(cwd, DRAFT_DIR), path.resolve(cwd, out));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !out.endsWith(".json")) {
    throw new Error(`--out muss eine .json-Datei unter ${DRAFT_DIR}/ sein (git-ignoriert: der Entwurf zitiert fremde Seiten wörtlich)`);
  }
  const seed = values["--seed"] === undefined ? 1 : Number(values["--seed"]);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(USAGE);
  return { subdivision, out, seed };
}

/** The CLI's summary of a draft, in German: one line per entry, then the gaps and the review reminder. */
export function renderDraftSummary(draft: ScenarioDraft, out: string): string {
  const lines = [`Szenario-Entwurf ${draft.scenario.name}: ${draft.scenario.entries.length} Einträge → ${out}`];
  for (const e of draft.scenario.entries) {
    const events = e.expect.events.map((ev) => `${ev.type} ${ev.attribute ?? "–"} ${ev.severity}`).join(", ") || "keine Ereignisse";
    lines.push(`  ${e.id} ${e.edit.op} ${e.url} → ${e.expect.document}, ${events}`);
  }
  if (draft.gaps.length > 0) {
    lines.push("Lücken:");
    for (const g of draft.gaps) lines.push(`  - ${g}`);
  }
  lines.push("Entwurf von Hand prüfen (Suchtexte, Ersatztexte, erwartete Ereignisse), erst dann sim:revisit.");
  return lines.join("\n");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  requireSimulationEnv(env, "sim:draft-scenario");
  if (await exists(args.out)) throw new Error(`${args.out} existiert schon – erst umbenennen oder löschen (ein geprüftes Szenario bleibt stehen)`);
  const { db, close } = createDb(env.DATABASE_URL);
  let draft: ScenarioDraft;
  try {
    draft = await draftScenario(db, getArchive(), { subdivisionKey: args.subdivision, seed: args.seed });
  } finally {
    await close();
  }
  if (draft.scenario.entries.length === 0) {
    process.stdout.write(`Kein Eintrag gefunden:\n${draft.gaps.map((g) => `  - ${g}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(draft.scenario, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${renderDraftSummary(draft, args.out)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

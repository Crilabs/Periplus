import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CostLedger } from "./costs";
import { pilotDir, readJsonl } from "./store";

/*
 * Lab script, pilot "Revier-Suche" (spec docs/superpowers/specs/2026-10-28-periplus-pilot-revier-suche-design.md).
 * Not production code: no queue, no run, nothing written to the database beyond rate tokens and the cost booking of
 * `assess-page`. Run: npx tsx --env-file-if-exists=.env.local scripts/lab/region-search/cli.ts <command> [options]
 */

export type Command = (args: string[], dir: string) => Promise<void>;

/** `--name value` and `--flag` pairs of an argv slice. */
export function parseFlags(args: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const status: Command = async (_args, dir) => {
  const ledger = await CostLedger.open(dir);
  process.stdout.write(`${dir}\nspent ${ledger.totalEur.toFixed(2)} EUR of ${ledger.capEur} EUR\n`);
  for (const [stage, eur] of Object.entries(ledger.byStage())) process.stdout.write(`  ${stage}: ${eur.toFixed(2)} EUR\n`);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort()) {
    const rows = await readJsonl<unknown>(dir, name);
    const size = (await stat(path.join(dir, name))).size;
    process.stdout.write(`  ${name}: ${rows.length} rows, ${(size / 1024).toFixed(0)} KiB\n`);
  }
};

const commands: Record<string, () => Promise<Command>> = {
  status: async () => status,
  areas: async () => (await import("./areas")).areasCommand,
  search: async () => (await import("./search")).searchCommand,
  fetch: async () => (await import("./fetch")).fetchCommand,
  assess: async () => (await import("./assess")).assessCommand,
  extract: async () => (await import("./extract")).extractCommand,
  gazetteer: async () => (await import("./gazetteer")).gazetteerCommand,
  locate: async () => (await import("./locate")).locateCommand,
  compare: async () => (await import("./compare")).compareCommand,
};

export async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  const load = name ? commands[name] : undefined;
  if (!load) {
    process.stderr.write(`usage: cli.ts <${Object.keys(commands).join("|")}> [--option value]\n`);
    process.exit(2);
  }
  const command = await load();
  await command(rest, await pilotDir());
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("region-search", "cli.ts"))) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}

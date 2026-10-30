import { createDb } from "../../../lib/db/client";
import type { Area } from "./areas";
import { parseFlags, type Command } from "./cli";
import { CostLedger } from "./costs";
import { runSearchD } from "./search-dataforseo";
import { readJson } from "./store";

/** `search --engine d|c [--limit n] [--area key]` */
export const searchCommand: Command = async (args, dir) => {
  const flags = parseFlags(args);
  const engine = flags.engine;
  const areas = await readJson<Area[]>(dir, "areas.json");
  if (!areas) throw new Error("areas.json missing: run `areas` first");
  const opts = { limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined, area: typeof flags.area === "string" ? flags.area : undefined };
  const ledger = await CostLedger.open(dir);
  if (engine === "d") {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const { db, close } = createDb(url);
    try {
      await runSearchD(db, ledger, dir, areas, opts);
    } finally {
      await close();
    }
  } else if (engine === "c") {
    const { runSearchC } = await import("./search-claude");
    await runSearchC(ledger, dir, areas, opts);
  } else throw new Error("--engine d or --engine c");
  process.stdout.write(`spent ${ledger.totalEur.toFixed(3)} EUR\n`);
};

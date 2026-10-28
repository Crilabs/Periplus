import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAnthropicClient } from "../../../lib/ai/anthropic";
import { assessPageTask, type AssessPageOutput } from "../../../lib/ai/tasks/assess-page";
import { getConfig } from "../../../lib/config";
import { createDb, type Db } from "../../../lib/db/client";
import { firstWords } from "../../../lib/domain/research/util/dates";
import { parseFlags, type Command } from "./cli";
import { CostLedger } from "./costs";
import type { PageRow } from "./fetch";
import { appendJsonl, readJsonl } from "./store";

/** Spec 5B: the pipeline's own page assessment (`assess-page` v1), so page kinds compare with T3. */
export type Assessment = Pick<AssessPageOutput, "page_kind" | "first_hand" | "generated" | "language" | "berths"> & { url: string; costEur: number; error?: string };

export async function runAssess(db: Db, ledger: CostLedger, dir: string, opts: { limit?: number; concurrency?: number } = {}): Promise<void> {
  const cfg = getConfig();
  const client = createAnthropicClient(db);
  const done = new Set((await readJsonl<Assessment>(dir, "assessments.jsonl")).map((a) => a.url));
  const queue = (await readJsonl<PageRow>(dir, "pages.jsonl")).filter((p) => !p.error && p.chars > 0 && !done.has(p.url)).slice(0, opts.limit);
  const total = queue.length;
  let n = 0;
  const worker = async () => {
    for (;;) {
      const page = queue.shift();
      if (!page) return;
      const md = await readFile(path.join(dir, "pages", page.file), "utf8");
      ledger.assertRoom(0.02);
      let row: Assessment;
      try {
        const result = await client.call(
          assessPageTask,
          { url: page.url, title: page.title, fetchedAt: new Date().toISOString().slice(0, 10), publishedAt: null, text: firstWords(md, cfg.research.assessWords) },
          { stage: "lab.assess" },
        );
        await ledger.add({ stage: "assess", service: "anthropic", units: 1, costEur: result.costEur });
        const o = result.output;
        row = { url: page.url, page_kind: o.page_kind, first_hand: o.first_hand, generated: o.generated, language: o.language, berths: o.berths, costEur: result.costEur };
      } catch (error) {
        row = { url: page.url, page_kind: "other", first_hand: false, generated: false, language: null, berths: [], costEur: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
      }
      await appendJsonl(dir, "assessments.jsonl", [row]);
      n++;
      process.stdout.write(`assess ${String(n).padStart(4)}/${total} ${row.page_kind.padEnd(12)} ${row.first_hand ? "1st" : "   "} ${row.berths.length} berths ${row.costEur.toFixed(4)} EUR  ${page.url.slice(0, 80)}${row.error ? `  ERROR ${row.error}` : ""}\n`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
}

export const assessCommand: Command = async (args, dir) => {
  const flags = parseFlags(args);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const ledger = await CostLedger.open(dir);
    await runAssess(db, ledger, dir, {
      limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
      concurrency: typeof flags.concurrency === "string" ? Number(flags.concurrency) : undefined,
    });
    process.stdout.write(`spent ${ledger.totalEur.toFixed(3)} EUR\n`);
  } finally {
    await close();
  }
};

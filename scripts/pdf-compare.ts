import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { modelPagesToMarkdown } from "../lib/adapters/pdf/claude";
import { runPdftotext } from "../lib/adapters/pdf/pdftotext";
import { createAnthropicClient } from "../lib/ai/anthropic";
import { getConfig, type FetchConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { externalCalls } from "../lib/db/schema";
import { layoutToMarkdown } from "../lib/domain/documents/pdf-layout";

const USAGE = "usage: pdf-compare.ts <file.pdf>… [--model-pages <from>-<to>]";
const OUT = "docs/pilot/m3-pdf-vergleich.md";

export type CompareArgs = { files: string[]; modelPages: { from: number; to: number } | null };

/** PDF paths, and optionally `--model-pages 1-6` (or a single page `3`): the pages Claude also transcribes. */
export function parseArgs(argv: string[]): CompareArgs {
  const files: string[] = [];
  let modelPages: CompareArgs["modelPages"] = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--model-pages") {
      const m = /^(\d+)(?:-(\d+))?$/.exec(argv[++i] ?? "");
      if (!m || modelPages) throw new Error(USAGE);
      const from = Number(m[1]);
      const to = Number(m[2] ?? m[1]);
      if (from < 1 || to < from) throw new Error(USAGE);
      modelPages = { from, to };
    } else if (arg.startsWith("--")) {
      throw new Error(USAGE);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) throw new Error(USAGE);
  return { files, modelPages };
}

export type FileComparison = {
  file: string;
  pages: Array<{ page: number; chars: number; unreadable: boolean }>;
  /** The compared pages: `pdftotext` Markdown and, when transcribed, Claude's. */
  compared: Array<{ page: number; pdftotext: string; claude: string | null }>;
};

/** A fence longer than any backtick run in `text`, so embedded fences stay inside. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** The comparison report (German, for the admin to fill in the check lists). */
export function renderPdfComparison(input: {
  generatedAt: Date;
  files: FileComparison[];
  cost: { calls: number; eur: number };
  pdf: FetchConfig["pdf"];
}): string {
  const out: string[] = [
    "# PDF-Vergleich: pdftotext und Claude",
    "",
    `Erstellt am ${input.generatedAt.toISOString().slice(0, 10)} mit \`npm run pdf:compare\`. Je Datei die Zeichen je Seite, die lokal unlesbaren Seiten und für die gewählten Seiten beide Verfahren nebeneinander. Die Prüflisten sind von Hand auszufüllen.`,
  ];
  for (const f of input.files) {
    const unreadable = f.pages.filter((p) => p.unreadable).map((p) => p.page);
    out.push(
      "",
      `## ${path.basename(f.file)}`,
      "",
      `- Seiten: ${f.pages.length}`,
      `- Unlesbare Seiten (pdftotext): ${unreadable.length > 0 ? unreadable.join(", ") : "keine"}`,
      "",
      "| Seite | Zeichen | Unlesbar |",
      "| ---: | ---: | --- |",
      ...f.pages.map((p) => `| ${p.page} | ${p.chars} | ${p.unreadable ? "ja" : "nein"} |`),
    );
    for (const c of f.compared) {
      out.push("", `### Seite ${c.page}`, "", "#### pdftotext", "", fenced(c.pdftotext, "markdown"), "", "#### Claude", "");
      out.push(c.claude === null ? "Nicht übertragen." : fenced(c.claude, "markdown"));
      out.push(
        "",
        "Prüfliste:",
        "",
        "- [ ] pdftotext: Ortsnamen korrekt",
        "- [ ] pdftotext: Tabellen (Tiefen, Plätze) korrekt",
        ...(c.claude === null ? [] : ["- [ ] Claude: Ortsnamen korrekt", "- [ ] Claude: Tabellen (Tiefen, Plätze) korrekt"]),
      );
    }
  }
  out.push(
    "",
    "## Kosten",
    "",
    `Claude-Aufrufe: ${input.cost.calls}, Kosten laut \`external_calls\`: ${input.cost.eur.toFixed(4)} EUR.`,
    "",
    "## Entscheidung",
    "",
    "Geltende Einstellung `pdf` in `config/fetch.json`:",
    "",
    fenced(JSON.stringify(input.pdf, null, 2), "json"),
    "",
  );
  return out.join("\n");
}

/**
 * Reads the PDFs with `pdftotext`, lets Claude transcribe the chosen pages (real calls, booked in the database of
 * `DATABASE_URL` under one stage) and writes the report.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const stage = `pdf:compare:${new Date().toISOString()}`;
  const { db, close } = createDb(url);
  try {
    const model = createAnthropicClient(db, config);
    const files: FileComparison[] = [];
    for (const file of args.files) {
      const bytes = new Uint8Array(await readFile(file));
      const { pages } = layoutToMarkdown(await runPdftotext(bytes), config.fetch.pdf.unreadableMinChars);
      const chosen = args.modelPages
        ? pages.filter((p) => p.page >= args.modelPages!.from && p.page <= args.modelPages!.to).map((p) => p.page)
        : [];
      const byModel = chosen.length > 0 ? await modelPagesToMarkdown(bytes, chosen, model, { stage }) : new Map<number, string>();
      files.push({
        file,
        pages: pages.map(({ page, chars, unreadable }) => ({ page, chars, unreadable })),
        compared: chosen.map((page) => ({ page, pdftotext: pages[page - 1]!.markdown, claude: byModel.get(page) ?? null })),
      });
      process.stdout.write(`${file}: ${pages.length} pages, ${chosen.length} transcribed by Claude\n`);
    }
    const [cost] = await db
      .select({ calls: sql<number>`count(*)::int`, eur: sql<string>`coalesce(sum(${externalCalls.costEur}), 0)` })
      .from(externalCalls)
      .where(and(eq(externalCalls.service, "anthropic"), eq(externalCalls.stage, stage)));
    const report = renderPdfComparison({
      generatedAt: new Date(),
      files,
      cost: { calls: cost!.calls, eur: Number(cost!.eur) },
      pdf: config.fetch.pdf,
    });
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, report);
    process.stdout.write(`written to ${OUT}\n`);
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

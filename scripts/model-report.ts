import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, type AppConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import type { ComparisonVerdict, DocType } from "../lib/db/schema";
import { COMPARISON_VERDICTS, type ComparisonSummary, type RatingSummary } from "../lib/domain/extraction/comparison";
import { extractionModelDecision, modelComparisonDetail, type ModelDecision } from "../lib/domain/model-comparison-view";

const OUT = "docs/pilot/m4-modellvergleich.md";
const USAGE = "usage: model-report.ts <comparisonId> [--out <file.md>]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<comparisonId>` and optionally `--out <file>`; default `docs/pilot/m4-modellvergleich.md`. */
export function parseArgs(argv: string[]): { comparisonId: string; out: string } {
  const [comparisonId, ...rest] = argv;
  if (!comparisonId || !UUID.test(comparisonId)) throw new Error(USAGE);
  if (rest.length === 0) return { comparisonId, out: OUT };
  if (rest.length !== 2 || rest[0] !== "--out" || !rest[1] || rest[1].startsWith("--")) throw new Error(USAGE);
  return { comparisonId, out: rest[1] };
}

const VERDICT_TEXT: Record<ComparisonVerdict, string> = {
  a_correct: "A richtig",
  b_correct: "B richtig",
  both_ok: "beide richtig",
  both_wrong: "beide falsch",
  unclear: "unklar",
};

export type ReportSampleItem = { unitKey: string; attribute: string; a: unknown; b: unknown; verdict: ComparisonVerdict | null };

export type ModelReportInput = {
  generatedAt: Date;
  comparison: {
    id: string;
    label: string;
    models: string[];
    units: number;
    sources: number;
    docTypes: DocType[];
    shortfall: string[];
    estimateEur: number;
  };
  target: AppConfig["extraction"]["comparison"];
  summary: ComparisonSummary;
  sample: ReportSampleItem[];
  ratings: RatingSummary;
  decision: ModelDecision;
};

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const value = (v: unknown) => (v === null || v === undefined ? "–" : `\`${cell(JSON.stringify(v))}\``);
const pct = (share: number) => `${(share * 100).toFixed(1)} %`;

/**
 * The comparison report (German): method, counters per model, agreement, the verdicts of the deviation sample, cost
 * and the decision ("Vorläufig"/"Entschieden" from `config/models.json`).
 */
export function renderModelReport(input: ModelReportInput): string {
  const { comparison: c, summary, ratings, decision, target } = input;
  const [modelA = "A", modelB = "B"] = c.models;
  const rated = input.sample.filter((s) => s.verdict !== null).length;
  const total = summary.runs.reduce((sum, r) => sum + r.costEur, 0);
  const out: string[] = [
    `# Modellvergleich Extraktion: ${modelA} und ${modelB}`,
    "",
    `Erstellt am ${input.generatedAt.toISOString().slice(0, 10)} mit \`npm run report:models -- ${c.id}\` aus dem Vergleich „${cell(c.label)}“ und den Bewertungen unter \`/compare/models\`.`,
    "",
    "## Methode",
    "",
    `Stichprobe (Spezifikation 06): ${target.units} Einheiten aus mindestens ${target.minSources} Quellen und allen Dokumenttypen. Eine Einheit ist ein Paar (Dokumentversion, Geo-Objekt) mit seinen Erwähnungen; die Auswahl geht reihum über die Dokumenttypen, darin reihum über die Quellen, darin nach \`md5(Version ‖ Objekt)\`.`,
    "",
    `Erreicht: ${c.units} Einheiten aus ${c.sources} Quellen, Dokumenttypen: ${c.docTypes.join(", ") || "keine"}.`,
    "",
    c.shortfall.length === 0 ? "Keine Abweichung von der Vorgabe." : `Abweichungen von der Vorgabe: ${c.shortfall.map((s) => `\`${s}\``).join(", ")}.`,
    "",
    `Beide Modelle extrahieren dieselben Einheiten mit demselben Prompt und Fact-Schema über die Batch-API (Modell A = \`${modelA}\`, Modell B = \`${modelB}\`). Verglichen wird je (Einheit, Attribut) der Fact höchster Konfidenz: Zahlen gelten bis ±${target.numericTolerance} als gleich, Listen als Mengen, sonst der kanonische JSON-Wert. Bewertet werden ${target.ratingSample} Abweichungen und einseitige Facts (stabile Auswahl nach \`md5(Einheit ‖ Attribut)\`).`,
    "",
    "## Kennzahlen je Modell",
    "",
    "| Modell | Einheiten | Facts | Verworfene Zitate | Ungültige Werte | Unbekannte Attribute | Kosten (EUR) | Kosten je Einheit (EUR) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.runs.map(
      (r) =>
        `| ${r.model} | ${r.units} | ${r.facts} | ${r.rejectedQuote} | ${r.invalidValue} | ${r.unknownAttribute} | ${r.costEur.toFixed(4)} | ${r.costPerUnitEur.toFixed(4)} |`,
    ),
    "",
    "## Übereinstimmung",
    "",
    `| gleich | abweichend | nur A | nur B | Anteil gleich |`,
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${summary.agreement.same} | ${summary.agreement.deviation} | ${summary.agreement.onlyA} | ${summary.agreement.onlyB} | ${summary.agreement.pct.toFixed(1)} % |`,
    "",
    "## Urteile der Stichprobe",
    "",
    `${rated} von ${input.sample.length} Einträgen der Stichprobe bewertet.`,
    "",
    "| Urteil | Anzahl | Anteil |",
    "| --- | ---: | ---: |",
    ...COMPARISON_VERDICTS.map((v) => `| ${VERDICT_TEXT[v]} | ${ratings.counts[v]} | ${pct(ratings.shares[v])} |`),
    "",
  ];
  if (input.sample.length > 0) {
    out.push("| Einheit | Attribut | A | B | Urteil |", "| --- | --- | --- | --- | --- |");
    for (const s of input.sample) {
      out.push(`| \`${s.unitKey}\` | \`${cell(s.attribute)}\` | ${value(s.a)} | ${value(s.b)} | ${s.verdict ? VERDICT_TEXT[s.verdict] : "offen"} |`);
    }
    out.push("");
  }
  out.push(
    "## Kosten",
    "",
    `Schätzung vor dem Lauf: ${c.estimateEur.toFixed(2)} EUR; tatsächlich gebucht: ${total.toFixed(4)} EUR (${summary.runs.map((r) => `${r.model} ${r.costEur.toFixed(4)} EUR`).join(", ") || "noch nichts"}).`,
    "",
    "## Entscheidung",
    "",
    `Status: **${decision.status === "decided" ? "Entschieden" : "Vorläufig"}** (\`config/models.json\` \`tasks.extract-facts.decision.status\` = \`${decision.status}\`), Modell \`${decision.model}\`.`,
    "",
    decision.note ?? "",
    "",
  );
  return out.join("\n");
}

/** Reads the comparison from the database of `DATABASE_URL` and writes the report. */
async function main(): Promise<void> {
  const { comparisonId, out } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const { db, close } = createDb(url);
  try {
    const detail = await modelComparisonDetail(db, comparisonId, config);
    if (!detail) throw new Error(`model comparison ${comparisonId} does not exist`);
    const report = renderModelReport({
      generatedAt: new Date(),
      comparison: detail,
      target: config.extraction.comparison,
      summary: detail.summary,
      sample: detail.sample.map((s) => ({ unitKey: s.unitKey, attribute: s.attribute, a: s.a?.value ?? null, b: s.b?.value ?? null, verdict: s.verdict })),
      ratings: detail.ratings,
      decision: extractionModelDecision(config),
    });
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, report);
    process.stdout.write(`${detail.sample.length} sample items (${detail.ratedInSample} rated), written to ${out}\n`);
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

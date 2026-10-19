import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConverterName } from "../lib/adapters/fetch";
import { getConfig, type FetchConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import {
  CONVERTER_SAMPLE,
  converterSummary,
  listConverterSamples,
  type ConverterSummary,
  type Rating,
} from "../lib/domain/converter-comparison";
import { CONVERTERS } from "../lib/domain/sources/crawl-rules";

const OUT = "docs/pilot/m3-konverter-vergleich.md";

export type ReportSample = {
  url: string;
  domain: string;
  ratings: Partial<Record<ConverterName, Rating | null>>;
  errors: Partial<Record<ConverterName, string>>;
};

export type ReportDecision = FetchConfig["decision"] & {
  defaultConverter: ConverterName;
  converterBySource: Record<string, ConverterName>;
};

/** Text for a Markdown table cell: pipes escaped, line breaks flattened. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const percent = (v: number | null) => (v === null ? "–" : `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} %`);
const yesNo = (v: boolean | null) => (v === null ? "–" : v ? "ja" : "nein");

function ratingText(rating: Rating | null | undefined, error: string | undefined): string {
  if (error) return `Fehler: ${cell(error)}`;
  if (!rating) return "nicht bewertet";
  return `Inhalt ${yesNo(rating.mainContent)}, Boilerplate entfernt ${yesNo(rating.boilerplateRemoved)}, Tabellen ${yesNo(rating.tablesKept)}`;
}

/** The comparison report (German): method, results per converter, costs and duration, pages, and the decision. */
export function renderConverterReport(input: {
  generatedAt: Date;
  summary: ConverterSummary[];
  samples: ReportSample[];
  decision: ReportDecision;
}): string {
  const { decision } = input;
  const exceptions = Object.entries(decision.converterBySource).sort(([a], [b]) => a.localeCompare(b));
  const out: string[] = [
    "# Konverter-Vergleich: Jina, Firecrawl und lokal",
    "",
    `Erstellt am ${input.generatedAt.toISOString().slice(0, 10)} mit \`npm run report:converters\` aus den Bewertungen unter \`/compare/converters\`.`,
    "",
    "## Methode",
    "",
    `Stichprobe: ${CONVERTER_SAMPLE.pages} Seiten aus ${CONVERTER_SAMPLE.sources} Quellen – die ${CONVERTER_SAMPLE.sources} freigegebenen Quellen mit den meisten aktiven HTML-Dokumenten, je ${CONVERTER_SAMPLE.perSource} Dokumente (stabile Auswahl nach \`md5(url_normalized)\`). Jede Seite wird einmal von Periplus abgerufen (robots.txt beachtet); der lokale Konverter wandelt dieses HTML um, Jina und Firecrawl laden die Seite selbst.`,
    "",
    "Kriterien je Seite und Konverter (von Hand bewertet):",
    "",
    "- **Hauptinhalt vollständig**: der eigentliche Text der Seite ist ganz enthalten.",
    "- **Boilerplate entfernt**: Navigation, Fußzeilen, Cookie-Hinweise und Werbung fehlen.",
    "- **Tabellen erhalten**: Tabellen der Seite sind als Tabellen lesbar (nur Seiten mit Tabellen zählen).",
    "",
    "Anteile beziehen sich auf die bewerteten Seiten; Kosten, Laufzeit und Länge sind Mittelwerte der erfolgreichen Umwandlungen.",
    "",
    "## Ergebnis je Konverter",
    "",
    "| Konverter | Seiten | Fehler | Bewertet | Hauptinhalt | Boilerplate entfernt | Tabellen erhalten |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...input.summary.map(
      (s) =>
        `| ${s.converter} | ${s.pages} | ${s.errors} | ${s.rated} | ${percent(s.mainContentPct)} | ${percent(s.boilerplatePct)} | ${percent(s.tablesPct)} |`,
    ),
    "",
    "## Kosten und Laufzeit",
    "",
    "| Konverter | Kosten je Seite (EUR) | Kosten für 1000 Seiten (EUR) | Laufzeit je Seite | Zeichen je Seite |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...input.summary.map(
      (s) =>
        `| ${s.converter} | ${s.avgCostEur.toFixed(4)} | ${(s.avgCostEur * 1000).toFixed(2)} | ${(s.avgDurationMs / 1000).toFixed(1)} s | ${s.avgChars} |`,
    ),
    "",
    "## Seiten",
    "",
  ];
  if (input.samples.length === 0) {
    out.push("Keine Seiten in der Stichprobe.");
  } else {
    out.push(`| Quelle | URL | ${CONVERTERS.join(" | ")} |`, `| --- | --- |${CONVERTERS.map(() => " --- |").join("")}`);
    for (const s of input.samples) {
      const cells = CONVERTERS.map((c) => ratingText(s.ratings[c], s.errors[c]));
      out.push(`| ${cell(s.domain)} | ${cell(s.url)} | ${cells.join(" | ")} |`);
    }
  }
  out.push(
    "",
    "## Entscheidung",
    "",
    `Status: **${decision.status === "decided" ? "Entschieden" : "Vorläufig"}** (\`config/fetch.json\` \`decision.status\` = \`${decision.status}\`)`,
    "",
    decision.note,
    "",
    `- Standard: \`${decision.defaultConverter}\``,
    `- Ausnahmen: ${exceptions.length === 0 ? "keine" : exceptions.map(([domain, c]) => `\`${domain}\` → \`${c}\``).join(", ")}`,
    "",
  );
  return out.join("\n");
}

/** Reads the comparison from the database of `DATABASE_URL` and writes the report. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { fetch } = getConfig();
  const { db, close } = createDb(url);
  try {
    const [summary, rows] = await Promise.all([converterSummary(db), listConverterSamples(db)]);
    const samples: ReportSample[] = rows.map((r) => ({
      url: r.url,
      domain: r.domain,
      ratings: Object.fromEntries(Object.entries(r.outputs).map(([c, o]) => [c, o.rating])),
      errors: Object.fromEntries(Object.entries(r.outputs).flatMap(([c, o]) => (o.error ? [[c, o.error]] : []))),
    }));
    const report = renderConverterReport({
      generatedAt: new Date(),
      summary,
      samples,
      decision: { ...fetch.decision, defaultConverter: fetch.defaultConverter, converterBySource: fetch.converterBySource },
    });
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, report);
    process.stdout.write(`${samples.length} pages, written to ${OUT}\n`);
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

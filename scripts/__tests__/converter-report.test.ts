import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { ConverterSummary } from "@/lib/domain/converter-comparison";
import { parseArgs, renderConverterReport } from "../converter-report";

const summary: ConverterSummary[] = [
  { converter: "jina", pages: 50, errors: 2, rated: 48, mainContentPct: 93.8, boilerplatePct: 87.5, tablesPct: 80, avgCostEur: 0.00031, avgDurationMs: 2400, avgChars: 5120 },
  { converter: "firecrawl", pages: 50, errors: 0, rated: 50, mainContentPct: 96, boilerplatePct: 92, tablesPct: null, avgCostEur: 0.0047, avgDurationMs: 3100, avgChars: 4800 },
  { converter: "local", pages: 50, errors: 0, rated: 50, mainContentPct: 90, boilerplatePct: 84, tablesPct: 75, avgCostEur: 0, avgDurationMs: 180, avgChars: 4500 },
];

describe("converter report", () => {
  it("writes to docs/pilot by default or to --out", () => {
    expect(parseArgs([])).toEqual({ out: "docs/pilot/m3-konverter-vergleich.md" });
    expect(parseArgs(["--out", "/out/report.md"])).toEqual({ out: "/out/report.md" });
    for (const argv of [["--out"], ["--out", "--x"], ["x.md"], ["--out", "a", "b"]]) expect(() => parseArgs(argv)).toThrow(/usage/);
  });

  it("the report marks a provisional decision", () => {
    const { fetch } = getConfig();
    const report = renderConverterReport({
      generatedAt: new Date("2026-10-19T08:00:00Z"),
      summary,
      samples: [
        {
          url: "https://example.test/bay|1",
          domain: "example.test",
          ratings: { local: { mainContent: true, boilerplateRemoved: false, tablesKept: null }, jina: null },
          errors: { firecrawl: "HTTP 403" },
        },
      ],
      decision: { ...fetch.decision, defaultConverter: fetch.defaultConverter, converterBySource: fetch.converterBySource },
    });
    expect(report).toContain("# Konverter-Vergleich");
    expect(report).toContain("50 Seiten aus 10 Quellen");
    expect(report).toMatch(/\| local \| 50 \| 0 \| 50 \| 90 % \| 84 % \| 75 % \|/);
    expect(report).toMatch(/\| firecrawl \|.*\| – \|/);
    expect(report).toContain("0.0047");
    // A pipe in a URL does not break the table.
    expect(report).toContain("https://example.test/bay\\|1");
    expect(report).toContain("Fehler: HTTP 403");
    expect(report).toMatch(/## Entscheidung[\s\S]*Vorläufig[\s\S]*Standard: `local`[\s\S]*Ausnahmen: keine/);
  });

  it("a decided decision lists its exceptions", () => {
    const report = renderConverterReport({
      generatedAt: new Date("2026-10-19T08:00:00Z"),
      summary,
      samples: [],
      decision: { status: "decided", note: "Firecrawl für JS-Seiten.", defaultConverter: "local", converterBySource: { "example.com": "firecrawl" } },
    });
    expect(report).toMatch(/## Entscheidung[\s\S]*Entschieden/);
    expect(report).not.toContain("Vorläufig");
    expect(report).toContain("`example.com` → `firecrawl`");
    expect(report).toContain("Firecrawl für JS-Seiten.");
  });
});

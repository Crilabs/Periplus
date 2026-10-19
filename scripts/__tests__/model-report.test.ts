import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { ComparisonSummary, RatingSummary } from "@/lib/domain/extraction/comparison";
import { extractionModelDecision } from "@/lib/domain/model-comparison-view";
import { parseArgs as parseCompareArgs } from "../compare-models";
import { parseArgs, renderModelReport, type ModelReportInput } from "../model-report";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const summary: ComparisonSummary = {
  runs: [
    { extractionRunId: "a", model: "claude-sonnet-5-5", units: 200, facts: 640, rejectedQuote: 12, invalidValue: 3, unknownAttribute: 1, costEur: 1.234567, costPerUnitEur: 0.006173 },
    { extractionRunId: "b", model: "claude-opus-5-5", units: 200, facts: 700, rejectedQuote: 5, invalidValue: 1, unknownAttribute: 0, costEur: 2.5, costPerUnitEur: 0.0125 },
  ],
  agreement: { same: 400, deviation: 150, onlyA: 40, onlyB: 100, pct: 58 },
};
const ratings: RatingSummary = {
  rated: 2,
  counts: { a_correct: 1, b_correct: 0, both_ok: 1, both_wrong: 0, unclear: 0 },
  shares: { a_correct: 0.5, b_correct: 0, both_ok: 0.5, both_wrong: 0, unclear: 0 },
};

function input(decision = extractionModelDecision(getConfig())): ModelReportInput {
  const cfg = getConfig();
  return {
    generatedAt: new Date("2026-10-19T08:00:00Z"),
    comparison: { id: ID, label: "pilot", models: cfg.models.comparison.models, units: 200, sources: 9, docTypes: ["pilot_guide", "trip_report", "forum"], shortfall: [], estimateEur: 6.42 },
    target: cfg.extraction.comparison,
    summary,
    sample: [
      { unitKey: "v1:o1", attribute: "holding", a: "good", b: "moderate", verdict: "a_correct" },
      { unitKey: "v2:o2", attribute: "seabed", a: null, b: [{ type: "sand", share: 1 }], verdict: null },
    ],
    ratings,
    decision,
  };
}

describe("model report", () => {
  it("takes the comparison id and an optional --out", () => {
    expect(parseArgs([ID])).toEqual({ comparisonId: ID, out: "docs/pilot/m4-modellvergleich.md" });
    expect(parseArgs([ID, "--out", "/out/r.md"])).toEqual({ comparisonId: ID, out: "/out/r.md" });
    for (const argv of [[], ["nope"], [ID, "--out"], [ID, "x.md"], [ID, "--out", "a", "b"]]) expect(() => parseArgs(argv)).toThrow(/usage/);
  });

  it("the report marks the provisional decision", () => {
    const report = renderModelReport(input());
    expect(report).toContain("# Modellvergleich Extraktion: claude-sonnet-5-5 und claude-opus-5-5");
    expect(report).toContain("200 Einheiten aus mindestens 8 Quellen und allen Dokumenttypen");
    expect(report).toMatch(/\| claude-sonnet-5-5 \| 200 \| 640 \| 12 \| 3 \| 1 \| 1\.2346 \| 0\.0062 \|/);
    expect(report).toMatch(/\| 400 \| 150 \| 40 \| 100 \| 58\.0 % \|/);
    expect(report).toContain("1 von 2 Einträgen der Stichprobe bewertet");
    expect(report).toMatch(/\| A richtig \| 1 \| 50\.0 % \|/);
    expect(report).toMatch(/\| `v2:o2` \| `seabed` \| – \| `\[\{"type":"sand","share":1\}\]` \| offen \|/);
    expect(report).toContain("Schätzung vor dem Lauf: 6.42 EUR");
    expect(report).toMatch(/## Entscheidung[\s\S]*\*\*Vorläufig\*\*[\s\S]*Modell `claude-sonnet-5-5`/);
  });

  it("a decided model and a shortfall show up", () => {
    const decided = renderModelReport({
      ...input({ model: "claude-opus-5-5", status: "decided", note: "Opus nach 50 Urteilen." }),
      comparison: { ...input().comparison, shortfall: ["sources:5/8"] },
    });
    expect(decided).toMatch(/## Entscheidung[\s\S]*\*\*Entschieden\*\*[\s\S]*Modell `claude-opus-5-5`[\s\S]*Opus nach 50 Urteilen\./);
    expect(decided).not.toContain("Vorläufig");
    expect(decided).toContain("`sources:5/8`");
  });

  it("compare:models takes a label, a cost ceiling and --start", () => {
    expect(parseCompareArgs(["--label", "pilot"])).toEqual({ label: "pilot", maxEur: 10, start: false });
    expect(parseCompareArgs(["--label", "pilot", "--max-eur", "4.5", "--start"])).toEqual({ label: "pilot", maxEur: 4.5, start: true });
    for (const argv of [[], ["--start"], ["--label"], ["--label", "--start"], ["--label", "x", "--max-eur", "0"], ["--label", "x", "--max-eur", "abc"], ["--label", "x", "--other", "y"]]) {
      expect(() => parseCompareArgs(argv)).toThrow(/usage/);
    }
  });
});

import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { parseArgs, renderPdfComparison } from "../pdf-compare";

describe("pdf-compare CLI", () => {
  it("parses files and the model page range", () => {
    expect(parseArgs(["a.pdf", "b.pdf"])).toEqual({ files: ["a.pdf", "b.pdf"], modelPages: null });
    expect(parseArgs(["a.pdf", "--model-pages", "1-6"])).toEqual({ files: ["a.pdf"], modelPages: { from: 1, to: 6 } });
    expect(parseArgs(["--model-pages", "3", "a.pdf"])).toEqual({ files: ["a.pdf"], modelPages: { from: 3, to: 3 } });
  });

  it("rejects bad arguments", () => {
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["a.pdf", "--model-pages", "6-1"])).toThrow(/usage/);
    expect(() => parseArgs(["a.pdf", "--model-pages", "0"])).toThrow(/usage/);
    expect(() => parseArgs(["a.pdf", "--model-pages"])).toThrow(/usage/);
    expect(() => parseArgs(["a.pdf", "--foo"])).toThrow(/usage/);
  });

  it("renders pages, both methods, check lists, costs and the decision", () => {
    const report = renderPdfComparison({
      generatedAt: new Date("2026-10-19T08:00:00Z"),
      files: [
        {
          file: "pilot/revier.pdf",
          pages: [
            { page: 1, chars: 1200, unreadable: false },
            { page: 2, chars: 3, unreadable: true },
          ],
          compared: [{ page: 2, pdftotext: "<!-- page 2 -->\n\n```text\nA  B  C\n```", claude: "| Ort | Tiefe |" }],
        },
      ],
      cost: { calls: 1, eur: 0.0123 },
      pdf: getConfig().fetch.pdf,
    });
    expect(report).toContain("## revier.pdf");
    expect(report).toContain("- Unlesbare Seiten (pdftotext): 2");
    expect(report).toContain("| 2 | 3 | ja |");
    expect(report).toContain("````markdown\n<!-- page 2 -->\n\n```text\nA  B  C\n```\n````");
    expect(report).toContain("- [ ] Claude: Tabellen (Tiefen, Plätze) korrekt");
    expect(report).toContain("- [ ] pdftotext: Ortsnamen korrekt");
    expect(report).toContain("0.0123 EUR");
    expect(report).toMatch(/## Entscheidung[\s\S]*"extractor": "pdftotext"/);
  });
});

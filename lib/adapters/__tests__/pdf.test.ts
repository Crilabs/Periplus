import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { convertPdf } from "@/lib/adapters/pdf";
import { hasPdftotext, runPdftotext } from "@/lib/adapters/pdf/pdftotext";
import { splitPdfPages } from "@/lib/adapters/pdf/split";
import { MockModel } from "@/lib/ai/mock";
import { BudgetExceeded } from "@/lib/domain/costs";
import { getConfig } from "@/lib/config";

const twoPages = new Uint8Array(readFileSync("test/fixtures/pdf/two-pages.pdf"));
const sample = readFileSync("test/fixtures/pdf/layout-sample.txt", "utf8");
const [page1] = sample.split("\f");
/** Page 2 as a broken font extracts it: replacement and private-use characters. */
const garbled = `${page1}\f${"� ".repeat(80)}\f`;
const cfg = () => getConfig().fetch.pdf;
const pdftotextHere = await hasPdftotext();

describe("convertPdf", () => {
  it("an unreadable page is replaced by the model page", async () => {
    const seen: number[] = [];
    const model = new MockModel({
      "pdf.to_markdown": (input) => {
        seen.push((input as { page: number }).page);
        return { markdown: "## Tiefen und Plätze\n\n| Ort | Tiefe |\n| --- | --- |\n| Perdika | 3-8 m |" };
      },
    });
    const pdftotext = vi.fn(async () => garbled);
    const r = await convertPdf(twoPages, { pdftotext, model, cfg: cfg() }, { stage: "test" });
    expect(r.converter).toBe("pdftotext+claude");
    expect(r.modelPages).toEqual([2]);
    expect(r.unreadablePages).toEqual([]);
    expect(seen).toEqual([2]);
    expect(r.markdown).toContain("<!-- page 1 -->\n\n## REVIERFÜHRER SARONISCHER GOLF");
    expect(r.markdown).toContain("<!-- page 2 -->\n\n## Tiefen und Plätze\n\n| Ort | Tiefe |");
    expect(r.markdown).not.toContain("�");
  });

  it("hands the model the single unreadable page as a one-page PDF", async () => {
    const call = vi.fn(async (...args: [task: unknown, input: unknown, ctx?: unknown]) => {
      const input = args[1];
      const { pdf } = input as { pdf: Uint8Array };
      expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
      return { output: { markdown: "Seite" }, model: "m", promptVersion: 1, usage: { inputTokens: 0, outputTokens: 0 }, costEur: 0 };
    });
    const sourceId = "00000000-0000-4000-8000-000000000001";
    await convertPdf(twoPages, { pdftotext: async () => garbled, model: { call } as never, cfg: cfg() }, { runId: "r", stage: "s", sourceId });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toEqual({ runId: "r", stage: "s", sourceId });
  });

  it("modelFallback false calls no model", async () => {
    const model = new MockModel({});
    const spy = vi.spyOn(model, "call");
    const r = await convertPdf(twoPages, { pdftotext: async () => garbled, model, cfg: { ...cfg(), modelFallback: false } }, {});
    expect(spy).not.toHaveBeenCalled();
    expect(r.converter).toBe("pdftotext");
    expect(r.modelPages).toEqual([]);
    expect(r.unreadablePages).toEqual([2]);
    expect(r.markdown).toContain("<!-- page 2 -->");
  });

  it("more unreadable pages than allowed calls no model", async () => {
    const model = new MockModel({});
    const spy = vi.spyOn(model, "call");
    const r = await convertPdf(
      twoPages,
      { pdftotext: async () => garbled, model, cfg: { ...cfg(), maxModelPagesPerDocument: 1, unreadableMinChars: 100_000 } },
      {},
    );
    expect(spy).not.toHaveBeenCalled();
    expect(r.unreadablePages).toEqual([1, 2]);
  });

  it("a budget running out midway keeps the pages already transcribed and lists the rest as unreadable", async () => {
    const calls: number[] = [];
    const model = {
      call: async (_task: unknown, input: unknown) => {
        const page = (input as { page: number }).page;
        calls.push(page);
        if (calls.length > 1) throw new BudgetExceeded("anthropic", 5, 5);
        return { output: { markdown: `Seite ${page}` }, model: "m", promptVersion: 1, usage: { inputTokens: 0, outputTokens: 0 }, costEur: 0 };
      },
    };
    const allGarbled = `${"� ".repeat(80)}\f${"� ".repeat(80)}\f`;
    const r = await convertPdf(twoPages, { pdftotext: async () => allGarbled, model: model as never, cfg: cfg() }, {});
    expect(calls).toEqual([1, 2]);
    expect(r).toMatchObject({ converter: "pdftotext+claude", modelPages: [1], unreadablePages: [2] });
    expect(r.markdown).toContain("<!-- page 1 -->\n\nSeite 1");
    expect(r.markdown).toContain("<!-- page 2 -->");

    // The budget already spent before the first page: pdftotext only.
    const broke = { call: async () => Promise.reject(new BudgetExceeded("anthropic", 5, 5)) };
    const none = await convertPdf(twoPages, { pdftotext: async () => allGarbled, model: broke as never, cfg: cfg() }, {});
    expect(none).toMatchObject({ converter: "pdftotext", modelPages: [], unreadablePages: [1, 2] });
  });

  it("readable pages need no model", async () => {
    const r = await convertPdf(twoPages, { pdftotext: async () => sample, cfg: cfg() }, {});
    expect(r).toMatchObject({ converter: "pdftotext", modelPages: [], unreadablePages: [] });
  });
});

describe("splitPdfPages", () => {
  it("cuts single pages, 1-based", async () => {
    const [second] = await splitPdfPages(twoPages, [2]);
    const doc = await PDFDocument.load(second!);
    expect(doc.getPageCount()).toBe(1);
    await expect(splitPdfPages(twoPages, [3])).rejects.toThrow(/page 3/);
  });
});

describe("pdftotext", () => {
  it.skipIf(!pdftotextHere)("pdftotext reads the two-page fixture", async () => {
    const text = await runPdftotext(twoPages);
    const pages = text.split("\f");
    expect(pages[0]).toContain("ANKERPLAETZE AEGINA");
    expect(pages[1]).toMatch(/Perdika\s{2,}3-8 m\s{2,}40/);
  });

  it.skipIf(!pdftotextHere)("output beyond the cap is an error", async () => {
    await expect(runPdftotext(twoPages, { maxOutputBytes: 10 })).rejects.toThrow(/exceeds 10 bytes/);
  });

  it.skipIf(!pdftotextHere)("a broken file is an error", async () => {
    await expect(runPdftotext(new TextEncoder().encode("not a pdf"))).rejects.toThrow(/pdftotext/);
  });
});

import { describe, expect, it } from "vitest";
import { unitText } from "@/lib/domain/research/unit-text";

const cfg = { maxUnitWords: 3000, windowWords: 600 };
const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

describe("unitText", () => {
  it("returns a short text unchanged without offsets", () => {
    const md = "We anchored at **Vathi** last night.";
    expect(unitText(md, ["Vathi"], cfg)).toEqual({ text: md, offset: null });
  });

  it("cuts windows around two occurrences of a name in a long text", () => {
    const md = `${filler(30000, "a")} Vathi ${filler(30000, "b")}\n\nBei Vathi liegt eine Bucht. ${filler(20000, "c")}`;
    const { text, offset } = unitText(md, ["Vathi"], cfg);
    expect(text.split("\n\n[…]\n\n")).toHaveLength(2);
    expect(text.length).toBeLessThanOrEqual(2 * (2 * 600 * 8 + 5));
    expect(text).toContain("a29999 Vathi b0");
    expect(text).not.toContain("a100 ");
    expect(offset).toHaveLength(text.length);
  });

  it("maps a quote of the second window back to its place in the markdown", () => {
    const md = `${filler(30000, "a")} Vathi ${filler(30000, "b")}\n\nBei Vathi liegt eine Bucht. ${filler(20000, "c")}`;
    const { text, offset } = unitText(md, ["Vathi"], cfg);
    const quote = "Bei Vathi liegt eine Bucht.";
    const at = text.indexOf(quote);
    expect(at).toBeGreaterThan(0);
    const start = offset![at]!;
    const end = offset![at + quote.length - 1]! + 1;
    expect(md.slice(start, end)).toBe(quote);
    expect(start).toBe(md.indexOf(quote));
  });

  it("marks the separator characters with -1", () => {
    const md = `${filler(5000, "a")} Vathi ${filler(5000, "b")} ${filler(5000, "c")} Vathi ${filler(100, "d")}`;
    const { text, offset } = unitText(md, ["Vathi"], cfg);
    const sep = "\n\n[…]\n\n";
    const at = text.indexOf(sep);
    expect(at).toBeGreaterThan(0);
    for (let i = at; i < at + sep.length; i++) expect(offset![i]).toBe(-1);
    expect(offset![at - 1]).toBeGreaterThanOrEqual(0);
    expect(offset![at + sep.length]).toBeGreaterThan(offset![at - 1]!);
  });

  it("merges overlapping windows", () => {
    const md = `${filler(5000, "a")} Vathi ${filler(100, "m")} Vathi ${filler(5000, "b")}`;
    const { text } = unitText(md, ["Vathi"], cfg);
    expect(text).not.toContain("[…]");
    expect(text.match(/Vathi/g)).toHaveLength(2);
  });

  it("finds Greek names case- and accent-insensitively on the original positions", () => {
    const md = `${filler(3000, "a")} Στο ΒΑΘΎ ήταν ωραία. ${filler(3000, "b")}`;
    const { text, offset } = unitText(md, ["Βαθύ"], { maxUnitWords: 1000, windowWords: 5 });
    expect(text).toContain("ΒΑΘΎ");
    const at = text.indexOf("ΒΑΘΎ");
    expect(md.slice(offset![at]!, offset![at]! + 4)).toBe("ΒΑΘΎ");
  });

  it("finds a name through markdown emphasis and matches whole words only", () => {
    const md = `${filler(3000, "a")} **Vathi**, ${filler(10, "x")} Vathia ${filler(3000, "b")}`;
    const { text } = unitText(md, ["Vathi"], { maxUnitWords: 1000, windowWords: 2 });
    expect(text).toContain("**Vathi**,");
    expect(text).not.toContain("Vathia");
  });

  it("caps a text with many occurrences at maxUnitWords words, windows in document order", () => {
    // a name every 1,200 words in an 80,000-word text
    const md = Array.from({ length: 80000 }, (_, i) => (i % 1200 === 0 ? "Vathi" : `w${i}`)).join(" ");
    const { text, offset } = unitText(md, ["Vathi"], { maxUnitWords: 12000, windowWords: 600 });
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(12000);
    expect(text.startsWith("Vathi w1 w2")).toBe(true);
    expect(offset).toHaveLength(text.length);
    expect(md.slice(offset![0]!, offset![0]! + 5)).toBe("Vathi");
  });

  it("uses the first words when no name occurs", () => {
    const md = filler(3000, "w");
    const { text, offset } = unitText(md, ["Vathi"], { maxUnitWords: 1000, windowWords: 600 });
    expect(text.split(/\s+/)).toHaveLength(1000);
    expect(text).toBe(md.slice(0, text.length));
    expect(offset).toHaveLength(text.length);
    expect(offset![5]).toBe(5);
  });

  it("uses the first words for empty names too", () => {
    const md = filler(3000, "w");
    expect(unitText(md, [""], { maxUnitWords: 1000, windowWords: 600 }).text.split(/\s+/)).toHaveLength(1000);
  });
});

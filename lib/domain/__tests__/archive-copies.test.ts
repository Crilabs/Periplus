import { describe, expect, it } from "vitest";
import { copyIndex } from "@/lib/domain/documents/archive-copies";

/*
 * The 15-word copy check of the delivery (spec 08, anti-goal 3): held against the package's source documents, the
 * markdown its places' facts and landing hints were extracted from (N6).
 */

/** `n` distinct words: letters only, a running suffix. */
function words(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `wort${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"qrstuvwxyz"[Math.floor(i / 26)]}`);
}

describe("copyIndex", () => {
  it("exactly 15 copied words are a hit (spec 08: a 15-word shingle)", () => {
    const w = words(30);
    expect(copyIndex([w.join(" ")]).longestRun(`Die Bucht ist schön. ${w.slice(5, 20).join(" ")} Mehr nicht.`)).toBe(15);
  });

  it("a 16-word sequence copied from a source is found, a 14-word one is not, a short text never", () => {
    const w = words(30);
    const index = copyIndex([w.join(" ")]);
    expect(index.longestRun(`Die Bucht ist schön. ${w.slice(5, 21).join(" ")} Mehr nicht.`)).toBe(16);
    expect(index.longestRun(`Die Bucht ist schön. ${w.slice(5, 19).join(" ")} Mehr nicht.`)).toBe(0);
    expect(index.longestRun("zu kurz")).toBe(0);
  });

  it("longestRun is the longest copied run of consecutive words, not the sum of separate copies", () => {
    const w = words(60);
    const index = copyIndex([w.join(" ")]);
    expect(index.longestRun(`${w.slice(0, 15).join(" ")} und dann ${w.slice(30, 45).join(" ")}`)).toBe(15);
    expect(index.longestRun(`Erst ${w.slice(40, 58).join(" ")} dann`)).toBe(18);
  });

  it("case and accents do not hide a copy; a text from no source document is no copy", () => {
    const w = words(30);
    const index = copyIndex(["andere Quelle ohne Bezug", w.join(" ")]);
    expect(index.longestRun(w.slice(0, 16).join(" ").toUpperCase())).toBe(16);
    expect(copyIndex(["andere Quelle ohne Bezug"]).longestRun(w.slice(0, 16).join(" "))).toBe(0);
    expect(copyIndex([]).longestRun(w.join(" "))).toBe(0);
  });
});

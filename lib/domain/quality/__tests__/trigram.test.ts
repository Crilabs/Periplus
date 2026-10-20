import { describe, expect, it } from "vitest";
import { trigramSimilarity } from "../trigram";

describe("trigramSimilarity", () => {
  it("trigram similarity follows pg_trgm", () => {
    expect(trigramSimilarity("vathi", "vathi")).toBe(1);
    // 9 shared of 14 trigrams (ruling T7-R1)
    expect(trigramSimilarity("porto cheli", "porto heli")).toBeCloseTo(0.64, 1);
    expect(trigramSimilarity("porto cheli", "porto heli")).toBeCloseTo(9 / 14, 10);
    expect(trigramSimilarity("vathy", "vathi")).toBe(0.5);
  });

  it("ignores case, punctuation and word order like pg_trgm", () => {
    expect(trigramSimilarity("Vathi", "vathi")).toBe(1);
    expect(trigramSimilarity("agia-marina", "marina agia")).toBe(1);
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
  });

  it("is 0 for empty or punctuation-only input", () => {
    expect(trigramSimilarity("", "")).toBe(0);
    expect(trigramSimilarity("--", "vathi")).toBe(0);
  });
});

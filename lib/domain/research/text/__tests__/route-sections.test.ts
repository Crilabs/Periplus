import { describe, expect, it } from "vitest";
import { routeSections } from "../route-sections";

const words = (n: number, word = "sea") => Array.from({ length: n }, () => word).join(" ");
const countWords = (s: string) => s.match(/\S+/g)?.length ?? 0;

describe("route sections", () => {
  it("a 45,000-word report is split at headings into sections of at most 20,000 words", () => {
    const md = ["# Day 1", words(15000), "## Day 2", words(15000), "## Day 3", words(14991)].join("\n\n");
    expect(countWords(md)).toBe(45000);
    const sections = routeSections(md, 20000);
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.split("\n")[0])).toEqual(["# Day 1", "## Day 2", "## Day 3"]);
    for (const s of sections) expect(countWords(s)).toBeLessThanOrEqual(20000);
    expect(sections.map(countWords).reduce((a, b) => a + b)).toBe(45000);

    // up to the limit the whole text is one section; a part without a heading is cut hard by words
    expect(routeSections(md, 45000)).toEqual([md]);
    const plain = routeSections(words(45000), 20000);
    expect(plain.map(countWords)).toEqual([20000, 20000, 5000]);
    // short sections between headings are joined up to the limit
    expect(routeSections(["# A", words(100), "# B", words(100), "#### not a split", words(100), "# C", words(30000)].join("\n\n"), 20000).map(countWords)).toEqual([
      308, 20000, 10002,
    ]);
  });
});

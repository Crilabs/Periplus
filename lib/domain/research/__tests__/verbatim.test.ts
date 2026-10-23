import { describe, expect, it } from "vitest";
import { copiesSource } from "@/lib/domain/research/verbatim";

const source = "the anchorage at vathi is well protected from the north wind and has good holding in sand";

describe("copiesSource", () => {
  it("is true for 8 shared consecutive words", () => {
    expect(copiesSource("Note: at vathi is well protected from the north wind", source, 8)).toBe(true);
  });
  it("is false for 7 shared words", () => {
    expect(copiesSource("Note: at vathi is well protected from the", source, 8)).toBe(false);
  });
  it("ignores case and punctuation", () => {
    expect(copiesSource("AT Vathi, is well-protected; FROM the north wind!", source, 8)).toBe(true);
  });
  it("is false when the shared words are not consecutive", () => {
    expect(copiesSource("at vathi is well protected x from the north wind", source, 8)).toBe(false);
  });
  it("is false for a statement shorter than the limit", () => {
    expect(copiesSource("at vathi", source, 8)).toBe(false);
  });
});

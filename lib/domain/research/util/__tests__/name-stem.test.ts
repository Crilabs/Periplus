import { describe, expect, it } from "vitest";
import { stemName } from "../name-stem";

const cfg = { minWordLetters: 5, minStemLetters: 4 };

describe("stemName", () => {
  it("maps nominative, genitive and transliterated forms of a Greek name to one stem (B34)", () => {
    expect(stemName("lavrion", cfg)).toBe("lavr");
    expect(stemName("lavriou", cfg)).toBe("lavr");
    expect(stemName("lavrio", cfg)).toBe("lavr");
    expect(stemName("ormos monastiriou", cfg)).toBe(stemName("ormos monastiri", cfg));
    expect(stemName("λαυριου", cfg)).toBe(stemName("λαυριο", cfg));
  });

  it("keeps short words and words whose stem would get too short", () => {
    expect(stemName("ormos", cfg)).toBe("ormos");
    expect(stemName("poros", cfg)).toBe("poros");
    expect(stemName("kea", cfg)).toBe("kea");
  });

  it("stems a very long word from a web page in linear time", () => {
    const word = `${"a".repeat(200_000)}x`;
    const start = performance.now();
    expect(stemName(word, cfg)).toBe(word);
    expect(stemName(`${"x".repeat(200_000)}${"a".repeat(200_000)}`, cfg)).toBe("x".repeat(200_000));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("does not fold transliteration variants beyond endings", () => {
    expect(stemName("vathy", cfg)).not.toBe(stemName("vathi", cfg));
    expect(stemName("ypsilonia", cfg)).not.toBe(stemName("ypsilon", cfg));
  });
});

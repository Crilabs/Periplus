import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/domain/documents/normalize";
import { locateQuote, normalizeForQuote, segmentText } from "../quote";

const cfg = { minChars: 12, maxChars: 300 };
const de = "Der Ankergrund ist **Sand**, gut haltend.\nDie „Taverne Nikos“ – direkt am Steg – öffnet im Mai.";

describe("locateQuote", () => {
  it("markdown, quotes, dashes and line breaks do not matter", () => {
    expect(locateQuote(de, "Der Ankergrund ist Sand, gut haltend", cfg)).toMatchObject({ ok: true, start: 0 });
    const r = locateQuote(de, 'Die "Taverne Nikos" - direkt am Steg', cfg);
    expect(r.ok && de.slice(r.start, r.end)).toBe("Die „Taverne Nikos“ – direkt am Steg");
  });

  it("greek in NFD matches greek in NFC", () => {
    const el = "Ο όρμος προσφέρει καλή προστασία από τα βόρεια.";
    expect(locateQuote(el, "όρμος προσφέρει καλή προστασία".normalize("NFD"), cfg).ok).toBe(true);
  });

  it.each([
    ["Der Ankergrund ist sandig", "not_found"], // paraphrase
    ["der ankergrund ist sand, gut haltend", "not_found"], // case
    ["Der Ankergrund … gut haltend", "ellipsis"],
    ["Der Ankergrund ... gut haltend", "ellipsis"],
    ["gut haltend. Die Taverne Nikos öffnet im Mai", "not_found"], // joined from two sentences
    ["Sand", "too_short"],
    ["x".repeat(301), "too_long"],
    ["  \n ", "empty"],
  ])("%s is rejected as %s", (quote, reason) => expect(locateQuote(de, quote, cfg)).toEqual({ ok: false, reason }));

  it("maps offsets back to the original chunk around stripped markup", () => {
    const r = locateQuote(de, "ist Sand, gut haltend.", cfg);
    expect(r.ok && de.slice(r.start, r.end)).toBe("ist **Sand**, gut haltend.");
    const r2 = locateQuote(de, "Der Ankergrund ist Sand", cfg);
    // the quote ends inside the bold markup: the closing ** is not part of the span
    expect(r2.ok && de.slice(r2.start, r2.end)).toBe("Der Ankergrund ist **Sand");
  });

  it("an NFD chunk maps whole decomposed characters", () => {
    const chunk = "Πολύ καλή προστασία στον όρμο.".normalize("NFD");
    const r = locateQuote(chunk, "καλή προστασία στον όρμο", cfg);
    expect(r.ok).toBe(true);
    expect(r.ok && chunk.slice(r.start, r.end).normalize("NFC")).toBe("καλή προστασία στον όρμο");
  });

  it("links, soft hyphens and zero-width characters are ignored", () => {
    const chunk = "Siehe [Taverne Nikos](https://nikos.example) am Ha­fen​ von Poros.";
    const r = locateQuote(chunk, "Siehe Taverne Nikos am Hafen von Poros", cfg);
    expect(r.ok && chunk.slice(r.start, r.end)).toBe(
      "Siehe [Taverne Nikos](https://nikos.example) am Ha­fen​ von Poros",
    );
  });

  it("a closing ***x*** leaves no trailing asterisk", () => {
    const chunk = "Wir lagen ***hold fast*** then gut geschützt.";
    const r = locateQuote(chunk, "hold fast then gut geschützt", cfg);
    expect(r.ok && chunk.slice(r.start, r.end)).toBe("hold fast*** then gut geschützt");
    expect(normalizeForQuote(chunk).text).toBe("Wir lagen hold fast then gut geschützt.");
  });

  it("a quote spanning two list bullets matches without the bullets", () => {
    const chunk = "Ausstattung:\n- Wasser am Steg\n* Strom gegen Gebühr\n1. Diesel nur morgens";
    const r = locateQuote(chunk, "Wasser am Steg Strom gegen Gebühr Diesel", cfg);
    expect(r.ok && chunk.slice(r.start, r.end)).toBe("Wasser am Steg\n* Strom gegen Gebühr\n1. Diesel");
    expect(normalizeForQuote(chunk).text).toBe("Ausstattung: Wasser am Steg Strom gegen Gebühr Diesel nur morgens");
    // a dash inside a line is not a bullet
    expect(normalizeForQuote("Die Bucht - gut geschützt").text).toBe("Die Bucht - gut geschützt");
  });

  it("links with parentheses or a title and images keep only their text", () => {
    const chunk =
      'Siehe [Poros (Stadt)](https://de.wikipedia.org/wiki/Poros_(Stadt)) und [Nikos](https://nikos.example "Taverne") ' +
      "sowie ![Hafen von Poros](img/poros.jpg) am Abend.";
    const n = normalizeForQuote(chunk);
    expect(n.text).toBe("Siehe Poros (Stadt) und Nikos sowie Hafen von Poros am Abend.");
    const r = locateQuote(chunk, "Poros (Stadt) und Nikos sowie Hafen von Poros am Abend", cfg);
    expect(r.ok && chunk.slice(r.start, r.end)).toBe(chunk.slice(7, chunk.length - 1));
    const img = locateQuote(chunk, "sowie Hafen von Poros am", cfg);
    expect(img.ok && chunk.slice(img.start, img.end)).toBe("sowie ![Hafen von Poros](img/poros.jpg) am");
  });

  it("a linked image keeps only its alt text", () => {
    const chunk = "Blick: [![Hafen von Poros](img/poros.jpg)](https://poros.example/(hafen)) am Abend.";
    expect(normalizeForQuote(chunk).text).toBe("Blick: Hafen von Poros am Abend.");
    const r = locateQuote(chunk, "Blick: Hafen von Poros am Abend", cfg);
    expect(r.ok && chunk.slice(r.start, r.end)).toBe(chunk.slice(0, chunk.length - 1));
    const alt = locateQuote(chunk, "Hafen von Poros am Abend", cfg);
    expect(alt.ok && chunk.slice(alt.start, alt.end)).toBe("Hafen von Poros](img/poros.jpg)](https://poros.example/(hafen)) am Abend");
  });

  it("returns the first match", () => {
    const chunk = "Gut haltender Sand. Gut haltender Sand.";
    expect(locateQuote(chunk, "Gut haltender Sand", cfg)).toEqual({ ok: true, start: 0, end: 18 });
  });
});

describe("normalizeForQuote", () => {
  it("agrees with normalizeText on text without markup", () => {
    for (const s of [de.replace(/\*\*/g, ""), "  Ο όρμος „x“ — y\t\n z ".normalize("NFD"), "‚a‘ ‐ b"]) {
      expect(normalizeForQuote(s).text).toBe(normalizeText(s));
    }
  });

  it("keeps snake_case, arithmetic stars and accents, strips emphasis", () => {
    expect(normalizeForQuote("max_depth 5 * 3, *Sand* und _Kies_ und __Fels__ `x`").text).toBe(
      "max_depth 5 * 3, Sand und Kies und Fels x",
    );
    expect(normalizeForQuote("Öffnung É").text).toBe("Öffnung É");
  });

  it("maps every output character to its offset in the original", () => {
    const s = "a  **b**\n„c“";
    const { text, map } = normalizeForQuote(s);
    expect(text).toBe('a b "c"');
    expect(map).toEqual([0, 1, 5, 8, 9, 10, 11]);
    expect(map).toHaveLength(text.length);
  });
});

describe("segmentText", () => {
  it("segments overlapping mention and quote spans", () => {
    expect(
      segmentText("abcdef", [
        { start: 1, end: 4, kind: "quote", ref: "f" },
        { start: 2, end: 3, kind: "mention", ref: "m" },
      ]),
    ).toEqual([
      { text: "a", kinds: [], refs: [] },
      { text: "b", kinds: ["quote"], refs: ["f"] },
      { text: "c", kinds: ["quote", "mention"], refs: ["f", "m"] },
      { text: "d", kinds: ["quote"], refs: ["f"] },
      { text: "ef", kinds: [], refs: [] },
    ]);
  });

  it("clamps spans outside the text and drops empty ones", () => {
    expect(
      segmentText("abc", [
        { start: -5, end: 1, kind: "mention", ref: "m" },
        { start: 2, end: 99, kind: "quote", ref: "f" },
        { start: 7, end: 9, kind: "quote", ref: "g" },
        { start: 1, end: 1, kind: "quote", ref: "h" },
      ]),
    ).toEqual([
      { text: "a", kinds: ["mention"], refs: ["m"] },
      { text: "b", kinds: [], refs: [] },
      { text: "c", kinds: ["quote"], refs: ["f"] },
    ]);
  });

  it("lists a kind once when two spans of that kind overlap", () => {
    expect(
      segmentText("abc", [
        { start: 0, end: 3, kind: "quote", ref: "f1" },
        { start: 1, end: 2, kind: "quote", ref: "f2" },
      ]),
    ).toEqual([
      { text: "a", kinds: ["quote"], refs: ["f1"] },
      { text: "b", kinds: ["quote"], refs: ["f1", "f2"] },
      { text: "c", kinds: ["quote"], refs: ["f1"] },
    ]);
    expect(segmentText("", [])).toEqual([]);
    expect(segmentText("abc", [])).toEqual([{ text: "abc", kinds: [], refs: [] }]);
  });
});

import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { isStopName, stripAffix } from "../affixes";
import { linkTextOnly, ngrams } from "../ngrams";
import { nameHints } from "../unmatched";

const affixes = getConfig().nameAffixes;
const cfg = getConfig().mentions;

describe("ngrams", () => {
  it("1–4 word n-grams stop at sentence ends", () => {
    const g = ngrams("Wir ankerten vor Kolona. Danach Vathy", 4).map((n) => n.forms[0]);
    expect(g).toContain("vor kolona");
    expect(g).not.toContain("kolona danach");
    expect(g).toContain("wir ankerten vor kolona");
    expect(g).not.toContain("wir ankerten vor kolona danach");
  });

  it("greek n-grams carry their transliteration", () => {
    expect(ngrams("στο Πόρτο Χέλι", 2).find((n) => n.surface === "Πόρτο Χέλι")!.forms).toEqual(["πορτο χελι", "porto cheli"]);
  });

  it("offsets point into the original text and words keep inner apostrophes and hyphens", () => {
    const text = "Bei Agios-Georgios und D'Arcy; dann\nPoros!";
    const g = ngrams(text, 3);
    for (const n of g) expect(text.slice(n.start, n.end)).toBe(n.surface);
    expect(g.map((n) => n.surface)).toContain("Agios-Georgios und D'Arcy");
    expect(g.find((n) => n.surface === "Agios-Georgios")).toMatchObject({ words: 1, forms: ["agios georgios"] });
    // `;` and the line break end a sentence
    expect(g.some((n) => n.surface.includes("dann") && n.surface.includes("Arcy"))).toBe(false);
    expect(g.some((n) => n.surface.includes("Poros") && n.words > 1)).toBe(false);
  });

  it("latin n-grams have one form; a greek question mark ends a sentence", () => {
    expect(ngrams("Vathy", 4)).toEqual([{ start: 0, end: 5, surface: "Vathy", forms: ["vathy"], words: 1 }]);
    expect(ngrams("Πού είναι; Βαθύ", 2).map((n) => n.surface)).not.toContain("είναι; Βαθύ");
  });
});

describe("linkTextOnly", () => {
  it("n-grams over link-reduced text come from link texts only, with the original offsets", () => {
    const text = "Siehe [Poros Stadt](https://example.test/poros-(stadt)) und ![Vathy](img/vathy.jpg), https://kolona.test/x. Ende";
    const reduced = linkTextOnly(text);
    expect(reduced).toHaveLength(text.length);
    const g = ngrams(reduced, 2);
    // offsets are those of the original text: a word inside a link maps back exactly
    for (const n of g.filter((x) => x.words === 1)) expect(text.slice(n.start, n.end)).toBe(n.surface);
    expect(text.slice(g.find((n) => n.surface === "Poros Stadt")!.start)).toMatch(/^Poros Stadt\]/);
    const forms = g.map((n) => n.forms[0]);
    expect(forms).toEqual(expect.arrayContaining(["poros stadt", "vathy", "ende"]));
    for (const url of ["https", "example", "poros stadt und", "img", "jpg", "kolona", "test"]) expect(forms).not.toContain(url);
  });
});

describe("affixes", () => {
  it("affixes are stripped with their hint", () => {
    expect(stripAffix("bucht von kolona", affixes)).toEqual({ core: "kolona", hint: "bay" });
    expect(stripAffix("vathy bay", affixes)).toEqual({ core: "vathy", hint: "bay" });
    expect(stripAffix("ορμο βαθυ", affixes)).toEqual({ core: "βαθυ", hint: "bay" });
    expect(stripAffix("bay", affixes)).toBeNull();
    expect(stripAffix("kolona", affixes)).toBeNull();
    // an affix only counts as a whole word
    expect(stripAffix("portokali beach", affixes)).toBeNull();
  });

  it("stop names never match on their own", () => {
    for (const s of ["marina", "port", "agios", "kap", "bucht", "12"]) expect(isStopName(s, cfg, affixes)).toBe(true);
    for (const s of ["ab", "1 2", "bucht von"]) expect(isStopName(s, cfg, affixes)).toBe(true);
    for (const s of ["kolona", "vathy", "poros 2"]) expect(isStopName(s, cfg, affixes)).toBe(false);
  });
});

describe("nameHints", () => {
  it("name hints find Kolona Bay, Ormos Vathy and όρμο Βαθύ", () => {
    expect(nameHints("We anchored in Kolona Bay, later at Ormos Vathy.", affixes).map((h) => [h.display, h.hint])).toEqual([
      ["Kolona", "bay"],
      ["Vathy", "bay"],
    ]);
    expect(nameHints("Αγκυροβολήσαμε στον όρμο Βαθύ.", affixes)[0]).toMatchObject({ display: "Βαθύ", nameNormalized: "βαθυ" });
  });

  it("takes up to three capitalised words in the original spelling, with offsets", () => {
    const text = "Danach in die Bucht von Agios Nikolaos Ost Nord, dann Vathy Cove.";
    const hints = nameHints(text, affixes);
    expect(hints.map((h) => [h.display, h.hint])).toEqual([
      ["Agios Nikolaos Ost", "bay"],
      ["Vathy", "bay"],
    ]);
    for (const h of hints) expect(text.slice(h.start, h.end)).toBe(h.display);
  });

  it("needs a capitalised word and never crosses a sentence end", () => {
    expect(nameHints("the bay was calm. Kolona bay", affixes).map((h) => h.display)).toEqual(["Kolona"]);
    expect(nameHints("Wir lagen in der Bucht. Vathy war voll.", affixes)).toEqual([]);
  });

  it("a sentence-initial word or a German common noun never joins a suffix name", () => {
    const stop = cfg.nameHintStopWords;
    expect(nameHints("In Kolona Bay lagen wir.", affixes, stop).map((h) => h.display)).toEqual(["Kolona"]);
    expect(nameHints("Wir fuhren im Süden Kolona Bay an.", affixes, stop).map((h) => h.display)).toEqual(["Kolona"]);
    expect(nameHints("The Vathy Cove was full.", affixes, stop).map((h) => h.display)).toEqual(["Vathy"]);
    // without stop words the old behaviour stays
    expect(nameHints("In Kolona Bay lagen wir.", affixes).map((h) => h.display)).toEqual(["In Kolona"]);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isUnreadable, layoutToMarkdown } from "@/lib/domain/documents/pdf-layout";

const sample = readFileSync("test/fixtures/pdf/layout-sample.txt", "utf8");

describe("layoutToMarkdown", () => {
  it("layout tables stay as text blocks and hyphenation is joined", () => {
    const { markdown, pages } = layoutToMarkdown(sample, 200);
    expect(markdown).toContain("<!-- page 2 -->");
    expect(markdown).toMatch(/```text\n.*Perdika\s{2,}3-8 m\s{2,}40/s);
    expect(markdown).toContain("Ankerplatz");
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it("joins a paragraph's lines, a hyphen before a lower-case letter without a space", () => {
    const { markdown } = layoutToMarkdown(sample, 200);
    expect(markdown).toContain("Der beliebteste Ankerplatz der Insel liegt vor dem Fischerdorf Perdika im Südwesten, wo die");
    expect(markdown).toMatch(/^<!-- page 1 -->\n\n## REVIERFÜHRER SARONISCHER GOLF\n\nAegina ist/);
    expect(markdown).toMatch(/^## ANSTEUERUNG$/m);
    expect(markdown).toMatch(/^## TIEFEN UND PLÄTZE$/m);
  });

  it("keeps the table lines unchanged inside the fence", () => {
    const { markdown } = layoutToMarkdown(sample, 200);
    const fence = /```text\n([\s\S]*?)\n```/.exec(markdown)![1]!;
    expect(fence.split("\n")).toEqual([
      "    Ankerplatz        Tiefe       Plätze     Grund",
      "    Perdika           3-8 m       40         Sand",
      "    Moni Nord         5-12 m      15         Sand, Seegras",
      "    Aponisos          4-10 m      20         Sand",
    ]);
  });

  it("two column-like lines are no table", () => {
    const text = "Ort      Tiefe     Plätze\nPerdika  3-8 m     40\n";
    const { markdown } = layoutToMarkdown(text, 0);
    expect(markdown).not.toContain("```");
    expect(markdown).toContain("Ort Tiefe Plätze Perdika 3-8 m 40");
  });

  it("keeps a hyphen before an upper-case word (compound with a name)", () => {
    expect(layoutToMarkdown("Die Moni-\nInsel liegt vor Perdika.", 0).markdown).toContain("Die Moni-Insel liegt");
  });

  it("reports characters and unreadable pages", () => {
    const { pages } = layoutToMarkdown(sample, 200);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.chars).toBeGreaterThan(400);
    expect(pages.every((p) => !p.unreadable)).toBe(true);
    const short = layoutToMarkdown("Titel\fNur wenig Text", 200).pages;
    expect(short.map((p) => p.unreadable)).toEqual([true, true]);
  });

  it("a page without text keeps its marker", () => {
    const { markdown, pages } = layoutToMarkdown("Erste Seite\f\fDritte Seite\f", 0);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(markdown).toBe("<!-- page 1 -->\n\nErste Seite\n\n<!-- page 2 -->\n\n<!-- page 3 -->\n\nDritte Seite");
  });
});

describe("isUnreadable", () => {
  const prose = "Perdika liegt im Südwesten von Aegina und bietet guten Schutz. ".repeat(5);

  it("is false for normal text", () => {
    expect(isUnreadable(prose, 200)).toBe(false);
  });

  it("is true below the letter minimum", () => {
    expect(isUnreadable("3-8 m 40 12", 200)).toBe(true);
  });

  it("is true when more than 20 % of the characters are garbage", () => {
    const garbage = "�■".repeat(40);
    expect(isUnreadable(`${prose}${garbage}`, 200)).toBe(true);
  });

  it("whitespace does not count against a page", () => {
    expect(isUnreadable(`${prose}${" ".repeat(5000)}`, 200)).toBe(false);
  });
});

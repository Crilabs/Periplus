import { describe, expect, it } from "vitest";
import { matchCarried } from "@/lib/domain/documents/carry";
import { chunkMarkdown, type ChunkDraft } from "@/lib/domain/documents/chunker";
import { normalizeMarkdown, normalizeText, sha256Hex } from "@/lib/domain/documents/normalize";

const cfg = { targetWords: 500, maxWords: 800, maxOverlapWords: 200 };

/** Paragraph `i` (1-based) of `n` distinct words. */
const paragraph = (i: number, n = 100) => Array.from({ length: n }, (_, j) => `p${i}w${j}`).join(" ");
const paragraphs = (count: number, n: number, from = 1) =>
  Array.from({ length: count }, (_, k) => paragraph(from + k, n)).join("\n\n");
const words = (c: ChunkDraft[]) => c.map((x) => x.wordCount);

/** Previous-version rows for `matchCarried`, with ids `<prefix><ordinal>`. */
const rows = (chunks: ChunkDraft[], prefix: string, carried: Array<string | null> = []) =>
  chunks.map((c, i) => ({ id: `${prefix}${i}`, textHash: c.textHash, carriedFromChunkId: carried[i] ?? null }));

describe("chunkMarkdown", () => {
  it("12 paragraphs of 100 words give chunks of 500, 500 and 400 words with one paragraph overlap", () => {
    const c = chunkMarkdown(paragraphs(12, 100), cfg);
    expect(words(c)).toEqual([500, 500, 400]);
    expect(c.map((x) => x.ordinal)).toEqual([0, 1, 2]);
    expect(c[0].text.startsWith(paragraph(1))).toBe(true);
    expect(c[1].text.startsWith(paragraph(5))).toBe(true);
    expect(c[2].text.startsWith(paragraph(9))).toBe(true);
    expect(c[2].text.endsWith(paragraph(12))).toBe(true);
    expect(c.every((x) => x.heading === null)).toBe(true);
  });

  it("no chunk exceeds 800 words", () => {
    expect(words(chunkMarkdown(paragraph(1, 2000), cfg))).toEqual([800, 800, 400]);
  });

  it("splits a long paragraph at sentence ends into pieces of at most 800 words", () => {
    const sentence = (i: number) => `${Array.from({ length: 100 }, (_, j) => `s${i}w${j}`).join(" ")}.`;
    const block = Array.from({ length: 9 }, (_, i) => sentence(i)).join(" ");
    const c = chunkMarkdown(block, cfg);
    expect(words(c)).toEqual([800, 100]);
    expect(c[0].text.endsWith(sentence(7))).toBe(true);
    expect(c[1].text).toBe(sentence(8));
  });

  it("a heading starts a new chunk without overlap", () => {
    const md = `# Aegina\n\n${paragraphs(2, 100, 1)}\n\n## Moni\n\n${paragraphs(1, 100, 3)}\n\n#### Detail\n\n${paragraphs(1, 100, 4)}`;
    const c = chunkMarkdown(md, cfg);
    expect(words(c)).toEqual([202, 204]);
    expect(c.map((x) => x.heading)).toEqual(["Aegina", "Moni"]);
    expect(c[0].text.startsWith("# Aegina\n\n")).toBe(true);
    expect(c[0].text.endsWith(paragraph(2))).toBe(true);
    expect(c[1].text.startsWith("## Moni\n\n")).toBe(true);
  });

  it("every chunk of a section carries its heading, text before the first heading has none", () => {
    const md = `${paragraph(1)}\n\n### Perdika ###\n\n${paragraphs(8, 100, 2)}`;
    const c = chunkMarkdown(md, cfg);
    expect(words(c)).toEqual([100, 403, 500]);
    expect(c.map((x) => x.heading)).toEqual([null, "Perdika", "Perdika"]);
    expect(c[2].text.startsWith(paragraph(5))).toBe(true);
  });

  it("keeps a heading together with a long first paragraph", () => {
    const c = chunkMarkdown(`## Moni\n\n${paragraph(1, 600)}\n\n${paragraph(2, 100)}`, cfg);
    expect(words(c)).toEqual([602, 100]);
  });

  it("a paragraph above 200 words is not repeated as overlap", () => {
    const c = chunkMarkdown(`${paragraph(1, 300)}\n\n${paragraph(2, 300)}`, cfg);
    expect(words(c)).toEqual([300, 300]);
    expect(c[1].text.startsWith(paragraph(2, 300))).toBe(true);
  });

  it("drops the overlap when it would push the chunk above 800 words", () => {
    const c = chunkMarkdown(`${paragraph(1, 200)}\n\n${paragraph(2, 700)}`, cfg);
    expect(words(c)).toEqual([200, 700]);
    expect(c[1].text.startsWith(paragraph(2, 700))).toBe(true);
  });

  it("a fenced code block with blank lines and # lines is one block", () => {
    const md = "Intro.\n\n```\n# not a heading\n\n\n\nx = 1\n```\n\nOutro.";
    const c = chunkMarkdown(md, { ...cfg, targetWords: 2 });
    expect(c.map((x) => x.text)).toEqual(["Intro.", "Intro.\n\n```\n# not a heading\n\nx = 1\n```", "```\n# not a heading\n\nx = 1\n```\n\nOutro."]);
    expect(c.every((x) => x.heading === null)).toBe(true);
  });

  it("char positions slice the chunk text out of the normalized markdown", () => {
    const raw = `﻿# Aegina  \r\n\r\n\r\n\r\n${paragraphs(7, 100)}\r\n## „Moni“ – Bucht\r\n${paragraphs(3, 100, 8)}​`;
    const md = normalizeMarkdown(raw);
    const c = chunkMarkdown(raw, cfg);
    expect(c.length).toBe(3);
    for (const x of c) {
      expect(md.slice(x.charStart, x.charEnd)).toBe(x.text);
      expect(x.textNormalized).toBe(normalizeText(x.text));
      expect(x.textHash).toBe(sha256Hex(x.textNormalized));
      expect(x.wordCount).toBe(x.text.split(/\s+/).filter(Boolean).length);
    }
    expect(c[2].heading).toBe("„Moni“ – Bucht");
    expect(c[2].textNormalized.startsWith('## "Moni" - Bucht p8w0')).toBe(true);
  });

  it("returns no chunks for empty markdown", () => {
    expect(chunkMarkdown("\n\n  \n", cfg)).toEqual([]);
  });
});

describe("matchCarried", () => {
  const section = (name: string, from: number) => `# ${name}\n\n${paragraphs(8, 100, from)}`;
  const doc = (edit = false) => {
    const md = [section("One", 1), section("Two", 9), section("Three", 17)].join("\n\n");
    return edit ? md.replace("p14w50", "p14w50x") : md;
  };

  it("editing one paragraph in section 2 carries every chunk of sections 1 and 3", () => {
    const v1 = chunkMarkdown(doc(), cfg);
    const v2 = chunkMarkdown(doc(true), cfg);
    expect(v1.map((x) => x.heading)).toEqual(["One", "One", "Two", "Two", "Three", "Three"]);
    expect(v2.map((x) => x.heading)).toEqual(v1.map((x) => x.heading));
    const carried = matchCarried(rows(v1, "a"), v2);
    expect(carried).toEqual(["a0", "a1", "a2", null, "a4", "a5"]);
    expect(carried.filter((x) => x === null).length).toBeLessThanOrEqual(2);
  });

  it("carried chunks point to the first extraction across three versions", () => {
    const v1 = chunkMarkdown(doc(), cfg);
    const v2 = chunkMarkdown(doc(true), cfg);
    const c2 = matchCarried(rows(v1, "a"), v2);
    const v3 = chunkMarkdown(doc(), cfg);
    const c3 = matchCarried(rows(v2, "b", c2), v3);
    // b3 was extracted in version 2; its old text comes back new (version 1's a3 is not in prev)
    expect(c3).toEqual(["a0", "a1", "a2", null, "a4", "a5"]);
    const v4 = chunkMarkdown(doc(), cfg);
    expect(matchCarried(rows(v3, "c", c3), v4)).toEqual(["a0", "a1", "a2", "c3", "a4", "a5"]);
  });

  it("two identical chunks are matched one to one", () => {
    const twice = chunkMarkdown(`# A\n\nsame text\n\n# A\n\nsame text`, cfg);
    expect(twice).toHaveLength(2);
    expect(twice[0].textHash).toBe(twice[1].textHash);
    expect(matchCarried(rows(twice, "a"), twice)).toEqual(["a0", "a1"]);
    const thrice = chunkMarkdown(`# A\n\nsame text\n\n# A\n\nsame text\n\n# A\n\nsame text`, cfg);
    expect(matchCarried(rows(twice, "a"), thrice)).toEqual(["a0", "a1", null]);
  });

  it("returns null for every chunk without a previous version", () => {
    expect(matchCarried([], chunkMarkdown(paragraphs(2, 10), cfg))).toEqual([null]);
  });

  it("recognises setext headings as section starts", () => {
    const md = `Title\n=====\n\n${paragraph(1)}\n\nSub\n---\n\n${paragraph(2)}\n\nlist\n\n---\n\n${paragraph(3)}`;
    const c = chunkMarkdown(md, cfg);
    expect(c.map((x) => x.heading)).toEqual(["Title", "Sub"]);
    expect(c[0].text.startsWith("Title\n=====")).toBe(true);
  });
});

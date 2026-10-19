import { normalizeText } from "@/lib/domain/documents/normalize";

/*
 * Verbatim quote check (spec 06): a quote counts when its normalized form is a substring of the normalized chunk.
 * Normalization strips inline Markdown, list bullets, soft hyphens and zero-width characters, then applies the rules of
 * `normalizeText` (NFC, typographic quotes, dashes, whitespace). Case and accents are kept (ruling M4-P21).
 * Every normalized character keeps the span of original characters it came from, so a match maps back to the chunk.
 */

export type QuoteCheck =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: "empty" | "too_long" | "too_short" | "ellipsis" | "not_found" };

export type SpanKind = "mention" | "quote";
export type Span = { start: number; end: number; kind: SpanKind; ref: string };
export type TextSegment = { text: string; kinds: SpanKind[]; refs: string[] };

/** Soft hyphen, zero-width space/non-joiner/joiner, word joiner, BOM. */
const INVISIBLE = new Set(["­", "​", "‌", "‍", "⁠", "﻿"]);
const WORD_CHAR = /[\p{L}\p{N}]/u;
const COMBINING = /^\p{M}$/u;
const WHITESPACE = /^\s$/u;
/** A list bullet at a line start (`- `, `* `, `+ `, `1. `, `1) `) with the indentation before it. */
const LIST_BULLET = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm;

type Normalized = { text: string; map: number[]; ends: number[] };

/**
 * Inline links and images: `[text](url)`, `[text](url "title")`, `![alt](url)`, with balanced parentheses inside
 * the url. Returns the ranges to remove around the kept text (`!`, `[`, and `](…)`).
 */
function linkMarkup(s: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "[") continue;
    const close = s.indexOf("]", i + 1);
    if (close < 0) break;
    const text = s.slice(i + 1, close);
    if (text.length === 0 || text.includes("\n") || text.includes("[") || s[close + 1] !== "(") continue;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let k = close + 2; k < s.length; k++) {
      const ch = s[k]!;
      if (ch === "\n") break;
      if (quote) {
        if (ch === quote) quote = null;
      } else if ((ch === '"' || ch === "'") && /\s/.test(s[k - 1]!)) {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        if (depth === 0) {
          end = k;
          break;
        }
        depth--;
      }
    }
    if (end < 0) continue;
    const from = i > 0 && s[i - 1] === "!" ? i - 1 : i;
    ranges.push([from, i + 1], [close, end + 1]);
    i = end;
  }
  return ranges;
}

/** Marks the original code units that Markdown (inline markup, list bullets) and invisible characters occupy. */
function strippedUnits(s: string): boolean[] {
  const removed = new Array<boolean>(s.length).fill(false);
  for (const m of s.matchAll(LIST_BULLET)) {
    for (let k = m.index; k < m.index + m[0].length; k++) removed[k] = true;
  }
  for (const [from, to] of linkMarkup(s)) {
    for (let k = from; k < to; k++) removed[k] = true;
  }
  const isWord = (i: number) => i >= 0 && i < s.length && !removed[i] && WORD_CHAR.test(s[i]!);
  for (let i = 0; i < s.length; i++) {
    if (removed[i]) continue;
    const ch = s[i]!;
    if (ch === "*" || ch === "_") {
      let run = 1;
      while (s[i + run] === ch && !removed[i + run]) run++;
      if (run >= 2) {
        // `**`, `__`, `***`: always markup, the whole run goes (a closing `***x***` leaves no `*`)
        for (let k = i; k < i + run; k++) removed[k] = true;
        i += run - 1;
      } else if (isWord(i - 1) !== isWord(i + 1)) {
        // emphasis at a word boundary; `snake_case` and `5 * 3` stay
        removed[i] = true;
      }
    } else if (ch === "`" || INVISIBLE.has(ch)) {
      removed[i] = true;
    }
  }
  return removed;
}

function normalizeWithSpans(s: string): Normalized {
  const removed = strippedUnits(s);
  // Clusters of a base character and its combining marks, so NFC can compose them while keeping their span.
  const clusters: { chars: string; start: number; end: number }[] = [];
  for (let i = 0; i < s.length; ) {
    const len = s.codePointAt(i)! > 0xffff ? 2 : 1;
    if (!removed[i]) {
      const ch = s.slice(i, i + len);
      const last = clusters.at(-1);
      if (last && COMBINING.test(ch)) {
        last.chars += ch;
        last.end = i + len;
      } else {
        clusters.push({ chars: ch, start: i, end: i + len });
      }
    }
    i += len;
  }

  let text = "";
  const map: number[] = [];
  const ends: number[] = [];
  let pendingSpace: { start: number; end: number } | null = null;
  for (const cluster of clusters) {
    for (const ch of cluster.chars.normalize("NFC")) {
      if (WHITESPACE.test(ch)) {
        if (pendingSpace) pendingSpace.end = cluster.end;
        else pendingSpace = { start: cluster.start, end: cluster.end };
        continue;
      }
      if (pendingSpace && text.length > 0) {
        text += " ";
        map.push(pendingSpace.start);
        ends.push(pendingSpace.end);
      }
      pendingSpace = null;
      // a single non-space character: normalizeText only maps quotes and dashes
      const out = normalizeText(ch);
      for (let k = 0; k < out.length; k++) {
        map.push(cluster.start);
        ends.push(cluster.end);
      }
      text += out;
    }
  }
  return { text, map, ends };
}

/**
 * Comparison form of a chunk or quote: inline Markdown (`[t](u "title")` → `t`, `![alt](u)` → `alt`, runs of `*`/`_`,
 * `` ` ``, single `*`/`_` at word boundaries), list bullets at line starts (`- `, `* `, `1. `), soft hyphens and zero-width characters removed, then the `normalizeText` rules. `map[i]` is the
 * offset in `s` of the character the `i`-th character of `text` came from.
 */
export function normalizeForQuote(s: string): { text: string; map: number[] } {
  const { text, map } = normalizeWithSpans(s);
  return { text, map };
}

/**
 * Finds the quote in the chunk: the first substring match of the normalized quote in the normalized chunk, with
 * `start`/`end` (exclusive) as offsets in the original chunk text.
 */
export function locateQuote(chunkText: string, quote: string, cfg: { minChars: number; maxChars: number }): QuoteCheck {
  const q = normalizeWithSpans(quote).text;
  if (q.length === 0) return { ok: false, reason: "empty" };
  if (quote.length > cfg.maxChars) return { ok: false, reason: "too_long" };
  if (q.length < cfg.minChars) return { ok: false, reason: "too_short" };
  if (quote.includes("…") || quote.includes("...")) return { ok: false, reason: "ellipsis" };
  const chunk = normalizeWithSpans(chunkText);
  const at = chunk.text.indexOf(q);
  if (at < 0) return { ok: false, reason: "not_found" };
  return { ok: true, start: chunk.map[at]!, end: chunk.ends[at + q.length - 1]! };
}

/**
 * Splits `text` at the boundaries of all spans; each segment lists the kinds (once each) and refs of the spans
 * covering it, in span order. Spans are clamped to the text; empty spans are ignored.
 */
export function segmentText(text: string, spans: Span[]): TextSegment[] {
  const clamped = spans
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
    .filter((s) => s.start < s.end);
  const bounds = [...new Set([0, text.length, ...clamped.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const segments: TextSegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [from, to] = [bounds[i]!, bounds[i + 1]!];
    const covering = clamped.filter((s) => s.start <= from && s.end >= to);
    segments.push({
      text: text.slice(from, to),
      kinds: [...new Set(covering.map((s) => s.kind))],
      refs: covering.map((s) => s.ref),
    });
  }
  return segments;
}

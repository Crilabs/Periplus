import { normalizeName } from "@/lib/domain/gazetteer/names";

/** Separator between two windows of a unit text. */
const GAP = "\n\n[…]\n\n";

type Word = { start: number; end: number };

/** Case- and accent-folded copy of the markdown (same folding as `normalizeName`), each character mapped to its original index. */
function foldWithMap(markdown: string): { folded: string; map: number[] } {
  const out: string[] = [" "];
  const map: number[] = [-1];
  let lastSpace = true;
  const push = (ch: string, at: number) => {
    const space = ch === " ";
    if (space && lastSpace) return;
    lastSpace = space;
    out.push(ch);
    map.push(at);
  };
  for (let i = 0; i < markdown.length; ) {
    const code = markdown.charCodeAt(i);
    // fast path: ASCII letters and digits, everything else ASCII is a separator
    if (code < 128) {
      const lower = code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : markdown[i]!;
      push(/[a-z0-9]/.test(lower) ? lower : " ", i);
      i++;
      continue;
    }
    const len = markdown.codePointAt(i)! > 0xffff ? 2 : 1;
    // one code point; marks of a decomposed letter are dropped, anything that is no letter or digit is a space
    const piece = markdown.slice(i, i + len).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ").replace(/[^\p{L}\p{N}]+/gu, " ");
    for (const ch of piece) for (let k = 0; k < ch.length; k++) push(ch[k]!, i);
    i += len;
  }
  push(" ", markdown.length);
  return { folded: out.join(""), map };
}

/** Original character ranges `[start, end)` of every whole-word occurrence of one of the names. */
function nameRanges(markdown: string, names: string[]): Array<[number, number]> {
  const keys = [...new Set(names.map(normalizeName).filter((k) => k !== ""))];
  if (keys.length === 0) return [];
  const { folded, map } = foldWithMap(markdown);
  const ranges: Array<[number, number]> = [];
  for (const key of keys) {
    const needle = ` ${key} `;
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
      const first = at + 1;
      const last = at + needle.length - 2;
      ranges.push([map[first]!, map[last]! + 1]);
    }
  }
  return ranges;
}

/** Index of the word that contains `pos`, else the next one (the last word when none follows). */
function wordAt(words: Word[], pos: number): number {
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.end <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The text a unit (a berth candidate) is extracted from. Up to `maxUnitWords` words the whole markdown
 * (`offset: null`). Longer texts yield only the windows of `windowWords` words before and after every occurrence of
 * one of `names` (found case- and accent-insensitively, whole words, through inline markup), overlapping or touching
 * windows merged, in document order, joined by `\n\n[…]\n\n`. Without any occurrence: the first `maxUnitWords` words.
 *
 * `offset[i]` is the index in `markdown` of character `i` of `text`; the characters of the separators are `-1`
 * (they belong to no place of the document; a quote can never span them, `locateQuote` rejects an ellipsis).
 */
export function unitText(
  markdown: string,
  names: string[],
  cfg: { maxUnitWords: number; windowWords: number },
): { text: string; offset: number[] | null } {
  const words: Word[] = [...markdown.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (words.length <= cfg.maxUnitWords) return { text: markdown, offset: null };

  const spans: Array<[number, number]> = []; // word index ranges, inclusive
  for (const [from, to] of nameRanges(markdown, names)) {
    spans.push([Math.max(0, wordAt(words, from) - cfg.windowWords), Math.min(words.length - 1, wordAt(words, to - 1) + cfg.windowWords)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  if (merged.length === 0) merged.push([0, cfg.maxUnitWords - 1]);

  let text = "";
  const offset: number[] = [];
  merged.forEach(([lo, hi], n) => {
    if (n > 0) {
      text += GAP;
      for (let k = 0; k < GAP.length; k++) offset.push(-1);
    }
    const from = words[lo]!.start;
    const to = words[hi]!.end;
    text += markdown.slice(from, to);
    for (let k = from; k < to; k++) offset.push(k);
  });
  return { text, offset };
}

/** A run of an offset map: `length` characters from markdown index `start` on, or `start = -1` for separator characters. */
export type OffsetRun = [start: number, length: number];

/** The offset map of `unitText` as runs (compact enough to keep with a batch item); `null` stays `null`. */
export function offsetRuns(offset: number[] | null): OffsetRun[] | null {
  if (offset === null) return null;
  const runs: OffsetRun[] = [];
  for (const at of offset) {
    const last = runs.at(-1);
    if (last && (at === -1 ? last[0] === -1 : last[0] !== -1 && last[0] + last[1] === at)) last[1]++;
    else runs.push([at, 1]);
  }
  return runs;
}

/** The offset map back from its runs (`offsetRuns`). */
export function expandOffsetRuns(runs: OffsetRun[] | null): number[] | null {
  if (runs === null) return null;
  const offset: number[] = [];
  for (const [start, length] of runs) for (let k = 0; k < length; k++) offset.push(start === -1 ? -1 : start + k);
  return offset;
}

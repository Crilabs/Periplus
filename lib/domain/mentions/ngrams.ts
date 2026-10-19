import { normalizeName, transliterateElot743 } from "@/lib/domain/gazetteer/names";

/*
 * Word n-grams of a text for the name match (spec 06): "Wort-N-Gramme (1–4 Wörter) normalisieren (wie
 * `geo_names.name_normalized`, griechische Wörter zusätzlich transliteriert)". Offsets are UTF-16 code units into the
 * text given (JS string indices), so a hit maps back to the chunk.
 */

/** One word of a text: letters/digits (with combining marks), inner apostrophes and hyphens allowed. */
export type Word = { start: number; end: number; text: string };

export type Ngram = { start: number; end: number; surface: string; forms: string[]; words: number };

const WORD = /[\p{L}\p{N}\p{M}]+(?:['’\-‐‑][\p{L}\p{N}\p{M}]+)*/gu;
/** Sentence ends between two words: `. ! ? ;`, the greek question mark and ano teleia, and line breaks. */
const SENTENCE_END = /[.!?;\n\r\u037e\u0387\u00b7]/u;
const GREEK = /\p{Script=Greek}/u;

/** The words of a text grouped by sentence; no group is empty. */
export function sentenceWords(text: string): Word[][] {
  const sentences: Word[][] = [];
  let current: Word[] = [];
  let lastEnd = 0;
  for (const m of text.matchAll(WORD)) {
    if (current.length > 0 && SENTENCE_END.test(text.slice(lastEnd, m.index))) {
      sentences.push(current);
      current = [];
    }
    current.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    lastEnd = m.index + m[0].length;
  }
  if (current.length > 0) sentences.push(current);
  return sentences;
}

/** The comparison forms of a surface: `normalizeName`, plus the normalized ELOT 743 transliteration of greek text. */
export function nameForms(surface: string): string[] {
  const forms = [normalizeName(surface)];
  if (GREEK.test(surface)) forms.push(normalizeName(transliterateElot743(surface)));
  return [...new Set(forms)].filter((f) => f.length > 0);
}

/** All n-grams of 1 to `maxWords` words that stay inside one sentence, by start and then length. */
export function ngrams(text: string, maxWords: number): Ngram[] {
  const out: Ngram[] = [];
  for (const words of sentenceWords(text)) {
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= maxWords && i + n <= words.length; n++) {
        const start = words[i]!.start;
        const end = words[i + n - 1]!.end;
        const surface = text.slice(start, end);
        out.push({ start, end, surface, forms: nameForms(surface), words: n });
      }
    }
  }
  return out;
}

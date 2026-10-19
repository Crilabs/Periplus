import type { NameAffixesConfig } from "@/lib/config";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import type { Hint } from "./affixes";
import { sentenceWords, type Word } from "./ngrams";

/*
 * Place hints in a text (spec 06, new names): a prefix affix followed by 1–3 capitalised words ("Ormos Vathy",
 * "όρμο Βαθύ", "Bucht von Agios Nikolaos"), or 1–3 capitalised words followed by a suffix affix ("Kolona Bay"). The
 * words are the candidate name in their original spelling; offsets are UTF-16 code units into the text.
 */

export type UnmatchedDraft = { display: string; nameNormalized: string; hint: Hint; start: number; end: number };

const MAX_NAME_WORDS = 3;
const CAPITALISED = /^\p{Lu}/u;

/** Whether the words from `at` spell the (normalized, possibly multi-word) affix. */
function spells(words: Word[], at: number, affix: string[]): boolean {
  return affix.every((part, k) => at + k < words.length && normalizeName(words[at + k]!.text) === part);
}

export function nameHints(text: string, affixes: NameAffixesConfig): UnmatchedDraft[] {
  const parsed = affixes.map((a) => ({ ...a, parts: a.affix.split(" ") }));
  const affixWords = new Set(parsed.filter((a) => a.parts.length === 1).map((a) => a.affix));
  // A capitalised word that is itself a generic part ("Marina", "Bay") never belongs to the name.
  const isNameWord = (w: Word | undefined) => w !== undefined && CAPITALISED.test(w.text) && !affixWords.has(normalizeName(w.text));
  const drafts = new Map<string, UnmatchedDraft>();
  const add = (words: Word[], from: number, to: number, hint: Hint) => {
    const start = words[from]!.start;
    const end = words[to]!.end;
    const key = `${start}:${end}`;
    if (drafts.has(key)) return;
    const display = text.slice(start, end);
    drafts.set(key, { display, nameNormalized: normalizeName(display), hint, start, end });
  };
  for (const words of sentenceWords(text)) {
    for (let i = 0; i < words.length; i++) {
      for (const a of parsed) {
        if (!spells(words, i, a.parts)) continue;
        if (a.position === "prefix") {
          const from = i + a.parts.length;
          let to = from - 1;
          while (to + 1 - from < MAX_NAME_WORDS && isNameWord(words[to + 1])) to++;
          if (to >= from) add(words, from, to, a.hint);
        } else {
          const to = i - 1;
          let from = i;
          while (to + 1 - from < MAX_NAME_WORDS && from - 1 >= 0 && isNameWord(words[from - 1])) from--;
          if (from <= to) add(words, from, to, a.hint);
        }
      }
    }
  }
  return [...drafts.values()].sort((x, y) => x.start - y.start || x.end - y.end);
}

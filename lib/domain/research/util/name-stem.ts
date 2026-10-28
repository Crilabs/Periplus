/** How far `stemName` folds endings (`research.nameStem`). */
export type NameStemConfig = { minWordLetters: number; minStemLetters: number };

const LATIN = { vowels: new Set("aeiou"), finals: new Set("ns") };
const GREEK = { vowels: new Set("αεηιουω"), finals: new Set("νσ") };

/** The word without its ending (a vowel group with an optional final n/s), scanned from the end: linear in its length. */
function stripEnding(letters: string[]): string[] {
  for (const { vowels, finals } of [LATIN, GREEK]) {
    let end = letters.length;
    if (end > 0 && finals.has(letters[end - 1]!)) end--;
    let start = end;
    while (start > 0 && vowels.has(letters[start - 1]!)) start--;
    if (start < end) return letters.slice(0, start);
  }
  return letters;
}

/**
 * The inflection-insensitive form of a normalized name (B34): Greek place names appear in the nominative, the
 * genitive and as transliteration ("Lavrion", "Lavriou", "Lavrio"; "Monastiri", "Monastiriou"). Each word of at least
 * `minWordLetters` letters loses its final vowel group with an optional n/s (Latin or Greek letters); a word whose
 * stem would keep fewer than `minStemLetters` letters stays whole. Nothing beyond endings is folded (`y` is no vowel
 * here: "Vathy" and "Vathi" stay apart). It runs over every word of a fetched page, so it never backtracks.
 */
export function stemName(normalized: string, cfg: NameStemConfig): string {
  return normalized
    .split(" ")
    .map((w) => {
      const letters = [...w];
      if (letters.length < cfg.minWordLetters) return w;
      const stem = stripEnding(letters);
      return stem.length >= cfg.minStemLetters ? stem.join("") : w;
    })
    .join(" ");
}

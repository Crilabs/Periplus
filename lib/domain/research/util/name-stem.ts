/** How far `stemName` folds endings (`research.nameStem`). */
export type NameStemConfig = { minWordLetters: number; minStemLetters: number };

const LATIN_ENDING = /[aeiou]+[ns]?$/;
const GREEK_ENDING = /[αεηιουω]+[νσ]?$/;

/**
 * The inflection-insensitive form of a normalized name (B34): Greek place names appear in the nominative, the
 * genitive and as transliteration ("Lavrion", "Lavriou", "Lavrio"; "Monastiri", "Monastiriou"). Each word of at least
 * `minWordLetters` letters loses its final vowel group with an optional n/s (Latin or Greek letters); a word whose
 * stem would keep fewer than `minStemLetters` letters stays whole. Nothing beyond endings is folded (`y` is no vowel
 * here: "Vathy" and "Vathi" stay apart).
 */
export function stemName(normalized: string, cfg: NameStemConfig): string {
  return normalized
    .split(" ")
    .map((w) => {
      if ([...w].length < cfg.minWordLetters) return w;
      const stem = w.replace(LATIN_ENDING.test(w) ? LATIN_ENDING : GREEK_ENDING, "");
      return [...stem].length >= cfg.minStemLetters ? stem : w;
    })
    .join(" ");
}

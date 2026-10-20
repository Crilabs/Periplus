/*
 * Trigram similarity with the semantics of PostgreSQL's pg_trgm `similarity()`, for matching in memory where the
 * other side never reaches the database (Navily names, Grundprinzip 9).
 */

/**
 * The trigram set of a string as pg_trgm builds it: lower case, words = runs of letters and digits, each word padded
 * with two leading and one trailing space.
 */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length === 0) continue;
    const padded = [..."  ", ...word, " "];
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3).join(""));
  }
  return out;
}

/** |A ∩ B| / |A ∪ B| of the trigram sets; 0 when both are empty. */
export function similarityOfSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** pg_trgm `similarity(a, b)`. */
export function trigramSimilarity(a: string, b: string): number {
  return similarityOfSets(trigrams(a), trigrams(b));
}

import { shingleWords } from "@/lib/domain/documents/shingles";

/**
 * True when the statement shares a run of `maxSharedWords` consecutive words with the source text. Words are
 * normalized like `shingleWords` (case, accents and punctuation do not matter). A statement shorter than the
 * limit cannot copy a run of that length.
 */
export function copiesSource(statement: string, sourceText: string, maxSharedWords: number): boolean {
  const size = Math.max(1, maxSharedWords);
  const words = shingleWords(statement);
  if (words.length < size) return false;
  const source = shingleWords(sourceText);
  const windows = new Set<string>();
  for (let i = 0; i + size <= source.length; i++) windows.add(source.slice(i, i + size).join(" "));
  for (let i = 0; i + size <= words.length; i++) {
    if (windows.has(words.slice(i, i + size).join(" "))) return true;
  }
  return false;
}

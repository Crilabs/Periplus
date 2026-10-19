import { createHash } from "node:crypto";
import { normalizeName } from "@/lib/domain/gazetteer/names";

/** Words of a text for shingling, folded like `normalizeName` (no diacritics, lower case, `ς → σ`, split at non-letters/digits). */
export function shingleWords(text: string): string[] {
  const folded = normalizeName(text);
  return folded === "" ? [] : folded.split(" ");
}

/**
 * Distinct hashes of every `size`-word window (15-word rule of the delivery contract), in order of first
 * occurrence: the first 8 bytes of sha256 over the words joined by a space, as a signed 64-bit integer
 * (`text_shingles.shingle_hash bigint`). Fewer than `size` words → none.
 */
export function shingleHashes(text: string, size = 15): bigint[] {
  const words = shingleWords(text);
  const hashes = new Set<bigint>();
  for (let i = 0; i + size <= words.length; i++) {
    const digest = createHash("sha256").update(words.slice(i, i + size).join(" "), "utf8").digest();
    hashes.add(digest.readBigInt64BE(0));
  }
  return [...hashes];
}

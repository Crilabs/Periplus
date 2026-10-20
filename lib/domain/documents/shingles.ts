import { createHash } from "node:crypto";
import { normalizeName } from "@/lib/domain/gazetteer/names";

/** Words per shingle of the copy check (the delivery contract's 15-word rule). */
export const COPY_SHINGLE_WORDS = 15;

/** Words of a text for shingling, folded like `normalizeName` (no diacritics, lower case, `ς → σ`, split at non-letters/digits). */
export function shingleWords(text: string): string[] {
  const folded = normalizeName(text);
  return folded === "" ? [] : folded.split(" ");
}

/**
 * The hash of every `size`-word window of `text` in text order (repeats kept): the first 8 bytes of sha256 over the
 * words joined by a space, as a signed 64-bit integer (`text_shingles.shingle_hash bigint`). Fewer than `size` words →
 * none.
 */
export function shingleWindowHashes(text: string, size = COPY_SHINGLE_WORDS): bigint[] {
  const words = shingleWords(text);
  const out: bigint[] = [];
  for (let i = 0; i + size <= words.length; i++) {
    out.push(createHash("sha256").update(words.slice(i, i + size).join(" "), "utf8").digest().readBigInt64BE(0));
  }
  return out;
}

/** Distinct `shingleWindowHashes` (15-word rule of the delivery contract), in order of first occurrence. */
export function shingleHashes(text: string, size = COPY_SHINGLE_WORDS): bigint[] {
  return [...new Set(shingleWindowHashes(text, size))];
}

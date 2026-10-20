import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { COPY_SHINGLE_WORDS, shingleHashes, shingleWindowHashes } from "./shingles";

export { COPY_SHINGLE_WORDS };

/**
 * How much of `text` the archive already holds word for word: its distinct 15-word shingles (`shingleHashes`), how
 * many of them occur in any stored chunk (`text_shingles`, the whole archive by design, ruling M5-P20), and the
 * longest run of consecutive words they cover (`longestRun`: n overlapping hit windows in a row are 14 + n words; 0
 * without a hit). `hits > 0` means a run of at least 15 words is copied from a source text.
 */
export async function findArchiveCopies(db: Db, text: string): Promise<{ shingles: number; hits: number; longestRun: number }> {
  const hashes = shingleHashes(text, COPY_SHINGLE_WORDS);
  if (hashes.length === 0) return { shingles: 0, hits: 0, longestRun: 0 };
  const { rows } = await db.execute<{ hash: string }>(sql`
    select distinct shingle_hash::text as hash from text_shingles
    where shingle_hash = any(${`{${hashes.join(",")}}`}::bigint[])
  `);
  const found = new Set(rows.map((r) => r.hash));
  let longest = 0;
  let run = 0;
  for (const hash of shingleWindowHashes(text, COPY_SHINGLE_WORDS)) {
    run = found.has(String(hash)) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { shingles: hashes.length, hits: found.size, longestRun: longest === 0 ? 0 : COPY_SHINGLE_WORDS - 1 + longest };
}

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { shingleHashes } from "./shingles";

/** Words per shingle of the copy check (the delivery contract's 15-word rule). */
export const COPY_SHINGLE_WORDS = 15;

/**
 * How much of `text` the archive already holds word for word: its distinct 15-word shingles (`shingleHashes`) and how
 * many of them occur in any stored chunk (`text_shingles`, the whole archive by design, ruling M5-P20). `hits > 0`
 * means a run of at least 15 words is copied from a source text.
 */
export async function findArchiveCopies(db: Db, text: string): Promise<{ shingles: number; hits: number }> {
  const hashes = shingleHashes(text, COPY_SHINGLE_WORDS);
  if (hashes.length === 0) return { shingles: 0, hits: 0 };
  const { rows } = await db.execute<{ hits: number }>(sql`
    select count(distinct shingle_hash)::int as hits from text_shingles
    where shingle_hash = any(${`{${hashes.join(",")}}`}::bigint[])
  `);
  return { shingles: hashes.length, hits: Number(rows[0]?.hits ?? 0) };
}

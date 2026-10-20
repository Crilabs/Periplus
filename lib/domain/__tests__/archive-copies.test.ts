import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { textShingles } from "@/lib/db/schema";
import { findArchiveCopies } from "@/lib/domain/documents/archive-copies";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { insertTestVersion } from "@/test/text";

/*
 * The 15-word copy check reads the whole archive by design (ruling M5-P20): the word sequences are salted with a fresh
 * uuid, so no other test's chunk can hold them.
 */

/** `n` words no other text has: a uuid salt in letters, then a running letter suffix. */
function saltedWords(n: number): string[] {
  const salt = newId().replace(/-/g, "").replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!);
  return Array.from({ length: n }, (_, i) => `${salt}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"qrstuvwxyz"[Math.floor(i / 26)]}`);
}

/** A chunk holding `text`, with its shingles stored as the document store does. */
async function archived(tx: Db, text: string): Promise<void> {
  const v = await insertTestVersion(tx, [text]);
  const hashes = shingleHashes(text, 15);
  await tx.insert(textShingles).values(hashes.map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
}

describe("findArchiveCopies", () => {
  it("exactly 15 copied words are a hit (spec 08: a 15-word shingle)", () =>
    withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));
      expect(await findArchiveCopies(tx, `Die Bucht ist schön. ${words.slice(5, 20).join(" ")} Mehr nicht.`)).toMatchObject({ hits: 1, longestRun: 15 });
    }));

  it("a 16-word sequence copied from a chunk is found, a 14-word one is not", () =>
    withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));

      const sixteen = `Die Bucht ist schön. ${words.slice(5, 21).join(" ")} Mehr nicht.`;
      expect(await findArchiveCopies(tx, sixteen)).toMatchObject({ hits: 2, longestRun: 16 });
      const fourteen = `Die Bucht ist schön. ${words.slice(5, 19).join(" ")} Mehr nicht.`;
      const r = await findArchiveCopies(tx, fourteen);
      expect(r.hits).toBe(0);
      expect(r.shingles).toBeGreaterThan(0);
      expect(r.longestRun).toBe(0);
      expect(await findArchiveCopies(tx, "zu kurz")).toEqual({ shingles: 0, hits: 0, longestRun: 0 });
    }));

  it("longestRun is the longest copied run of consecutive words, not the sum of separate copies", () =>
    withRollback(async (tx) => {
      const words = saltedWords(60);
      await archived(tx, words.join(" "));
      // two separate 15-word copies (2 hits) are no 16-word copy; an 18-word copy is
      const twice = `${words.slice(0, 15).join(" ")} und dann ${words.slice(30, 45).join(" ")}`;
      expect(await findArchiveCopies(tx, twice)).toMatchObject({ hits: 2, longestRun: 15 });
      expect(await findArchiveCopies(tx, `Erst ${words.slice(40, 58).join(" ")} dann`)).toMatchObject({ hits: 4, longestRun: 18 });
    }));
});

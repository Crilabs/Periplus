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
  it("a 16-word sequence copied from a chunk is found, a 14-word one is not", () =>
    withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));

      const sixteen = `Die Bucht ist schön. ${words.slice(5, 21).join(" ")} Mehr nicht.`;
      expect(await findArchiveCopies(tx, sixteen)).toMatchObject({ hits: 2 });
      const fourteen = `Die Bucht ist schön. ${words.slice(5, 19).join(" ")} Mehr nicht.`;
      const r = await findArchiveCopies(tx, fourteen);
      expect(r.hits).toBe(0);
      expect(r.shingles).toBeGreaterThan(0);
      expect(await findArchiveCopies(tx, "zu kurz")).toEqual({ shingles: 0, hits: 0 });
    }));
});

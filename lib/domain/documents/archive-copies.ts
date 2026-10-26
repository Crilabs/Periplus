import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { berthFacts, documentVersions, landingHints, places } from "@/lib/db/schema";
import { COPY_SHINGLE_WORDS, shingleWindowHashes } from "./shingles";

export { COPY_SHINGLE_WORDS };

/**
 * The delivery copy check (anti-goal 3: no source's wording leaves Periplus). A delivered text is held against the
 * markdown of the document versions the delivered places' facts and landing hints were extracted from: those are the
 * only texts the model saw, so a copied run can only come from them (N6, replaces the whole-archive `text_shingles`
 * index, which nothing fills any more). `longestRun` is the longest run of consecutive words of `text` that occurs word
 * for word in one of the sources: n overlapping 15-word windows in a row are 14 + n words; 0 without a hit.
 */
export type CopyIndex = { longestRun(text: string): number };

/** A copy index over source texts (pure). */
export function copyIndex(sources: Iterable<string>): CopyIndex {
  const known = new Set<bigint>();
  for (const source of sources) for (const hash of shingleWindowHashes(source, COPY_SHINGLE_WORDS)) known.add(hash);
  return {
    longestRun(text) {
      let longest = 0;
      let run = 0;
      for (const hash of shingleWindowHashes(text, COPY_SHINGLE_WORDS)) {
        run = known.has(hash) ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
      return longest === 0 ? 0 : COPY_SHINGLE_WORDS - 1 + longest;
    },
  };
}

/**
 * The markdown keys of the document versions behind the places' facts (berth and landside) and landing hints, for the
 * places of the given geo objects. Every fact of the place counts, not only the bundled ones: stricter, and a fact's
 * group members are among them.
 */
export async function sourceMarkdownKeys(db: Db, geoObjectIds: string[]): Promise<string[]> {
  if (geoObjectIds.length === 0) return [];
  const placeIds = (await db.select({ id: places.id }).from(places).where(inArray(places.geoObjectId, geoObjectIds))).map((r) => r.id);
  if (placeIds.length === 0) return [];
  const fromFacts = await db
    .selectDistinct({ mdKey: documentVersions.mdKey })
    .from(berthFacts)
    .innerJoin(documentVersions, eq(documentVersions.id, berthFacts.documentVersionId))
    .where(inArray(berthFacts.placeId, placeIds));
  const fromHints = await db
    .selectDistinct({ mdKey: documentVersions.mdKey })
    .from(landingHints)
    .innerJoin(documentVersions, eq(documentVersions.id, landingHints.documentVersionId))
    .where(and(inArray(landingHints.placeId, placeIds), isNotNull(landingHints.documentVersionId)));
  return [...new Set([...fromFacts, ...fromHints].map((r) => r.mdKey))].sort();
}

/**
 * The copy index for a package: the archived markdown of `sourceMarkdownKeys`. A missing markdown object fails the build
 * (the check must not pass silently on an incomplete source set).
 */
export async function loadCopyIndex(db: Db, archive: Archive, geoObjectIds: string[]): Promise<CopyIndex> {
  const decoder = new TextDecoder();
  const sources: string[] = [];
  for (const key of await sourceMarkdownKeys(db, geoObjectIds)) {
    const body = await archive.get(key);
    if (body === null) throw new Error(`Archived markdown ${key} is missing: the copy check cannot run`);
    sources.push(decoder.decode(body));
  }
  return copyIndex(sources);
}

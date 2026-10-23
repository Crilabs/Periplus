import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, pageAssessments, researchHits, researchRouteStops, serpQueries, serpResults } from "@/lib/db/schema";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor, berthNameMatches, unitsForPlaces } from "@/lib/domain/research/assign";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestVersion } from "@/test/text";

const affixes = getConfig().nameAffixes;

describe("berthNameMatches", () => {
  it("matches through generic affixes", () => {
    expect(berthNameMatches({ name: "Ormos Vathi", island: null }, ["Vathi"], affixes)).toBe(true);
    expect(berthNameMatches({ name: "Vathi", island: null }, ["Vathi Bay"], affixes)).toBe(true);
  });
  it("does not match fuzzily", () => {
    expect(berthNameMatches({ name: "Vathy Bay", island: null }, ["Vathi"], affixes)).toBe(false);
    expect(berthNameMatches({ name: "Kolona", island: null }, ["Vathi"], affixes)).toBe(false);
  });
  it("requires the same island when both are named", () => {
    expect(berthNameMatches({ name: "Vathi", island: "Ithaca" }, ["Vathi"], affixes, ["Meganisi"])).toBe(false);
    expect(berthNameMatches({ name: "Vathi", island: "Ithaca" }, ["Vathi"], affixes, ["Ithaca"])).toBe(true);
    expect(berthNameMatches({ name: "Vathi", island: "Ithaca" }, ["Vathi"], affixes, [])).toBe(true);
    expect(berthNameMatches({ name: "Vathi", island: null }, ["Vathi"], affixes, ["Meganisi"])).toBe(true);
  });
});

async function hit(tx: Db, placeId: string, geoObjectId: string, url: string) {
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: geoObjectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
    .returning({ id: serpQueries.id });
  const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: "test.invalid", title: "t", snippet: "s" }).returning({ id: serpResults.id });
  await tx.insert(researchHits).values({ placeId, geoObjectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: "test.invalid", rank: 1, purpose: "positive" });
}

async function assessedPage(tx: Db, placeId: string, objectId: string, berths: string[], generated = false, assess = true, texts: string[] = ["x"]) {
  const v = await insertTestVersion(tx, texts);
  const url = (await tx.select().from(documents).where(eq(documents.id, v.documentId)))[0]!.urlNormalized;
  await hit(tx, placeId, objectId, url);
  if (assess) {
    const { model, promptVersion } = activeAssessor();
    await tx.insert(pageAssessments).values({
      documentVersionId: v.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated,
      observedAt: "2025-06-15", observedAtBasis: "explicit", berths: berths.map((name) => ({ name, island: null, kind: "anchorage" as const })), runId: await insertTestRun(tx),
    });
  }
  return v.versionId;
}

/** An archive that serves `text` under the version's Markdown key. */
async function archiveOf(tx: Db, versionId: string, text: string) {
  const [v] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, versionId));
  return { get: async (key: string) => (key === v!.mdKey ? new TextEncoder().encode(text) : null) };
}

const noArchive = { get: async () => null };

describe("unitsForPlaces", () => {
  // 0.05 deg longitude at 35.2 N is about 4.5 km; 0.45 deg about 41 km
  it("adds nearby candidates named on the page, not distant ones", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Alpha", lon: 21.0, lat: 35.2, status: "candidate" });
      const b = await insertPlace(tx, { name: "Bravo", lon: 21.055, lat: 35.2, status: "candidate" });
      await insertPlace(tx, { name: "Bravo", lon: 21.45, lat: 35.2, status: "candidate" });
      await insertPlace(tx, { name: "Delta", lon: 21.02, lat: 35.2, status: "candidate" });
      const versionId = await assessedPage(tx, a.placeId, a.objectId, ["Alpha", "Bravo"]);
      const units = await unitsForPlaces(tx, [a.placeId], getConfig(), noArchive);
      expect(units).toEqual([{ documentVersionId: versionId, placeIds: [a.placeId, b.placeId].sort() }]);
    }));

  it("gives a searched place no unit when the page names it neither in the assessment nor in the text", () =>
    withRollback(async (tx) => {
      const y = await insertPlace(tx, { name: "Ypsilon", lon: 21.0, status: "candidate" });
      const text = "We sailed around Zulu and had a lovely time.";
      const v = await assessedPage(tx, y.placeId, y.objectId, ["Zulu"], false, true, [text]);
      const archive = await archiveOf(tx, v, text);
      expect(await unitsForPlaces(tx, [y.placeId], getConfig(), archive)).toEqual([]);
    }));

  it("keeps a searched place when the page's Markdown is missing (undecidable; extraction skips it as missing Markdown)", () =>
    withRollback(async (tx) => {
      const y = await insertPlace(tx, { name: "Ypsilon", lon: 21.0, status: "candidate" });
      const v = await assessedPage(tx, y.placeId, y.objectId, ["Zulu"]);
      expect(await unitsForPlaces(tx, [y.placeId], getConfig(), noArchive)).toEqual([{ documentVersionId: v, placeIds: [y.placeId] }]);
    }));

  it("gives a searched place a unit when only the text names it (whole words, accent-insensitive)", () =>
    withRollback(async (tx) => {
      const y = await insertPlace(tx, { name: "Ypsilon", lon: 21.0, status: "candidate" });
      const text = "Wir ankerten vor YPSÍLON und blieben die Nacht.";
      const v = await assessedPage(tx, y.placeId, y.objectId, ["Zulu"], false, true, [text]);
      expect(await unitsForPlaces(tx, [y.placeId], getConfig(), await archiveOf(tx, v, text))).toEqual([{ documentVersionId: v, placeIds: [y.placeId] }]);
      const w = await assessedPage(tx, y.placeId, y.objectId, ["Zulu"], false, true, ["Ypsilonia is another place."]);
      const both = { get: async (key: string) => (await archiveOf(tx, v, text).then((a) => a.get(key))) ?? (await archiveOf(tx, w, "Ypsilonia is another place.").then((a) => a.get(key))) };
      expect(await unitsForPlaces(tx, [y.placeId], getConfig(), both)).toEqual([{ documentVersionId: v, placeIds: [y.placeId] }]);
    }));

  it("yields no unit for generated or unassessed pages", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Alpha", status: "candidate" });
      await assessedPage(tx, a.placeId, a.objectId, ["Alpha"], true);
      await assessedPage(tx, a.placeId, a.objectId, ["Alpha"], false, false);
      expect(await unitsForPlaces(tx, [a.placeId], getConfig(), noArchive)).toEqual([]);
    }));

  it("ignores rejected neighbours", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Alpha", lon: 21.0, status: "candidate" });
      await insertPlace(tx, { name: "Bravo", lon: 21.055, status: "rejected" });
      await assessedPage(tx, a.placeId, a.objectId, ["Alpha", "Bravo"]);
      const units = await unitsForPlaces(tx, [a.placeId], getConfig(), noArchive);
      expect(units[0]!.placeIds).toEqual([a.placeId]);
    }));

  it("adds a place a route stop of the page points to, for the active route model and prompt only", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Alpha", lon: 21.0, status: "candidate" });
      const far = await insertPlace(tx, { name: "Echo", lon: 21.9, status: "candidate" });
      const stale = await insertPlace(tx, { name: "Foxtrot", lon: 22.3, status: "candidate" });
      const versionId = await assessedPage(tx, a.placeId, a.objectId, ["Alpha"]);
      const { model, promptVersion } = activeRouteExtractor(getConfig());
      await tx.insert(researchRouteStops).values([
        { documentVersionId: versionId, seq: 0, name: "Ormos Echo", quote: "q", observedAt: "2025-06-15", placeId: far.placeId, match: "corridor", model, promptVersion },
        { documentVersionId: versionId, seq: 1, name: "Foxtrot", quote: "q", observedAt: "2025-06-15", placeId: stale.placeId, match: "name", model, promptVersion: promptVersion + 1 },
      ]);
      expect(await unitsForPlaces(tx, [far.placeId], getConfig(), noArchive)).toEqual([{ documentVersionId: versionId, placeIds: [far.placeId] }]);
      expect(await unitsForPlaces(tx, [stale.placeId], getConfig(), noArchive)).toEqual([]);
      expect((await unitsForPlaces(tx, [a.placeId, far.placeId], getConfig(), noArchive))[0]!.placeIds).toEqual([a.placeId, far.placeId].sort());
    }));
});

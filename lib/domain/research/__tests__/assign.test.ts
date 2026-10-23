import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, pageAssessments, researchHits, serpQueries, serpResults } from "@/lib/db/schema";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { berthNameMatches, unitsForPlaces } from "@/lib/domain/research/assign";
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

async function assessedPage(tx: Db, placeId: string, objectId: string, berths: string[], generated = false, assess = true) {
  const v = await insertTestVersion(tx, ["x"]);
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

describe("unitsForPlaces", () => {
  // 0.05 deg longitude at 35.2 N is about 4.5 km; 0.45 deg about 41 km
  it("adds nearby candidates named on the page, not distant ones", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Alpha", lon: 21.0, lat: 35.2, status: "candidate" });
      const b = await insertPlace(tx, { name: "Bravo", lon: 21.055, lat: 35.2, status: "candidate" });
      await insertPlace(tx, { name: "Bravo", lon: 21.45, lat: 35.2, status: "candidate" });
      await insertPlace(tx, { name: "Delta", lon: 21.02, lat: 35.2, status: "candidate" });
      const versionId = await assessedPage(tx, a.placeId, a.objectId, ["Alpha", "Bravo"]);
      const units = await unitsForPlaces(tx, [a.placeId], getConfig());
      expect(units).toEqual([{ documentVersionId: versionId, placeIds: [a.placeId, b.placeId].sort() }]);
    }));

  it("yields no unit for generated or unassessed pages", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Alpha", status: "candidate" });
      await assessedPage(tx, a.placeId, a.objectId, ["Alpha"], true);
      await assessedPage(tx, a.placeId, a.objectId, ["Alpha"], false, false);
      expect(await unitsForPlaces(tx, [a.placeId], getConfig())).toEqual([]);
    }));

  it("ignores rejected neighbours", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Alpha", lon: 21.0, status: "candidate" });
      await insertPlace(tx, { name: "Bravo", lon: 21.055, status: "rejected" });
      await assessedPage(tx, a.placeId, a.objectId, ["Alpha", "Bravo"]);
      const units = await unitsForPlaces(tx, [a.placeId], getConfig());
      expect(units[0]!.placeIds).toEqual([a.placeId]);
    }));
});

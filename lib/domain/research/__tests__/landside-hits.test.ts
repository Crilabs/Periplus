import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, researchHits } from "@/lib/db/schema";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { unitsForPlaces } from "@/lib/domain/research/assign";
import { loadEvidence } from "@/lib/domain/research/confirmation";
import { matchStops } from "@/lib/domain/research/discovery";
import { measureGate } from "@/lib/domain/research/gate-report";
import { planResearchDiscover, planResearchRoutes } from "@/lib/pipeline/research/routes";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { signalPage } from "@/test/research-signals";
import { insertTestRun, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";
import { tileIdFor } from "@/lib/domain/tiles";
import { documents, pageAssessments, researchRouteStops } from "@/lib/db/schema";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { newId } from "@/lib/domain/ids";

/* A landside hit (purpose `landside`) is no evidence for the berth: the berth-side readers of research_hits ignore it. */

const config = getConfig();
const noArchive = { get: async () => null };

describe("landside hits never feed berth logic", () => {
  it("planUnits: a landside-only hit on a page naming the place creates no unit; a positive hit does", () =>
    withRollback(async (tx) => {
      const p = await insertPlace(tx, { name: "Alpha", lon: 21.0, lat: 35.2, status: "candidate" });
      const landside = await signalPage(tx, config, p, { domain: "a.example", hitPurpose: "landside" });
      expect(await unitsForPlaces(tx, [p.placeId], config, noArchive)).toEqual([]);
      await tx.update(researchHits).set({ purpose: "positive" }).where(eq(researchHits.placeId, p.placeId));
      expect((await unitsForPlaces(tx, [p.placeId], config, noArchive)).map((u) => u.documentVersionId)).toEqual([landside.versionId]);
    }));

  it("loadEvidence: a landside hit is no search link", () =>
    withRollback(async (tx) => {
      const p = await insertPlace(tx, { name: "Alpha", lon: 21.0, lat: 35.2, status: "candidate" });
      await signalPage(tx, config, p, { domain: "a.example", hitPurpose: "landside" });
      expect((await loadEvidence(tx, [p.placeId], config)).get(p.placeId)!.map((e) => e.link)).toEqual(["name"]);
      await tx.update(researchHits).set({ purpose: "positive" }).where(eq(researchHits.placeId, p.placeId));
      expect((await loadEvidence(tx, [p.placeId], config)).get(p.placeId)!.map((e) => e.link)).toEqual(["search"]);
    }));

  it("gate hasHits: a place with landside hits only is a miss without search hits", () =>
    withRollback(async (tx) => {
      const key = `XL-${newId()}`;
      const sub = await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
      await insertTestTile(tx, tileIdFor(21.0, 35.2), null, sub.id);
      const p = await insertPlace(tx, { name: "Alpha", lon: 21.0, lat: 35.2, status: "candidate" });
      await tx.update(geoObjects).set({ subdivisionId: sub.id }).where(eq(geoObjects.id, p.objectId));
      await signalPage(tx, config, p, { domain: "a.example", hitPurpose: "landside" });
      const spot = { lat: 35.2, lon: 21.0, prot: null, seabeds: null, name: null, kind: "mooring" as const, type: null, water: null, shop: null };
      const reasons = async () => (await measureGate(tx, { subdivisionKey: key, spots: [spot] }, config)).misses.get(config.research.gate.thresholds[0]!)!.map((m) => m.reason);
      expect(await reasons()).toContain("no_hits");
      await tx.update(researchHits).set({ purpose: "positive" }).where(eq(researchHits.placeId, p.placeId));
      expect(await reasons()).not.toContain("no_hits");
    }));
});

async function reportPage(tx: Db, at: { placeId: string; objectId: string }, purpose: "positive" | "landside", withStops: boolean) {
  const v = await insertTestVersion(tx, ["x"]);
  const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
  const assessor = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model: assessor.model, promptVersion: assessor.promptVersion, pageKind: "trip_report", firstHand: true, generated: false,
    language: "de", observedAt: "2025-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  await tx.insert(researchHits).values({ placeId: at.placeId, geoObjectId: at.objectId, urlNormalized: doc!.urlNormalized, domain: "test.invalid", rank: 0, purpose, origin: "place_website" });
  if (withStops) {
    const { model, promptVersion } = activeRouteExtractor(config);
    await tx.insert(researchRouteStops).values({ documentVersionId: v.versionId, seq: 0, name: "Alpha", mooringKind: "anchor", quote: "We reached Alpha", observedAt: "2025-06-15", model, promptVersion });
  }
  return v.versionId;
}

describe("landside hits never feed route planning", () => {
  it("research.routes plans a trip report of a positive hit, not of a landside hit", () =>
    withRollback(async (tx) => {
      const p = await insertPlace(tx, { name: "Alpha", lon: 21.0, lat: 35.2, status: "candidate" });
      const run = { id: newId(), params: { placeIds: [p.placeId] } };
      const v = await reportPage(tx, p, "landside", false);
      expect(await planResearchRoutes(tx, run, config)).toEqual([]);
      await tx.update(researchHits).set({ purpose: "positive" }).where(eq(researchHits.placeId, p.placeId));
      expect(await planResearchRoutes(tx, run, config)).toEqual([expect.objectContaining({ versionIds: [v] })]);
    }));

  it("research.discover plans open stops of a positive hit, not of a landside hit", () =>
    withRollback(async (tx) => {
      const p = await insertPlace(tx, { name: "Alpha", lon: 21.0, lat: 35.2, status: "candidate" });
      const run = { id: newId(), params: { placeIds: [p.placeId] } };
      const v = await reportPage(tx, p, "landside", true);
      expect(await planResearchDiscover(tx, run, config)).toEqual([]);
      await tx.update(researchHits).set({ purpose: "positive" }).where(eq(researchHits.placeId, p.placeId));
      expect(await planResearchDiscover(tx, run, config)).toEqual([{ key: v, documentVersionId: v }]);
    }));

  it("matchStops: a landside hit makes no place a place of the page", () =>
    withRollback(async (tx) => {
      const p = await insertPlace(tx, { name: "Alpha", lon: 33.4, lat: 42.6, status: "candidate" });
      const v = await reportPage(tx, p, "landside", true);
      expect(await matchStops(tx, v, config)).toEqual({ byName: 0, byCorridor: 0, open: 1 });
      await tx.update(researchHits).set({ purpose: "positive" }).where(eq(researchHits.placeId, p.placeId));
      expect((await matchStops(tx, v, config)).byName).toBe(1);
    }));
});


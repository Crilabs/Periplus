import { and, asc, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, geoNames, pageAssessments, places, researchHits, researchRouteStops, serpQueries, serpResults } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { matchStops } from "@/lib/domain/research/discovery";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestGeoObject, insertTestRun, insertTestVersion } from "@/test/text";

const config = getConfig();

// Outside the pilot box (test/db.ts). At 42.6 N one degree of longitude is about 81.9 km.
const LAT = 42.6;
const X0 = 33.4;

async function hit(tx: Db, placeId: string, geoObjectId: string, url: string) {
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: geoObjectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
    .returning({ id: serpQueries.id });
  const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: "test.invalid", title: "t", snippet: "s" }).returning({ id: serpResults.id });
  await tx.insert(researchHits).values({ placeId, geoObjectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: "test.invalid", rank: 1, purpose: "positive" });
}

/** A candidate bay without any name. */
async function unnamedPlace(tx: Db, lon: number, lat: number, kind: "anchorage" | "mooring_field" = "anchorage"): Promise<{ placeId: string; objectId: string }> {
  const point = geomFromGeoJson({ type: "Point", coordinates: [lon, lat] });
  const objectId = await insertTestGeoObject(tx, { type: "bay", geom: point });
  const [p] = await tx.insert(places).values({ geoObjectId: objectId, kind, status: "candidate", position: point }).returning({ id: places.id });
  return { placeId: p!.id, objectId };
}

/** A German trip report, a hit of `of`, with the route stops `stops` (active route model and prompt). */
async function routedPage(tx: Db, of: { placeId: string; objectId: string }, stops: string[]): Promise<string> {
  const v = await insertTestVersion(tx, ["x"]);
  const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
  await hit(tx, of.placeId, of.objectId, doc!.urlNormalized);
  const assessor = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model: assessor.model, promptVersion: assessor.promptVersion, pageKind: "trip_report", firstHand: true, generated: false,
    language: "de", observedAt: "2025-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  const { model, promptVersion } = activeRouteExtractor(config);
  if (stops.length > 0) {
    await tx.insert(researchRouteStops).values(
      stops.map((name, seq) => ({ documentVersionId: v.versionId, seq, name, mooringKind: "anchor", quote: `We reached ${name}`, observedAt: "2025-06-15", model, promptVersion })),
    );
  }
  return v.versionId;
}

async function stopsOf(tx: Db, versionId: string) {
  return tx
    .select({ name: researchRouteStops.name, placeId: researchRouteStops.placeId, match: researchRouteStops.match })
    .from(researchRouteStops)
    .where(eq(researchRouteStops.documentVersionId, versionId))
    .orderBy(asc(researchRouteStops.seq));
}

async function namesOf(tx: Db, objectId: string) {
  return tx
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, objectId), isNull(geoNames.validTo)));
}

describe("matchStops", () => {
  it("assigns an unknown stop between two known ones to the only unnamed bay in the corridor and names it", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      const poros = await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      const bay = await unnamedPlace(tx, X0 + 0.07, LAT + 0.005);
      // a named bay in the corridor whose name does not fit
      await insertPlace(tx, { name: "Kalamaki", lon: X0 + 0.1, lat: LAT - 0.005, status: "candidate" });
      const versionId = await routedPage(tx, hydra, ["Hydra", "Ormos Livadi", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 1, open: 0 });
      expect(await stopsOf(tx, versionId)).toEqual([
        { name: "Hydra", placeId: hydra.placeId, match: "name" },
        { name: "Ormos Livadi", placeId: bay.placeId, match: "corridor" },
        { name: "Poros", placeId: poros.placeId, match: "name" },
      ]);
      expect(await namesOf(tx, bay.objectId)).toEqual([{ name: "Ormos Livadi", language: "de", origin: "research" }]);
      const [place] = await tx.select({ status: places.status }).from(places).where(eq(places.id, bay.placeId));
      expect(place!.status).toBe("candidate");

      // a second call changes nothing
      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 0, byCorridor: 0, open: 0 });
      expect(await namesOf(tx, bay.objectId)).toHaveLength(1);
    }));

  it("assigns a stop in the corridor to a named candidate with a similar name, without renaming it", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      const georgios = await insertPlace(tx, { name: "Agios Georgios", lon: X0 + 0.07, lat: LAT + 0.005, status: "candidate" });
      await unnamedPlace(tx, X0 + 0.1, LAT - 0.005);
      const versionId = await routedPage(tx, hydra, ["Hydra", "Agios Georgious", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 1, open: 0 });
      expect((await stopsOf(tx, versionId))[1]).toEqual({ name: "Agios Georgious", placeId: georgios.placeId, match: "corridor" });
      expect((await namesOf(tx, georgios.objectId)).map((n) => n.name)).toEqual(["Agios Georgios"]);
    }));

  it("leaves the stop open when two unnamed bays lie in the corridor", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      const a = await unnamedPlace(tx, X0 + 0.05, LAT + 0.005);
      const b = await unnamedPlace(tx, X0 + 0.1, LAT - 0.005, "mooring_field");
      const versionId = await routedPage(tx, hydra, ["Hydra", "Ormos Livadi", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 0, open: 1 });
      expect((await stopsOf(tx, versionId))[1]).toEqual({ name: "Ormos Livadi", placeId: null, match: null });
      expect(await namesOf(tx, a.objectId)).toEqual([]);
      expect(await namesOf(tx, b.objectId)).toEqual([]);
    }));

  it("matches a stop by name to the only candidate of that name 10 km away", () =>
    withRollback(async (tx) => {
      const kastos = await insertPlace(tx, { name: "Kastos", lon: X0, lat: LAT, status: "candidate" });
      const vathi = await insertPlace(tx, { name: "Vathi", lon: X0 + 0.122, lat: LAT, status: "candidate" });
      // another Vathi far away, and a rejected one nearby
      await insertPlace(tx, { name: "Vathi", lon: X0 + 0.8, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Vathi", lon: X0 + 0.05, lat: LAT, status: "rejected" });
      const versionId = await routedPage(tx, kastos, ["Vathi"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 1, byCorridor: 0, open: 0 });
      expect(await stopsOf(tx, versionId)).toEqual([{ name: "Vathi", placeId: vathi.placeId, match: "name" }]);
    }));

  it("leaves an unknown stop without both neighbours open", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      const bay = await unnamedPlace(tx, X0 + 0.03, LAT + 0.002);
      const versionId = await routedPage(tx, hydra, ["Hydra", "Ormos Livadi"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 1, byCorridor: 0, open: 1 });
      expect((await stopsOf(tx, versionId))[1]).toEqual({ name: "Ormos Livadi", placeId: null, match: null });
      expect(await namesOf(tx, bay.objectId)).toEqual([]);
    }));
});

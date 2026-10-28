import { and, asc, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, geoNames, geoObjects, pageAssessments, places, researchHits, researchRouteStops, serpQueries, serpResults } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor, unitsForPlaces } from "@/lib/domain/research/assign";
import { matchStops } from "@/lib/domain/research/discovery";
import { candidateNames } from "@/lib/domain/research/queries";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestGeoObject, insertTestRun, insertTestSubdivision, insertTestVersion } from "@/test/text";

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

type At = { placeId: string; objectId: string };

/**
 * A German trip report, a hit of `of` (one or several places), with the route stops `stops` (active route model and
 * prompt), dated `dates` (else the page's date). `url` replaces the page's address (its registrable domain counts).
 */
async function routedPage(tx: Db, of: At | At[], stops: string[], opts: { url?: string; dates?: string[] } = {}): Promise<string> {
  const v = await insertTestVersion(tx, ["x"]);
  if (opts.url) await tx.update(documents).set({ url: opts.url, urlNormalized: opts.url }).where(eq(documents.id, v.documentId));
  const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
  for (const at of Array.isArray(of) ? of : [of]) await hit(tx, at.placeId, at.objectId, doc!.urlNormalized);
  const assessor = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model: assessor.model, promptVersion: assessor.promptVersion, pageKind: "trip_report", firstHand: true, generated: false,
    language: "de", observedAt: "2025-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  const { model, promptVersion } = activeRouteExtractor(config);
  if (stops.length > 0) {
    await tx.insert(researchRouteStops).values(
      stops.map((name, seq) => ({
        documentVersionId: v.versionId, seq, name, mooringKind: "anchor", quote: `We reached ${name}`, observedAt: opts.dates?.[seq] ?? "2025-06-15", model, promptVersion,
      })),
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
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin, isPreferred: geoNames.isPreferred })
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
      expect(await namesOf(tx, bay.objectId)).toEqual([{ name: "Ormos Livadi", language: "de", origin: "research", isPreferred: false }]);
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
      const versionId = await routedPage(tx, hydra, ["Hydra", "Agios Georgioss", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 1, open: 0 });
      expect((await stopsOf(tx, versionId))[1]).toEqual({ name: "Agios Georgioss", placeId: georgios.placeId, match: "corridor" });
      expect((await namesOf(tx, georgios.objectId)).map((n) => n.name)).toEqual(["Agios Georgios"]);
      expect((await namesOf(tx, georgios.objectId))[0]!.isPreferred).toBe(true);
    }));

  it("assigns a stop whose name differs only in its Greek ending by name (B34)", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      const georgios = await insertPlace(tx, { name: "Agios Georgios", lon: X0 + 0.07, lat: LAT + 0.005, status: "candidate" });
      const versionId = await routedPage(tx, hydra, ["Hydra", "Agios Georgiou", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 3, byCorridor: 0, open: 0 });
      expect((await stopsOf(tx, versionId))[1]).toMatchObject({ name: "Agios Georgiou", placeId: georgios.placeId });
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

  it("leaves a stop open when its neighbours' surroundings hold two places of its name, whatever the page area holds", () =>
    withRollback(async (tx) => {
      const sub = await insertTestSubdivision(tx, `t5-${Date.now()}`, [X0 - 1, LAT - 1, X0 + 1, LAT + 1]);
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      // two Vathi within the radius of Poros (but not of Hydra), one far away in Hydra's subdivision
      await insertPlace(tx, { name: "Vathi", lon: X0 + 0.25, lat: LAT + 0.03, status: "candidate" });
      await insertPlace(tx, { name: "Vathi", lon: X0 + 0.25, lat: LAT - 0.03, status: "candidate" });
      const far = await insertPlace(tx, { name: "Vathi", lon: X0 - 0.5, lat: LAT, status: "candidate" });
      for (const o of [hydra.objectId, far.objectId]) await tx.update(geoObjects).set({ subdivisionId: sub.id }).where(eq(geoObjects.id, o));
      const versionId = await routedPage(tx, hydra, ["Hydra", "Vathi", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 0, open: 1 });
      expect((await stopsOf(tx, versionId))[1]).toEqual({ name: "Vathi", placeId: null, match: null });
    }));

  it("does not name an unnamed bay when a named corridor candidate has a similar name", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Vathi", lon: X0 + 0.05, lat: LAT + 0.005, status: "candidate" });
      const bay = await unnamedPlace(tx, X0 + 0.1, LAT - 0.005);
      const versionId = await routedPage(tx, hydra, ["Hydra", "Vathy", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 0, open: 1 });
      expect(await namesOf(tx, bay.objectId)).toEqual([]);
    }));

  it("uses no corridor for a leg longer than maxLegKm", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      const poros = await insertPlace(tx, { name: "Poros", lon: X0 + 0.733, lat: LAT, status: "candidate" });
      const bay = await unnamedPlace(tx, X0 + 0.36, LAT + 0.005);
      const versionId = await routedPage(tx, [hydra, poros], ["Hydra", "Ormos Livadi", "Poros"]);

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 0, open: 1 });
      expect(await namesOf(tx, bay.objectId)).toEqual([]);
    }));

  it("uses no corridor when the neighbour stops are more than maxLegDays apart", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      const bay = await unnamedPlace(tx, X0 + 0.07, LAT + 0.005);
      const versionId = await routedPage(tx, hydra, ["Hydra", "Ormos Livadi", "Poros"], { dates: ["2025-06-01", "2025-06-05", "2025-06-11"] });

      expect(await matchStops(tx, versionId, config)).toEqual({ byName: 2, byCorridor: 0, open: 1 });
      expect(await namesOf(tx, bay.objectId)).toEqual([]);
    }));

  it("keeps a research name provisional until stops of two domains give it", () =>
    withRollback(async (tx) => {
      const hydra = await insertPlace(tx, { name: "Hydra", lon: X0, lat: LAT, status: "candidate" });
      await insertPlace(tx, { name: "Poros", lon: X0 + 0.15, lat: LAT, status: "candidate" });
      const bay = await unnamedPlace(tx, X0 + 0.07, LAT + 0.005);
      const route = ["Hydra", "Ormos Livadi", "Poros"];
      const first = await routedPage(tx, hydra, route, { url: "https://www.sailing-a.com/one" });
      expect((await matchStops(tx, first, config)).byCorridor).toBe(1);

      // provisional: not searched with, not matched by name on another page
      expect((await candidateNames(tx, bay.placeId)).names).toEqual({});
      const other = await routedPage(tx, hydra, ["Livadi"], { url: "https://www.elsewhere-c.net/x" });
      expect(await matchStops(tx, other, config)).toEqual({ byName: 0, byCorridor: 0, open: 1 });
      // but the page linked through its stop is a page of the bay
      expect((await unitsForPlaces(tx, [bay.placeId], config, { get: async () => null })).map((u) => u.documentVersionId)).toEqual([first]);

      // the same domain again does not corroborate it
      const same = await routedPage(tx, hydra, route, { url: "https://blog.sailing-a.com/two" });
      expect((await matchStops(tx, same, config)).byCorridor).toBe(1);
      expect((await candidateNames(tx, bay.placeId)).names).toEqual({});

      // a second domain does; the name stays not preferred
      const second = await routedPage(tx, hydra, route, { url: "https://www.cruising-b.org/three" });
      expect((await matchStops(tx, second, config)).byCorridor).toBe(1);
      expect((await candidateNames(tx, bay.placeId)).names).toEqual({ de: "Ormos Livadi" });
      expect(await namesOf(tx, bay.objectId)).toEqual([{ name: "Ormos Livadi", language: "de", origin: "research", isPreferred: false }]);
      expect(await matchStops(tx, other, config)).toEqual({ byName: 1, byCorridor: 0, open: 0 });
      expect((await stopsOf(tx, other))[0]!.placeId).toBe(bay.placeId);
    }));
});

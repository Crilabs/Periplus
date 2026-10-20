import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig, loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  COMPARISON_ATTRIBUTES,
  comparisonResults,
  comparisonSet,
  places,
  routes,
  routeStops,
  sources,
  tiles,
  type ComparisonAttribute,
  type ComparisonResultValue,
  type PlaceStatus,
} from "@/lib/db/schema";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { newId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import {
  insertComputation,
  insertExtraction,
  insertMention,
  insertMentionFact,
  insertSource,
  type TestMention,
} from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestVersion } from "@/test/text";
import { comparisonValues, loadComparisonSubjects } from "../comparison-values";
import {
  coverageMetric,
  factPrecisionMetric,
  multiDocumentMetric,
  multiSourceMetric,
  quoteFidelityMetric,
  routeReconstructionMetric,
  shelterConfidenceMetric,
} from "../metrics";

// Synthetic area around 21.0° E / 35.2° N (outside the pilot box): two tiles, every row rolled back.

const quality = getConfig().quality;
const extractRoute = loadConfig("config").models.tasks["extract-route"]!;
const WEST = { lon: 21.0, lat: 35.2 };
const EAST = { lon: 21.3, lat: 35.2 };

async function area(tx: Db) {
  const areaKey = `test-${newId()}`;
  const areaId = await insertNamedObject(tx, { type: "area", names: [{ name: "Test area" }], lon: 21.15, lat: 35.2, configKey: areaKey });
  const tileIds: string[] = [];
  for (const p of [WEST, EAST]) {
    const id = tileIdFor(p.lon, p.lat);
    const [w, s, e, n] = tileBbox(id);
    await tx
      .insert(tiles)
      .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId })
      .onConflictDoUpdate({ target: tiles.id, set: { areaId } });
    tileIds.push(id);
  }
  let n = 0;
  /** A place in the west tile (or `at`), confirmed unless told otherwise, optionally in the comparison set. */
  const addPlace = async (o: { status?: PlaceStatus; inSet?: boolean; at?: { lon: number; lat: number }; name?: string } = {}) => {
    const at = o.at ?? WEST;
    const lon = at.lon + 0.001 * ++n;
    const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: o.name ?? `Place ${n}` }], lon, lat: at.lat });
    const [p] = await tx
      .insert(places)
      .values({
        geoObjectId: objectId,
        kind: "anchorage",
        status: o.status ?? "confirmed",
        // valid long before any fixed measurement date a test passes as today
        validFrom: "2000-01-01",
        tileId: tileIdFor(lon, at.lat),
        position: geomFromGeoJson({ type: "Point", coordinates: [lon, at.lat] }),
      })
      .returning({ id: places.id });
    if (o.inSet) await tx.insert(comparisonSet).values({ placeId: p!.id, areaId, addedBy: "test" });
    return { placeId: p!.id, objectId };
  };
  return { areaKey, areaId, westTile: tileIds[0]!, eastTile: tileIds[1]!, addPlace };
}

/** A duplicate geo object merged into `survivorId` (as the gazetteer merge leaves it: ended, `merged_into_id` set). */
async function mergedDuplicate(tx: Db, survivorId: string): Promise<string> {
  const id = await insertNamedObject(tx, { type: "bay", names: [{ name: "Duplicate" }], lon: 21.002, lat: 35.2 });
  await tx.execute(sql`update geo_objects set merged_into_id = ${survivorId}, valid_to = current_date where id = ${id}`);
  return id;
}

const rejectSource = (tx: Db, sourceId: string) => tx.update(sources).set({ status: "rejected" }).where(eq(sources.id, sourceId));

/** Appends a comparison outcome for the place's current own value (or `valueHash`). */
async function addResult(
  tx: Db,
  areaKey: string,
  placeId: string,
  attribute: ComparisonAttribute,
  result: ComparisonResultValue,
  o: { method?: "manual" | "proposal_auto" | "proposal_confirmed" | "review"; valueHash?: string } = {},
) {
  const subject = (await loadComparisonSubjects(tx, areaKey)).find((s) => s.placeId === placeId)!;
  await tx.insert(comparisonResults).values({
    placeId,
    attribute,
    profileVersion: subject.profileVersion,
    valueHash: o.valueHash ?? comparisonValues(subject, quality.navily)[attribute].hash,
    result,
    method: o.method ?? (result.startsWith("deviation_confirmed") ? "review" : "manual"),
    checkedBy: "test",
  });
}

describe("coverageMetric", () => {
  it("coverage: 4 of 5 set places confirmed is 0.8", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      for (let i = 0; i < 4; i++) await addPlace({ inSet: true });
      await addPlace({ inSet: true, status: "rejected" });
      await addPlace(); // confirmed, not in the set
      expect(await coverageMetric(tx, { areaKey })).toEqual({ metric: "coverage", value: 0.8, details: { set: 5, confirmed: 4 } });
    }));

  it("an empty set or an unknown area is null", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      await addPlace();
      expect((await coverageMetric(tx, { areaKey })).value).toBeNull();
      expect(await coverageMetric(tx, { areaKey: `test-${newId()}` })).toEqual({ metric: "coverage", value: null, details: { set: 0, confirmed: 0 } });
    }));
});

describe("multiSourceMetric", () => {
  it("multi_source: two documents of one source do not count, two sources do", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const [s1, s2] = [await insertSource(tx), await insertSource(tx)];
      const oneSource = await addPlace();
      await insertMention(tx, oneSource.objectId, { sourceId: s1 });
      await insertMention(tx, oneSource.objectId, { sourceId: s1 });
      const twoSources = await addPlace();
      await insertMention(tx, twoSources.objectId, { sourceId: s1 });
      await insertMention(tx, twoSources.objectId, { sourceId: s2 });
      const single = await addPlace();
      await insertMention(tx, single.objectId, { sourceId: s2 });
      // a candidate place mentioned in two sources is not in the scope
      const candidate = await addPlace({ status: "candidate" });
      await insertMention(tx, candidate.objectId, { sourceId: s1 });
      await insertMention(tx, candidate.objectId, { sourceId: s2 });

      const r = await multiSourceMetric(tx, { areaKey });
      expect(r.metric).toBe("multi_source");
      expect(r.value).toBeCloseTo(1 / 3);
      // ≥ 2 documents (datendienst, ruling M7-P12) is reported beside it and is its own metric
      expect(r.details).toEqual({ places: 3, multi: 1, multiDocument: 2 });
      const d = await multiDocumentMetric(tx, { areaKey });
      expect(d.metric).toBe("multi_document");
      expect(d.value).toBeCloseTo(2 / 3);
      expect(d.details).toEqual({ places: 3, multiDocument: 2, multiSource: 1 });
      expect(await multiDocumentMetric(tx, { areaKey: `test-${newId()}` })).toMatchObject({ value: null, details: { places: 0 } });
    }));
});

describe("multiSourceMetric counts text as consolidation does (ruling M7-C-R2)", () => {
  it("a mention on a duplicate merged into the place counts for it", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const [s1, s2] = [await insertSource(tx), await insertSource(tx)];
      const place = await addPlace();
      await insertMention(tx, place.objectId, { sourceId: s1 });
      const duplicate = await mergedDuplicate(tx, place.objectId);
      // a chain of two merges: the older duplicate was merged into the first
      const older = await mergedDuplicate(tx, duplicate);
      await insertMention(tx, older, { sourceId: s2 });
      expect((await multiSourceMetric(tx, { areaKey })).details).toEqual({ places: 1, multi: 1, multiDocument: 1 });
    }));

  it("a mention from a rejected or ended source does not count", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const [s1, rejected, ended] = [await insertSource(tx), await insertSource(tx), await insertSource(tx)];
      const place = await addPlace();
      await insertMention(tx, place.objectId, { sourceId: s1 });
      await insertMention(tx, place.objectId, { sourceId: rejected });
      await insertMention(tx, place.objectId, { sourceId: ended });
      expect((await multiSourceMetric(tx, { areaKey })).details).toEqual({ places: 1, multi: 1, multiDocument: 1 });
      await rejectSource(tx, rejected);
      await tx.update(sources).set({ validTo: "2026-10-01" }).where(eq(sources.id, ended));
      expect((await multiSourceMetric(tx, { areaKey }, { today: "2026-10-20" })).details).toEqual({ places: 1, multi: 0, multiDocument: 0 });
      // before the source ended, it still counts
      expect((await multiSourceMetric(tx, { areaKey }, { today: "2026-09-30" })).details).toEqual({ places: 1, multi: 1, multiDocument: 1 });
    }));
});

describe("factPrecisionMetric", () => {
  it("fact_precision: 7 match + 2 confirmed own of 10 compared and 3 not_at_navily is 0.9", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const { placeId } = await addPlace({ inSet: true });
      const plan: Array<[ComparisonAttribute, ComparisonResultValue, ("proposal_auto" | "manual")?]> = [
        ["existence", "match", "proposal_auto"],
        ["position", "match", "proposal_auto"],
        ["shelter.N", "match", "proposal_auto"],
        ["shelter.NE", "match"],
        ["shelter.E", "match"],
        ["shelter.SE", "match"],
        ["shelter.S", "match"],
        ["shelter.SW", "deviation_confirmed_own"],
        ["shelter.W", "deviation_confirmed_own"],
        ["shelter.NW", "deviation_confirmed_navily"],
        ["depth", "not_at_navily"],
        ["seabed", "not_at_navily"],
        ["highlight.food", "not_at_navily"],
      ];
      for (const [attribute, result, method] of plan) await addResult(tx, areaKey, placeId, attribute, result, { method });

      const r = await factPrecisionMetric(tx, { areaKey });
      expect(r.metric).toBe("fact_precision");
      expect(r.value).toBeCloseTo(0.9);
      expect(r.details).toMatchObject({ compared: 10, correct: 9, notAtNavily: 3, pending: 3, matches: 7, autoMatches: 3 });
      const byAttribute = r.details.byAttribute as Record<ComparisonAttribute, { compared: number; correct: number }>;
      expect(Object.keys(byAttribute).sort()).toEqual([...COMPARISON_ATTRIBUTES].sort());
      expect([byAttribute["shelter.W"], byAttribute["shelter.NW"], byAttribute.depth, byAttribute["mooring.buoys"]]).toEqual([
        { compared: 1, correct: 1 },
        { compared: 1, correct: 0 },
        { compared: 0, correct: 0 },
        { compared: 0, correct: 0 },
      ]);
    }));

  it("fact_precision ignores results for an old value hash and counts them as pending", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const { placeId } = await addPlace({ inSet: true });
      await addResult(tx, areaKey, placeId, "existence", "match");
      await addResult(tx, areaKey, placeId, "services.water", "deviation", { valueHash: "0123456789abcdef" });
      const r = await factPrecisionMetric(tx, { areaKey });
      expect(r.value).toBe(1);
      expect(r.details).toMatchObject({ compared: 1, correct: 1, notAtNavily: 0, pending: 15 });
    }));

  it("without compared results the precision is null", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const { placeId } = await addPlace({ inSet: true });
      await addResult(tx, areaKey, placeId, "depth", "not_at_navily");
      expect((await factPrecisionMetric(tx, { areaKey })).value).toBeNull();
    }));
});

describe("quoteFidelityMetric", () => {
  // runs dated in 2001, so no row another test commits falls into the window
  const window = { from: new Date("2001-02-03T00:00:00Z"), to: new Date("2001-02-04T00:00:00Z") };
  const textRun = async (
    tx: Db,
    createdAt: Date,
    quoteCheck: { facts: number; verified: number },
    o: { purpose?: "regular" | "comparison"; evaluation?: boolean } = {},
  ) => {
    const runId = await insertTestRun(tx);
    await tx.execute(sql`update runs set created_at = ${createdAt.toISOString()}::timestamptz, params = ${JSON.stringify(o.evaluation ? { evaluation: true } : {})}::jsonb where id = ${runId}`);
    await insertTestExtractionRun(tx, {
      runId,
      purpose: o.purpose ?? "regular",
      quoteCheck: { ...quoteCheck, ratio: quoteCheck.verified / quoteCheck.facts, failures: [] },
    });
    return runId;
  };

  it("quote_fidelity over two text runs is verified / facts", () =>
    withRollback(async (tx) => {
      await textRun(tx, new Date("2001-02-03T08:00:00Z"), { facts: 100, verified: 100 });
      await textRun(tx, new Date("2001-02-03T20:00:00Z"), { facts: 100, verified: 99 });
      await textRun(tx, new Date("2001-02-04T00:00:00Z"), { facts: 50, verified: 0 }); // the window's end is exclusive
      await textRun(tx, new Date("2001-02-02T23:59:59Z"), { facts: 50, verified: 0 });
      const r = await quoteFidelityMetric(tx, window);
      expect(r.metric).toBe("quote_fidelity");
      expect(r.value).toBeCloseTo(0.995);
      expect(r.details).toEqual({
        facts: 200,
        verified: 199,
        runs: 2,
        regular: { facts: 200, verified: 199, runs: 2 },
        evaluation: { facts: 0, verified: 0, runs: 0 },
      });
    }));

  it("the value spans regular text runs only; evaluation and model comparison runs are reported apart (ruling M7-D-R1)", () =>
    withRollback(async (tx) => {
      await textRun(tx, new Date("2001-02-03T08:00:00Z"), { facts: 10, verified: 10 });
      await textRun(tx, new Date("2001-02-03T09:00:00Z"), { facts: 10, verified: 9 }, { purpose: "comparison" });
      await textRun(tx, new Date("2001-02-03T10:00:00Z"), { facts: 10, verified: 8 }, { evaluation: true });
      const r = await quoteFidelityMetric(tx, window);
      expect(r.value).toBe(1);
      expect(r.details).toEqual({
        facts: 10,
        verified: 10,
        runs: 1,
        regular: { facts: 10, verified: 10, runs: 1 },
        evaluation: { facts: 20, verified: 17, runs: 2 },
      });
    }));

  it("with evaluation runs only the value is null and the evaluation is still reported", () =>
    withRollback(async (tx) => {
      await textRun(tx, new Date("2001-02-03T10:00:00Z"), { facts: 10, verified: 8 }, { evaluation: true });
      const r = await quoteFidelityMetric(tx, window);
      expect(r.value).toBeNull();
      expect(r.details).toMatchObject({ facts: 0, verified: 0, runs: 0, evaluation: { facts: 10, verified: 8, runs: 1 } });
    }));

  it("without text facts in the window it is null", () =>
    withRollback(async (tx) => {
      expect(await quoteFidelityMetric(tx, { from: new Date("2001-03-03T00:00:00Z"), to: new Date("2001-03-04T00:00:00Z") })).toEqual({
        metric: "quote_fidelity",
        value: null,
        details: { facts: 0, verified: 0, runs: 0, regular: { facts: 0, verified: 0, runs: 0 }, evaluation: { facts: 0, verified: 0, runs: 0 } },
      });
    }));
});

describe("shelterConfidenceMetric", () => {
  const shelterFacts = async (tx: Db, objectId: string, values: Partial<Record<(typeof SECTORS)[number], number>>, o: { blocked?: boolean } = {}) => {
    const m: TestMention = await insertMention(tx, objectId);
    const run = await insertExtraction(tx, objectId, m, o.blocked ? { status: "blocked" } : {});
    for (const [sector, value] of Object.entries(values)) {
      await insertMentionFact(tx, objectId, m, run, { attribute: `shelter.${sector}`, value });
    }
  };
  const all = (v: number) => Object.fromEntries(SECTORS.map((s) => [s, v])) as Record<(typeof SECTORS)[number], number>;

  it("shelter_confidence counts a place only with text facts in all 8 sectors", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const complete = await addPlace();
      await insertComputation(tx, complete.objectId, "shelter", Object.fromEntries(SECTORS.map((s) => [`shelter.${s}`, 0.9])));
      // seven sectors confirm the computation (0.7 is within the tolerance 0.2), S corrects it
      await shelterFacts(tx, complete.objectId, { ...all(0.9), NE: 0.7, S: 0.1 });

      const seven = await addPlace();
      await insertComputation(tx, seven.objectId, "shelter", Object.fromEntries(SECTORS.map((s) => [`shelter.${s}`, 0.5])));
      await shelterFacts(tx, seven.objectId, Object.fromEntries(SECTORS.filter((x) => x !== "NW").map((x) => [x, 0.5])));
      // the eighth sector only from a blocked extraction run: not active, does not count
      await shelterFacts(tx, seven.objectId, { NW: 0.5 }, { blocked: true });

      const r = await shelterConfidenceMetric(tx, { areaKey }, quality);
      expect(r.metric).toBe("shelter_confidence");
      expect(r.value).toBe(0.5);
      expect(r.details).toMatchObject({ places: 2, complete: 1, confirmed: 14, corrected: 1, textOnly: 0 });
      const bySector = r.details.bySector as Record<string, { withText: number; confirmed: number; corrected: number; textOnly: number }>;
      expect(bySector.S).toEqual({ withText: 2, confirmed: 1, corrected: 1, textOnly: 0 });
      expect(bySector.NW).toEqual({ withText: 1, confirmed: 1, corrected: 0, textOnly: 0 });
    }));

  it("a text fact without a computed value is text only, never corrected (ruling M7-C-R1), and never completes a place (final review B M-5); no places is null", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const place = await addPlace();
      await shelterFacts(tx, place.objectId, all(0.9));
      const r = await shelterConfidenceMetric(tx, { areaKey }, quality);
      // spec 10: a sector counts when its text confirms or corrects the computed value; text alone does not
      expect([r.value, r.details.complete, r.details.confirmed, r.details.corrected, r.details.textOnly]).toEqual([0, 0, 0, 0, 8]);
      expect((r.details.bySector as Record<string, unknown>).E).toEqual({ withText: 1, confirmed: 0, corrected: 0, textOnly: 1 });
      expect((await shelterConfidenceMetric(tx, { areaKey: `test-${newId()}` }, quality)).value).toBeNull();
    }));

  it("facts on a merged duplicate count for the place, facts of a rejected source do not (ruling M7-C-R2)", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const place = await addPlace();
      await insertComputation(tx, place.objectId, "shelter", Object.fromEntries(SECTORS.map((x) => [`shelter.${x}`, 0.5])));
      // four sectors on the place's own object, four on a duplicate merged into it
      await shelterFacts(tx, place.objectId, { N: 0.5, NE: 0.5, E: 0.5, SE: 0.5 });
      const duplicate = await mergedDuplicate(tx, place.objectId);
      // the duplicate's own computation describes ended geometry: it is not compared with
      await insertComputation(tx, duplicate, "shelter", Object.fromEntries(SECTORS.map((x) => [`shelter.${x}`, 0.0])));
      await shelterFacts(tx, duplicate, { S: 0.5, SW: 0.5, W: 0.5, NW: 0.5 });
      const r = await shelterConfidenceMetric(tx, { areaKey }, quality);
      expect(r.value).toBe(1);
      expect(r.details).toMatchObject({ places: 1, complete: 1, confirmed: 8, corrected: 0, textOnly: 0 });

      // the same text from a rejected source: the place loses those four sectors
      const sourceOfDuplicate = (
        await tx.execute<{ source_id: string }>(sql`
          select d.source_id from facts f join mentions m on m.id = f.mention_id join document_versions v on v.id = m.document_version_id
          join documents d on d.id = v.document_id where f.geo_object_id = ${duplicate} limit 1`)
      ).rows[0]!.source_id;
      await rejectSource(tx, sourceOfDuplicate);
      const after = await shelterConfidenceMetric(tx, { areaKey }, quality);
      expect(after.value).toBe(0);
      expect(after.details).toMatchObject({ complete: 0, confirmed: 4 });
    }));
});

describe("routeReconstructionMetric", () => {
  /** A route of a route extraction run on the version; `stops` are geo object ids or null (unassigned). */
  async function addRoute(
    tx: Db,
    v: { versionId: string; chunkIds: string[] },
    stops: Array<string | null>,
    o: { status?: "finished" | "blocked"; startedAt?: Date } = {},
  ) {
    const status = o.status ?? "finished";
    const extractionRunId = await insertTestExtractionRun(tx, {
      task: "extract-route",
      model: extractRoute.model,
      promptVersion: extractRoute.promptVersion,
      status,
      blockedReason: status === "blocked" ? "quote_fidelity" : null,
      startedAt: o.startedAt ?? new Date("2026-10-18T10:00:00Z"),
    });
    const [route] = await tx.insert(routes).values({ documentVersionId: v.versionId, extractionRunId, stopsCount: stops.length }).returning({ id: routes.id });
    await tx.insert(routeStops).values(
      stops.map((geoObjectId, ordinal) => ({
        routeId: route!.id,
        ordinal,
        name: `Stop ${ordinal}`,
        geoObjectId,
        quote: "we anchored",
        quoteVerified: true,
        quoteChunkId: v.chunkIds[0]!,
      })),
    );
  }

  /** A trip report (a new document, its version current) with one route. */
  async function tripReport(tx: Db, stops: Array<string | null>) {
    const v = await insertTestVersion(tx, ["Day 1: we anchored. Day 2: we moored."]);
    await addRoute(tx, v, stops);
    return v;
  }

  it("route_reconstruction: one of two routes fully on confirmed places is 0.5", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const [a, b] = [await addPlace(), await addPlace()];
      const candidate = await addPlace({ status: "candidate" });
      const complete = await tripReport(tx, [a.objectId, b.objectId]);
      // an older route of the same version and a blocked newer route do not count: the newest eligible route does
      await addRoute(tx, complete, [a.objectId, null], { startedAt: new Date("2026-10-01T10:00:00Z") });
      await addRoute(tx, complete, [a.objectId, null], { status: "blocked", startedAt: new Date("2026-10-19T10:00:00Z") });
      const open = await tripReport(tx, [b.objectId, candidate.objectId, null]);
      // a report whose stops all lie outside the area is not in the scope
      const elsewhere = await addPlace({ at: { lon: 22.0, lat: 35.2 } });
      await tripReport(tx, [elsewhere.objectId, null]);

      const r = await routeReconstructionMetric(tx, { areaKey });
      expect(r.metric).toBe("route_reconstruction");
      expect(r.value).toBe(0.5);
      expect(r.details).toMatchObject({ routes: 2, complete: 1, openStops: 2 });
      expect(r.details.reports).toEqual(
        expect.arrayContaining([
          { documentId: complete.documentId, stops: 2, openStops: 0, complete: true },
          { documentId: open.documentId, stops: 3, openStops: 2, complete: false },
        ]),
      );
    }));

  it("a stop at a duplicate merged into a confirmed place is at that place; a rejected source's report does not count (ruling M7-C-R2)", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const [a, b] = [await addPlace(), await addPlace()];
      const duplicate = await mergedDuplicate(tx, b.objectId);
      const report = await tripReport(tx, [a.objectId, duplicate]);
      expect((await routeReconstructionMetric(tx, { areaKey })).details).toMatchObject({ routes: 1, complete: 1, openStops: 0 });
      // a report whose only in-scope stop is the merged duplicate is still in the scope
      await tripReport(tx, [duplicate, null]);
      expect((await routeReconstructionMetric(tx, { areaKey })).details).toMatchObject({ routes: 2, complete: 1, openStops: 1 });

      const [doc] = (await tx.execute<{ source_id: string }>(sql`select source_id from documents where id = ${report.documentId}`)).rows;
      await rejectSource(tx, doc!.source_id);
      const r = await routeReconstructionMetric(tx, { areaKey });
      expect((r.details.reports as Array<{ documentId: string }>).map((x) => x.documentId)).not.toContain(report.documentId);
    }));

  it("only the current version of a trip report counts; without routes it is null", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await area(tx);
      const a = await addPlace();
      expect((await routeReconstructionMetric(tx, { areaKey })).value).toBeNull();
      const old = await tripReport(tx, [a.objectId, null]);
      await insertTestVersion(tx, ["A new text without a route."], { documentId: old.documentId });
      expect((await routeReconstructionMetric(tx, { areaKey })).details).toMatchObject({ routes: 0, complete: 0, openStops: 0 });
    }));
});

describe("tile scope", () => {
  it("a tile scope counts only places of that tile", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace, westTile, eastTile } = await area(tx);
      for (let i = 0; i < 3; i++) await addPlace({ inSet: true });
      await addPlace({ inSet: true, at: EAST });
      await addPlace({ inSet: true, at: EAST, status: "rejected" });
      const s1 = await insertSource(tx);
      const s2 = await insertSource(tx);
      const east = await addPlace({ at: EAST });
      await insertMention(tx, east.objectId, { sourceId: s1 });
      await insertMention(tx, east.objectId, { sourceId: s2 });

      expect((await coverageMetric(tx, { areaKey })).details).toEqual({ set: 5, confirmed: 4 });
      expect((await coverageMetric(tx, { areaKey, tileId: westTile })).value).toBe(1);
      expect(await coverageMetric(tx, { areaKey, tileId: eastTile })).toMatchObject({ value: 0.5, details: { set: 2, confirmed: 1 } });
      expect((await multiSourceMetric(tx, { areaKey, tileId: eastTile })).details).toEqual({ places: 2, multi: 1, multiDocument: 1 });
      expect((await multiSourceMetric(tx, { areaKey, tileId: westTile })).details).toEqual({ places: 3, multi: 0, multiDocument: 0 });
      // a tile of another area is out of the scope
      expect((await coverageMetric(tx, { areaKey, tileId: tileIdFor(22.0, 35.2) })).details).toEqual({ set: 0, confirmed: 0 });
      // a set member whose tile is not labelled with the area does not count for the area (ruling M7-C-R1)
      await addPlace({ inSet: true, at: { lon: 22.0, lat: 35.2 } });
      expect((await coverageMetric(tx, { areaKey })).details).toEqual({ set: 5, confirmed: 4 });
    }));
});

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { computations, facts, mentions, places, profiles, restrictedAreas, reviewDecisions, reviewTasks, sources, wikidataSitelinks } from "@/lib/db/schema";
import type { GeoObjectType, PlaceStatus } from "@/lib/db/schema/geo";
import { popularityForArea } from "@/lib/domain/consolidation/derived/popularity";
import { loadContext, loadDerivedInputs } from "@/lib/domain/consolidation/inputs";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestTile, insertTestVersion } from "@/test/text";

/*
 * Inputs of the derived values (quietness, POI importance and spot candidates), inside withRollback around 21.0° E /
 * 35.2° N. Other tests commit places near there, so spot assertions only look at the test's own public ids.
 */

const cfg = getConsolidationConfig();
const opts = { cfg, schemaVersion: "v2", today: "" };
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  opts.today = rows[0]!.today;
});

const LON = 21.0;
const LAT = 35.2;
const NM_LAT = 1 / 60;

async function object(tx: Db, type: GeoObjectType, o: { lon?: number; lat?: number; parentId?: string | null; category?: "culture" | null } = {}) {
  return insertNamedObject(tx, { type, names: [{ name: `Test ${type}` }], lon: o.lon ?? LON, lat: o.lat ?? LAT, parentId: o.parentId ?? null, category: o.category ?? null });
}

async function place(tx: Db, objectId: string, o: { lon?: number; lat?: number; status?: PlaceStatus; publicId?: string | null; ended?: boolean } = {}) {
  await tx.insert(places).values({
    geoObjectId: objectId,
    kind: "anchorage",
    status: o.status ?? "confirmed",
    publicId: o.publicId === undefined ? `sp_${newId()}` : o.publicId,
    position: geomFromGeoJson({ type: "Point", coordinates: [o.lon ?? LON, o.lat ?? LAT] }),
    ...(o.ended ? { validTo: "2000-01-02", validFrom: "2000-01-01" } : {}),
  });
}

/** A place object (bay) with a confirmed place at (lon, lat). */
async function placeAt(tx: Db, lon: number, lat: number, o: { status?: PlaceStatus; parentId?: string; ended?: boolean } = {}) {
  const id = await object(tx, "bay", { lon, lat, parentId: o.parentId });
  const publicId = o.status === "candidate" ? null : `sp_${newId()}`;
  await place(tx, id, { lon, lat, status: o.status, publicId, ended: o.ended });
  return { id, publicId };
}

async function source(tx: Db, weight: number, status: "approved" | "rejected" = "approved"): Promise<string> {
  const [row] = await tx
    .insert(sources)
    .values({ domain: `${newId()}.test.invalid`, name: "Test source", type: "travel_guide", weight, status, crawlRules: { startUrls: [] }, origin: "manual" })
    .returning({ id: sources.id });
  return row!.id;
}

async function mentionOf(tx: Db, objectId: string, sourceId: string) {
  const v = await insertTestVersion(tx, ["The monastery is worth a visit."], { sourceId });
  await tx.insert(mentions).values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId: objectId, surface: "monastery", charStart: 4, charEnd: 13, observedAt: "2026-10-19", confidence: 1, matchKind: "deterministic" });
}

async function reviewFact(tx: Db, objectId: string, attribute: string, value: unknown) {
  const [t] = await tx
    .insert(reviewTasks)
    .values({ kind: "conflict", subjectType: "profile_attribute", subjectId: `${objectId}:${attribute}`, context: { key: newId() }, status: "decided" })
    .returning({ id: reviewTasks.id });
  const [d] = await tx.insert(reviewDecisions).values({ taskId: t!.id, decision: { action: "value_a" }, decidedBy: "test" }).returning({ id: reviewDecisions.id });
  await tx.insert(facts).values({ geoObjectId: objectId, attribute, value, reviewDecisionId: d!.id, observedAt: "2026-09-01", confidence: 0.95, factSchemaVersion: "v2" });
}

async function derived(tx: Db, objectId: string) {
  const ctx = await loadContext(tx, objectId, cfg, opts.today);
  expect(ctx).not.toBeNull();
  return loadDerivedInputs(tx, objectId, ctx!, opts);
}

describe("loadDerivedInputs", () => {
  it("a poi gets confirmed places within 50 nm as candidates, a candidate place is not one", () =>
    withRollback(async (tx) => {
      const poi = await object(tx, "poi", { category: "culture" });
      await tx.execute(sql`update geo_objects set wikidata_id = 'Q940000001' where id = ${poi}`);
      await tx.insert(wikidataSitelinks).values({ wikidataId: "Q940000001", sitelinks: 37, fetchedAt: new Date() });
      const near = await placeAt(tx, LON, LAT + 10 * NM_LAT);
      const nearer = await placeAt(tx, LON, LAT + 3 * NM_LAT);
      const candidate = await placeAt(tx, LON, LAT + 5 * NM_LAT, { status: "candidate" });
      const ended = await placeAt(tx, LON, LAT + 4 * NM_LAT, { ended: true });
      const far = await placeAt(tx, LON, LAT + 60 * NM_LAT);
      const guide = await source(tx, 0.5);
      const forum = await source(tx, 0.4);
      await mentionOf(tx, poi, guide);
      await mentionOf(tx, poi, guide);
      await mentionOf(tx, poi, forum);
      await mentionOf(tx, poi, await source(tx, 0.9, "rejected"));

      const d = await derived(tx, poi);
      expect(d.quietness).toBeNull();
      const own = new Set([near.publicId, nearer.publicId, candidate.publicId, ended.publicId, far.publicId]);
      const spots = d.importance!.spotCandidates.filter((c) => own.has(c.placeId));
      expect(spots.map((c) => c.placeId)).toEqual([nearer.publicId, near.publicId]);
      expect(spots[0]!.distanceNm).toBeCloseTo(3, 1);
      expect(spots[1]!.distanceNm).toBeCloseTo(10, 1);
      expect(d.importance).toMatchObject({
        sitelinks: 37,
        category: "culture",
        sources: [
          { key: `source:${guide}`, weight: 0.5 },
          { key: `source:${forum}`, weight: 0.4 },
        ].sort((a, b) => (a.key < b.key ? -1 : 1)),
      });
    }));

  it("a poi without a sitelink count has sitelinks null, one without a category no importance", () =>
    withRollback(async (tx) => {
      const poi = await object(tx, "poi", { category: "culture" });
      expect((await derived(tx, poi)).importance).toMatchObject({ sitelinks: null, sources: [] });
      const plain = await object(tx, "poi");
      expect(await derived(tx, plain)).toEqual({ quietness: null, importance: null });
    }));

  it("a place gets its distances from the newest quietness computation and the lane value near a ferry lane", () =>
    withRollback(async (tx) => {
      const { id } = await placeAt(tx, LON, LAT);
      const [c] = await tx
        .insert(computations)
        .values({ geoObjectId: id, kind: "quietness", inputs: {}, inputsHash: newId(), outputs: { settlementDistanceM: 1500, roadDistanceM: 420 }, rulesVersion: "test" })
        .returning({ id: computations.id });
      // a lane 1 km east of the place, inside ferryLaneRadiusM (2 km)
      const east = LON + 1000 / (111_320 * Math.cos((LAT * Math.PI) / 180));
      await tx.insert(restrictedAreas).values({ kind: "ferry_lane", geom: geomFromGeoJson({ type: "LineString", coordinates: [[east, LAT - 0.05], [east, LAT + 0.05]] }) });

      expect(await derived(tx, id)).toEqual({
        quietness: { settlementDistanceM: 1500, roadDistanceM: 420, ferry: cfg.quietness.ferryLaneValue, computationId: c!.id },
        importance: null,
      });
    }));

  it("without a lane the ferry part is the nearest parent's ferry traffic under its rule, without one null (ruling M5-P17)", () =>
    withRollback(async (tx) => {
      // far from the lanes of other tests: 21.4° E
      const area = await object(tx, "area", { lon: 21.4 });
      const island = await object(tx, "island", { lon: 21.4, parentId: area });
      await reviewFact(tx, area, "ferry_traffic", "none");
      await reviewFact(tx, island, "ferry_traffic", "high");
      const { id } = await placeAt(tx, 21.4, LAT, { parentId: island });
      expect((await derived(tx, id)).quietness).toEqual({ settlementDistanceM: null, roadDistanceM: null, ferry: cfg.quietness.ferryTraffic.high, computationId: null });

      // an island without ferry facts passes on to the area
      const bare = await object(tx, "island", { lon: 21.4, parentId: area });
      const other = await placeAt(tx, 21.4, LAT + 0.01, { parentId: bare });
      expect((await derived(tx, other.id)).quietness?.ferry).toBe(cfg.quietness.ferryTraffic.none);

      const orphan = await placeAt(tx, 21.4, LAT + 0.02);
      expect((await derived(tx, orphan.id)).quietness?.ferry).toBeNull();
    }));
});

describe("popularityForArea", () => {
  async function profile(tx: Db, objectId: string, version: number, sourcesCount: number) {
    await tx.insert(profiles).values({
      geoObjectId: objectId,
      version,
      validFrom: "2026-10-19",
      attributes: {},
      provenance: {},
      sourcesCount,
      documentsCount: sourcesCount,
      contentHash: newId(),
      factSchemaVersion: "v2",
      rulesVersion: "v1",
    });
  }

  it("normalizes the newest sources_count of the area's places by the area maximum", () =>
    withRollback(async (tx) => {
      const area = await object(tx, "area", { lon: 22.1 });
      // an own tile of the synthetic grid, labelled with the test area
      await insertTestTile(tx, "q025:808:500", area);
      const a = await placeAt(tx, 22.1, LAT);
      const b = await placeAt(tx, 22.11, LAT);
      const none = await placeAt(tx, 22.12, LAT);
      await profile(tx, a.id, 1, 1);
      await profile(tx, a.id, 2, 15);
      await profile(tx, b.id, 1, 3);
      const rejected = await placeAt(tx, 22.13, LAT, { status: "rejected" });
      await profile(tx, rejected.id, 1, 99);

      const p = await popularityForArea(tx, area);
      expect([...p.keys()].sort()).toEqual([a.id, b.id].sort());
      expect(p.get(a.id)).toBe(1);
      expect(p.get(b.id)).toBeCloseTo(0.5, 3);
      expect(p.has(none.id)).toBe(false);
    }));
});

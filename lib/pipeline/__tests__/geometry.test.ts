import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { computations, facts, places, restrictedAreas, reviewTasks, runs, tiles, type ComputationKind } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { latestComputations } from "@/lib/domain/facts/computations";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { tileBbox } from "@/lib/domain/tiles";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import { createLogger } from "@/lib/logger";
import { computePlaceGeometry, GEOMETRY_STAGE, geometryPlaceIds, storeComputedAnchor } from "@/lib/pipeline/geometry";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { withRollback } from "@/test/db";
import { insertTestRaster } from "@/test/geometry/raster";
import { buildBayScene, insertScenePlace, SCENE_LAND_VERSION } from "@/test/geometry/scene";
import { lonLatOf, rect, SYNTHETIC_SRID, utmOf } from "@/test/geometry/synthetic";

const TODAY = "2026-10-19";
const ALL_KINDS: ComputationKind[] = ["anchor_area", "fetch", "shelter", "depth", "seabed", "restriction", "quietness"];

async function countsOf(tx: Db, geoObjectId: string) {
  const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(computations).where(eq(computations.geoObjectId, geoObjectId));
  const [f] = await tx.select({ n: sql<number>`count(*)::int` }).from(facts).where(eq(facts.geoObjectId, geoObjectId));
  return { computations: c!.n, facts: f!.n };
}

async function placeRow(tx: Db, placeId: string) {
  const { rows } = await tx.execute<{
    status: string;
    status_reason: string | null;
    lon: number | null;
    lat: number | null;
    anchor_confidence: number | null;
    anchor_origin: string | null;
  }>(sql`
    select status, status_reason, ST_X(anchor_position) as lon, ST_Y(anchor_position) as lat, anchor_confidence, anchor_origin
    from places where id = ${placeId}`);
  return rows[0]!;
}

function factValue(stored: Awaited<ReturnType<typeof latestComputations>>, kind: ComputationKind, attribute: string) {
  return stored.get(kind)?.facts.find((f) => f.attribute === attribute);
}

describe("computePlaceGeometry", () => {
  it("writes all seven computations and the 27 M2 facts", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const result = await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      expect([...result.created].sort()).toEqual([...ALL_KINDS].sort());
      expect(result.unchanged).toEqual([]);
      expect(result.gaps).toEqual([]);
      expect(result.excluded).toBe(false);

      const stored = await latestComputations(tx, scene.geoObjectId);
      expect([...stored.keys()].sort()).toEqual([...ALL_KINDS].sort());
      const all = [...stored.values()].flatMap((c) => c.facts);
      expect(all).toHaveLength(27);
      expect(all.every((f) => f.observedAt === TODAY)).toBe(true);

      const rows = await tx
        .select({ computationId: facts.computationId })
        .from(facts)
        .where(eq(facts.geoObjectId, scene.geoObjectId));
      expect(rows).toHaveLength(27);
      expect(rows.every((r) => r.computationId !== null)).toBe(true);

      // Origin = this run's computed anchor, inside the bay (M2-P1).
      const fetch = stored.get("fetch")!;
      expect(fetch.inputs.originSource).toBe("computed_anchor");
      const origin = fetch.inputs.origin as { lon: number; lat: number };
      const { x, y } = await utmOf(tx, origin);
      expect(Math.abs(x)).toBeLessThan(60);
      expect(y).toBeGreaterThan(100);
      expect(y).toBeLessThan(300);
      expect(fetch.inputs.landVersions).toEqual([SCENE_LAND_VERSION]);
      expect(fetch.outputs.rays as number[]).toHaveLength(72);

      const shelterOf = (s: string) => factValue(stored, "shelter", `shelter.${s}`)!.value as number;
      expect(Math.abs(shelterOf("S"))).toBeLessThanOrEqual(0.02);
      expect(shelterOf("N")).toBeGreaterThanOrEqual(0.93);
      for (const s of SECTORS) expect(factValue(stored, "shelter", `shelter.${s}`)!.confidence).toBe(0.6);
      expect(factValue(stored, "shelter", "opening_bearing")!.value).toMatchObject({ bearingDeg: 180 });
      expect(factValue(stored, "shelter", "swell_protection")!.confidence).toBe(0.4);
      expect(factValue(stored, "fetch", "fetch.S")!).toMatchObject({ value: 50000, confidence: 0.7 });

      const approach = factValue(stored, "depth", "depth.approach")!.value as Record<string, number | null>;
      expect(Object.values(approach).some((v) => v !== null)).toBe(true);
      expect(approach).toEqual({ at50m: 8, at100m: 10, at200m: 12 });
      const anchoringMin = factValue(stored, "depth", "depth.anchoring_min")!.value as number;
      const anchoringMax = factValue(stored, "depth", "depth.anchoring_max")!.value as number;
      expect(anchoringMin).toBeGreaterThanOrEqual(3);
      expect(anchoringMax).toBeLessThanOrEqual(12);
      expect((stored.get("depth")!.outputs.samples as unknown[]).length).toBe(3);

      const seabed = factValue(stored, "seabed", "seabed")!;
      expect((seabed.value as Array<{ type: string }>).map((p) => p.type).sort()).toEqual(["mud", "sand"]);
      expect(stored.get("seabed")!.inputs.target).toBe("anchor_area");

      expect(factValue(stored, "anchor_area", "anchor_position")!.confidence).toBe(0.3);
      expect((factValue(stored, "anchor_area", "anchor_area")!.value as { areaM2: number }).areaM2).toBeGreaterThan(100000);
      expect(factValue(stored, "restriction", "prohibitions")!).toMatchObject({ value: [], confidence: 0.9 });

      const quietness = stored.get("quietness")!;
      expect(quietness.facts).toEqual([]);
      expect(quietness.inputs.settlementId).toBe(scene.settlementId);
      expect(Math.abs((quietness.outputs.settlementDistanceM as number) - 1300)).toBeLessThan(150);
      expect(Math.abs((quietness.outputs.roadDistanceM as number) - 2300)).toBeLessThan(150);
    }));

  it("second run creates no computations or facts", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      const before = await countsOf(tx, scene.geoObjectId);
      const second = await computePlaceGeometry(tx, scene.placeId, { today: "2026-10-20" });
      expect(second.created).toEqual([]);
      expect([...second.unchanged].sort()).toEqual([...ALL_KINDS].sort());
      expect(await countsOf(tx, scene.geoObjectId)).toEqual(before);
    }));

  it("computed anchor is written with 0.3, is the origin, and a rerun is unchanged", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      const place = await placeRow(tx, scene.placeId);
      expect(place).toMatchObject({ anchor_confidence: 0.3, anchor_origin: "computed" });

      const stored = await latestComputations(tx, scene.geoObjectId);
      const anchor = factValue(stored, "anchor_area", "anchor_position")!.value as { lon: number; lat: number };
      expect(Number(place.lon)).toBeCloseTo(anchor.lon, 6);
      expect(Number(place.lat)).toBeCloseTo(anchor.lat, 6);
      const origin = stored.get("fetch")!.inputs.origin as { lon: number; lat: number };
      expect(origin.lon).toBeCloseTo(anchor.lon, 6);
      expect(origin.lat).toBeCloseTo(anchor.lat, 6);

      const rerun = await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      expect(rerun.created).toEqual([]);
      expect([...rerun.unchanged].sort()).toEqual([...ALL_KINDS].sort());
    }));

  it("review anchor is the ray origin and is never overwritten", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const review = await lonLatOf(tx, 100, 200);
      await tx
        .update(places)
        .set({
          anchorPosition: sql`${geomFromGeoJson({ type: "Point", coordinates: [review.lon, review.lat] })}`,
          anchorConfidence: 0.9,
          anchorOrigin: "review",
        })
        .where(eq(places.id, scene.placeId));

      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      const stored = await latestComputations(tx, scene.geoObjectId);
      expect(stored.get("fetch")!.inputs.originSource).toBe("review_anchor");
      const origin = stored.get("fetch")!.inputs.origin as { lon: number; lat: number };
      expect(origin.lon).toBeCloseTo(review.lon, 6);
      expect(origin.lat).toBeCloseTo(review.lat, 6);
      expect(stored.get("depth")!.inputs.origin).toEqual(origin);

      const place = await placeRow(tx, scene.placeId);
      expect(place).toMatchObject({ anchor_confidence: 0.9, anchor_origin: "review" });
      expect(Number(place.lon)).toBeCloseTo(review.lon, 9);
      expect(Number(place.lat)).toBeCloseTo(review.lat, 9);
    }));

  it("a new land dataset version recomputes exactly fetch, shelter and anchor_area", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      await tx.execute(sql`
        update land_polygons set dataset_version = 'scene-land-2'
        where dataset_version = ${SCENE_LAND_VERSION} and created_at = now()`);
      const second = await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      expect([...second.created].sort()).toEqual(["anchor_area", "fetch", "shelter"]);
      expect([...second.unchanged].sort()).toEqual(["depth", "quietness", "restriction", "seabed"]);
    }));

  it("place outside the raster gets gaps no_bathymetry and no_anchor_area but 8 shelter facts", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const outside = await insertScenePlace(tx, 5000, -3000);
      if (outside.tileId !== scene.tileId) {
        // The tile needs some bathymetry (else the stage refuses it); this raster lies far from the place.
        await insertTestRaster(tx, { origin: await lonLatOf(tx, 15000, -15000), tileId: outside.tileId });
      }
      const result = await computePlaceGeometry(tx, outside.placeId, { today: TODAY });
      const reasons = new Set(result.gaps.map((g) => g.reason));
      expect(reasons.has("no_bathymetry")).toBe(true);
      expect(reasons.has("no_anchor_area")).toBe(true);
      expect(result.gaps).toContainEqual({ attribute: "anchor_position", reason: "no_anchor_area" });
      expect(result.gaps).toContainEqual({ attribute: "depth.min", reason: "no_bathymetry" });

      const stored = await latestComputations(tx, outside.geoObjectId);
      expect(stored.get("shelter")!.facts.filter((f) => f.attribute.startsWith("shelter."))).toHaveLength(8);
      expect(stored.get("anchor_area")!.facts).toEqual([]);
      expect(stored.get("anchor_area")!.outputs.gaps).toContainEqual({ attribute: "anchor_area", reason: "no_anchor_area" });
      expect(stored.get("depth")!.outputs.gaps).toContainEqual({ attribute: "depth.approach", reason: "no_bathymetry" });
      expect(stored.get("fetch")!.inputs.originSource).toBe("position");
      expect(await placeRow(tx, outside.placeId)).toMatchObject({ lon: null, anchor_origin: null });
    }));

  it("anchor area > 50 % in a military area → no_anchoring, task dismissed", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const [area] = await tx
        .insert(restrictedAreas)
        .values({
          kind: "military",
          sourceRef: `test:scene-${crypto.randomUUID()}`,
          geom: sql`ST_Transform(ST_GeomFromText(${rect(-1000, -1000, 1000, 1000)}, ${SYNTHETIC_SRID}::int), 4326)`,
        })
        .returning({ id: restrictedAreas.id });

      const result = await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      expect(result.excluded).toBe(true);
      expect(await placeRow(tx, scene.placeId)).toMatchObject({
        status: "no_anchoring",
        status_reason: `restricted:military:${area!.id}`,
      });
      const tasks = await tx
        .select({ status: reviewTasks.status })
        .from(reviewTasks)
        .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.subjectId, scene.placeId)));
      expect(tasks).toEqual([{ status: "dismissed" }]);

      const stored = await latestComputations(tx, scene.geoObjectId);
      const prohibitions = factValue(stored, "restriction", "prohibitions")!.value as Array<Record<string, unknown>>;
      expect(prohibitions).toEqual([
        expect.objectContaining({ kind: "military", restrictedAreaId: area!.id, anchoringBan: true, share: 1 }),
      ]);
    }));

  it("missing bathymetry for the tile fails with a clear message", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx, { raster: false });
      await expect(computePlaceGeometry(tx, scene.placeId, { today: TODAY })).rejects.toThrow(
        `bathymetry not imported for tile ${scene.tileId} – run Datensätze laden`,
      );
    }));

  it("missing land polygons fail with a clear message", () =>
    withRollback(async (tx) => {
      // 200 km east of the scene: open sea without synthetic land.
      const place = await insertScenePlace(tx, 200000, 0);
      await insertTestRaster(tx, { origin: await lonLatOf(tx, 200000, 0), tileId: place.tileId });
      await expect(computePlaceGeometry(tx, place.placeId, { today: TODAY })).rejects.toThrow(/land polygons missing/);
    }));
});

describe("stage geometry.place", () => {
  it("runs on queue geometry.compute", () => {
    expect(GEOMETRY_STAGE).toBe("geometry.place");
    expect(STAGES[GEOMETRY_STAGE]?.queue).toBe("geometry.compute");
  });

  it("stage plan skips rejected and merged places", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const confirmed = await insertScenePlace(tx, 50, 100, { status: "confirmed" });
      const noAnchoring = await insertScenePlace(tx, -50, 100, { status: "no_anchoring" });
      const rejected = await insertScenePlace(tx, 0, 150, { status: "rejected" });
      const merged = await insertScenePlace(tx, 0, 50, { mergedIntoId: scene.placeId });
      const ended = await insertScenePlace(tx, 20, 50, { ended: true });

      const expected = [scene, confirmed, noAnchoring].filter((p) => p.tileId === scene.tileId).map((p) => p.placeId).sort();
      const ids = await geometryPlaceIds(tx, { tileIds: [scene.tileId] });
      expect(ids.filter((id) => [scene, confirmed, noAnchoring, rejected, merged, ended].some((p) => p.placeId === id))).toEqual(
        expected,
      );

      const jobs = await STAGES[GEOMETRY_STAGE]!.plan(tx, { id: newId(), params: { tileIds: [scene.tileId] } });
      expect(jobs).toEqual(ids.map((placeId) => ({ key: placeId, placeId })));
      expect(ids).not.toContain(rejected.placeId);
      expect(ids).not.toContain(merged.placeId);
      expect(ids).not.toContain(ended.placeId);
    }));

  it("the handler computes the job's place", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "tile", id: scene.tileId },
        stages: [GEOMETRY_STAGE],
        triggeredBy: "test",
      });
      await HANDLERS["geometry.compute"](
        { key: scene.placeId, placeId: scene.placeId, runId, stage: GEOMETRY_STAGE },
        { db: tx, boss: {} as PgBoss, log: createLogger("test"), jobId: newId(), runId },
      );
      const rows = await tx
        .select({ kind: computations.kind, runId: computations.runId })
        .from(computations)
        .where(and(eq(computations.geoObjectId, scene.geoObjectId), inArray(computations.kind, ALL_KINDS)));
      expect(rows).toHaveLength(7);
      expect(rows.every((r) => r.runId === runId)).toBe(true);
    }));
});

function recordingBoss() {
  const inserted: Array<{ queue: string; data: unknown }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id: string; data: unknown }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id);
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

async function insertTile(tx: Db, tileId: string) {
  const [w, s, e, n] = tileBbox(tileId);
  await tx
    .insert(tiles)
    .values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true })
    .onConflictDoNothing();
}

describe("startGeometryRun", () => {
  it("creates a tile run and enqueues one job per place", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      await insertTile(tx, scene.tileId);
      const { boss, inserted } = recordingBoss();
      const { id } = await startGeometryRun(tx, boss, { tileId: scene.tileId }, "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ scopeType: "tile", scopeId: scene.tileId, stages: [GEOMETRY_STAGE], params: { tileIds: [scene.tileId] } });
      expect(inserted).toContainEqual({
        queue: "geometry.compute",
        data: { key: scene.placeId, placeId: scene.placeId, runId: id, stage: GEOMETRY_STAGE },
      });
    }));

  it("rejects a tile without bathymetry before creating a run", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx, { raster: false });
      await insertTile(tx, scene.tileId);
      const { boss, inserted } = recordingBoss();
      await expect(startGeometryRun(tx, boss, { tileId: scene.tileId }, "test")).rejects.toThrow(
        /bathymetry not imported for tile/,
      );
      expect(await tx.select().from(runs).where(eq(runs.scopeId, scene.tileId))).toEqual([]);
      expect(inserted).toEqual([]);
    }));

  it("rejects an unknown tile and an unknown area before creating a run", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      await expect(startGeometryRun(tx, boss, { tileId: "q025:0:0" }, "test")).rejects.toThrow("Unknown tile q025:0:0");
      await expect(startGeometryRun(tx, boss, { areaKey: "nope" }, "test")).rejects.toThrow("Unknown area nope");
      expect(getConfig().queues["geometry.compute"]).toEqual({
        concurrency: 4,
        retryLimit: 2,
        retryDelaySeconds: 60,
        retryBackoff: true,
      });
    }));
});

describe("storeComputedAnchor", () => {
  it("leaves a review anchor intact when it is written after the stage read the place", () =>
    withRollback(async (tx) => {
      const place = await insertScenePlace(tx, 0, 100, { status: "confirmed" });
      const computed = await lonLatOf(tx, 0, 200);
      const review = await lonLatOf(tx, 100, 300);
      // The stage read the place without an anchor; the review anchor commits before the stage's write.
      await setAnchorPosition(tx, { placeId: place.placeId, position: review, decidedBy: "admin@example.org" });

      await storeComputedAnchor(tx, place.placeId, computed, 0.3);
      await storeComputedAnchor(tx, place.placeId, null, 0.3);

      const row = await placeRow(tx, place.placeId);
      expect(row).toMatchObject({ anchor_confidence: 0.9, anchor_origin: "review" });
      expect(Number(row.lon)).toBeCloseTo(review.lon, 9);
      expect(Number(row.lat)).toBeCloseTo(review.lat, 9);
    }));

  it("writes and clears a computed anchor", () =>
    withRollback(async (tx) => {
      const place = await insertScenePlace(tx, 0, 100, { status: "confirmed" });
      const computed = await lonLatOf(tx, 0, 200);
      await storeComputedAnchor(tx, place.placeId, computed, 0.3);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ anchor_confidence: 0.3, anchor_origin: "computed" });
      await storeComputedAnchor(tx, place.placeId, null, 0.3);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ lon: null, anchor_confidence: null, anchor_origin: null });
    }));
});

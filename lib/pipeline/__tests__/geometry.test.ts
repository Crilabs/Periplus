import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { computations, facts, geoObjects, places, restrictedAreas, reviewTasks, runs, tiles, type ComputationKind } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { latestComputations } from "@/lib/domain/facts/computations";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { createRun } from "@/lib/domain/runs";
import { tileBbox } from "@/lib/domain/tiles";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import { createLogger } from "@/lib/logger";
import { computePlaceGeometry, DETECT_BAYS_STAGE, GEOMETRY_STAGE, geometryPlaceIds, storeComputedAnchor } from "@/lib/pipeline/geometry";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { testDb, withRollback } from "@/test/db";
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
      // In the nearshore band: 30–150 m off the shore of the 500 m bay circle, inside the bay.
      const offShoreM = 500 - Math.hypot(x, y);
      expect(offShoreM).toBeGreaterThanOrEqual(30);
      expect(offShoreM).toBeLessThanOrEqual(150);
      expect(y).toBeGreaterThan(0);
      expect(fetch.inputs.landVersions).toEqual([SCENE_LAND_VERSION]);
      expect(fetch.outputs.rays as number[]).toHaveLength(72);

      const shelterOf = (s: string) => factValue(stored, "shelter", `shelter.${s}`)!.value as number;
      expect(Math.abs(shelterOf("S"))).toBeLessThanOrEqual(0.02);
      expect(shelterOf("N")).toBeGreaterThanOrEqual(0.93);
      for (const s of SECTORS) expect(factValue(stored, "shelter", `shelter.${s}`)!.confidence).toBe(0.6);
      // South out of the bay mouth, seen from the anchor off the bay's centre line.
      const { bearingDeg } = factValue(stored, "shelter", "opening_bearing")!.value as { bearingDeg: number };
      expect(Math.abs(bearingDeg - 180)).toBeLessThanOrEqual(30);
      expect(factValue(stored, "shelter", "swell_protection")!.confidence).toBe(0.4);
      expect(factValue(stored, "fetch", "fetch.S")!).toMatchObject({ value: 50000, confidence: 0.7 });

      const approach = factValue(stored, "depth", "depth.approach")!.value as Record<string, number | null>;
      expect(Object.values(approach).some((v) => v !== null)).toBe(true);
      expect(approach).toEqual({ at50m: 8, at100m: 8, at200m: 10 });
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

  it("place without water gets gaps no_water for shelter, fetch, depth and seabed on the anchor area", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      // 3 km east of the bay, 400 m inland: the 250 m harbour circle lies entirely on land.
      const inland = await insertScenePlace(tx, 3000, 400, { type: "harbour" });
      if (inland.tileId !== scene.tileId) {
        await insertTestRaster(tx, { origin: await lonLatOf(tx, 15000, -15000), tileId: inland.tileId });
      }
      const result = await computePlaceGeometry(tx, inland.placeId, { today: TODAY });
      const noWater = ["shelter.*", "fetch.*", "depth.*", "seabed"].map((attribute) => ({ attribute, reason: "no_water" }));
      expect(result.gaps).toEqual([
        ...noWater,
        { attribute: "anchor_area", reason: "no_anchor_area" },
        { attribute: "anchor_position", reason: "no_anchor_area" },
      ]);

      const stored = await latestComputations(tx, inland.geoObjectId);
      expect([...stored.keys()].sort()).toEqual(["anchor_area", "quietness", "restriction"]);
      expect(stored.get("anchor_area")!.outputs.gaps).toEqual(result.gaps);
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

  it("a confirmed place kept in one ban area is asked again for a second area that sorts after it (GR-5, SAF-5)", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      await tx.update(places).set({ status: "confirmed" }).where(eq(places.id, scene.placeId));
      // the scene's own candidate task is done: the place was confirmed
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.subjectId, scene.placeId));
      const military = async () => {
        const [row] = await tx
          .insert(restrictedAreas)
          .values({
            kind: "military",
            sourceRef: `test:scene-${crypto.randomUUID()}`,
            geom: sql`ST_Transform(ST_GeomFromText(${rect(-1000, -1000, 1000, 1000)}, ${SYNTHETIC_SRID}::int), 4326)`,
          })
          .returning({ id: restrictedAreas.id });
        return row!.id;
      };
      const first = await military();
      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      const openTasks = () =>
        tx
          .select({ id: reviewTasks.id, context: reviewTasks.context })
          .from(reviewTasks)
          .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.subjectId, scene.placeId), eq(reviewTasks.status, "open")));
      const [task] = await openTasks();
      expect(task!.context).toMatchObject({ reason: "restricted", restriction: { id: first } });
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "confirm", kind: "anchorage" }, decidedBy: "test" });

      // the same area again: the decision holds
      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      expect(await openTasks()).toEqual([]);
      // a second area (a newer id, so it sorts after the decided one) asks again
      const second = await military();
      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      const [again] = await openTasks();
      expect(again!.context).toMatchObject({ reason: "restricted", restriction: { id: second }, restrictions: [{ id: second }] });
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
  it("creates a tile run that first detects unnamed bays on the tile (ruling M7-P13)", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      await insertTile(tx, scene.tileId);
      const { boss, inserted } = recordingBoss();
      const { id } = await startGeometryRun(tx, boss, { tileId: scene.tileId }, "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      // geometry, then done: no consolidation stages, no rules version (N6)
      expect(run).toMatchObject({ scopeType: "tile", scopeId: scene.tileId, stages: [DETECT_BAYS_STAGE, GEOMETRY_STAGE], params: { tileIds: [scene.tileId] } });
      expect(run!.params).not.toHaveProperty("rulesVersion");
      expect(inserted).toEqual([
        { queue: "geometry.detect_bays", data: { key: scene.tileId, tileId: scene.tileId, runId: id, stage: DETECT_BAYS_STAGE } },
      ]);
      // the place stage plans the tile's places (here the scene's seeded place; that a bay detected by the first stage
      // is planned too is tested in lib/domain/geometry/__tests__/bays.test.ts)
      expect(await STAGES[GEOMETRY_STAGE]!.plan(tx, { id, params: run!.params as Record<string, unknown> })).toEqual([
        { key: scene.placeId, placeId: scene.placeId },
      ]);
    }));

  it("with skipBayDetection a tile run only computes the places (rerun after a rule change)", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      await insertTile(tx, scene.tileId);
      const { boss, inserted } = recordingBoss();
      const { id } = await startGeometryRun(tx, boss, { tileId: scene.tileId }, "test", { skipBayDetection: true });
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ scopeType: "tile", stages: [GEOMETRY_STAGE], params: { tileIds: [scene.tileId] } });
      expect(inserted).toEqual([
        { queue: "geometry.compute", data: { key: scene.placeId, placeId: scene.placeId, runId: id, stage: GEOMETRY_STAGE } },
      ]);
    }));

  it("creates a place run that enqueues only that place", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const other = await insertScenePlace(tx, 200, 100);
      const { boss, inserted } = recordingBoss();
      const { id } = await startGeometryRun(tx, boss, { placeId: scene.placeId }, "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ scopeType: "place", scopeId: scene.placeId, stages: [GEOMETRY_STAGE], params: { placeIds: [scene.placeId] } });
      expect(inserted).toEqual([
        { queue: "geometry.compute", data: { key: scene.placeId, placeId: scene.placeId, runId: id, stage: GEOMETRY_STAGE } },
      ]);
      expect(await geometryPlaceIds(tx, { placeIds: [scene.placeId, other.placeId] })).toEqual(
        [scene.placeId, other.placeId].sort(),
      );
    }));

  it("rejects a place the stage does not compute before creating a run", () =>
    withRollback(async (tx) => {
      await buildBayScene(tx);
      const ended = await insertScenePlace(tx, 200, 100, { ended: true });
      const { boss, inserted } = recordingBoss();
      const error = await startGeometryRun(tx, boss, { placeId: ended.placeId }, "test").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RunScopeNotReady);
      expect((error as RunScopeNotReady).reason).toBe("place_not_computable");
      expect(await tx.select().from(runs).where(eq(runs.scopeId, ended.placeId))).toEqual([]);
      expect(inserted).toEqual([]);
    }));

  it("rejects a tile without bathymetry before creating a run", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx, { raster: false });
      await insertTile(tx, scene.tileId);
      const { boss, inserted } = recordingBoss();
      await expect(startGeometryRun(tx, boss, { tileId: scene.tileId }, "test")).rejects.toThrow(
        /bathymetry not imported for tile/,
      );
      await expect(startGeometryRun(tx, boss, { placeId: scene.placeId }, "test")).rejects.toMatchObject({
        reason: "bathymetry_missing",
      });
      expect(await tx.select().from(runs).where(eq(runs.scopeId, scene.tileId))).toEqual([]);
      expect(inserted).toEqual([]);
    }));

  it("rejects an unknown tile, an unknown subdivision and an area key before creating a run", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      await expect(startGeometryRun(tx, boss, { tileId: "q025:0:0" }, "test")).rejects.toThrow("Unknown tile q025:0:0");
      await expect(startGeometryRun(tx, boss, { subdivisionKey: "XG-NOPE" }, "test")).rejects.toThrow("Unbekannter Landesteil XG-NOPE");
      const areaKey = Object.keys(getConfig().subdivisions.retiredAreaKeys)[0]!;
      await expect(startGeometryRun(tx, boss, { subdivisionKey: areaKey }, "test")).rejects.toThrow(`Revier-Schlüssel ${areaKey} ist kein Laufumfang mehr`);
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

describe("lock order", () => {
  // Needs two committing connections, so it cannot run in withRollback: the synthetic place stays in the test
  // database, in open sea outside the pilot box and away from the bay scene (≈ 28.3 E / 35.2 N).
  it("the stage locks the open review task before the place, like decideReviewTask", async () => {
    const db = testDb();
    const position: GeoJSON.Point = { type: "Point", coordinates: [28.3, 35.2] };
    const { placeId, taskId } = await db.transaction(async (tx) => {
      const [object] = await tx
        .insert(geoObjects)
        .values({ type: "bay", origin: "geonames", geom: sql`${geomFromGeoJson(position)}` })
        .returning({ id: geoObjects.id });
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: object!.id, kind: "anchorage", status: "candidate", position: sql`${geomFromGeoJson(position)}` })
        .returning({ id: places.id });
      const task = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: place!.id, context: {} });
      return { placeId: place!.id, taskId: task.id };
    });

    // The decision holds the task lock (its first step) and pauses before locking the place.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let decisionPid!: number;
    let taskLocked!: () => void;
    const locked = new Promise<void>((resolve) => (taskLocked = resolve));
    const decision = db.transaction(async (b) => {
      await b.execute(sql`select id from review_tasks where id = ${taskId} for update`);
      const { rows } = await b.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      decisionPid = rows[0]!.pid;
      taskLocked();
      await gate;
      await decideReviewTask(b, { taskId, decision: { action: "reject" }, decidedBy: "admin@example.org" });
    });
    await locked;

    const stage = computePlaceGeometry(db, placeId, { today: TODAY }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      // The stage blocks on the task lock held by the decision …
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where ${decisionPid}::int = any(pg_blocking_pids(pid))`,
        );
        blocked = rows[0]!.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      // … and holds no lock on the place, so the decision can take it next.
      const placeFree = await db
        .transaction(async (c) => {
          await c.execute(sql`select id from places where id = ${placeId} for update nowait`);
          return true;
        })
        .catch(() => false);
      expect(placeFree).toBe(true);
    } finally {
      release();
    }

    await decision;
    // The stage then sees the rejected place and skips it.
    expect(await stage).toEqual({ result: { created: [], unchanged: [], gaps: [], excluded: false } });
    expect((await placeRow(db, placeId)).status).toBe("rejected");
  });
});

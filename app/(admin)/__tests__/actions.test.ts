import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { comparisonSet, geoObjects, places, reviewDecisions, reviewTasks, tiles } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { GEOMETRY_CONSOLIDATION_STAGES } from "@/lib/pipeline/consolidation/stages";
import { testDb, withRollback } from "@/test/db";
import { buildBayScene } from "@/test/geometry/scene";

const db = testDb();
/** What getDb() returns; a test may point it at a rollback transaction. */
let currentDb: Db = db;
const requireAdmin = vi.fn();
const startRun = vi.fn();
const redirect = vi.fn();
const pauseQueue = vi.fn();
const resumeQueue = vi.fn();
const retryFailedJob = vi.fn();
const endRunByAdmin = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({}) }));
vi.mock("@/lib/pipeline/runs", () => ({
  startRun: (...args: unknown[]) => startRun(...args),
  endRunByAdmin: (...args: unknown[]) => endRunByAdmin(...args),
}));
vi.mock("@/lib/jobs/controls", () => ({
  pauseQueue: (...args: unknown[]) => pauseQueue(...args),
  resumeQueue: (...args: unknown[]) => resumeQueue(...args),
}));
vi.mock("@/lib/domain/jobs-view", () => ({ retryFailedJob: (...args: unknown[]) => retryFailedJob(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import {
  startDatasetImportAction,
  startGazetteerAction,
  startGeometryAction,
  startPingRun,
  startSeedAction,
} from "../runs/actions";
import { consolidateTileAction, geometryTileAction, seedTileAction } from "../tiles/[id]/actions";
import { pauseQueueAction, resumeQueueAction } from "../jobs/actions";
import { endRunAction, retryJobAction } from "../runs/[id]/actions";
import { toggleComparisonAction } from "../quality/actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
  currentDb = db;
  requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
  startRun.mockResolvedValue({ id: "run-1" });
});

describe("admin server actions", () => {
  it("startPingRun rejects count 0 and 51 without creating a run", async () => {
    await expect(startPingRun(form({ count: "0" }))).rejects.toThrow();
    await expect(startPingRun(form({ count: "51" }))).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("startPingRun starts a ping run triggered by the admin email", async () => {
    await startPingRun(form({ count: "7" }));
    expect(startRun).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ kind: "system", stages: ["ping"], params: { count: 7 }, triggeredBy: "admin@example.invalid" }),
    );
    expect(redirect).toHaveBeenCalledWith("/runs");
  });

  it("pause and resume toggle the queue", async () => {
    await pauseQueueAction(form({ queue: "system.ping" }));
    expect(pauseQueue).toHaveBeenCalledWith(db, "system.ping", null, "manual", "admin@example.invalid");
    await resumeQueueAction({ queue: "system.ping" });
    expect(resumeQueue).toHaveBeenCalledWith(db, "system.ping", "admin@example.invalid");
    await expect(pauseQueueAction(form({ queue: "nope" }))).rejects.toThrow();
    expect(pauseQueue).toHaveBeenCalledTimes(1);
  });

  it("server actions redirect without a session", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startPingRun(form({ count: "3" }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(pauseQueueAction(form({ queue: "system.ping" }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(resumeQueueAction(form({ queue: "system.ping" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(startRun).not.toHaveBeenCalled();
    expect(pauseQueue).not.toHaveBeenCalled();
    expect(resumeQueue).not.toHaveBeenCalled();
  });

  it("retryJobAction rejects an unknown queue", async () => {
    const jobId = "0190a6c2-7a1b-7c3d-8e4f-0123456789ab";
    await expect(retryJobAction(form({ queue: "nope", jobId }))).rejects.toThrow();
    await expect(retryJobAction(form({ queue: "system.dead", jobId }))).rejects.toThrow();
    await expect(retryJobAction({ queue: "system.ping", jobId: "not-a-uuid" })).rejects.toThrow();
    expect(retryFailedJob).not.toHaveBeenCalled();

    await retryJobAction(form({ queue: "system.ping", jobId }));
    expect(retryFailedJob).toHaveBeenCalledWith(db, expect.anything(), "system.ping", jobId);

    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(retryJobAction({ queue: "system.ping", jobId })).rejects.toThrow("NEXT_REDIRECT");
    expect(retryFailedJob).toHaveBeenCalledTimes(1);
  });

  it("endRunAction ends the run as the admin; a malformed id or no session ends nothing", async () => {
    const runId = newId();
    await expect(endRunAction(form({ runId: "not-a-uuid" }))).rejects.toThrow();
    await expect(endRunAction({ runId: "" })).rejects.toThrow();
    expect(endRunByAdmin).not.toHaveBeenCalled();

    await endRunAction(form({ runId }));
    expect(endRunByAdmin).toHaveBeenCalledWith(db, expect.anything(), runId, "admin@example.invalid");

    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(endRunAction(form({ runId }))).rejects.toThrow("NEXT_REDIRECT");
    expect(endRunByAdmin).toHaveBeenCalledTimes(1);
  });

  it("retryJobAction decides an open failed_job task of the job with retry", async () => {
    const jobId = newId();
    const { id: taskId } = await createReviewTask(db, {
      kind: "failed_job",
      subjectType: "job",
      subjectId: jobId,
      context: { queue: "seed.tile" },
    });
    await retryJobAction({ queue: "seed.tile", jobId });
    expect(retryFailedJob).toHaveBeenCalledTimes(1);
    expect(retryFailedJob).toHaveBeenCalledWith(db, expect.anything(), "seed.tile", jobId);
    const [task] = await db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId));
    expect(task!.status).toBe("decided");
    const decisions = await db.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: { action: "retry" }, decidedBy: "admin@example.invalid" });
  });

  it("startGazetteerAction: unknown areaKey rejected, a configured area starts a gazetteer run", async () => {
    await expect(startGazetteerAction(form({ areaKey: "atlantis" }))).rejects.toThrow();
    await expect(startGazetteerAction({ areaKey: "" })).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();

    await startGazetteerAction(form({ areaKey: "saronic" }));
    expect(startRun).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        kind: "stage",
        scope: { type: "area", id: "saronic" },
        stages: ["tiles.ensure", "gazetteer.osm", "gazetteer.wikidata", "gazetteer.geonames", "gazetteer.hierarchy"],
        params: { areaKey: "saronic" },
        triggeredBy: "admin@example.invalid",
      }),
    );
    expect(redirect).toHaveBeenCalledWith("/runs/run-1");
  });

  it("startSeedAction: unknown areaKey, malformed or unknown tileId rejected without a run", async () => {
    await expect(startSeedAction(form({ areaKey: "atlantis" }))).rejects.toThrow();
    await expect(startSeedAction({ tileId: "q025:813" })).rejects.toThrow();
    await expect(startSeedAction({ tileId: "q025:813:510; drop" })).rejects.toThrow();
    // Well-formed but no such tile (north pole row, never created).
    await expect(startSeedAction({ tileId: "q025:0:719" })).rejects.toThrow();
    await expect(seedTileAction(form({ tileId: "q025:0:719" }))).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("startSeedAction for an area starts an area-scoped seed run", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      // The area needs its geo object (normally written by tiles.ensure) before a seed run may start.
      const [area] = await tx
        .select({ id: geoObjects.id })
        .from(geoObjects)
        .where(sql`${geoObjects.type} = 'area' and ${geoObjects.configKey} = 'saronic' and ${geoObjects.validTo} is null`);
      if (!area) {
        const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [24.61, 32.83] })}`;
        await tx.insert(geoObjects).values({ type: "area", origin: "manual", configKey: "saronic", geom });
      }
      await startSeedAction(form({ areaKey: "saronic" }));
      expect(startRun).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          kind: "stage",
          scope: { type: "area", id: "saronic" },
          stages: ["seed.tile"],
          params: { areaKey: "saronic" },
          triggeredBy: "admin@example.invalid",
        }),
      );
    }));

  it("seed for a tile starts a tile-scoped run", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      // Open sea outside the pilot box, at a spot no other test uses.
      const tileId = tileIdFor(24.61, 32.83);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(24.5, 32.75, 24.75, 33.0, 4326)` });
      const expected = expect.objectContaining({
        kind: "stage",
        scope: { type: "tile", id: tileId },
        stages: ["seed.tile"],
        params: { tileIds: [tileId] },
        triggeredBy: "admin@example.invalid",
      });

      await startSeedAction(form({ tileId }));
      expect(startRun).toHaveBeenLastCalledWith(tx, expect.anything(), expected);
      await seedTileAction(form({ tileId }));
      expect(startRun).toHaveBeenLastCalledWith(tx, expect.anything(), expected);
      expect(startRun).toHaveBeenCalledTimes(2);
      expect(redirect).toHaveBeenLastCalledWith("/runs/run-1");

      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(startSeedAction({ tileId })).rejects.toThrow("NEXT_REDIRECT");
      await expect(seedTileAction({ tileId })).rejects.toThrow("NEXT_REDIRECT");
      await expect(startGazetteerAction({ areaKey: "saronic" })).rejects.toThrow("NEXT_REDIRECT");
      expect(startRun).toHaveBeenCalledTimes(2);
    }));
  it("„Konsolidieren“ on the tile page starts a tile-scoped consolidation run; an unknown tile is refused", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      // Open sea outside the pilot box, at a spot no other test uses.
      const tileId = tileIdFor(24.61, 32.83);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(24.5, 32.75, 24.75, 33.0, 4326)` });
      await consolidateTileAction(form({ tileId }));
      expect(startRun).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          kind: "stage",
          scope: { type: "tile", id: tileId },
          stages: ["consolidation.geo", "consolidation.summary", "consolidation.followup"],
          params: { tileId, rulesVersion: "v1" },
          triggeredBy: "admin@example.invalid",
        }),
      );
      expect(redirect).toHaveBeenLastCalledWith("/runs/run-1");
      await expect(consolidateTileAction({ tileId: "q025:0:719" })).rejects.toThrow();
      await expect(consolidateTileAction({ tileId: "q025:813" })).rejects.toThrow();
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(consolidateTileAction({ tileId })).rejects.toThrow("NEXT_REDIRECT");
      expect(startRun).toHaveBeenCalledTimes(1);
    }));

  it("startSeedAction rejects a payload with both fields or an unknown tile next to a valid area", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      // Open sea outside the pilot box, at a spot no other test uses.
      const tileId = tileIdFor(24.61, 32.83);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(24.5, 32.75, 24.75, 33.0, 4326)` });
      await expect(startSeedAction(form({ tileId, areaKey: "saronic" }))).rejects.toThrow();
      await expect(startSeedAction({ tileId: "q025:0:719", areaKey: "saronic" })).rejects.toThrow();
      await expect(startSeedAction(form({ tileId: "q025:813", areaKey: "saronic" }))).rejects.toThrow();
      expect(startRun).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    }));

  it("toggleComparisonAction: validates input, adds and removes a confirmed place", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      // Open sea outside the pilot box, at a spot no other test uses.
      const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [24.61, 32.83] })}`;
      let [area] = await tx
        .select({ id: geoObjects.id })
        .from(geoObjects)
        .where(sql`${geoObjects.type} = 'area' and ${geoObjects.configKey} = 'saronic' and ${geoObjects.validTo} is null`);
      area ??= (
        await tx.insert(geoObjects).values({ type: "area", origin: "manual", configKey: "saronic", geom }).returning({ id: geoObjects.id })
      )[0]!;
      const tileId = tileIdFor(24.61, 32.83);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(24.5, 32.75, 24.75, 33.0, 4326)`, areaId: area.id });
      const [obj] = await tx.insert(geoObjects).values({ type: "bay", origin: "osm", geom }).returning({ id: geoObjects.id });
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: obj!.id, kind: "anchorage", status: "confirmed", position: geom })
        .returning({ id: places.id });
      const placeId = place!.id;
      const rows = () => tx.select().from(comparisonSet).where(sql`${comparisonSet.placeId} = ${placeId}`);

      await expect(toggleComparisonAction({ placeId, areaKey: "atlantis", include: true })).rejects.toThrow();
      await expect(toggleComparisonAction({ placeId: "nope", areaKey: "saronic", include: true })).rejects.toThrow();
      expect(await rows()).toHaveLength(0);

      await toggleComparisonAction(form({ placeId, areaKey: "saronic", include: "true" }));
      await toggleComparisonAction({ placeId, areaKey: "saronic", include: true });
      expect(await rows()).toMatchObject([{ placeId, areaId: area.id, addedBy: "admin@example.invalid" }]);

      // An unticked checkbox sends no `include` field.
      await toggleComparisonAction(form({ placeId, areaKey: "saronic" }));
      expect(await rows()).toHaveLength(0);

      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(toggleComparisonAction({ placeId, areaKey: "saronic", include: true })).rejects.toThrow("NEXT_REDIRECT");
      expect(await rows()).toHaveLength(0);
    }));

  it("startGeometryAction for a tile starts a tile-scoped run with stage geometry.place", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      const [w, s, e, n] = tileBbox(scene.tileId);
      await tx.insert(tiles).values({ id: scene.tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true });
      const expected = expect.objectContaining({
        kind: "stage",
        scope: { type: "tile", id: scene.tileId },
        stages: ["geometry.place", ...GEOMETRY_CONSOLIDATION_STAGES],
        params: { tileIds: [scene.tileId] },
        triggeredBy: "admin@example.invalid",
      });

      await startGeometryAction(form({ tileId: scene.tileId }));
      expect(startRun).toHaveBeenLastCalledWith(tx, expect.anything(), expected);
      await geometryTileAction(form({ tileId: scene.tileId }));
      expect(startRun).toHaveBeenLastCalledWith(tx, expect.anything(), expected);
      expect(redirect).toHaveBeenLastCalledWith("/runs/run-1");

      await expect(startGeometryAction({ tileId: "q025:0:719" })).rejects.toThrow();
      await expect(startGeometryAction(form({ tileId: scene.tileId, areaKey: "saronic" }))).rejects.toThrow();
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(geometryTileAction({ tileId: scene.tileId })).rejects.toThrow("NEXT_REDIRECT");
      expect(startRun).toHaveBeenCalledTimes(2);
    }));

  it("startGeometryAction returns to the tile page when the tile lacks bathymetry", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx, { raster: false });
      const [w, s, e, n] = tileBbox(scene.tileId);
      await tx.insert(tiles).values({ id: scene.tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true });
      await geometryTileAction(form({ tileId: scene.tileId }));
      expect(startRun).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`/tiles/${encodeURIComponent(scene.tileId)}?error=bathymetry_missing`);
    }));

  it("startDatasetImportAction rejects an unknown area", async () => {
    await expect(startDatasetImportAction(form({ areaKey: "atlantis" }))).rejects.toThrow();
    await expect(startDatasetImportAction({ areaKey: "" })).rejects.toThrow();
    await expect(startGeometryAction(form({ areaKey: "atlantis" }))).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startDatasetImportAction({ areaKey: "saronic" })).rejects.toThrow("NEXT_REDIRECT");
    expect(startRun).not.toHaveBeenCalled();
  });

  it("startDatasetImportAction starts an area run once the area has coast tiles", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      let [area] = await tx
        .select({ id: geoObjects.id })
        .from(geoObjects)
        .where(sql`${geoObjects.type} = 'area' and ${geoObjects.configKey} = 'saronic' and ${geoObjects.validTo} is null`);
      area ??= (
        await tx
          .insert(geoObjects)
          .values({ type: "area", origin: "manual", configKey: "saronic", geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [24.61, 32.83] })}` })
          .returning({ id: geoObjects.id })
      )[0]!;
      // Open sea outside the pilot box, at a spot no other test uses.
      const tileId = tileIdFor(24.61, 32.83);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(24.5, 32.75, 24.75, 33.0, 4326)`, areaId: area.id, hasCoast: true });

      await startDatasetImportAction(form({ areaKey: "saronic" }));
      expect(startRun).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          kind: "stage",
          scope: { type: "area", id: "saronic" },
          stages: ["datasets.import"],
          params: { areaKey: "saronic" },
          triggeredBy: "admin@example.invalid",
        }),
      );
      expect(redirect).toHaveBeenCalledWith("/runs/run-1");
    }));
});

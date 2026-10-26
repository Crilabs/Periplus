import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { comparisonSet, geoObjects, places, reviewDecisions, reviewTasks, tiles } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { testDb, withRollback } from "@/test/db";
import { AEGINA_WEST_KEY, insertAeginaWest } from "@/test/fixtures/subdivisions/aegina-west";
import { buildBayScene } from "@/test/geometry/scene";
import { insertPlace } from "@/test/consolidation";
import { insertTestSubdivision } from "@/test/text";

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
// the research test subdivision is the gate subdivision: research elsewhere waits for the released gate (N3)
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  let cached: ReturnType<typeof actual.getConfig> | undefined;
  return {
    ...actual,
    getConfig: () => {
      const c = actual.getConfig();
      cached ??= { ...c, research: { ...c.research, gate: { ...c.research.gate, subdivision: "XQ-RES" } } };
      return cached;
    },
  };
});
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
import { geometryTileAction, seedTileAction } from "../tiles/[id]/actions";
import { pauseQueueAction, resumeQueueAction } from "../jobs/actions";
import { endRunAction, retryJobAction } from "../runs/[id]/actions";
import { saveComparisonSelectionAction } from "../quality/actions";
import { buildSubdivisionAction, queueCountryAction, startSubdivisionLandAction, startSubdivisionResearchAction } from "../subdivisions/actions";

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

    // a run that is no subdivision build: its end starts nothing (`afterBuildRunEnded` finds no build)
    endRunByAdmin.mockResolvedValue({ ended: true, cleanedUp: true, cancelledJobs: 0 });
    await endRunAction(form({ runId }));
    expect(endRunByAdmin).toHaveBeenCalledWith(db, expect.anything(), runId, "admin@example.invalid");
    expect(startRun).not.toHaveBeenCalled();

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

  it("startGazetteerAction: unknown subdivisionKey rejected, a subdivision starts a gazetteer run", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      await expect(startGazetteerAction(form({ subdivisionKey: "XX-ATLANTIS" }))).rejects.toThrow("Unbekannter Landesteil XX-ATLANTIS");
      await expect(startGazetteerAction({ subdivisionKey: "" })).rejects.toThrow();
      expect(startRun).not.toHaveBeenCalled();

      await insertAeginaWest(tx);
      await startGazetteerAction(form({ subdivisionKey: AEGINA_WEST_KEY }));
      expect(startRun).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          kind: "stage",
          scope: { type: "subdivision", id: AEGINA_WEST_KEY },
          stages: ["tiles.ensure", "gazetteer.osm", "gazetteer.wikidata", "gazetteer.geonames", "gazetteer.hierarchy"],
          params: { subdivisionKey: AEGINA_WEST_KEY },
          triggeredBy: "admin@example.invalid",
        }),
      );
      expect(redirect).toHaveBeenCalledWith("/runs/run-1");
    }));

  it("startSeedAction: malformed or unknown tileId rejected without a run", async () => {
    await expect(startSeedAction({ tileId: "q025:813" })).rejects.toThrow();
    await expect(startSeedAction({ tileId: "q025:813:510; drop" })).rejects.toThrow();
    // Well-formed but no such tile (north pole row, never created).
    await expect(startSeedAction({ tileId: "q025:0:719" })).rejects.toThrow();
    await expect(seedTileAction(form({ tileId: "q025:0:719" }))).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("runs action rejects an unknown subdivision and names the subdivision for an area key", async () => {
    await expect(startSeedAction(form({ subdivisionKey: "XX-ATLANTIS" }))).rejects.toThrow("Unbekannter Landesteil XX-ATLANTIS");
    await expect(startDatasetImportAction(form({ subdivisionKey: "XX-ATLANTIS" }))).rejects.toThrow("Unbekannter Landesteil XX-ATLANTIS");
    await expect(startGeometryAction(form({ subdivisionKey: "XX-ATLANTIS" }))).rejects.toThrow("Unbekannter Landesteil XX-ATLANTIS");
    await expect(startSeedAction(form({ subdivisionKey: "saronic" }))).rejects.toThrow("Revier-Schlüssel saronic ist kein Laufumfang mehr");
    await expect(startSeedAction(form({ areaKey: "saronic" }))).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("startSeedAction for a subdivision starts a subdivision-scoped seed run", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      await insertAeginaWest(tx);
      const tileId = "q025:813:510";
      const [w, s, e, n] = tileBbox(tileId);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true });
      await startSeedAction(form({ subdivisionKey: AEGINA_WEST_KEY }));
      expect(startRun).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          kind: "stage",
          scope: { type: "subdivision", id: AEGINA_WEST_KEY },
          stages: ["seed.tile"],
          params: { subdivisionKey: AEGINA_WEST_KEY },
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
      await expect(startGazetteerAction({ subdivisionKey: "GR-I" })).rejects.toThrow("NEXT_REDIRECT");
      expect(startRun).toHaveBeenCalledTimes(2);
    }));

  it("startSeedAction rejects a payload with both fields or an unknown tile next to a subdivision", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      // Open sea outside the pilot box, at a spot no other test uses.
      const tileId = tileIdFor(24.61, 32.83);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(24.5, 32.75, 24.75, 33.0, 4326)` });
      await expect(startSeedAction(form({ tileId, subdivisionKey: AEGINA_WEST_KEY }))).rejects.toThrow();
      await expect(startSeedAction({ tileId: "q025:0:719", subdivisionKey: AEGINA_WEST_KEY })).rejects.toThrow();
      await expect(startSeedAction(form({ tileId: "q025:813", subdivisionKey: AEGINA_WEST_KEY }))).rejects.toThrow();
      expect(startRun).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    }));

  it("saveComparisonSelectionAction: validates input, saves every shown place's box at once", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      // Open sea outside the pilot box, at a spot no other test uses; the places belong to the test subdivision.
      const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [24.61, 32.83] })}`;
      const { subdivisionId } = await insertAeginaWest(tx);
      const confirmed = async () => {
        const [obj] = await tx.insert(geoObjects).values({ type: "bay", origin: "osm", geom, subdivisionId }).returning({ id: geoObjects.id });
        const [place] = await tx
          .insert(places)
          .values({ geoObjectId: obj!.id, kind: "anchorage", status: "confirmed", position: geom })
          .returning({ id: places.id });
        return place!.id;
      };
      const a = await confirmed();
      const b = await confirmed();
      const rows = () => tx.select().from(comparisonSet).where(sql`${comparisonSet.placeId} in (${a}, ${b})`);
      const selection = (subdivisionKey: string, shown: string[], included: string[]) => {
        const f = form({ subdivisionKey });
        for (const id of shown) f.append("shown", id);
        for (const id of included) f.append("include", id);
        return f;
      };

      await saveComparisonSelectionAction(selection("atlantis", [a], [a]));
      expect(redirect).toHaveBeenLastCalledWith("/quality?error=invalid_input");
      await saveComparisonSelectionAction(selection("saronic", [a], [a]));
      expect(redirect).toHaveBeenLastCalledWith("/quality?error=invalid_input");
      await saveComparisonSelectionAction(selection(AEGINA_WEST_KEY, ["nope"], []));
      expect(redirect).toHaveBeenLastCalledWith(`/quality?subdivision=${AEGINA_WEST_KEY}&error=invalid_input`);
      expect(await rows()).toHaveLength(0);

      // every ticked box of the list is saved at once (UI-11), not only one row
      await saveComparisonSelectionAction(selection(AEGINA_WEST_KEY, [a, b], [a, b]));
      expect((await rows()).map((r) => r.placeId).sort()).toEqual([a, b].sort());
      expect(await rows()).toMatchObject([{ subdivisionId, addedBy: "admin@example.invalid" }, { subdivisionId }]);

      // an unticked box sends no `include`: that place leaves the set, the other stays
      await saveComparisonSelectionAction(selection(AEGINA_WEST_KEY, [a, b], [b]));
      expect((await rows()).map((r) => r.placeId)).toEqual([b]);

      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(saveComparisonSelectionAction(selection(AEGINA_WEST_KEY, [a, b], []))).rejects.toThrow("NEXT_REDIRECT");
      expect(await rows()).toHaveLength(1);
    }));

  it("startGeometryAction for a tile starts a tile-scoped run with stages geometry.detect_bays and geometry.place", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      const [w, s, e, n] = tileBbox(scene.tileId);
      await tx.insert(tiles).values({ id: scene.tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true });
      const expected = expect.objectContaining({
        kind: "stage",
        scope: { type: "tile", id: scene.tileId },
        stages: ["geometry.detect_bays", "geometry.place"],
        params: { tileIds: [scene.tileId] },
        triggeredBy: "admin@example.invalid",
      });

      await startGeometryAction(form({ tileId: scene.tileId }));
      expect(startRun).toHaveBeenLastCalledWith(tx, expect.anything(), expected);
      await geometryTileAction(form({ tileId: scene.tileId }));
      expect(startRun).toHaveBeenLastCalledWith(tx, expect.anything(), expected);
      expect(redirect).toHaveBeenLastCalledWith("/runs/run-1");

      await expect(startGeometryAction({ tileId: "q025:0:719" })).rejects.toThrow();
      await expect(startGeometryAction(form({ tileId: scene.tileId, subdivisionKey: AEGINA_WEST_KEY }))).rejects.toThrow();
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

  it("startDatasetImportAction rejects an unknown subdivision", async () => {
    await expect(startDatasetImportAction(form({ subdivisionKey: "XX-ATLANTIS" }))).rejects.toThrow();
    await expect(startDatasetImportAction({ subdivisionKey: "" })).rejects.toThrow();
    await expect(startGeometryAction(form({ subdivisionKey: "XX-ATLANTIS" }))).rejects.toThrow();
    expect(startRun).not.toHaveBeenCalled();
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startDatasetImportAction({ subdivisionKey: AEGINA_WEST_KEY })).rejects.toThrow("NEXT_REDIRECT");
    expect(startRun).not.toHaveBeenCalled();
  });

  it("startDatasetImportAction starts a subdivision run once the subdivision has coast tiles", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      await insertAeginaWest(tx);
      const tileId = "q025:813:510";
      const [w, s, e, n] = tileBbox(tileId);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true });

      await startDatasetImportAction(form({ subdivisionKey: AEGINA_WEST_KEY }));
      expect(startRun).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          kind: "stage",
          scope: { type: "subdivision", id: AEGINA_WEST_KEY },
          stages: ["datasets.import"],
          params: { subdivisionKey: AEGINA_WEST_KEY },
          triggeredBy: "admin@example.invalid",
        }),
      );
      expect(redirect).toHaveBeenCalledWith("/runs/run-1");
    }));

  it("buildSubdivisionAction starts the build and opens its run; an excluded subdivision starts nothing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
      startRun.mockResolvedValue({ id: "run-1" });
      await insertTestSubdivision(tx, "XQ-ACT", [40.0, 30.0, 40.5, 30.25], { country: "XQ" });
      await insertTestSubdivision(tx, "XQ-EXC", [40.5, 30.0, 41.0, 30.25], { country: "XQ", status: "excluded" });
      await buildSubdivisionAction(form({ subdivisionKey: "XQ-ACT" }));
      expect(startRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ kind: "full", scope: { type: "subdivision", id: "XQ-ACT" } }));
      expect(redirect).toHaveBeenLastCalledWith("/runs/run-1");
      await expect(buildSubdivisionAction({ subdivisionKey: "XQ-EXC" })).rejects.toThrow("Landesteil XQ-EXC ist ausgeschlossen");
      expect(startRun).toHaveBeenCalledTimes(1);
      currentDb = db;
    }));

  it("startSubdivisionResearchAction starts a research run; a subdivision without candidates comes back with a reason", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
      startRun.mockResolvedValue({ id: "run-1" });
      const sub = await insertTestSubdivision(tx, "XQ-RES", [40.0, 30.0, 40.5, 30.25], { country: "XQ" });
      await startSubdivisionResearchAction(form({ subdivisionKey: "XQ-RES" }));
      expect(startRun).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenLastCalledWith("/subdivisions/XQ-RES?error=no_research_candidates");
      const { objectId } = await insertPlace(tx, { status: "candidate" });
      await tx.update(geoObjects).set({ subdivisionId: sub.id }).where(eq(geoObjects.id, objectId));
      await startSubdivisionResearchAction(form({ subdivisionKey: "XQ-RES" }));
      expect(startRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ scope: { type: "subdivision", id: "XQ-RES" }, params: { subdivisionKey: "XQ-RES", rulesVersion: expect.any(String) }, triggeredBy: "admin@example.invalid" }),
      );
      expect(redirect).toHaveBeenLastCalledWith("/runs/run-1");
      currentDb = db;
    }));

  it("startSubdivisionLandAction starts a gazetteer.land run; a subdivision without candidates comes back with a reason", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
      startRun.mockResolvedValue({ id: "run-1" });
      const sub = await insertTestSubdivision(tx, "XQ-LAND", [40.0, 30.0, 40.5, 30.25], { country: "XQ" });
      await startSubdivisionLandAction(form({ subdivisionKey: "XQ-LAND" }));
      expect(startRun).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenLastCalledWith("/subdivisions/XQ-LAND?error=subdivision_without_candidates");
      const { objectId } = await insertPlace(tx, { status: "candidate" });
      await tx.update(geoObjects).set({ subdivisionId: sub.id }).where(eq(geoObjects.id, objectId));
      await startSubdivisionLandAction(form({ subdivisionKey: "XQ-LAND" }));
      expect(startRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ kind: "stage", scope: { type: "subdivision", id: "XQ-LAND" }, stages: ["gazetteer.land"], params: { subdivisionKey: "XQ-LAND" }, triggeredBy: "admin@example.invalid" }),
      );
      expect(redirect).toHaveBeenLastCalledWith("/runs/run-1");
      currentDb = db;
    }));

  it("queueCountryAction queues the open subdivisions of a country and reports how many", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
      startRun.mockResolvedValue({ id: "run-2" });
      await insertTestSubdivision(tx, "XQ-Q1", [40.0, 30.0, 40.5, 30.25], { country: "XQ" });
      await insertTestSubdivision(tx, "XQ-Q2", [40.5, 30.0, 41.0, 30.25], { country: "XQ" });
      await queueCountryAction(form({ country: "XQ" }));
      expect(redirect).toHaveBeenLastCalledWith("/subdivisions?queued=2&country=XQ");
      await expect(queueCountryAction({ country: "greece" })).rejects.toThrow();
      currentDb = db;
    }));
});

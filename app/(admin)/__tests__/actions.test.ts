import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { reviewDecisions, reviewTasks, tiles } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { tileIdFor } from "@/lib/domain/tiles";
import { testDb, withRollback } from "@/test/db";

const db = testDb();
/** What getDb() returns; a test may point it at a rollback transaction. */
let currentDb: Db = db;
const requireAdmin = vi.fn();
const startRun = vi.fn();
const redirect = vi.fn();
const pauseQueue = vi.fn();
const resumeQueue = vi.fn();
const retryFailedJob = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({}) }));
vi.mock("@/lib/pipeline/runs", () => ({ startRun: (...args: unknown[]) => startRun(...args) }));
vi.mock("@/lib/jobs/controls", () => ({
  pauseQueue: (...args: unknown[]) => pauseQueue(...args),
  resumeQueue: (...args: unknown[]) => resumeQueue(...args),
}));
vi.mock("@/lib/domain/jobs-view", () => ({ retryFailedJob: (...args: unknown[]) => retryFailedJob(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { startGazetteerAction, startPingRun, startSeedAction } from "../runs/actions";
import { seedTileAction } from "../tiles/[id]/actions";
import { pauseQueueAction, resumeQueueAction } from "../jobs/actions";
import { retryJobAction } from "../runs/[id]/actions";

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

  it("startSeedAction for an area starts an area-scoped seed run", async () => {
    await startSeedAction(form({ areaKey: "saronic" }));
    expect(startRun).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        kind: "stage",
        scope: { type: "area", id: "saronic" },
        stages: ["seed.tile"],
        params: { areaKey: "saronic" },
        triggeredBy: "admin@example.invalid",
      }),
    );
  });

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
});

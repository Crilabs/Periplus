import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { testDb } from "@/test/db";

const db = testDb();
const requireAdmin = vi.fn();
const redirect = vi.fn();
const retryFailedJob = vi.fn();
const startConsolidationRun = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({
  requireAdmin: () => requireAdmin(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({}) }));
vi.mock("@/lib/domain/jobs-view", () => ({
  retryFailedJob: (...args: unknown[]) => retryFailedJob(...args),
}));
vi.mock("@/lib/pipeline/consolidation/run", () => ({
  startConsolidationRun: (...args: unknown[]) => startConsolidationRun(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

import { decideAction } from "../review/[id]/actions";

const ADMIN = "admin@example.invalid";
// These rows are committed (the action uses its own transactions): open sea outside the pilot box
// 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses. Each run adds new rows.
const LON = 27.61;
const LAT = 34.61;
// Above anything the pipeline creates, so "the next candidate" is the one this test made.
const PRIORITY = 1_500_000_000;

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

async function candidateTask(): Promise<{ taskId: string; placeId: string; geoObjectId: string }> {
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] })}`;
  const [object] = await db
    .insert(geoObjects)
    .values({ type: "bay", origin: "geonames", geom })
    .returning({ id: geoObjects.id });
  const [place] = await db
    .insert(places)
    .values({ geoObjectId: object!.id, kind: "anchorage", position: geom })
    .returning({ id: places.id });
  const { id } = await createReviewTask(db, {
    kind: "place_candidate",
    subjectType: "place",
    subjectId: place!.id,
    context: {},
    priority: PRIORITY,
  });
  return { taskId: id, placeId: place!.id, geoObjectId: object!.id };
}

const decisionsOf = (taskId: string) => db.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId));
const statusOf = async (taskId: string) =>
  (await db.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, taskId)))[0]!.status;

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: ADMIN });
  startConsolidationRun.mockResolvedValue({ id: newId() });
});

describe("review server actions", () => {
  it("decideAction confirms and redirects to the next candidate", async () => {
    const a = await candidateTask();
    const b = await candidateTask();
    const openedAt = new Date(Date.now() - 5000).toISOString();
    await decideAction(
      form({
        taskId: a.taskId,
        openedAt,
        decision: JSON.stringify({
          action: "confirm",
          kind: "marina",
          position: { lon: LON + 0.001, lat: LAT },
        }),
      }),
    );
    expect(redirect).toHaveBeenCalledWith(`/review/${b.taskId}`);
    const [place] = await db
      .select({
        status: places.status,
        kind: places.kind,
        publicId: places.publicId,
      })
      .from(places)
      .where(eq(places.id, a.placeId));
    expect(place).toMatchObject({ status: "confirmed", kind: "marina" });
    expect(place!.publicId).toMatch(/^sp_/);
    const decisions = await decisionsOf(a.taskId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decidedBy: ADMIN,
      decision: { action: "confirm", kind: "marina" },
    });
    expect(decisions[0]!.durationMs).toBeGreaterThanOrEqual(5000);
    // the place's object is consolidated after the decision committed (final review I-2)
    expect(startConsolidationRun).toHaveBeenCalledTimes(1);
    expect(startConsolidationRun.mock.calls[0]![2]).toEqual({ scope: { geoObjectIds: [a.geoObjectId] }, triggeredBy: ADMIN });

    // Leave no open task behind; then the queue of this kind continues below this test's priority.
    await decideAction(
      form({
        taskId: b.taskId,
        decision: JSON.stringify({ action: "reject" }),
      }),
    );
    expect(redirect).toHaveBeenLastCalledWith(expect.not.stringContaining(b.taskId));
    expect(await statusOf(b.taskId)).toBe("decided");
    expect(startConsolidationRun.mock.calls[1]![2]).toEqual({ scope: { geoObjectIds: [b.geoObjectId] }, triggeredBy: ADMIN });
  });

  it("invalid decision JSON is rejected without a decision row", async () => {
    const { taskId } = await candidateTask();
    for (const decision of ["{not json", JSON.stringify({ action: "bogus" }), JSON.stringify({ action: "confirm" })]) {
      await expect(decideAction(form({ taskId, decision }))).rejects.toThrow();
    }
    // An action that does not fit the task kind is not decided either.
    await decideAction(form({ taskId, decision: JSON.stringify({ action: "same" }) }));
    expect(redirect).toHaveBeenCalledWith(`/review/${taskId}?error=1`);
    expect(await decisionsOf(taskId)).toHaveLength(0);
    expect(await statusOf(taskId)).toBe("open");
    await decideReviewTask(db, {
      taskId,
      decision: { action: "reject" },
      decidedBy: ADMIN,
    });
  });

  it("a stale task redirects with stale=1", async () => {
    const { taskId } = await candidateTask();
    await decideReviewTask(db, {
      taskId,
      decision: { action: "reject" },
      decidedBy: ADMIN,
    });
    await decideAction(form({ taskId, decision: JSON.stringify({ action: "no_anchoring" }) }));
    expect(redirect).toHaveBeenCalledWith(`/review/${taskId}?stale=1`);
    expect(await decisionsOf(taskId)).toHaveLength(1);
  });

  it("retry of a failed job retries it through retryFailedJob", async () => {
    const jobId = newId();
    const { id: taskId } = await createReviewTask(db, {
      kind: "failed_job",
      subjectType: "job",
      subjectId: jobId,
      context: { queue: "seed.tile" },
    });
    await decideAction(form({ taskId, decision: JSON.stringify({ action: "retry" }) }));
    expect(retryFailedJob).toHaveBeenCalledWith(db, expect.anything(), "seed.tile", jobId);
    expect(await statusOf(taskId)).toBe("decided");
  });

  it("retry of a failed job with a manipulated queue redirects with error=1", async () => {
    for (const queue of ["nope", "system.dead"]) {
      const { id: taskId } = await createReviewTask(db, {
        kind: "failed_job",
        subjectType: "job",
        subjectId: newId(),
        context: { queue },
      });
      await decideAction(form({ taskId, decision: JSON.stringify({ action: "retry" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/review/${taskId}?error=1`);
      expect(await statusOf(taskId)).toBe("open");
      expect(await decisionsOf(taskId)).toHaveLength(0);
      await decideReviewTask(db, { taskId, decision: { action: "ignore" }, decidedBy: ADMIN });
    }
    expect(retryFailedJob).not.toHaveBeenCalled();
  });

  it("requires an admin session", async () => {
    const { taskId } = await candidateTask();
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(decideAction(form({ taskId, decision: JSON.stringify({ action: "reject" }) }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(await decisionsOf(taskId)).toHaveLength(0);
    expect(redirect).not.toHaveBeenCalled();
    await decideReviewTask(db, {
      taskId,
      decision: { action: "reject" },
      decidedBy: ADMIN,
    });
  });
});

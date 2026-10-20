import { and, eq, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { placeImages, reviewTasks, runs } from "@/lib/db/schema";
import { reviewTaskDetail } from "@/lib/domain/review-view";
import { createRun } from "@/lib/domain/runs";
import { generatePlaceImage, type PlaceImageTaskContext } from "@/lib/pipeline/images/generate";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { testDb, withRollback } from "@/test/db";
import { checker, GOOD, imageModel, imageTasksOf, insertImageSubdivision, insertSpot, stubRender, syntheticImageryTransport } from "@/test/images";
import { memoryArchive } from "@/test/s3";

/*
 * The review of a place image: the page data (`reviewTaskDetail`), the decision through the server action with its
 * follow-up image run, and the admin route that serves the render, mask and candidate from the archive. The action's
 * `getDb()` is the test's transaction, its `getArchive()` an in-memory archive.
 */

let current: Db | undefined;
let archive = memoryArchive();
const requireAdmin = vi.fn();
const adminSession = vi.fn();
const redirect = vi.fn();
vi.mock("@/lib/security/require-admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/require-admin")>()),
  requireAdmin: () => requireAdmin(),
  adminSession: () => adminSession(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => current ?? testDb(),
}));
vi.mock("@/lib/adapters/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/s3")>()),
  getArchive: () => archive,
}));
const bossInsert = vi.fn();
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ insert: (...args: unknown[]) => bossInsert(...args) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

const { decideAction } = await import("../review/[id]/actions");
const { GET } = await import("../images/file/route");

const ADMIN = "admin@example.invalid";

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: ADMIN });
  adminSession.mockResolvedValue({ email: ADMIN });
  bossInsert.mockResolvedValue([]);
  current = undefined;
  archive = memoryArchive();
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

/** A spot named „Bildbucht“ with an open title image task (candidate in the archive). */
async function imageTask(tx: Db): Promise<{ objectId: string; placeId: string; task: { id: string; context: PlaceImageTaskContext } }> {
  const sd = await insertImageSubdivision(tx);
  const spot = await insertSpot(tx, sd.id, { name: "Bildbucht" });
  const run = await createRun(tx, { kind: "stage", scope: { type: "system", id: "test" }, stages: [IMAGES_STAGE], triggeredBy: "test" });
  await generatePlaceImage(
    tx,
    { geoObjectId: spot.objectId, view: { slot: "title", zoom: "z1" }, runId: run.id },
    { archive, transport: await syntheticImageryTransport(), imageModel: await imageModel(GOOD), model: checker(false), render: stubRender },
  );
  const [task] = await imageTasksOf(tx, `${spot.objectId}:title`);
  return { ...spot, task: task! };
}

const get = (key: string) => GET(new NextRequest(`http://localhost/images/file?key=${encodeURIComponent(key)}`));

describe("review of a place image", () => {
  it("shows the place, the slot, the camera, the checks and the render's keys", () =>
    withRollback(async (tx) => {
      const t = await imageTask(tx);
      const detail = await reviewTaskDetail(tx, t.task.id);
      const s = detail!.subject;
      if (s.type !== "place_image") throw new Error(`subject ${s.type}`);
      expect(s).toMatchObject({
        geoObjectId: t.objectId,
        placeId: t.placeId,
        name: "Bildbucht",
        slot: "title",
        key: t.task.context.key,
        candidateKey: t.task.context.candidateKey,
        threshold: 0.8,
        sources: ["ktimatologio", "sentinel2", "copernicus_dem"],
      });
      expect(s.photoKey).toMatch(/^imagery\/renders\/.+\/photo\.png$/);
      expect(s.maskKey).toMatch(/^imagery\/renders\/.+\/mask\.png$/);
      expect(s.context.camera).toEqual(t.task.context.camera);
    }));

  it("„Freigeben“ approves with the shown key and redirects onwards", () =>
    withRollback(async (tx) => {
      current = tx;
      const t = await imageTask(tx);
      await decideAction(form({ taskId: t.task.id, taskKey: t.task.context.key, decision: JSON.stringify({ action: "approve_image" }) }));
      expect(redirect.mock.lastCall![0]).not.toContain(t.task.id);
      const images = await tx.select().from(placeImages).where(and(eq(placeImages.geoObjectId, t.objectId), isNull(placeImages.validTo)));
      expect(images.map((i) => [i.slot, i.generationKey])).toEqual([["title", t.task.context.key]]);
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, ADMIN))).toEqual([]);
    }));

  it("a stale form redirects back with ?changed=1; approving a task without candidate with ?error=1", () =>
    withRollback(async (tx) => {
      current = tx;
      const t = await imageTask(tx);
      await decideAction(form({ taskId: t.task.id, taskKey: "0000000000000000", decision: JSON.stringify({ action: "approve_image" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/review/${t.task.id}?changed=1`);
      await tx
        .update(reviewTasks)
        .set({ context: { ...t.task.context, candidateKey: null, reason: "no_valid_output" } })
        .where(eq(reviewTasks.id, t.task.id));
      await decideAction(form({ taskId: t.task.id, taskKey: t.task.context.key, decision: JSON.stringify({ action: "approve_image" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/review/${t.task.id}?error=1`);
      const [task] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, t.task.id));
      expect(task!.status).toBe("open");
    }));

  it("„Neu erzeugen“ decides the task and starts an image run for the slot with the chosen zoom", () =>
    withRollback(async (tx) => {
      current = tx;
      const t = await imageTask(tx);
      await decideAction(form({ taskId: t.task.id, taskKey: t.task.context.key, decision: JSON.stringify({ action: "regenerate_image", zoom: "z2" }) }));
      const started = await tx.select().from(runs).where(eq(runs.triggeredBy, ADMIN));
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        scopeType: "place",
        scopeId: t.placeId,
        stages: [IMAGES_STAGE],
        params: { images: { geoObjectId: t.objectId, view: { slot: "title", zoom: "z2" }, force: true } },
      });
      const [task] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, t.task.id));
      expect(task!.status).toBe("decided");
    }));
});

describe("GET /images/file", () => {
  it("file route rejects keys outside the allowed prefixes", async () => {
    const id = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    await archive.put(`imagery/renders/${id}/photo.png`, new Uint8Array([1, 2, 3]), "image/png");
    await archive.put(`imagery/ktimatologio/x.jpg`, new Uint8Array([4]), "image/jpeg");
    await archive.put(`documents/${id}/raw.html`, new Uint8Array([5]), "text/html");

    const ok = await get(`imagery/renders/${id}/photo.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    for (const key of [
      "imagery/ktimatologio/x.jpg",
      `documents/${id}/raw.html`,
      `imagery/renders/${id}/../../../documents/${id}/raw.html`,
      `imagery/renders/not-a-uuid/photo.png`,
      `images/places/${id}/sub/x.jpg`,
      "",
    ]) {
      expect((await get(key)).status, key).toBe(404);
    }
    // an allowed key whose object is missing
    expect((await get(`images/places/${id}/missing.jpg`)).status).toBe(404);
    // without a session
    adminSession.mockResolvedValue(null);
    expect((await get(`imagery/renders/${id}/photo.png`)).status).toBe(401);
  });
});

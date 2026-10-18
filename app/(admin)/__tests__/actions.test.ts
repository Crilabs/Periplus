import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/db";

const db = testDb();
const requireAdmin = vi.fn();
const startRun = vi.fn();
const redirect = vi.fn();
const pauseQueue = vi.fn();
const resumeQueue = vi.fn();
const retryFailedJob = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => db,
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

import { startPingRun } from "../runs/actions";
import { pauseQueueAction, resumeQueueAction } from "../jobs/actions";
import { retryJobAction } from "../runs/[id]/actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
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
});

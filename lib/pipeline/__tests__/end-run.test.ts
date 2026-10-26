import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { aiBatches, runs } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, getRun } from "@/lib/domain/runs";
import { endRunByAdmin } from "@/lib/pipeline/runs";

/*
 * „Lauf beenden“ is repeatable until its cleanup completed, and a stage planned after (or racing) the end plans
 * nothing (rulings GR-8, CON-1/CON-2). In withRollback.
 */

const ADMIN = "admin@example.invalid";
const STAGE = "research.fetch";

const stubBoss = () =>
  ({
    findJobs: async () => [],
    cancel: async () => undefined,
    insert: async (_q: string, jobs: Array<{ id?: string }>) => jobs.map((j) => j.id ?? newId()),
  }) as unknown as PgBoss;

describe("Lauf beenden", () => {
  it("a cleanup that failed after the end committed is repeated by the next call, and then recorded", () =>
    withRollback(async (tx) => {
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `end-${newId()}` }, stages: [STAGE], params: {}, triggeredBy: "test" });
      await beginStage(tx, runId, STAGE, 1);
      const [batch] = await tx
        .insert(aiBatches)
        .values({ runId, stage: STAGE, task: "assess-page", model: "mock", promptVersion: 1, status: "submitting",
          outcomeKey: `end-${newId()}`, requestCount: 1, estimatedCostEur: "1.0" })
        .returning({ id: aiBatches.id });

      const flaky = { findJobs: async () => { throw new Error("connection terminated"); }, cancel: async () => undefined } as unknown as PgBoss;
      await expect(endRunByAdmin(tx, flaky, runId, ADMIN)).rejects.toThrow("connection terminated");
      const pending = (await getRun(tx, runId))!;

      const second = await endRunByAdmin(tx, stubBoss(), runId, ADMIN);
      const [b] = await tx.select().from(aiBatches).where(eq(aiBatches.id, batch!.id));
      expect(b!.status).toBe("failed");
      expect(pending).toMatchObject({ status: "failed", endedBy: ADMIN, endCleanupPending: true });
      expect(second).toEqual({ ended: false, cleanedUp: true, cancelledJobs: 0 });
      expect((await getRun(tx, runId))!.endCleanupPending).toBe(false);

      // Once cleaned up, another click changes nothing.
      expect(await endRunByAdmin(tx, flaky, runId, ADMIN)).toEqual({ ended: false, cleanedUp: false, cancelledJobs: 0 });
    }));

  it("a run that ended by itself is never cleaned up as an admin end", () =>
    withRollback(async (tx) => {
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `end-${newId()}` }, stages: [STAGE], params: {}, triggeredBy: "test" });
      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, runId));
      expect(await endRunByAdmin(tx, stubBoss(), runId, ADMIN)).toEqual({ ended: false, cleanedUp: false, cancelledJobs: 0 });
      expect((await getRun(tx, runId))!).toMatchObject({ status: "finished", endedBy: null, endCleanupPending: false });
    }));
});

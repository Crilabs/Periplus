import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { newId } from "@/lib/domain/ids";
import { failedJobsOfRun, type FailedJob } from "@/lib/domain/jobs-view";
import { getConfig } from "@/lib/config";
import { createBoss } from "@/lib/jobs/boss";
import { DEAD_LETTER_QUEUE, ensureQueues } from "@/lib/jobs/queues";

const db = testDb();
const boss = createBoss(process.env.TEST_DATABASE_URL!, { supervise: false, schedule: false });

beforeAll(async () => {
  await boss.start();
  // Never reconfigure an existing queue: other test files share this database.
  if (!(await boss.getQueue("system.ping"))) await ensureQueues(boss, getConfig().queues);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
});

/** Inserts a finished job row directly; inside the test's transaction no other test file can see or delete it. */
async function insertJob(
  tx: Db,
  name: string,
  state: "failed" | "completed",
  data: Record<string, unknown>,
  message: string,
  at: Date,
): Promise<string> {
  const id = newId();
  await tx.execute(sql`
    insert into pgboss.job (id, name, data, state, output, completed_on)
    values (${id}::uuid, ${name}, ${JSON.stringify(data)}::jsonb, ${state}::pgboss.job_state,
            ${JSON.stringify({ name: "Error", message })}::jsonb, ${at.toISOString()}::timestamptz)`);
  return id;
}

describe("jobs view", () => {
  it("failedJobsOfRun lists only failed jobs of that run", async () => {
    const runId = newId();
    const t1 = new Date("2030-01-01T10:00:00Z");
    const t2 = new Date("2030-01-01T11:00:00Z");
    const rollback = new Error("rollback");
    let ids: { ping: string; advance: string } | undefined;
    let listed: FailedJob[] = [];
    let unknownRun: FailedJob[] = [];
    await expect(
      db.transaction(async (tx) => {
        ids = {
          ping: await insertJob(tx, "system.ping", "failed", { runId, stage: "ping", key: "1" }, "ping failed for key 1", t1),
          advance: await insertJob(tx, "run.advance", "failed", { runId, nextStage: "b", key: `${runId}:b` }, "plan failed", t2),
        };
        await insertJob(tx, "system.ping", "completed", { runId, stage: "ping", key: "0" }, "", t1);
        await insertJob(tx, "system.ping", "failed", { runId: newId(), stage: "ping", key: "1" }, "other run", t1);
        await insertJob(tx, DEAD_LETTER_QUEUE, "failed", { runId, stage: "ping", key: "1" }, "dead letter", t1);
        listed = await failedJobsOfRun(tx, runId);
        unknownRun = await failedJobsOfRun(tx, newId());
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(listed).toEqual([
      { id: ids!.advance, queue: "run.advance", key: `${runId}:b`, stage: null, error: "plan failed", failedAt: t2 },
      { id: ids!.ping, queue: "system.ping", key: "1", stage: "ping", error: "ping failed for key 1", failedAt: t1 },
    ]);
    expect(unknownRun).toEqual([]);
  });
});

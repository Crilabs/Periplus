import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, externalCalls, jobOutcomes, runStages } from "@/lib/db/schema";
import { BudgetExceeded, recordExternalCall } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, endRun, recordJobOutcome } from "@/lib/domain/runs";
import { MockBatchError, MockModel } from "@/lib/ai/mock";
import { echoTask } from "@/lib/ai/tasks/system-echo";
import { estimateBatchCostEur } from "@/lib/ai/cost";
import type { ModelTask } from "@/lib/ai/types";
import {
  failBatchUnit,
  pollBatch,
  submitStageBatch,
  type BatchHandlerEntry,
  type BatchHandlerItem,
  type BatchItemInput,
} from "@/lib/pipeline/batches";

const STAGE = "test.batch";
const NEXT = "test.next";

const base = loadConfig("config");
const config: AppConfig = {
  ...base,
  budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } },
  models: {
    ...base.models,
    tasks: { "system.echo": { model: "claude-haiku-5-5", promptVersion: 1, effort: "low", maxTokens: 1024, cacheSystem: false } },
  },
};

const task = echoTask as ModelTask<unknown, unknown>;

/** Records every pg-boss insert instead of queueing it. */
function recordingBoss() {
  const inserted: Array<{ queue: string; id?: string; data: Record<string, unknown>; startAfter?: unknown }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown>; startAfter?: unknown }>) => {
      for (const job of jobs) inserted.push({ queue, ...job });
      return jobs.map((j) => j.id ?? newId());
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

/** A handler table whose `system.echo` handler records each item it gets. */
function countingHandlers() {
  const seen: BatchHandlerItem[] = [];
  const handlers: Record<string, BatchHandlerEntry> = {
    "system.echo": {
      task,
      handle: async (_db, item) => {
        seen.push(item);
      },
    },
  };
  return { handlers, seen };
}

const echoBack = (input: unknown) => ({ echo: (input as { text: string }).text, language: "en" });

function items(...texts: string[]): BatchItemInput[] {
  return texts.map((text, i) => ({ subjectType: "test", subjectId: `s${i}`, input: { text } }));
}

/** A run with the batch stage begun with `jobs` submit jobs. */
async function stageRun(tx: Db, jobs = 1): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: `batch-test-${newId()}` },
    stages: [STAGE, NEXT],
    triggeredBy: "test",
  });
  await beginStage(tx, id, STAGE, jobs);
  return id;
}

async function stageRow(tx: Db, runId: string) {
  const [row] = await tx.select().from(runStages).where(and(eq(runStages.runId, runId), eq(runStages.stage, STAGE)));
  return row!;
}

async function batchesOf(tx: Db, runId: string) {
  return tx.select().from(aiBatches).where(eq(aiBatches.runId, runId)).orderBy(aiBatches.id);
}

async function itemsOf(tx: Db, batchId: string) {
  return tx.select().from(aiBatchItems).where(eq(aiBatchItems.batchId, batchId)).orderBy(aiBatchItems.id);
}

describe("stage batches", () => {
  it("a stage with 1 submit job finishes only after its batch is distributed", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const { boss, inserted } = recordingBoss();
      const { handlers, seen } = countingHandlers();

      const submitted = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "b") });
      expect(submitted).toMatchObject({ items: 2, reused: false });
      expect(await stageRow(tx, runId)).toMatchObject({ total: 2, status: "running" });
      const [batch] = await batchesOf(tx, runId);
      expect(batch).toMatchObject({ status: "submitted", outcomeKey: "batch:k", providerBatchId: "mock-batch-1", requestCount: 2 });
      expect(Number(batch!.estimatedCostEur)).toBeGreaterThan(0);
      const poll = inserted.find((j) => j.queue === "ai.batch.poll");
      expect(poll?.data).toEqual({ key: `poll:${batch!.id}:0`, batchId: batch!.id });
      expect(poll?.startAfter).toBe(`${config.models.batch.pollSeconds} seconds`);
      // The poll job never names the run or stage, so the worker records no outcome for it.
      expect(poll?.data).not.toHaveProperty("runId");

      // The worker records the submit job itself; the stage still waits for the batch.
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      expect(await stageRow(tx, runId)).toMatchObject({ done: 1, status: "running" });

      expect(await pollBatch(tx, { model, boss, config, handlers }, batch!.id)).toBe("distributed");
      expect(seen.map((s) => s.output)).toEqual([
        { echo: "a", language: "en" },
        { echo: "b", language: "en" },
      ]);
      expect(seen[0]).toMatchObject({
        subjectType: "test",
        subjectId: "s0",
        input: { text: "a" },
        usage: { inputTokens: 0, outputTokens: 0 },
        costEur: 0,
        batch: { id: batch!.id, model: "claude-haiku-5-5", promptVersion: 1, runId, stage: STAGE },
      });
      expect(await stageRow(tx, runId)).toMatchObject({ total: 2, done: 2, status: "finished" });
      expect(inserted.some((j) => j.queue === "run.advance" && j.data.nextStage === NEXT)).toBe(true);
      expect((await batchesOf(tx, runId))[0]!.status).toBe("distributed");
    }));

  it("distributing twice calls each handler once and records the outcome once", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const { boss } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "b", "c") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");

      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect(seen).toHaveLength(3);
      expect(await stageRow(tx, runId)).toMatchObject({ total: 2, done: 2, failed: 0 });
      const outcomes = await tx.select().from(jobOutcomes).where(eq(jobOutcomes.runId, runId));
      expect(outcomes.map((o) => o.key).sort()).toEqual(["batch:k", "k"]);
      // One booking per collected batch, in the transaction that ended it.
      const booked = await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(booked).toHaveLength(1);
      expect(booked[0]).toMatchObject({ service: "anthropic", operation: "system.echo.batch", stage: STAGE, unit: "tokens" });
      expect(booked[0]!.meta).toMatchObject({ batchId, model: "claude-haiku-5-5", items: 3, cacheRead: 0, cacheWrite: 0 });
      for (const item of await itemsOf(tx, batchId!)) expect(item.distributedAt).not.toBeNull();
    }));

  it("an item whose handler failed is distributed by the next poll, the others are not repeated", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const { boss } = recordingBoss();
      const calls: string[] = [];
      let failOnce = true;
      const handlers: Record<string, BatchHandlerEntry> = {
        "system.echo": {
          task,
          handle: async (_db, item) => {
            calls.push(item.subjectId);
            if (item.subjectId === "s1" && failOnce) {
              failOnce = false;
              throw new Error("store failed");
            }
          },
        },
      };
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "b") });
      await expect(tx.transaction(() => pollBatch(tx, { model, boss, config, handlers }, batchId!))).rejects.toThrow("store failed");
      expect((await batchesOf(tx, runId))[0]!.status).toBe("ended");
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect(calls).toEqual(["s0", "s1", "s1"]);
      expect(await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId))).toHaveLength(1);
    }));

  it("a retried submit job reuses its batch", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const submit = vi.spyOn(model, "submitBatch");
      const { boss } = recordingBoss();
      const req = { task, runId, stage: STAGE, key: "k", items: items("a", "b") };
      const first = await submitStageBatch(tx, { model, boss, config }, req);
      const second = await submitStageBatch(tx, { model, boss, config }, req);
      expect(second).toEqual({ batchId: first.batchId, items: 2, reused: true });
      expect(await batchesOf(tx, runId)).toHaveLength(1);
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await stageRow(tx, runId)).total).toBe(2);
    }));

  it("a batch left in submitting by a failed provider call is sent by the retried job", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      vi.spyOn(model, "submitBatch").mockRejectedValueOnce(new Error("connection reset"));
      const { boss } = recordingBoss();
      const req = { task, runId, stage: STAGE, key: "k", items: items("a") };
      await expect(submitStageBatch(tx, { model, boss, config }, req)).rejects.toThrow("connection reset");
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "submitting", providerBatchId: null });
      expect((await stageRow(tx, runId)).total).toBe(2);

      const retried = await submitStageBatch(tx, { model, boss, config }, req);
      expect(retried.reused).toBe(true);
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "submitted", providerBatchId: "mock-batch-1" });
      expect((await stageRow(tx, runId)).total).toBe(2);
    }));

  it("retryable failures are resubmitted once, then fail", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({
        "system.echo": (input) => {
          if ((input as { text: string }).text === "busy") throw new MockBatchError("overloaded", true);
          if ((input as { text: string }).text === "bad") throw new MockBatchError("invalid", false);
          return echoBack(input);
        },
      });
      const { boss, inserted } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "busy", "bad") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");

      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("resubmitted");
      expect(seen.map((s) => s.subjectId)).toEqual(["s0"]);
      const [first, followUp] = await batchesOf(tx, runId);
      expect(first).toMatchObject({ status: "distributed" });
      expect(followUp).toMatchObject({ status: "submitted", outcomeKey: "batch:k", requestCount: 1, providerBatchId: "mock-batch-2" });
      expect(Number(followUp!.estimatedCostEur)).toBeCloseTo(Number(first!.estimatedCostEur) / 3, 5);
      expect((await itemsOf(tx, first!.id)).map((i) => i.status)).toEqual(["succeeded", "retried", "failed"]);
      const [again] = await itemsOf(tx, followUp!.id);
      expect(again).toMatchObject({ subjectId: "s1", attempt: 2, status: "pending" });
      expect(inserted.some((j) => j.queue === "ai.batch.poll" && j.data.batchId === followUp!.id)).toBe(true);
      // The unit is still open while its follow-up runs.
      expect(await stageRow(tx, runId)).toMatchObject({ done: 1, status: "running" });
      // A repeated poll of the first batch neither distributes nor resubmits again.
      expect(await pollBatch(tx, { model, boss, config, handlers }, first!.id)).toBe("resubmitted");
      expect(await batchesOf(tx, runId)).toHaveLength(2);

      expect(await pollBatch(tx, { model, boss, config, handlers }, followUp!.id)).toBe("distributed");
      expect((await itemsOf(tx, followUp!.id))[0]).toMatchObject({ status: "failed", error: "overloaded" });
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, failed: 0, status: "finished" });
      expect(await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId))).toHaveLength(2);
    }));

  it("a batch older than maxHours fails its unit", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack }, { batchRounds: 100 });
      const { boss, inserted } = recordingBoss();
      const { handlers } = countingHandlers();
      const submittedAt = new Date();
      const { batchId } = await submitStageBatch(tx, { model, boss, config, now: () => submittedAt }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");

      expect(await pollBatch(tx, { model, boss, config, handlers, now: () => new Date(submittedAt.getTime() + 3_600_000) }, batchId!)).toBe("waiting");
      expect((await batchesOf(tx, runId))[0]!.pollCount).toBe(1);
      expect(inserted.filter((j) => j.queue === "ai.batch.poll").map((j) => j.data.key)).toEqual([`poll:${batchId}:0`, `poll:${batchId}:1`]);

      const late = new Date(submittedAt.getTime() + (config.models.batch.maxHours + 1) * 3_600_000);
      expect(await pollBatch(tx, { model, boss, config, handlers, now: () => late }, batchId!)).toBe("failed");
      expect((await batchesOf(tx, runId))[0]!.status).toBe("failed");
      expect((await itemsOf(tx, batchId!))[0]).toMatchObject({ status: "failed", error: "batch exceeded maxHours" });
      expect(await stageRow(tx, runId)).toMatchObject({ done: 1, failed: 1, status: "finished" });
      // A late copy of the poll job changes nothing.
      expect(await pollBatch(tx, { model, boss, config, handlers, now: () => late }, batchId!)).toBe("failed");
      expect(await stageRow(tx, runId)).toMatchObject({ done: 1, failed: 1 });
    }));

  it("an empty item list submits nothing and does not extend the stage", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const submit = vi.spyOn(model, "submitBatch");
      const { boss } = recordingBoss();
      expect(await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: [] })).toEqual({
        batchId: null,
        items: 0,
        reused: false,
      });
      expect(submit).not.toHaveBeenCalled();
      expect(await batchesOf(tx, runId)).toHaveLength(0);
      expect((await stageRow(tx, runId)).total).toBe(1);
    }));

  it("a stage that takes no more jobs gets no batch", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      const { boss } = recordingBoss();
      const result = await submitStageBatch(tx, { model: new MockModel({ "system.echo": echoBack }), boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      expect(result.batchId).toBeNull();
      expect(await batchesOf(tx, runId)).toHaveLength(0);
    }));

  it("the budget check counts open reservations and runs before the stage is extended", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const { boss } = recordingBoss();
      // Spend and reservation of other batches leave less room than this batch needs.
      await recordExternalCall(tx, { service: "anthropic", operation: "seed", units: 1, unit: "tokens", costEur: 0.5, at: now });
      const estimate = estimateBatchCostEur(config, task, [{ text: "a" }]);
      const tight: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 0.5 + estimate / 2 } } };
      await expect(
        submitStageBatch(tx, { model, boss, config: tight, now: () => now }, { task, runId, stage: STAGE, key: "k", items: items("a") }),
      ).rejects.toBeInstanceOf(BudgetExceeded);
      expect(await batchesOf(tx, runId)).toHaveLength(0);
      expect((await stageRow(tx, runId)).total).toBe(1);

      const roomy: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 0.5 + estimate * 1.5 } } };
      const ok = await submitStageBatch(tx, { model, boss, config: roomy, now: () => now }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      expect(ok.batchId).not.toBeNull();
      expect(Number((await batchesOf(tx, runId))[0]!.estimatedCostEur)).toBeCloseTo(estimate, 6);
      // The open batch now reserves its estimate: a second one only fits if both do.
      await expect(
        submitStageBatch(tx, { model, boss, config: roomy, now: () => now }, { task, runId, stage: STAGE, key: "k2", items: items("a") }),
      ).rejects.toBeInstanceOf(BudgetExceeded);
    }));

  it("a batch whose estimate alone reaches the daily budget is a planning error", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const { boss } = recordingBoss();
      const tiny: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 0.0001 } } };
      await expect(
        submitStageBatch(tx, { model: new MockModel({ "system.echo": echoBack }), boss, config: tiny }, { task, runId, stage: STAGE, key: "k", items: items("a") }),
      ).rejects.toThrow(/plan smaller batches/);
    }));

  it("a dead-lettered poll fails the unit; a manual retry distributes and upgrades it", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const { boss } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");

      expect(await failBatchUnit(tx, boss, batchId!)).toBe(true);
      expect((await batchesOf(tx, runId))[0]!.status).toBe("failed");
      expect(await stageRow(tx, runId)).toMatchObject({ done: 1, failed: 1, status: "finished" });
      // A second dead-letter delivery records nothing more.
      expect(await failBatchUnit(tx, boss, batchId!)).toBe(false);

      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect(seen).toHaveLength(1);
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, failed: 0 });
    }));

  it("a run an admin ended is booked but not distributed", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const { boss } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      await endRun(tx, runId, "admin@test.invalid");
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("failed");
      expect(seen).toHaveLength(0);
      expect(await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId))).toHaveLength(1);
    }));
});

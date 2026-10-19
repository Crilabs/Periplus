import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { testDb, withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, externalCalls, jobOutcomes, runStages } from "@/lib/db/schema";
import { BudgetExceeded, recordExternalCall, reservedBatchEur } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, endRun, recordJobOutcome } from "@/lib/domain/runs";
import { MockBatchError, MockModel } from "@/lib/ai/mock";
import { echoTask } from "@/lib/ai/tasks/system-echo";
import { estimateBatchCostEur } from "@/lib/ai/cost";
import type { ModelTask, ModelUsage } from "@/lib/ai/types";
import {
  anthropicHeadroomEur,
  endRunBatches,
  failBatchUnit,
  failSubmitUnit,
  pollBatch,
  reviveBatch,
  sizeBatch,
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

/** Open batch reservations of the given runs only (ruling M4-P23: never sum DB-wide in a test). */
function reservedOf(tx: Db, runIds: string[], now = new Date()): Promise<number> {
  return reservedBatchEur(tx, { now, hours: config.models.batch.reservationHours, scope: { runIds } });
}

const ITEM_USAGE: ModelUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
const ITEM_COST = 0.0125;

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
      expect(poll?.data).toEqual({ key: `poll:${batch!.id}:0`, batchId: batch!.id, n: 0 });
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
      const model = new MockModel({ "system.echo": echoBack }, { itemCost: { usage: ITEM_USAGE, costEur: ITEM_COST } });
      const { boss } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "b", "c") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      const [open] = await batchesOf(tx, runId);
      expect(await reservedOf(tx, [runId])).toBeCloseTo(Number(open!.estimatedCostEur), 6);

      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect(seen).toHaveLength(3);
      expect(seen[0]).toMatchObject({ usage: { inputTokens: 1000, outputTokens: 200 }, costEur: ITEM_COST });
      // Booking the actual cost released the reservation in the same transition.
      expect(await reservedOf(tx, [runId])).toBe(0);
      expect(await stageRow(tx, runId)).toMatchObject({ total: 2, done: 2, failed: 0 });
      const outcomes = await tx.select().from(jobOutcomes).where(eq(jobOutcomes.runId, runId));
      expect(outcomes.map((o) => o.key).sort()).toEqual(["batch:k", "k"]);
      // One booking per collected batch, in the transaction that ended it.
      const booked = await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(booked).toHaveLength(1);
      expect(booked[0]).toMatchObject({ service: "anthropic", operation: "system.echo.batch", stage: STAGE, unit: "tokens" });
      expect(Number(booked[0]!.costEur)).toBeCloseTo(3 * ITEM_COST, 6);
      expect(Number(booked[0]!.units)).toBe(3 * 1200);
      expect(Number((await batchesOf(tx, runId))[0]!.costEur)).toBeCloseTo(3 * ITEM_COST, 6);
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
      // The outcome of the call is unknown: the claim stays, its lease is given up, so the retry checks the provider first.
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "sending", providerBatchId: null });
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
      // The provider may still bill it: it stays reserved and a booking poll cancels and books it.
      expect(await reservedOf(tx, [runId], late)).toBeGreaterThan(0);
      expect(inserted.some((j) => j.queue === "ai.batch.poll" && j.data.batchId === batchId && j.data.mode === "book")).toBe(true);
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
      const scope = { runIds: [runId] };
      await expect(
        submitStageBatch(tx, { model, boss, config: tight, now: () => now, reservationScope: scope }, { task, runId, stage: STAGE, key: "k", items: items("a") }),
      ).rejects.toBeInstanceOf(BudgetExceeded);
      expect(await batchesOf(tx, runId)).toHaveLength(0);
      expect((await stageRow(tx, runId)).total).toBe(1);

      const roomy: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 0.5 + estimate * 1.5 } } };
      const ok = await submitStageBatch(tx, { model, boss, config: roomy, now: () => now, reservationScope: scope }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      expect(ok.batchId).not.toBeNull();
      expect(Number((await batchesOf(tx, runId))[0]!.estimatedCostEur)).toBeCloseTo(estimate, 6);
      // The open batch now reserves its estimate: a second one only fits if both do.
      await expect(
        submitStageBatch(tx, { model, boss, config: roomy, now: () => now, reservationScope: scope }, { task, runId, stage: STAGE, key: "k2", items: items("a") }),
      ).rejects.toBeInstanceOf(BudgetExceeded);
      expect(await anthropicHeadroomEur(tx, roomy, now, scope)).toBeCloseTo(estimate * 0.5, 6);
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

  it("a sender that crashed before the provider accepted holds its lease, then the batch is sent once", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const submit = vi.spyOn(model, "submitBatch").mockRejectedValueOnce(new Error("killed"));
      const { boss } = recordingBoss();
      const req = { task, runId, stage: STAGE, key: "k", items: items("a") };
      await expect(submitStageBatch(tx, { model, boss, config }, req)).rejects.toThrow("killed");
      // As if the process died inside the call: the claim still holds a live lease.
      const t0 = new Date();
      const leaseUntil = new Date(t0.getTime() + config.models.batch.leaseSeconds * 1000);
      await tx.update(aiBatches).set({ leaseUntil }).where(eq(aiBatches.runId, runId));

      await expect(submitStageBatch(tx, { model, boss, config, now: () => t0 }, req)).rejects.toThrow(/being sent/);
      expect(submit).toHaveBeenCalledTimes(1);

      const afterLease = new Date(leaseUntil.getTime() + 1000);
      const list = vi.spyOn(model, "listBatches");
      const retried = await submitStageBatch(tx, { model, boss, config, now: () => afterLease }, req);
      expect(retried.reused).toBe(true);
      expect(list).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(2);
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "submitted", providerBatchId: "mock-batch-1" });
    }));

  it("a batch the provider accepted before the sender crashed is adopted from the provider list, not sent again", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const original = model.submitBatch.bind(model);
      const submit = vi.spyOn(model, "submitBatch").mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("socket hang up");
      });
      const { boss, inserted } = recordingBoss();
      const req = { task, runId, stage: STAGE, key: "k", items: items("a", "b") };
      await expect(submitStageBatch(tx, { model, boss, config }, req)).rejects.toThrow("socket hang up");
      const t0 = new Date();
      const leaseUntil = new Date(t0.getTime() + config.models.batch.leaseSeconds * 1000);
      await tx.update(aiBatches).set({ leaseUntil }).where(eq(aiBatches.runId, runId));
      await expect(submitStageBatch(tx, { model, boss, config, now: () => t0 }, req)).rejects.toThrow(/being sent/);

      const afterLease = new Date(leaseUntil.getTime() + 1000);
      expect((await submitStageBatch(tx, { model, boss, config, now: () => afterLease }, req)).reused).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
      const [batch] = await batchesOf(tx, runId);
      expect(batch).toMatchObject({ status: "submitted", providerBatchId: "mock-batch-1" });
      expect(inserted.filter((j) => j.queue === "ai.batch.poll" && j.data.batchId === batch!.id).map((j) => j.data.key)).toEqual([
        `poll:${batch!.id}:0`,
      ]);
      const { handlers, seen } = countingHandlers();
      expect(await pollBatch(tx, { model, boss, config, handlers }, batch!.id)).toBe("distributed");
      expect(seen).toHaveLength(2);
    }));

  it("distribution goes on past an item whose handler throws, keeps its error and fails the poll once at the end", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const { boss } = recordingBoss();
      const calls: string[] = [];
      let broken = true;
      const handlers: Record<string, BatchHandlerEntry> = {
        "system.echo": {
          task,
          handle: async (_db, item) => {
            calls.push(item.subjectId);
            if (item.subjectId === "s1" && broken) throw new Error("check violation");
          },
        },
      };
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "b", "c") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");

      await expect(pollBatch(tx, { model, boss, config, handlers }, batchId!)).rejects.toThrow(/1 of 3 items .* check violation/);
      expect(calls).toEqual(["s0", "s1", "s2"]);
      const stored = await itemsOf(tx, batchId!);
      expect(stored.map((i) => i.distributedAt !== null)).toEqual([true, false, true]);
      expect(stored[1]!.distributionError).toBe("check violation");
      expect((await batchesOf(tx, runId))[0]!.status).toBe("ended");

      await expect(pollBatch(tx, { model, boss, config, handlers }, batchId!)).rejects.toThrow(/1 of 1 items/);
      expect(calls).toEqual(["s0", "s1", "s2", "s1"]);
      broken = false;
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect((await itemsOf(tx, batchId!))[1]).toMatchObject({ distributionError: null });
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, status: "finished" });
    }));

  it("a dead-lettered submit job fails its unit and releases the reservation; a manual retry sends it", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const submit = vi.spyOn(model, "submitBatch").mockRejectedValue(new Error("invalid_request_error: too large"));
      const { boss } = recordingBoss();
      const req = { task, runId, stage: STAGE, key: "k", items: items("a") };
      for (let attempt = 0; attempt < 3; attempt++) await expect(submitStageBatch(tx, { model, boss, config }, req)).rejects.toThrow("too large");
      expect(await reservedOf(tx, [runId])).toBeGreaterThan(0);

      // The worker's dead-letter branch: the job's own outcome, then its batch unit.
      await recordJobOutcome(tx, runId, STAGE, "k", "failed");
      expect(await failSubmitUnit(tx, boss, { runId, stage: STAGE, key: "k" })).toBe(true);
      expect((await batchesOf(tx, runId))[0]!.status).toBe("failed");
      expect(await reservedOf(tx, [runId])).toBe(0);
      expect(await stageRow(tx, runId)).toMatchObject({ total: 2, failed: 2, status: "finished" });
      expect(await failSubmitUnit(tx, boss, { runId, stage: STAGE, key: "k" })).toBe(false);

      // Manual retry of the submit job, now that the provider accepts it.
      submit.mockRestore();
      const retried = await submitStageBatch(tx, { model, boss, config }, req);
      expect(retried).toMatchObject({ batchId: (await batchesOf(tx, runId))[0]!.id, reused: true });
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "submitted", providerBatchId: "mock-batch-1" });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      const { handlers } = countingHandlers();
      expect(await pollBatch(tx, { model, boss, config, handlers }, retried.batchId!)).toBe("distributed");
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, failed: 0 });
    }));

  it("a manual retry of a dead-lettered submit job whose last call reached the provider adopts that batch", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const original = model.submitBatch.bind(model);
      const submit = vi.spyOn(model, "submitBatch").mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("response lost");
      });
      const { boss } = recordingBoss();
      const req = { task, runId, stage: STAGE, key: "k", items: items("a") };
      await expect(submitStageBatch(tx, { model, boss, config }, req)).rejects.toThrow("response lost");
      expect(await failSubmitUnit(tx, boss, { runId, stage: STAGE, key: "k" })).toBe(true);

      await submitStageBatch(tx, { model, boss, config }, req);
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "submitted", providerBatchId: "mock-batch-1" });
    }));

  it("a dead-lettered poll keeps the reservation of a live provider batch until a booking poll cancels and books it", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack }, { batchRounds: 100, itemCost: { usage: ITEM_USAGE, costEur: ITEM_COST } });
      const cancel = vi.spyOn(model, "cancelBatch");
      const { boss, inserted } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "b") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      const estimate = Number((await batchesOf(tx, runId))[0]!.estimatedCostEur);

      expect(await failBatchUnit(tx, boss, batchId!)).toBe(true);
      expect((await batchesOf(tx, runId))[0]!.status).toBe("failed");
      expect(await reservedOf(tx, [runId])).toBeCloseTo(estimate, 6);
      const book = inserted.find((j) => j.queue === "ai.batch.poll" && j.data.mode === "book");
      expect(book?.data).toMatchObject({ batchId, mode: "book" });

      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { mode: "book" })).toBe("failed");
      expect(cancel).toHaveBeenCalledWith("mock-batch-1");
      const booked = await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(booked).toHaveLength(1);
      expect(Number(booked[0]!.costEur)).toBeCloseTo(2 * ITEM_COST, 6);
      expect(await reservedOf(tx, [runId])).toBe(0);
      expect(seen).toHaveLength(0);
      // A repeated booking poll books nothing more.
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { mode: "book" })).toBe("failed");
      expect(await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId))).toHaveLength(1);

      // A manual retry of the dead-lettered poll distributes the stored results.
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { n: 0 })).toBe("distributed");
      expect(seen).toHaveLength(2);
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, failed: 0 });
      expect(await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId))).toHaveLength(1);
    }));

  it("ending a run fails its unsent batches and cancels, books and fails its submitted ones", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx, 2);
      const model = new MockModel({ "system.echo": echoBack }, { batchRounds: 100, itemCost: { usage: ITEM_USAGE, costEur: ITEM_COST } });
      const submit = vi.spyOn(model, "submitBatch");
      const cancel = vi.spyOn(model, "cancelBatch");
      const { boss, inserted } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      submit.mockRejectedValueOnce(new Error("overloaded"));
      await expect(submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k1", items: items("a") })).rejects.toThrow();
      const sent = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k2", items: items("b") });
      const [unsent] = (await batchesOf(tx, runId)).filter((b) => b.id !== sent.batchId);

      await endRun(tx, runId, "admin@test.invalid");
      expect(await endRunBatches(tx, boss, runId)).toEqual({ failed: 1, cancelling: 1 });
      expect((await batchesOf(tx, runId)).find((b) => b.id === unsent!.id)!.status).toBe("failed");
      expect((await batchesOf(tx, runId)).find((b) => b.id === sent.batchId)!.status).toBe("submitted");
      expect(await reservedOf(tx, [runId])).toBeCloseTo(Number((await batchesOf(tx, runId)).find((b) => b.id === sent.batchId)!.estimatedCostEur), 6);
      expect(inserted.some((j) => j.queue === "ai.batch.poll" && j.data.key === `end:${sent.batchId}`)).toBe(true);

      // The poll cancels the provider batch, books what it billed and fails it without distributing.
      expect(await pollBatch(tx, { model, boss, config, handlers }, sent.batchId!)).toBe("failed");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect((await batchesOf(tx, runId)).find((b) => b.id === sent.batchId)!.status).toBe("failed");
      expect(Number((await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId)))[0]!.costEur)).toBeCloseTo(ITEM_COST, 6);
      expect(await reservedOf(tx, [runId])).toBe(0);
      // A late poll of the unsent batch of the ended run sends nothing.
      expect(await pollBatch(tx, { model, boss, config, handlers }, unsent!.id)).toBe("failed");
      expect(submit).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(0);
    }));

  it("a provider call that returns after the run was ended is recorded, cancelled and booked", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack }, { batchRounds: 100, itemCost: { usage: ITEM_USAGE, costEur: ITEM_COST } });
      const original = model.submitBatch.bind(model);
      const { boss } = recordingBoss();
      vi.spyOn(model, "submitBatch").mockImplementationOnce(async (...args) => {
        // The admin presses "Lauf beenden" while the request is on its way.
        await endRun(tx, runId, "admin@test.invalid");
        await endRunBatches(tx, boss, runId);
        return original(...args);
      });
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "submitted", providerBatchId: "mock-batch-1" });
      const { handlers } = countingHandlers();
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("failed");
      expect(await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId))).toHaveLength(1);
      expect(await reservedOf(tx, [runId])).toBe(0);
    }));

  it("a redelivered poll with a stale number schedules no second poll chain", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack }, { batchRounds: 100 });
      const { boss, inserted } = recordingBoss();
      const { handlers } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      const polls = () => inserted.filter((j) => j.queue === "ai.batch.poll").map((j) => j.data.key);

      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { n: 0 })).toBe("waiting");
      expect(polls()).toEqual([`poll:${batchId}:0`, `poll:${batchId}:1`]);
      // Poll 0 again (worker crash before completing it): poll 1 is already scheduled.
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { n: 0 })).toBe("waiting");
      expect(polls()).toEqual([`poll:${batchId}:0`, `poll:${batchId}:1`]);
      expect((await batchesOf(tx, runId))[0]!.pollCount).toBe(1);
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { n: 1 })).toBe("waiting");
      expect(polls()).toEqual([`poll:${batchId}:0`, `poll:${batchId}:1`, `poll:${batchId}:2`]);
    }));

  it("a follow-up batch over the budget is not sent and its send is retried later", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const runId = await stageRun(tx);
      const scope = { runIds: [runId] };
      const model = new MockModel(
        {
          "system.echo": (input) => {
            if ((input as { text: string }).text === "busy") throw new MockBatchError("overloaded", true);
            return echoBack(input);
          },
        },
        { itemCost: { usage: ITEM_USAGE, costEur: 1 } },
      );
      const submit = vi.spyOn(model, "submitBatch");
      const { boss, inserted } = recordingBoss();
      const { handlers } = countingHandlers();
      // The first batch fits; its actual cost (1 EUR for the answered item) uses up the budget.
      const tight: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 1 } } };
      const deps = { model, boss, config: tight, now: () => now, reservationScope: scope, handlers };
      const { batchId } = await submitStageBatch(tx, deps, { task, runId, stage: STAGE, key: "k", items: items("a", "busy") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");

      expect(await pollBatch(tx, deps, batchId!)).toBe("waiting");
      const followUp = (await batchesOf(tx, runId))[1]!;
      expect(followUp.status).toBe("submitting");
      expect(submit).toHaveBeenCalledTimes(1);
      const send = inserted.find((j) => j.queue === "ai.batch.poll" && j.data.batchId === followUp.id && j.data.mode === "send");
      expect(send?.startAfter).toBe(`${tight.models.batch.budgetRetrySeconds} seconds`);

      // Next day: the send poll goes through.
      const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
      expect(await pollBatch(tx, { ...deps, now: () => tomorrow }, followUp.id, { mode: "send" })).toBe("waiting");
      expect((await batchesOf(tx, runId))[1]!.status).toBe("submitted");
      expect(submit).toHaveBeenCalledTimes(2);
    }));

  it("a dead letter after a failed follow-up send fails the unit; a manual retry sends the follow-up", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({
        "system.echo": (input) => {
          if ((input as { text: string }).text === "busy" && !retriedOnce.has("busy")) {
            retriedOnce.add("busy");
            throw new MockBatchError("overloaded", true);
          }
          return echoBack(input);
        },
      });
      const retriedOnce = new Set<string>();
      const submit = vi.spyOn(model, "submitBatch");
      const { boss } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "busy") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      submit.mockRejectedValueOnce(new Error("overloaded"));
      await expect(pollBatch(tx, { model, boss, config, handlers }, batchId!)).rejects.toThrow("overloaded");
      const followUp = (await batchesOf(tx, runId))[1]!;
      expect(followUp.status).toBe("sending");

      expect(await failBatchUnit(tx, boss, batchId!)).toBe(true);
      expect((await batchesOf(tx, runId))[1]!.status).toBe("failed");
      expect(await reservedOf(tx, [runId])).toBe(0);
      expect(await stageRow(tx, runId)).toMatchObject({ done: 1, failed: 1, status: "finished" });

      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { n: 0 })).toBe("resubmitted");
      expect((await batchesOf(tx, runId))[1]).toMatchObject({ status: "submitted", providerBatchId: "mock-batch-2" });
      expect(await pollBatch(tx, { model, boss, config, handlers }, followUp.id)).toBe("distributed");
      expect(seen.map((s) => s.subjectId)).toEqual(["s0", "s1"]);
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, failed: 0 });
    }));

  it("a manual retry racing a booking poll never revives a collected batch as running; a later retry distributes it", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack }, { batchRounds: 100 });
      const collect = vi.spyOn(model, "collectBatch");
      const { boss } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "b") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      expect(await failBatchUnit(tx, boss, batchId!)).toBe(true);
      // What the manual retry read before the booking poll committed: failed, sent, not collected.
      const stale = (await batchesOf(tx, runId))[0]!;
      expect(stale).toMatchObject({ status: "failed", endedAt: null });

      // The booking poll commits between the retry's read of pending items and its revive update: at that point the
      // row has `ended_at`, the retry still believes it running. Its revive must lose.
      await tx.update(aiBatches).set({ endedAt: new Date() }).where(eq(aiBatches.id, batchId!));
      expect(await reviveBatch(tx, stale)).toBeUndefined();
      expect((await batchesOf(tx, runId))[0]!.status).toBe("failed");
      await tx.update(aiBatches).set({ endedAt: null }).where(eq(aiBatches.id, batchId!));

      // The real booking poll books it while it stays failed; the stale revive still loses.
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { mode: "book" })).toBe("failed");
      expect((await batchesOf(tx, runId))[0]).toMatchObject({ status: "failed" });
      expect(await reviveBatch(tx, stale)).toBeUndefined();

      const calls = collect.mock.calls.length;
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("distributed");
      expect(collect.mock.calls.length).toBe(calls);
      expect(seen).toHaveLength(2);
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, failed: 0 });
    }));

  it("a poll that finds its batch still submitted after collecting fails once instead of recursing", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({ "system.echo": echoBack });
      const collect = vi.spyOn(model, "collectBatch");
      const { boss } = recordingBoss();
      const { handlers } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a") });
      // The state the old revive race could leave behind: submitted, but its results already collected.
      await tx.update(aiBatches).set({ endedAt: new Date() }).where(eq(aiBatches.id, batchId!));
      await expect(pollBatch(tx, { model, boss, config, handlers }, batchId!)).rejects.toThrow("after its results were collected");
      expect(collect).toHaveBeenCalledTimes(1);
    }));

  it("an adapter budget refusal of a follow-up send defers only that batch", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel({
        "system.echo": (input) => {
          if ((input as { text: string }).text === "busy" && !retriedOnce.has("busy")) {
            retriedOnce.add("busy");
            throw new MockBatchError("overloaded", true);
          }
          return echoBack(input);
        },
      });
      const retriedOnce = new Set<string>();
      const submit = vi.spyOn(model, "submitBatch");
      const { boss, inserted } = recordingBoss();
      const { handlers } = countingHandlers();
      const deps = { model, boss, config, handlers, reservationScope: { runIds: [runId] } };
      const { batchId } = await submitStageBatch(tx, deps, { task, runId, stage: STAGE, key: "k", items: items("a", "busy") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      // Spend booked between our reservation check and the adapter's own check.
      submit.mockRejectedValueOnce(new BudgetExceeded("anthropic", 1000, 1000));

      expect(await pollBatch(tx, deps, batchId!)).toBe("waiting");
      const followUp = (await batchesOf(tx, runId))[1]!;
      expect(followUp).toMatchObject({ status: "submitting", claimId: null });
      const send = inserted.find((j) => j.queue === "ai.batch.poll" && j.data.batchId === followUp.id && j.data.mode === "send");
      expect(send?.startAfter).toBe(`${config.models.batch.budgetRetrySeconds} seconds`);

      expect(await pollBatch(tx, deps, followUp.id, { mode: "send" })).toBe("waiting");
      expect((await batchesOf(tx, runId))[1]!.status).toBe("submitted");
    }));

  it("a failed follow-up revived as sent gets a poll of its own", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const model = new MockModel(
        {
          "system.echo": (input) => {
            if ((input as { text: string }).text === "busy" && !retriedOnce.has("busy")) {
              retriedOnce.add("busy");
              throw new MockBatchError("overloaded", true);
            }
            return echoBack(input);
          },
        },
        { batchRounds: 0 },
      );
      const retriedOnce = new Set<string>();
      const { boss, inserted } = recordingBoss();
      const { handlers, seen } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "busy") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("resubmitted");
      const followUp = (await batchesOf(tx, runId))[1]!;
      expect(followUp.status).toBe("submitted");
      // The follow-up's own poll dead-letters: it fails while sent and not collected.
      expect(await failBatchUnit(tx, boss, followUp.id)).toBe(true);
      expect((await batchesOf(tx, runId))[1]).toMatchObject({ status: "failed", endedAt: null });

      // A manual retry of the parent's poll revives the follow-up as sent and schedules its poll.
      const before = inserted.length;
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { n: 0 })).toBe("resubmitted");
      expect((await batchesOf(tx, runId))[1]!.status).toBe("submitted");
      const poll = inserted.slice(before).find((j) => j.queue === "ai.batch.poll" && j.data.batchId === followUp.id && j.data.mode === undefined);
      expect(poll?.data).toMatchObject({ batchId: followUp.id });
      expect(String(poll?.data.key)).toMatch(new RegExp(`^revive:${followUp.id}:${followUp.pollCount}:`));

      // The revived poll dead-letters again before advancing the poll count; a second manual retry revives it with a
      // poll whose job id differs from the first revive poll's (pg-boss would drop a duplicate id).
      expect(await failBatchUnit(tx, boss, followUp.id)).toBe(true);
      const before2 = inserted.length;
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!, { n: 0 })).toBe("resubmitted");
      const poll2 = inserted.slice(before2).find((j) => j.queue === "ai.batch.poll" && j.data.batchId === followUp.id && j.data.mode === undefined);
      expect(poll2).toBeDefined();
      expect(poll2!.id).not.toBe(poll!.id);
      expect(poll2!.data.key).not.toBe(poll!.data.key);

      expect(await pollBatch(tx, { model, boss, config, handlers }, followUp.id)).toBe("distributed");
      expect(seen.map((s) => s.subjectId)).toEqual(["s0", "s1"]);
      expect(await stageRow(tx, runId)).toMatchObject({ done: 2, failed: 0 });
    }));

  it("a revive whose poll cannot be enqueued is rolled back with it", () =>
    withRollback(async (tx) => {
      const runId = await stageRun(tx);
      const retriedOnce = new Set<string>();
      const model = new MockModel(
        {
          "system.echo": (input) => {
            if ((input as { text: string }).text === "busy" && !retriedOnce.has("busy")) {
              retriedOnce.add("busy");
              throw new MockBatchError("overloaded", true);
            }
            return echoBack(input);
          },
        },
        { batchRounds: 0 },
      );
      const { boss } = recordingBoss();
      const { handlers } = countingHandlers();
      const { batchId } = await submitStageBatch(tx, { model, boss, config }, { task, runId, stage: STAGE, key: "k", items: items("a", "busy") });
      await recordJobOutcome(tx, runId, STAGE, "k", "done");
      expect(await pollBatch(tx, { model, boss, config, handlers }, batchId!)).toBe("resubmitted");
      const followUp = (await batchesOf(tx, runId))[1]!;
      expect(await failBatchUnit(tx, boss, followUp.id)).toBe(true);

      const failingBoss = { insert: async () => { throw new Error("queue down"); } } as unknown as PgBoss;
      await expect(pollBatch(tx, { model, boss: failingBoss, config, handlers }, batchId!, { n: 0 })).rejects.toThrow("queue down");
      // nothing half done: the follow-up is still failed (no sent batch without its poll)
      expect((await batchesOf(tx, runId))[1]!.status).toBe("failed");
    }));

  it("sizeBatch takes the longest prefix that stays below the headroom", () => {
    expect(sizeBatch([0.1, 0.2, 0.3], 0.35, 10)).toBe(2);
    expect(sizeBatch([0.1, 0.2, 0.3], 0.35, 1)).toBe(1);
    expect(sizeBatch([0.1, 0.2, 0.3], 0.6, 10)).toBe(2);
    expect(sizeBatch([0.1, 0.2, 0.3], 10, 10)).toBe(3);
    expect(sizeBatch([0.1], 0.05, 10)).toBe(0);
    expect(sizeBatch([0.1], -1, 10)).toBe(0);
  });
});

describe("stage batches under concurrency (committed)", () => {
  it("two stage jobs of different runs cannot both pass the budget check", async () => {
    const db = testDb();
    const now = new Date((await quietDay(db)).getTime() + 12 * 3_600_000);
    const runIds = [await stageRun(db), await stageRun(db)];
    try {
      const estimate = estimateBatchCostEur(config, task, [{ text: "a" }]);
      const tight: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: estimate * 1.5 } } };
      // Committed rows: provider ids must not meet those of other tests.
      const model = new MockModel({ "system.echo": echoBack }, { batchIdPrefix: `mock-${newId()}-` });
      const { boss } = recordingBoss();
      const deps = { model, boss, config: tight, now: () => now, reservationScope: { runIds } };
      // Open pool connections first, so both jobs run side by side instead of one waiting for a new connection.
      await Promise.all([1, 2, 3, 4].map(() => db.execute(sql`select pg_sleep(0.02)`)));
      const results = await Promise.allSettled(
        runIds.map((runId) => submitStageBatch(db, deps, { task, runId, stage: STAGE, key: "k", items: items("a") })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(BudgetExceeded);
    } finally {
      const own = await db.select({ id: aiBatches.id }).from(aiBatches).where(inArray(aiBatches.runId, runIds));
      if (own.length > 0) {
        await db.delete(aiBatchItems).where(inArray(aiBatchItems.batchId, own.map((b) => b.id)));
        await db.delete(aiBatches).where(inArray(aiBatches.id, own.map((b) => b.id)));
      }
    }
  });
});

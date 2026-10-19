import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { aiBatches, externalCalls } from "@/lib/db/schema";
import { createRun } from "@/lib/domain/runs";
import { newId } from "@/lib/domain/ids";
import { BudgetExceeded, recordExternalCall } from "@/lib/domain/costs";
import { loadConfig, type AppConfig } from "@/lib/config";
import { createAnthropicClient, type AnthropicMessagesApi } from "@/lib/ai/anthropic";
import { estimateBatchCostEur, estimateBatchItemCostsEur, usageCostEur } from "@/lib/ai/cost";
import { fixtureKey } from "@/lib/ai/fixtures";
import { MockBatchError, MockModel } from "@/lib/ai/mock";
import { echoTask } from "@/lib/ai/tasks/system-echo";

const base = loadConfig("config");
const config: AppConfig = {
  ...base,
  queues: {},
  budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } },
  models: {
    ...base.models,
    tasks: {
      "system.echo": { model: "claude-sonnet-5-5", promptVersion: 1, effort: "medium", maxTokens: 2048, cacheSystem: true },
    },
  },
};

type Line = { custom_id: string; result: Record<string, unknown> };

const succeeded = (customId: string, text: string, usage: Record<string, number> = { input_tokens: 100, output_tokens: 20 }): Line => ({
  custom_id: customId,
  result: { type: "succeeded", message: { content: [{ type: "text", text }], usage, stop_reason: "end_turn" } },
});

const errored = (customId: string, type: string): Line => ({
  custom_id: customId,
  result: { type: "errored", error: { type: "error", error: { type, message: `${type} happened` }, request_id: null } },
});

type ListedBatch = { id: string; created_at: string; request_counts: Record<string, number> };

function fakeBatchSdk(lines: Line[] = [], status: "in_progress" | "ended" = "ended", listed: ListedBatch[] = []) {
  const create = vi.fn(async (...args: unknown[]) => ({ id: "msgbatch_test", processing_status: "in_progress", body: args[0] }));
  const retrieve = vi.fn(async (id: string) => ({ id, processing_status: status }));
  const results = vi.fn(async () =>
    (async function* () {
      for (const line of lines) yield line;
    })(),
  );
  const cancel = vi.fn(async (id: string) => ({ id, processing_status: "canceling" }));
  const listedPages: ListedBatch[] = [];
  // Newest first, as the API lists them; counts how far the client read.
  const list = vi.fn(() =>
    (async function* () {
      for (const batch of listed) {
        listedPages.push(batch);
        yield batch;
      }
    })(),
  );
  const messagesCreate = vi.fn();
  const api = { messages: { create: messagesCreate, batches: { create, retrieve, results, cancel, list } } } as unknown as AnthropicMessagesApi;
  return { api, create, retrieve, results, cancel, list, listedPages };
}

const counts = (processing: number) => ({ processing, succeeded: 0, errored: 0, canceled: 0, expired: 0 });

const echo = (text: string) => JSON.stringify({ echo: text, language: "en" });

describe("anthropic batches", () => {
  it("submitBatch sends one request per item with custom_id, effort and json schema", () =>
    withRollback(async (tx) => {
      const { api, create } = fakeBatchSdk();
      const client = createAnthropicClient(tx, config, { sdk: api });
      const submitted = await client.submitBatch(echoTask, [
        { customId: "a", input: { text: "one" } },
        { customId: "b", input: { text: "two" } },
      ]);
      expect(submitted).toEqual({ batchId: "msgbatch_test", model: "claude-sonnet-5-5", promptVersion: 1 });
      const body = create.mock.calls[0]![0] as { requests: Array<{ custom_id: string; params: Record<string, unknown> }> };
      expect(body.requests.map((r) => r.custom_id)).toEqual(["a", "b"]);
      const params = body.requests[0]!.params as {
        model: string;
        max_tokens: number;
        system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
        messages: Array<{ content: string }>;
        output_config: { effort: string; format: { type: string; schema: unknown } };
      };
      expect(params.model).toBe("claude-sonnet-5-5");
      expect(params.max_tokens).toBe(2048);
      expect(params.output_config.effort).toBe("medium");
      expect(params.output_config.format.type).toBe("json_schema");
      expect(params.output_config.format.schema).toMatchObject({ type: "object" });
      expect(params.system[0]!.cache_control).toEqual({ type: "ephemeral" });
      expect(params.messages[0]!.content).toContain("one");
      expect((body.requests[1]!.params as { messages: Array<{ content: string }> }).messages[0]!.content).toContain("two");
    }));

  it("batches.create is sent once, without SDK retries and with the configured timeout", () =>
    withRollback(async (tx) => {
      const { api, create } = fakeBatchSdk();
      await createAnthropicClient(tx, config, { sdk: api }).submitBatch(echoTask, [{ customId: "a", input: { text: "x" } }]);
      expect(create.mock.calls[0]![1]).toEqual({ maxRetries: 0, timeout: config.models.batch.providerTimeoutSeconds * 1000 });
    }));

  it("cancelBatch asks the provider to cancel", () =>
    withRollback(async (tx) => {
      const { api, cancel } = fakeBatchSdk();
      await createAnthropicClient(tx, config, { sdk: api }).cancelBatch("msgbatch_x");
      expect(cancel).toHaveBeenCalledWith("msgbatch_x", null, { timeout: config.models.batch.providerTimeoutSeconds * 1000 });
    }));

  it("listBatches returns the batches created in the window and stops reading at its start", () =>
    withRollback(async (tx) => {
      const { api, listedPages } = fakeBatchSdk([], "ended", [
        { id: "b4", created_at: "2026-10-19T12:10:00Z", request_counts: counts(1) },
        { id: "b3", created_at: "2026-10-19T12:05:00Z", request_counts: { ...counts(1), succeeded: 2 } },
        { id: "b2", created_at: "2026-10-19T11:50:00Z", request_counts: counts(5) },
        { id: "b1", created_at: "2026-10-19T11:00:00Z", request_counts: counts(1) },
      ]);
      const found = await createAnthropicClient(tx, config, { sdk: api }).listBatches({
        from: new Date("2026-10-19T12:00:00Z"),
        to: new Date("2026-10-19T12:06:00Z"),
      });
      expect(found).toEqual([{ batchId: "b3", createdAt: new Date("2026-10-19T12:05:00Z"), requestCount: 3 }]);
      expect(listedPages.map((b) => b.id)).toEqual(["b4", "b3", "b2"]);
    }));

  it("a synchronous call counts the open batch reservations against the budget", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const { id: runId } = await createRun(tx, { kind: "reprocess", scope: { type: "system", id: `res-${newId()}` }, stages: ["s"], triggeredBy: "test" });
      const tight: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 5 } } };
      await tx.insert(aiBatches).values({
        task: "system.echo",
        model: "claude-sonnet-5-5",
        promptVersion: 1,
        status: "submitted",
        providerBatchId: `msgbatch_${newId()}`,
        runId,
        stage: "s",
        outcomeKey: "batch:k",
        requestCount: 1,
        estimatedCostEur: "5",
        createdAt: now,
      });
      const { api } = fakeBatchSdk();
      await expect(createAnthropicClient(tx, tight, { sdk: api, now: () => now }).call(echoTask, { text: "x" })).rejects.toBeInstanceOf(BudgetExceeded);
      expect(api.messages.create).not.toHaveBeenCalled();
    }));

  it("without cacheSystem the system prompt stays a plain string", () =>
    withRollback(async (tx) => {
      const { api, create } = fakeBatchSdk();
      const plain: AppConfig = {
        ...config,
        models: { ...config.models, tasks: { "system.echo": { ...config.models.tasks["system.echo"]!, cacheSystem: false } } },
      };
      await createAnthropicClient(tx, plain, { sdk: api }).submitBatch(echoTask, [{ customId: "a", input: { text: "x" } }]);
      const body = create.mock.calls[0]![0] as { requests: Array<{ params: { system: unknown } }> };
      expect(typeof body.requests[0]!.params.system).toBe("string");
    }));

  it("collectBatch maps results by custom_id, not by position", () =>
    withRollback(async (tx) => {
      // Results arrive in the reverse order of the requests.
      const { api } = fakeBatchSdk([succeeded("b", echo("two")), succeeded("a", echo("one"))]);
      const client = createAnthropicClient(tx, config, { sdk: api });
      const { status, results } = await client.collectBatch(echoTask, "msgbatch_test");
      expect(status).toBe("ended");
      const byId = new Map(results.map((r) => [r.customId, r]));
      expect(byId.get("a")).toMatchObject({ ok: true, output: { echo: "one" } });
      expect(byId.get("b")).toMatchObject({ ok: true, output: { echo: "two" } });
    }));

  it("collectBatch reports in_progress without reading results", () =>
    withRollback(async (tx) => {
      const { api, results } = fakeBatchSdk([], "in_progress");
      const collected = await createAnthropicClient(tx, config, { sdk: api }).collectBatch(echoTask, "msgbatch_test");
      expect(collected).toMatchObject({ status: "in_progress", results: [], costEur: 0 });
      expect(results).not.toHaveBeenCalled();
    }));

  it("an invalid_request error is not retryable, an overloaded one is", () =>
    withRollback(async (tx) => {
      const { api } = fakeBatchSdk([
        errored("bad", "invalid_request_error"),
        errored("busy", "overloaded_error"),
        { custom_id: "late", result: { type: "expired" } },
        { custom_id: "stopped", result: { type: "canceled" } },
      ]);
      const { results } = await createAnthropicClient(tx, config, { sdk: api }).collectBatch(echoTask, "msgbatch_test");
      const byId = new Map(results.map((r) => [r.customId, r]));
      expect(byId.get("bad")).toMatchObject({ ok: false, retryable: false });
      expect(byId.get("busy")).toMatchObject({ ok: false, retryable: true });
      expect(byId.get("late")).toMatchObject({ ok: false, retryable: true, error: "expired" });
      expect(byId.get("stopped")).toMatchObject({ ok: false, retryable: true, error: "canceled" });
    }));

  it("schema-invalid output becomes a retryable failure", () =>
    withRollback(async (tx) => {
      const cut: Line = {
        custom_id: "cut",
        result: { type: "succeeded", message: { content: [{ type: "text", text: "{" }], usage: { input_tokens: 10, output_tokens: 2048 }, stop_reason: "max_tokens" } },
      };
      const { api } = fakeBatchSdk([succeeded("x", '{"echo":1}'), cut]);
      const { results, usage } = await createAnthropicClient(tx, config, { sdk: api }).collectBatch(echoTask, "msgbatch_test");
      const byId = new Map(results.map((r) => [r.customId, r]));
      expect(byId.get("x")).toMatchObject({ ok: false, retryable: true });
      expect(byId.get("cut")).toMatchObject({ ok: false, retryable: true, error: "stop_reason max_tokens" });
      // Both answers were billed, so their tokens count.
      expect(usage.outputTokens).toBe(20 + 2048);
    }));

  it("batch cost applies the 0.5 discount and collecting books nothing", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const { api } = fakeBatchSdk([succeeded("a", echo("x"), { input_tokens: 1_000_000, output_tokens: 0 })]);
      const client = createAnthropicClient(tx, config, { sdk: api, now: () => now });
      const { results, costEur, usage } = await client.collectBatch(echoTask, "msgbatch_test");
      expect(results[0]).toMatchObject({ ok: true });
      expect(results[0]!.costEur).toBeCloseTo(0.88865, 6);
      expect(costEur).toBeCloseTo(0.88865, 6);
      expect(usage).toEqual({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      // pollBatch books the batch in its own transaction (ruling M4-P4).
      const rows = await tx.select().from(externalCalls).where(eq(externalCalls.operation, "system.echo.batch"));
      expect(rows.filter((r) => r.at.getTime() === now.getTime())).toHaveLength(0);
    }));

  it("cache writes and reads are priced with their factors", () => {
    const price = config.models.pricesEurPerMTok["claude-sonnet-5-5"]!;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(usageCostEur(usage, price, 1.25, 0.5)).toBeCloseTo((1.7773 * 1.25 + 1.7773 * 0.1) * 0.5, 6);
  });

  it("an exhausted anthropic budget throws BudgetExceeded before submitting", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      await recordExternalCall(tx, { service: "anthropic", operation: "seed", units: 1, unit: "tokens", costEur: 0.02, at: now });
      const { api, create } = fakeBatchSdk();
      const tight: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 0.01 } } };
      const client = createAnthropicClient(tx, tight, { sdk: api, now: () => now });
      await expect(client.submitBatch(echoTask, [{ customId: "a", input: { text: "x" } }])).rejects.toBeInstanceOf(BudgetExceeded);
      expect(create).not.toHaveBeenCalled();
    }));

  it("opts.model overrides the configured model", () =>
    withRollback(async (tx) => {
      const { api, create } = fakeBatchSdk([succeeded("a", echo("x"), { input_tokens: 1_000_000, output_tokens: 0 })]);
      const client = createAnthropicClient(tx, config, { sdk: api });
      const submitted = await client.submitBatch(echoTask, [{ customId: "a", input: { text: "x" } }], { model: "claude-opus-5-5" });
      expect(submitted.model).toBe("claude-opus-5-5");
      const body = create.mock.calls[0]![0] as { requests: Array<{ params: { model: string } }> };
      expect(body.requests[0]!.params.model).toBe("claude-opus-5-5");
      // Collected results are priced at the batch's model.
      const { costEur } = await client.collectBatch(echoTask, "msgbatch_test", { model: "claude-opus-5-5" });
      expect(costEur).toBeCloseTo(3.5546 * 0.5, 6);
    }));

  it("the estimate counts the rendered prompt at 4 characters per token and maxTokens per answer", () => {
    const one = estimateBatchCostEur(config, echoTask, [{ text: "x" }]);
    const two = estimateBatchCostEur(config, echoTask, [{ text: "x" }, { text: "x" }]);
    expect(two).toBeCloseTo(2 * one, 10);
    // At least the output reservation: 2048 tokens of sonnet output at half price.
    expect(one).toBeGreaterThan((2048 / 1e6) * 8.8865 * 0.5);
    expect(estimateBatchCostEur(config, echoTask, [{ text: "x" }], "claude-opus-5-5")).toBeGreaterThan(one);
    // Per item: longer prompts reserve more; the batch estimate is their sum.
    const perItem = estimateBatchItemCostsEur(config, echoTask, [{ text: "x" }, { text: "x".repeat(4000) }]);
    expect(perItem[0]).toBeCloseTo(one, 10);
    expect(perItem[1]! - perItem[0]!).toBeCloseTo((3999 / 4 / 1e6) * 1.7773 * 0.5, 8);
    expect(estimateBatchCostEur(config, echoTask, [{ text: "x" }, { text: "x".repeat(4000) }])).toBeCloseTo(perItem[0]! + perItem[1]!, 10);
  });

  it("the estimate refuses tasks with attachments it cannot count", () => {
    const withPdf = { ...echoTask, attachments: () => [{ kind: "pdf" as const, data: new Uint8Array([1]) }] };
    expect(() => estimateBatchItemCostsEur(config, withPdf, [{ text: "x" }])).toThrow(/attachments/);
  });
});

describe("MockModel batches", () => {
  it("answers a batch at once through the registered functions", async () => {
    const model = new MockModel({
      "system.echo": (i) => {
        const text = (i as { text: string }).text;
        if (text === "retry") throw new MockBatchError("overloaded", true);
        if (text === "boom") throw new Error("broken");
        if (text === "bad") return { echo: 1 };
        return { echo: text, language: "en" };
      },
    });
    const { batchId } = await model.submitBatch(echoTask, [
      { customId: "ok", input: { text: "hi" } },
      { customId: "r", input: { text: "retry" } },
      { customId: "b", input: { text: "boom" } },
      { customId: "s", input: { text: "bad" } },
    ]);
    expect(batchId).toBe("mock-batch-1");
    const { status, results } = await model.collectBatch(echoTask, batchId);
    expect(status).toBe("ended");
    const byId = new Map(results.map((r) => [r.customId, r]));
    expect(byId.get("ok")).toMatchObject({ ok: true, output: { echo: "hi" }, costEur: 0 });
    expect(byId.get("r")).toMatchObject({ ok: false, retryable: true, error: "overloaded" });
    expect(byId.get("b")).toMatchObject({ ok: false, retryable: false });
    expect(byId.get("s")).toMatchObject({ ok: false, retryable: true });
  });

  it("reports the configured cost per answered item and ends a cancelled batch at once", async () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const model = new MockModel({ "system.echo": () => ({ echo: "x", language: "en" }) }, { batchRounds: 5, itemCost: { usage, costEur: 0.25 } });
    const { batchId } = await model.submitBatch(echoTask, [
      { customId: "a", input: { text: "x" } },
      { customId: "b", input: { text: "y" } },
    ]);
    expect((await model.listBatches({ from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) })).map((b) => b.batchId)).toEqual([batchId]);
    await model.cancelBatch(batchId);
    const collected = await model.collectBatch(echoTask, batchId);
    expect(collected).toMatchObject({ status: "ended", costEur: 0.5, usage: { inputTokens: 20, outputTokens: 10 } });
    expect(collected.results[0]).toMatchObject({ ok: true, costEur: 0.25 });
  });

  it("stays in progress for the configured rounds", async () => {
    const model = new MockModel({ "system.echo": () => ({ echo: "x", language: "en" }) }, { batchRounds: 1 });
    const { batchId } = await model.submitBatch(echoTask, [{ customId: "a", input: { text: "x" } }]);
    expect((await model.collectBatch(echoTask, batchId)).status).toBe("in_progress");
    expect((await model.collectBatch(echoTask, batchId)).status).toBe("ended");
  });
});

describe("recorded fixtures", () => {
  const dir = mkdtempSync(join(tmpdir(), "periplus-ai-fixtures-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fixtureKey ignores key order", () => {
    expect(fixtureKey("t", { a: 1, b: [2, { c: 3, d: 4 }] })).toBe(fixtureKey("t", { b: [2, { d: 4, c: 3 }], a: 1 }));
    expect(fixtureKey("t", { a: 1 })).not.toBe(fixtureKey("u", { a: 1 }));
  });

  it("MockModel.fromFixtures answers a recorded input and throws for an unknown one", async () => {
    const input = { text: "Kalimera" };
    const key = fixtureKey("system.echo", input);
    mkdirSync(join(dir, "system.echo"), { recursive: true });
    writeFileSync(
      join(dir, "system.echo", `${key}.json`),
      JSON.stringify({ task: "system.echo", key, input, output: { echo: "Kalimera", language: "el" }, model: "claude-haiku-5-5", recordedAt: "2026-10-19T00:00:00Z" }),
    );
    const model = MockModel.fromFixtures(dir);
    expect((await model.call(echoTask, input)).output).toEqual({ echo: "Kalimera", language: "el" });
    await expect(model.call(echoTask, { text: "unknown" })).rejects.toThrow(/No recorded answer/);
  });

  it("a fixture whose key does not match its input is rejected", () => {
    const stale = join(dir, "stale");
    const key = "0".repeat(64);
    mkdirSync(join(stale, "system.echo"), { recursive: true });
    writeFileSync(
      join(stale, "system.echo", `${key}.json`),
      JSON.stringify({ task: "system.echo", key, input: {}, output: {}, model: "m", recordedAt: "2026-10-19T00:00:00Z" }),
    );
    expect(() => MockModel.fromFixtures(stale)).toThrow(/stale key/);
  });
});

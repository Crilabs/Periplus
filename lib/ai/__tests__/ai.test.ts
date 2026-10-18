import { describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { externalCalls } from "@/lib/db/schema";
import { BudgetExceeded, recordExternalCall } from "@/lib/domain/costs";
import type { AppConfig } from "@/lib/config";
import { loadPrompt, renderPrompt } from "@/lib/ai/prompts";
import { MockModel } from "@/lib/ai/mock";
import { createAnthropicClient, type AnthropicMessagesApi } from "@/lib/ai/anthropic";
import { ModelOutputInvalid } from "@/lib/ai/types";
import { echoTask } from "@/lib/ai/tasks/system-echo";

const db = testDb();

const config: AppConfig = {
  queues: {},
  budgets: {
    anthropic: { dailyEur: 0.01 },
    voyage: { dailyEur: 1 },
    dataforseo: { dailyEur: 1 },
    firecrawl: { dailyEur: 1 },
    jina: { dailyEur: 1 },
  },
  models: {
    tasks: { "system.echo": { model: "claude-haiku-5-5", promptVersion: 1 } },
    pricesEurPerMTok: { "claude-haiku-5-5": { input: 0.1, output: 0.5 } },
  },
};

function fakeSdk(text: string, usage = { input_tokens: 1000, output_tokens: 200 }) {
  const create = vi.fn(async (params: unknown) => ({
    params,
    content: [{ type: "text" as const, text }],
    usage,
    stop_reason: "end_turn",
  }));
  return { api: { messages: { create } } as unknown as AnthropicMessagesApi, create };
}

function uniqueDay(): Date {
  const year = 2200 + Math.floor(Math.random() * 800);
  const month = Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return new Date(Date.UTC(year, month, day, 12));
}

describe("prompts", () => {
  it("renderPrompt throws on a missing variable", () => {
    expect(() => renderPrompt("Hi {{name}}", {})).toThrow(/name/);
  });

  it("renderPrompt replaces placeholders", () => {
    expect(renderPrompt("Hi {{name}}, {{name}}!", { name: "Ada" })).toBe("Hi Ada, Ada!");
  });

  it("loadPrompt reads system and user sections of system.echo v1", () => {
    const p = loadPrompt("system.echo", 1);
    expect(p.system.length).toBeGreaterThan(0);
    expect(p.user).toContain("{{text}}");
  });

  it("loadPrompt throws for an unknown version", () => {
    expect(() => loadPrompt("system.echo", 999)).toThrow(/system\.echo/);
  });
});

describe("MockModel", () => {
  it("validates output against the task schema", async () => {
    await expect(new MockModel({ "system.echo": () => ({ echo: 1 }) }).call(echoTask, { text: "x" })).rejects.toThrow();
  });

  it("returns parsed output with zero cost", async () => {
    const r = await new MockModel({ "system.echo": (i) => ({ echo: (i as { text: string }).text, language: "en" }) }).call(
      echoTask,
      { text: "hi" },
    );
    expect(r.output).toEqual({ echo: "hi", language: "en" });
    expect(r.costEur).toBe(0);
    expect(r.promptVersion).toBe(1);
  });

  it("throws when no response is registered for the task", async () => {
    await expect(new MockModel({}).call(echoTask, { text: "x" })).rejects.toThrow(/system\.echo/);
  });
});

describe("anthropic client", () => {
  it("refuses to call when the budget is exhausted", async () => {
    const now = uniqueDay();
    await recordExternalCall(db, { service: "anthropic", operation: "seed", units: 1, unit: "tokens", costEur: 0.02, at: now });
    const { api, create } = fakeSdk('{"echo":"x","language":"en"}');
    const client = createAnthropicClient(db, config, { sdk: api, now: () => now });
    await expect(client.call(echoTask, { text: "x" })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(create).not.toHaveBeenCalled();
  });

  it("records tokens and cost", async () => {
    const now = uniqueDay();
    const stage = `ai-test-${Math.random()}`;
    const { api, create } = fakeSdk('{"echo":"hello","language":"en"}');
    const client = createAnthropicClient(db, config, { sdk: api, now: () => now });
    const r = await client.call(echoTask, { text: "hello" }, { stage });
    const expected = (1000 / 1e6) * 0.1 + (200 / 1e6) * 0.5;
    expect(r.output).toEqual({ echo: "hello", language: "en" });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    expect(r.costEur).toBeCloseTo(expected, 10);
    const params = create.mock.calls[0]![0] as { model: string; output_config: { format: { type: string } } };
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.output_config.format.type).toBe("json_schema");
    const [row] = await db.select().from(externalCalls).where(eq(externalCalls.stage, stage)).orderBy(desc(externalCalls.at));
    expect(row).toMatchObject({ service: "anthropic", operation: "system.echo", unit: "tokens" });
    expect(Number(row!.units)).toBe(1200);
    expect(Number(row!.costEur)).toBeCloseTo(expected, 6);
  });

  it("throws ModelOutputInvalid for output violating the schema, still recording the spend", async () => {
    const now = uniqueDay();
    const stage = `ai-test-${Math.random()}`;
    const { api } = fakeSdk('{"echo":1}');
    const client = createAnthropicClient(db, config, { sdk: api, now: () => now });
    await expect(client.call(echoTask, { text: "x" }, { stage })).rejects.toBeInstanceOf(ModelOutputInvalid);
    const rows = await db.select().from(externalCalls).where(eq(externalCalls.stage, stage));
    expect(rows).toHaveLength(1);
  });

  it("throws a config error before calling when the model has no price", async () => {
    const { api, create } = fakeSdk("{}");
    const bad: AppConfig = { ...config, models: { ...config.models, pricesEurPerMTok: {} } };
    const client = createAnthropicClient(db, bad, { sdk: api });
    await expect(client.call(echoTask, { text: "x" })).rejects.toThrow(/claude-haiku-5-5/);
    expect(create).not.toHaveBeenCalled();
  });
});

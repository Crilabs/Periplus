import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { testDb, withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { externalCalls } from "@/lib/db/schema";
import { BudgetExceeded, recordExternalCall } from "@/lib/domain/costs";
import { loadConfig, type AppConfig } from "@/lib/config";
import { loadPrompt, renderPrompt } from "@/lib/ai/prompts";
import { MockModel } from "@/lib/ai/mock";
import { buildParams, createAnthropicClient, structuredOutputSchema, type AnthropicMessagesApi } from "@/lib/ai/anthropic";
import { ModelOutputInvalid, type ModelTask } from "@/lib/ai/types";
import { echoTask } from "@/lib/ai/tasks/system-echo";
import { pdfToMarkdownTask } from "@/lib/ai/tasks/pdf-to-markdown";
import { sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";

const db = testDb();

const config: AppConfig = {
  ...loadConfig("config"),
  queues: {},
  budgets: {
    anthropic: { dailyEur: 0.01 },
    dataforseo: { dailyEur: 1 },
    firecrawl: { dailyEur: 1 },
    jina: { dailyEur: 1 },
    openai: { dailyEur: 1 },
  },
  models: {
    tasks: {
      "system.echo": { model: "claude-haiku-5-5", promptVersion: 1, effort: "low", maxTokens: 1024, cacheSystem: false },
      "pdf.to_markdown": { model: "claude-haiku-5-5", promptVersion: 1, effort: "low", maxTokens: 16000, cacheSystem: false },
    },
    pricesEurPerMTok: { "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheReadFactor: 0.1 } },
    imageTasks: {},
    pricesEurPerImage: {},
    cacheWriteFactor: 1.25,
    callTimeoutSeconds: 600,
    batch: { discount: 0.5, pollSeconds: 60, maxHours: 26, maxRequests: 1000, providerTimeoutSeconds: 120, leaseSeconds: 600, clockSkewSeconds: 120, reservationHours: 48, budgetRetrySeconds: 900 },
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

describe("model config", () => {
  it("gives the pdf page transcription room for a full page", () => {
    expect(loadConfig("config").models.tasks["pdf.to_markdown"]!.maxTokens).toBeGreaterThanOrEqual(16000);
  });
});

describe("anthropic client", () => {
  // Budget checks sum a whole day: each test writes inside a rollback transaction on a day nothing else spent on.
  it("refuses to call when the budget is exhausted", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      await recordExternalCall(tx, { service: "anthropic", operation: "seed", units: 1, unit: "tokens", costEur: 0.02, at: now });
      const { api, create } = fakeSdk('{"echo":"x","language":"en"}');
      const client = createAnthropicClient(tx, config, { sdk: api, now: () => now });
      await expect(client.call(echoTask, { text: "x" })).rejects.toBeInstanceOf(BudgetExceeded);
      expect(create).not.toHaveBeenCalled();
    }));

  it("calls without SDK retries; a failed attempt is on record at 0 EUR with its reason (SEC-2)", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const stage = `ai-test-${newId()}`;
      const create = vi.fn(async () => {
        throw new Error("Request timed out.");
      });
      const api = { messages: { create } } as unknown as AnthropicMessagesApi;
      const client = createAnthropicClient(tx, { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 1 } } }, { sdk: api, now: () => now });
      await expect(client.call(echoTask, { text: "x" }, { stage })).rejects.toThrow("Request timed out.");
      const rows = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ service: "anthropic", operation: "system.echo", unit: "tokens", meta: expect.objectContaining({ error: "Request timed out." }) });
      expect(Number(rows[0]!.costEur)).toBe(0);
      expect(create).toHaveBeenCalledWith(expect.anything(), { maxRetries: 0, timeout: 600_000 });
      // a task with its own timeoutSeconds (the watermark check inside an image job) gets that instead of callTimeoutSeconds
      const shortEcho = { ...config, models: { ...config.models, tasks: { ...config.models.tasks, "system.echo": { ...config.models.tasks["system.echo"]!, timeoutSeconds: 60 } } } };
      await expect(createAnthropicClient(tx, shortEcho, { sdk: api, now: () => now }).call(echoTask, { text: "x" }, { stage })).rejects.toThrow("Request timed out.");
      expect(create).toHaveBeenLastCalledWith(expect.anything(), { maxRetries: 0, timeout: 60_000 });
    }));

  it("never builds the real SDK under test (OPS-7)", () =>
    withRollback(async (tx) => {
      const client = createAnthropicClient(tx, { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 1000 } } });
      await expect(client.call(echoTask, { text: "x" })).rejects.toThrow(/no Anthropic SDK under test/);
    }));

  it("records tokens and cost", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const stage = `ai-test-${Math.random()}`;
      const { api, create } = fakeSdk('{"echo":"hello","language":"en"}');
      const client = createAnthropicClient(tx, config, { sdk: api, now: () => now });
      const r = await client.call(echoTask, { text: "hello" }, { stage });
      const expected = (1000 / 1e6) * 0.1 + (200 / 1e6) * 0.5;
      expect(r.output).toEqual({ echo: "hello", language: "en" });
      expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
      expect(r.costEur).toBeCloseTo(expected, 10);
      const params = create.mock.calls[0]![0] as { model: string; max_tokens: number; output_config: { format: { type: string } } };
      expect(params.model).toBe("claude-haiku-5-5");
      expect(params.max_tokens).toBe(1024);
      expect(params.output_config.format.type).toBe("json_schema");
      const [row] = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage)).orderBy(desc(externalCalls.at));
      expect(row).toMatchObject({ service: "anthropic", operation: "system.echo", unit: "tokens" });
      expect(Number(row!.units)).toBe(1200);
      expect(Number(row!.costEur)).toBeCloseTo(expected, 6);
    }));

  it("throws ModelOutputInvalid for output violating the schema, still recording the spend", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const stage = `ai-test-${Math.random()}`;
      const { api } = fakeSdk('{"echo":1}');
      const client = createAnthropicClient(tx, config, { sdk: api, now: () => now });
      await expect(client.call(echoTask, { text: "x" }, { stage })).rejects.toBeInstanceOf(ModelOutputInvalid);
      const rows = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
      expect(rows).toHaveLength(1);
    }));

  it("attachments are sent as document blocks", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const { api, create } = fakeSdk('{"markdown":"# Seite"}');
      const client = createAnthropicClient(tx, config, { sdk: api, now: () => now });
      const pdf = new Uint8Array([37, 80, 68, 70]);
      const r = await client.call(pdfToMarkdownTask, { pdf, page: 3 });
      expect(r.output).toEqual({ markdown: "# Seite" });
      const params = create.mock.calls[0]![0] as { messages: Array<{ content: Array<Record<string, unknown>> }> };
      const content = params.messages[0]!.content;
      expect(content[0]!.type).toBe("document");
      expect(content[0]!.source).toEqual({ type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") });
      expect(content[1]).toMatchObject({ type: "text" });
      expect(content[1]!.text).toContain("3");
    }));

  it("a call without attachments sends the prompt as plain text", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const { api, create } = fakeSdk('{"echo":"x","language":"en"}');
      await createAnthropicClient(tx, config, { sdk: api, now: () => now }).call(echoTask, { text: "x" });
      const params = create.mock.calls[0]![0] as { messages: Array<{ content: unknown }> };
      expect(typeof params.messages[0]!.content).toBe("string");
    }));

  it("records the source of a call", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const stage = `ai-test-${Math.random()}`;
      const [source] = await tx
        .insert(sources)
        .values({
          domain: `${newId()}.test.invalid`,
          name: "AI test",
          type: "forum",
          weight: 0.4,
          status: "paused",
          crawlRules: DEFAULT_CRAWL_RULES,
          origin: "serp",
        })
        .returning({ id: sources.id });
      const { api } = fakeSdk('{"echo":"x","language":"en"}');
      await createAnthropicClient(tx, config, { sdk: api, now: () => now }).call(echoTask, { text: "x" }, { stage, sourceId: source!.id });
      const [row] = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
      expect(row!.sourceId).toBe(source!.id);
    }));

  it("throws a config error before calling when the model has no price", async () => {
    const { api, create } = fakeSdk("{}");
    const bad: AppConfig = { ...config, models: { ...config.models, pricesEurPerMTok: {} } };
    const client = createAnthropicClient(db, bad, { sdk: api });
    await expect(client.call(echoTask, { text: "x" })).rejects.toThrow(/claude-haiku-5-5/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("structured output schema (ruling M4-D-R1)", () => {
  type Constrained = { echo: string; language: string; on: string; tags: string[]; score: number; format: string | null };
  /** `system.echo` with limits structured outputs reject; a property named `format` must survive. */
  const constrainedTask: ModelTask<{ text: string }, Constrained> = {
    name: "system.echo",
    output: z.object({
      echo: z.string().max(3),
      language: z.string().regex(/^[a-z]{2}$/),
      on: z.iso.date(),
      tags: z.array(z.string().min(1)).max(2),
      score: z.number().min(0).max(1),
      format: z.string().nullable(),
    }),
    variables: echoTask.variables,
  };
  const KEYWORDS = /"(maxLength|minLength|pattern|format|minimum|maximum|maxItems|minItems|exclusiveMinimum|exclusiveMaximum|multipleOf)":[^{]/;

  it("strips unsupported keywords at every level but keeps property names", () => {
    const schema = structuredOutputSchema(z.toJSONSchema(constrainedTask.output)) as { properties: Record<string, unknown>; required: string[] };
    const json = JSON.stringify(schema);
    expect(json).not.toMatch(KEYWORDS);
    expect(Object.keys(schema.properties)).toEqual(["echo", "language", "on", "tags", "score", "format"]);
    expect(schema.required).toContain("format");
    expect(schema.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("strips constraints inside unions and $defs; additionalProperties other than false is refused", () => {
    const code = z.object({ code: z.string().max(3).regex(/^[A-Z]+$/) });
    const nested = z.object({ maybe: z.string().max(3).nullable(), a: code, b: code, list: z.array(z.number().min(0)).max(2).nullable() });
    const schema = z.toJSONSchema(nested, { reused: "ref" }) as { $defs?: Record<string, unknown> };
    expect(Object.keys(schema.$defs ?? {}).length).toBeGreaterThan(0);
    const stripped = structuredOutputSchema(schema) as {
      properties: { maybe: unknown; list: unknown };
      $defs: Record<string, { properties?: { code?: unknown } }>;
    };
    expect(JSON.stringify(stripped)).not.toMatch(KEYWORDS);
    expect(stripped.properties.maybe).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(stripped.properties.list).toMatchObject({ anyOf: [{ type: "array" }, { type: "null" }] });
    expect(Object.values(stripped.$defs).find((d) => d.properties?.code)!.properties!.code).toEqual({ type: "string" });
    expect(() => structuredOutputSchema(z.toJSONSchema(z.object({ r: z.record(z.string(), z.number()) })))).toThrow(
      /#\/properties\/r allows other properties/,
    );
    expect(() => structuredOutputSchema(z.toJSONSchema(z.looseObject({ x: z.string() })))).toThrow(/additionalProperties false/);
  });

  it("the batch and sync params send the stripped schema; the answer is checked against the full one", () =>
    withRollback(async (tx) => {
      const params = buildParams(constrainedTask, { text: "x" }, config.models.tasks["system.echo"]!, "claude-haiku-5-5");
      expect(JSON.stringify(params.output_config)).not.toMatch(KEYWORDS);
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const ok = { echo: "abc", language: "en", on: "2026-10-19", tags: ["a"], score: 0.5, format: null };
      const { api, create } = fakeSdk(JSON.stringify(ok));
      const client = createAnthropicClient(tx, { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 1000 } } }, { sdk: api, now: () => now });
      expect((await client.call(constrainedTask, { text: "x" })).output).toEqual(ok);
      expect(JSON.stringify((create.mock.calls[0]![0] as { output_config: unknown }).output_config)).not.toMatch(KEYWORDS);
      for (const bad of [{ ...ok, echo: "abcd" }, { ...ok, language: "EN" }, { ...ok, on: "2026-13-01" }, { ...ok, tags: ["a", "b", "c"] }, { ...ok, score: 2 }]) {
        const { api: badApi } = fakeSdk(JSON.stringify(bad));
        const badClient = createAnthropicClient(tx, { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: 1000 } } }, { sdk: badApi, now: () => now });
        await expect(badClient.call(constrainedTask, { text: "x" })).rejects.toBeInstanceOf(ModelOutputInvalid);
      }
    }));
});

describe("anthropic client options", () => {
  it("ctx.model overrides the configured model and cache tokens are booked", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const stage = `ai-test-${Math.random()}`;
      const withSonnet: AppConfig = {
        ...config,
        budgets: { ...config.budgets, anthropic: { dailyEur: 100 } },
        models: {
          ...config.models,
          pricesEurPerMTok: { ...config.models.pricesEurPerMTok, "claude-sonnet-5-5": { input: 2, output: 10, cacheReadFactor: 0.1 } },
        },
      };
      const { api, create } = fakeSdk('{"echo":"x","language":"en"}', {
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 1000,
      } as { input_tokens: number; output_tokens: number });
      const r = await createAnthropicClient(tx, withSonnet, { sdk: api, now: () => now }).call(
        echoTask,
        { text: "x" },
        { stage, model: "claude-sonnet-5-5" },
      );
      expect(r.model).toBe("claude-sonnet-5-5");
      expect((create.mock.calls[0]![0] as { model: string }).model).toBe("claude-sonnet-5-5");
      expect(r.costEur).toBeCloseTo((1000 * 2 + 1000 * 2 * 1.25 + 1000 * 2 * 0.1) / 1e6, 10);
      const [row] = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
      expect(Number(row!.units)).toBe(3000);
      expect(row!.meta).toMatchObject({ cacheRead: 1000, cacheWrite: 1000 });
    }));
});

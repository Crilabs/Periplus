import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { getConfig, type AppConfig, type ModelTaskConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { assertWithinBudget, recordExternalCall, reservedBatchEur } from "@/lib/domain/costs";
import { createLogger } from "@/lib/logger";
import { resolveTaskModel, usageCostEur } from "./cost";
import { loadPrompt, renderPrompt } from "./prompts";
import {
  addUsage,
  ModelOutputInvalid,
  totalTokens,
  ZERO_USAGE,
  type BatchItemResult,
  type BatchRequest,
  type CollectedBatch,
  type ModelCallContext,
  type ModelClient,
  type ModelResult,
  type ModelTask,
  type ModelUsage,
  type ProviderBatch,
  type SubmittedBatch,
} from "./types";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("ai.anthropic"));

/** The slice of the Anthropic SDK this client uses; tests inject a fake. */
export type AnthropicMessagesApi = Pick<Anthropic, "messages">;

export type AnthropicClientOptions = {
  sdk?: AnthropicMessagesApi;
  now?: () => Date;
};

function defaultSdk(): AnthropicMessagesApi {
  // Tests never reach the provider (AI only through MockModel or an injected SDK), like the HTTP transports.
  if (getEnv().NODE_ENV === "test") throw new Error("no Anthropic SDK under test: inject one (options.sdk) or use MockModel");
  const apiKey = getEnv().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

/**
 * JSON-Schema keywords structured outputs do not support (numerical, string and complex array constraints, formats
 * and patterns; ruling M4-D-R1). They are removed from the schema sent to the provider; the answer is still checked
 * against the full zod schema when it arrives.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
]);
/** Keywords whose value is a map of names to subschemas (the names are data, never keywords). */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);

/**
 * A JSON schema without the keywords structured outputs reject, at every level (property names stay untouched).
 * `additionalProperties` other than `false` (a `z.record` or a loose object) cannot be expressed in structured outputs
 * at all; such a task schema is a programming error and throws here, before anything is sent.
 */
export function structuredOutputSchema(schema: unknown, path = "#"): unknown {
  if (Array.isArray(schema)) return schema.map((s, i) => structuredOutputSchema(s, `${path}/${i}`));
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === "additionalProperties" && value !== false) {
      throw new Error(`structured outputs need additionalProperties false; ${path} allows other properties (z.record or a loose object)`);
    }
    if (SCHEMA_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, structuredOutputSchema(sub, `${path}/${key}/${name}`)]));
    } else if (key === "enum" || key === "const" || key === "required" || key === "default" || key === "examples") {
      out[key] = value;
    } else {
      out[key] = structuredOutputSchema(value, `${path}/${key}`);
    }
  }
  return out;
}

/**
 * The Messages API parameters of one request, shared by `call` and batches: the rendered system prompt (marked for
 * prompt caching when the task sets `cacheSystem`), the user prompt after any attachments, the configured effort,
 * the JSON schema of the output (without unsupported keywords, `structuredOutputSchema`) and `max_tokens`.
 */
export function buildParams<I, O>(
  task: ModelTask<I, O>,
  input: I,
  taskConfig: ModelTaskConfig,
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const prompt = loadPrompt(task.name, taskConfig.promptVersion);
  const vars = task.variables(input);
  const systemText = renderPrompt(prompt.system, vars);
  const user = renderPrompt(prompt.user, vars);
  const attachments = task.attachments?.(input) ?? [];
  // Files go before the text that refers to them; without files the prompt stays a plain string.
  const content: Anthropic.MessageParam["content"] =
    attachments.length === 0
      ? user
      : [
          ...attachments.map((a) =>
            a.kind === "image"
              ? { type: "image" as const, source: { type: "base64" as const, media_type: a.mediaType, data: Buffer.from(a.data).toString("base64") } }
              : {
                  type: "document" as const,
                  source: { type: "base64" as const, media_type: "application/pdf" as const, data: Buffer.from(a.data).toString("base64") },
                },
          ),
          { type: "text" as const, text: user },
        ];
  const system: Anthropic.MessageCreateParamsNonStreaming["system"] = taskConfig.cacheSystem
    ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
    : systemText;
  return {
    model,
    max_tokens: taskConfig.maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: taskConfig.effort, format: { type: "json_schema", schema: structuredOutputSchema(z.toJSONSchema(task.output)) as Record<string, unknown> } },
  };
}

function usageOf(usage: Anthropic.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** The validated output of a finished message, or why it is unusable. */
function parseMessage<O>(
  task: ModelTask<unknown, O>,
  message: Anthropic.Message,
): { ok: true; output: O } | { ok: false; error: string; cause?: unknown } {
  if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
    return { ok: false, error: `stop_reason ${message.stop_reason}` };
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: "response is not valid JSON", cause: error };
  }
  const parsed = task.output.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message, cause: parsed.error };
  return { ok: true, output: parsed.data };
}

/** One batch result: an `invalid_request` error cannot succeed on a resend; anything else (overload, expiry) can. */
function batchItemResult<O>(
  task: ModelTask<unknown, O>,
  line: Anthropic.Messages.MessageBatchIndividualResponse,
  price: ReturnType<typeof resolveTaskModel>["price"],
  config: AppConfig,
): BatchItemResult<O> {
  const customId = line.custom_id;
  const result = line.result;
  switch (result.type) {
    case "succeeded": {
      const usage = usageOf(result.message.usage);
      const costEur = usageCostEur(usage, price, config.models.cacheWriteFactor, config.models.batch.discount);
      const parsed = parseMessage(task, result.message);
      // A cut-off, refused or schema-violating answer is billed and may succeed on a second try (ruling M4-P7).
      if (!parsed.ok) return { customId, ok: false, error: parsed.error, retryable: true, usage, costEur };
      return { customId, ok: true, output: parsed.output, usage, costEur };
    }
    case "errored": {
      const error = result.error.error;
      return { customId, ok: false, error: `${error.type}: ${error.message}`, retryable: error.type !== "invalid_request_error" };
    }
    case "expired":
    case "canceled":
      return { customId, ok: false, error: result.type, retryable: true };
  }
}

export function createAnthropicClient(db: Db, config: AppConfig = getConfig(), options: AnthropicClientOptions = {}): ModelClient {
  let sdk = options.sdk;
  // Every provider request goes through here.
  const getSdk = () => (sdk ??= defaultSdk());
  const timeout = config.models.batch.providerTimeoutSeconds * 1000;
  const callTimeout = config.models.callTimeoutSeconds * 1000;

  return {
    async call<I, O>(task: ModelTask<I, O>, input: I, ctx?: ModelCallContext): Promise<ModelResult<O>> {
      const { taskConfig, model, price } = resolveTaskModel(config, task.name, ctx?.model, ctx?.promptVersion);
      const { promptVersion } = taskConfig;
      const params = buildParams(task, input, taskConfig, model);

      // Open message batches have promised part of the budget already (ruling M4-C-R5).
      const now = options.now?.() ?? new Date();
      const reserved = await reservedBatchEur(db, { now, hours: config.models.batch.reservationHours });
      await assertWithinBudget(db, "anthropic", config.budgets, now, reserved);

      const messages = getSdk().messages;
      let response: Awaited<ReturnType<typeof messages.create>>;
      try {
        // No SDK retry (SEC-2): a resent request after a timeout or a lost connection may be billed again without a
        // booking. The job retry resends instead, after a new budget check.
        response = await messages.create(params, { maxRetries: 0, timeout: taskConfig.timeoutSeconds === undefined ? callTimeout : taskConfig.timeoutSeconds * 1000 });
      } catch (error) {
        // The attempt may still have been billed: on record at 0 EUR with the reason, as `httpCall` does.
        await recordExternalCall(db, {
          service: "anthropic",
          operation: task.name,
          units: 0,
          unit: "tokens",
          costEur: 0,
          runId: ctx?.runId,
          stage: ctx?.stage,
          sourceId: ctx?.sourceId,
          meta: { model, promptVersion, error: (error as Error).message },
          ...(options.now ? { at: options.now() } : {}),
        }).catch((recordError: unknown) => getLog().error({ err: recordError, task: task.name }, "recording failed model call failed"));
        throw error;
      }

      const usage = usageOf(response.usage);
      const { inputTokens, outputTokens } = usage;
      const costEur = usageCostEur(usage, price, config.models.cacheWriteFactor);
      await recordExternalCall(db, {
        service: "anthropic",
        operation: task.name,
        units: totalTokens(usage),
        unit: "tokens",
        costEur,
        runId: ctx?.runId,
        stage: ctx?.stage,
        sourceId: ctx?.sourceId,
        meta: {
          model,
          promptVersion,
          inputTokens,
          outputTokens,
          cacheRead: usage.cacheReadTokens,
          cacheWrite: usage.cacheWriteTokens,
        },
        ...(options.now ? { at: options.now() } : {}),
      });
      getLog().debug({ task: task.name, model, inputTokens, outputTokens, costEur }, "model call finished");

      const parsed = parseMessage(task as ModelTask<unknown, O>, response);
      if (!parsed.ok) throw new ModelOutputInvalid(task.name, parsed.error, { cause: parsed.cause });
      return { output: parsed.output, model, promptVersion, usage: { inputTokens, outputTokens }, costEur };
    },

    async submitBatch<I, O>(task: ModelTask<I, O>, requests: BatchRequest<I>[], ctx?: ModelCallContext): Promise<SubmittedBatch> {
      if (requests.length === 0) throw new Error(`Batch of task ${task.name} has no requests`);
      const { taskConfig, model } = resolveTaskModel(config, task.name, ctx?.model, ctx?.promptVersion);
      const batchRequests = requests.map((r) => ({ custom_id: r.customId, params: buildParams(task, r.input, taskConfig, model) }));

      // Booked spend only: the caller has reserved this batch's estimate already (ruling M4-P6).
      await assertWithinBudget(db, "anthropic", config.budgets, options.now?.());

      // No SDK retry: the API has no idempotency key, so a retried create after a lost response starts a second,
      // paid batch. The job retry resends, after checking the provider's batch list (ruling M4-C-R6).
      const batch = await getSdk().messages.batches.create({ requests: batchRequests }, { maxRetries: 0, timeout });
      getLog().info({ task: task.name, model, batchId: batch.id, requests: requests.length, runId: ctx?.runId }, "batch submitted");
      return { batchId: batch.id, model, promptVersion: taskConfig.promptVersion };
    },

    async collectBatch<I, O>(task: ModelTask<I, O>, batchId: string, ctx?: ModelCallContext): Promise<CollectedBatch<O>> {
      const { price } = resolveTaskModel(config, task.name, ctx?.model);
      const batch = await getSdk().messages.batches.retrieve(batchId, null, { timeout });
      if (batch.processing_status !== "ended") return { status: "in_progress", results: [], usage: ZERO_USAGE, costEur: 0 };

      const results: BatchItemResult<O>[] = [];
      let usage = ZERO_USAGE;
      let costEur = 0;
      for await (const line of await getSdk().messages.batches.results(batchId)) {
        const item = batchItemResult(task as ModelTask<unknown, O>, line, price, config);
        if (item.usage) usage = addUsage(usage, item.usage);
        costEur += item.costEur ?? 0;
        results.push(item);
      }
      return { status: "ended", results, usage, costEur };
    },

    async cancelBatch(batchId: string): Promise<void> {
      await getSdk().messages.batches.cancel(batchId, null, { timeout });
      getLog().info({ batchId }, "batch cancel requested");
    },

    async listBatches(window: { from: Date; to: Date }): Promise<ProviderBatch[]> {
      const found: ProviderBatch[] = [];
      // Newest first: stop at the first batch created before the window.
      for await (const batch of getSdk().messages.batches.list({ limit: 100 }, { timeout })) {
        const createdAt = new Date(batch.created_at);
        if (createdAt < window.from) break;
        if (createdAt > window.to) continue;
        const requestCount = Object.values(batch.request_counts).reduce((sum, n) => sum + n, 0);
        found.push({ batchId: batch.id, createdAt, requestCount });
      }
      return found;
    },
  };
}

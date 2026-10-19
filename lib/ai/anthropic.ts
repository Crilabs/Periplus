import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { getConfig, type AppConfig, type ModelTaskConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { assertWithinBudget, recordExternalCall } from "@/lib/domain/costs";
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
  const apiKey = getEnv().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

/**
 * The Messages API parameters of one request, shared by `call` and batches: the rendered system prompt (marked for
 * prompt caching when the task sets `cacheSystem`), the user prompt after any attachments, the configured effort,
 * the JSON schema of the output and `max_tokens`.
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
          ...attachments.map((a) => ({
            type: "document" as const,
            source: { type: "base64" as const, media_type: "application/pdf" as const, data: Buffer.from(a.data).toString("base64") },
          })),
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
    output_config: { effort: taskConfig.effort, format: { type: "json_schema", schema: z.toJSONSchema(task.output) } },
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
  const getSdk = () => (sdk ??= defaultSdk());

  return {
    async call<I, O>(task: ModelTask<I, O>, input: I, ctx?: ModelCallContext): Promise<ModelResult<O>> {
      const { taskConfig, model, price } = resolveTaskModel(config, task.name, ctx?.model);
      const { promptVersion } = taskConfig;
      const params = buildParams(task, input, taskConfig, model);

      await assertWithinBudget(db, "anthropic", config.budgets, options.now?.());

      const response = await getSdk().messages.create(params);

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
      const { taskConfig, model } = resolveTaskModel(config, task.name, ctx?.model);
      const batchRequests = requests.map((r) => ({ custom_id: r.customId, params: buildParams(task, r.input, taskConfig, model) }));

      await assertWithinBudget(db, "anthropic", config.budgets, options.now?.());

      const batch = await getSdk().messages.batches.create({ requests: batchRequests });
      getLog().info({ task: task.name, model, batchId: batch.id, requests: requests.length, runId: ctx?.runId }, "batch submitted");
      return { batchId: batch.id, model, promptVersion: taskConfig.promptVersion };
    },

    async collectBatch<I, O>(task: ModelTask<I, O>, batchId: string, ctx?: ModelCallContext): Promise<CollectedBatch<O>> {
      const { price } = resolveTaskModel(config, task.name, ctx?.model);
      const batch = await getSdk().messages.batches.retrieve(batchId);
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
  };
}

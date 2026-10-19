import type { z } from "zod";

/** A file sent with the prompt (before its text); `pdf` becomes an Anthropic `document` block. */
export type ModelAttachment = { kind: "pdf"; data: Uint8Array };

export type ModelTask<I, O> = {
  name: string;
  output: z.ZodType<O>;
  variables(input: I): Record<string, string>;
  attachments?(input: I): ModelAttachment[];
};

/**
 * Bookkeeping of a model call (the `external_calls` row gets `runId`, `stage`, `sourceId`) and an optional model
 * that replaces the configured one of the task (model comparison, ruling M4-P8), and likewise a prompt version (an
 * extraction run keeps the one it was planned with, ruling M4-G-R3).
 */
export type ModelCallContext = { runId?: string; stage?: string; sourceId?: string; model?: string; promptVersion?: number };

/** Tokens of one answer; the cache counts are billed apart from `inputTokens` (ruling M4-P5). */
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ModelResult<O> = {
  output: O;
  model: string;
  promptVersion: number;
  usage: { inputTokens: number; outputTokens: number };
  costEur: number;
};

/** One request of a message batch; `customId` comes back with its result (`ai_batch_items.id`). */
export type BatchRequest<I> = { customId: string; input: I };

/**
 * The result of one batch request. A failure carries the usage and cost when the answer was billed (an answer
 * that violates the schema or was cut off); `retryable` says whether sending it again can help.
 */
export type BatchItemResult<O> =
  | { customId: string; ok: true; output: O; usage: ModelUsage; costEur: number }
  | { customId: string; ok: false; error: string; retryable: boolean; usage?: ModelUsage; costEur?: number };

export type SubmittedBatch = { batchId: string; model: string; promptVersion: number };

/**
 * `in_progress` while the provider still works on the batch (results empty); `ended` with one result per request,
 * the summed usage and the summed cost (batch discount applied). Collecting books nothing: the caller writes the
 * `external_calls` row together with its own state change (ruling M4-P4).
 */
export type CollectedBatch<O> = {
  status: "in_progress" | "ended";
  results: BatchItemResult<O>[];
  usage: ModelUsage;
  costEur: number;
};

/** A message batch as the provider lists it: no metadata, only when it was created and how many requests it has. */
export type ProviderBatch = { batchId: string; createdAt: Date; requestCount: number };

export interface ModelClient {
  call<I, O>(task: ModelTask<I, O>, input: I, ctx?: ModelCallContext): Promise<ModelResult<O>>;
  /**
   * Sends one request per item as a provider message batch, exactly once: no client-side retry, a bounded timeout (a
   * retried create could start a second, paid batch). Checks the booked spend first.
   */
  submitBatch<I, O>(task: ModelTask<I, O>, requests: BatchRequest<I>[], ctx?: ModelCallContext): Promise<SubmittedBatch>;
  /** Reads the state and, once ended, the results of a batch, keyed by `customId` (never by position). */
  collectBatch<I, O>(task: ModelTask<I, O>, batchId: string, ctx?: ModelCallContext): Promise<CollectedBatch<O>>;
  /** Asks the provider to stop a batch; requests it already answered stay billed and come back with the results. */
  cancelBatch(batchId: string): Promise<void>;
  /** The provider's batches created in [from, to], to find one whose submit outcome is unknown (ruling M4-C-R6). */
  listBatches(window: { from: Date; to: Date }): Promise<ProviderBatch[]>;
}

export const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** All billed tokens of a usage (`external_calls.units`). */
export function totalTokens(u: ModelUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export class ModelOutputInvalid extends Error {
  constructor(
    readonly task: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Model output for task ${task} is invalid: ${detail}`, options);
    this.name = "ModelOutputInvalid";
  }
}

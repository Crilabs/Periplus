import type { z } from "zod";

/** A file sent with the prompt (before its text); `pdf` becomes an Anthropic `document` block. */
export type ModelAttachment = { kind: "pdf"; data: Uint8Array };

export type ModelTask<I, O> = {
  name: string;
  output: z.ZodType<O>;
  variables(input: I): Record<string, string>;
  attachments?(input: I): ModelAttachment[];
};

/** Bookkeeping of a model call: the `external_calls` row gets these. */
export type ModelCallContext = { runId?: string; stage?: string; sourceId?: string };

export type ModelResult<O> = {
  output: O;
  model: string;
  promptVersion: number;
  usage: { inputTokens: number; outputTokens: number };
  costEur: number;
};

export interface ModelClient {
  call<I, O>(task: ModelTask<I, O>, input: I, ctx?: ModelCallContext): Promise<ModelResult<O>>;
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

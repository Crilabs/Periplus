import type { z } from "zod";

export type ModelTask<I, O> = {
  name: string;
  output: z.ZodType<O>;
  variables(input: I): Record<string, string>;
};

export type ModelResult<O> = {
  output: O;
  model: string;
  promptVersion: number;
  usage: { inputTokens: number; outputTokens: number };
  costEur: number;
};

export interface ModelClient {
  call<I, O>(task: ModelTask<I, O>, input: I, ctx?: { runId?: string; stage?: string }): Promise<ModelResult<O>>;
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

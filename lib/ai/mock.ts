import { getConfig } from "@/lib/config";
import { loadAiFixtures } from "./fixtures";
import type {
  BatchItemResult,
  BatchRequest,
  CollectedBatch,
  ModelCallContext,
  ModelClient,
  ModelResult,
  ModelTask,
  SubmittedBatch,
} from "./types";
import { ModelOutputInvalid, ZERO_USAGE } from "./types";

/** Thrown by a registered response to make that batch item fail; `retryable` as the provider would report it. */
export class MockBatchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MockBatchError";
  }
}

export type MockModelOptions = {
  /** How many `collectBatch` calls per batch answer `in_progress` before it ends (default 0: ends at once). */
  batchRounds?: number;
};

type MockBatch = { task: string; requests: BatchRequest<unknown>[]; polls: number };

/** Test double: answers from registered per-task functions, validates against the task schema, costs nothing. */
export class MockModel implements ModelClient {
  private readonly batches = new Map<string, MockBatch>();
  private batchCount = 0;

  constructor(
    private readonly responses: Record<string, (input: unknown) => unknown>,
    private readonly options: MockModelOptions = {},
  ) {}

  /** Answers from the recorded fixtures below `dir` (default `test/fixtures/ai`); an unrecorded input throws. */
  static fromFixtures(dir?: string, options?: MockModelOptions): MockModel {
    return new MockModel(loadAiFixtures(dir), options);
  }

  /** The requests of a submitted batch, for assertions. */
  batchRequests(batchId: string): BatchRequest<unknown>[] | undefined {
    return this.batches.get(batchId)?.requests;
  }

  private respond(taskName: string): (input: unknown) => unknown {
    const respond = this.responses[taskName];
    if (!respond) throw new Error(`MockModel has no response for task ${taskName}`);
    return respond;
  }

  private meta(taskName: string, ctx?: ModelCallContext): { model: string; promptVersion: number } {
    const cfg = getConfig().models.tasks[taskName];
    return { model: ctx?.model ?? cfg?.model ?? "mock", promptVersion: cfg?.promptVersion ?? 1 };
  }

  async call<I, O>(task: ModelTask<I, O>, input: I, ctx?: ModelCallContext): Promise<ModelResult<O>> {
    const parsed = task.output.safeParse(this.respond(task.name)(input));
    if (!parsed.success) throw new ModelOutputInvalid(task.name, parsed.error.message, { cause: parsed.error });
    return { output: parsed.data, ...this.meta(task.name, ctx), usage: { inputTokens: 0, outputTokens: 0 }, costEur: 0 };
  }

  async submitBatch<I, O>(task: ModelTask<I, O>, requests: BatchRequest<I>[], ctx?: ModelCallContext): Promise<SubmittedBatch> {
    this.respond(task.name);
    const batchId = `mock-batch-${++this.batchCount}`;
    this.batches.set(batchId, { task: task.name, requests: requests as BatchRequest<unknown>[], polls: 0 });
    return { batchId, ...this.meta(task.name, ctx) };
  }

  async collectBatch<I, O>(task: ModelTask<I, O>, batchId: string): Promise<CollectedBatch<O>> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.task !== task.name) throw new Error(`MockModel knows no batch ${batchId} of task ${task.name}`);
    if (batch.polls++ < (this.options.batchRounds ?? 0)) return { status: "in_progress", results: [], usage: ZERO_USAGE, costEur: 0 };
    const respond = this.respond(task.name);
    const results = batch.requests.map(({ customId, input }): BatchItemResult<O> => {
      let answer: unknown;
      try {
        answer = respond(input);
      } catch (error) {
        if (error instanceof MockBatchError) return { customId, ok: false, error: error.message, retryable: error.retryable };
        return { customId, ok: false, error: (error as Error).message, retryable: false };
      }
      const parsed = task.output.safeParse(answer);
      if (!parsed.success) return { customId, ok: false, error: parsed.error.message, retryable: true };
      return { customId, ok: true, output: parsed.data, usage: ZERO_USAGE, costEur: 0 };
    });
    return { status: "ended", results, usage: ZERO_USAGE, costEur: 0 };
  }
}

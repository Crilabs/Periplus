import { getConfig } from "@/lib/config";
import type { ModelClient, ModelResult, ModelTask } from "./types";
import { ModelOutputInvalid } from "./types";

/** Test double: answers from registered per-task functions, validates against the task schema, costs nothing. */
export class MockModel implements ModelClient {
  constructor(private readonly responses: Record<string, (input: unknown) => unknown>) {}

  async call<I, O>(task: ModelTask<I, O>, input: I): Promise<ModelResult<O>> {
    const respond = this.responses[task.name];
    if (!respond) throw new Error(`MockModel has no response for task ${task.name}`);
    const parsed = task.output.safeParse(respond(input));
    if (!parsed.success) throw new ModelOutputInvalid(task.name, parsed.error.message, { cause: parsed.error });
    const cfg = getConfig().models.tasks[task.name];
    return {
      output: parsed.data,
      model: cfg?.model ?? "mock",
      promptVersion: cfg?.promptVersion ?? 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      costEur: 0,
    };
  }
}

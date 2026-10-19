import type { AppConfig, ModelTaskConfig } from "@/lib/config";
import { loadPrompt, renderPrompt } from "./prompts";
import type { ModelTask, ModelUsage } from "./types";

export type ModelPrice = AppConfig["models"]["pricesEurPerMTok"][string];

/**
 * The configuration of a task and the model it runs on (`override` replaces the configured model, `promptVersion` the
 * configured prompt version).
 */
export function resolveTaskModel(
  config: AppConfig,
  taskName: string,
  override?: string,
  promptVersion?: number,
): { taskConfig: ModelTaskConfig; model: string; price: ModelPrice } {
  const configured = config.models.tasks[taskName];
  if (!configured) throw new Error(`No model configured for task ${taskName} in config/models.json`);
  const taskConfig = promptVersion === undefined ? configured : { ...configured, promptVersion };
  const model = override ?? taskConfig.model;
  const price = config.models.pricesEurPerMTok[model];
  if (!price) throw new Error(`No price configured for model ${model} (task ${taskName}) in config/models.json`);
  return { taskConfig, model, price };
}

/**
 * Cost of one answer (ruling M4-P5): input, cache writes at `cacheWriteFactor` and cache reads at the model's
 * `cacheReadFactor` times the input price, output at the output price; all times `factor` (the batch discount).
 */
export function usageCostEur(usage: ModelUsage, price: ModelPrice, cacheWriteFactor: number, factor = 1): number {
  const input =
    usage.inputTokens + usage.cacheWriteTokens * cacheWriteFactor + usage.cacheReadTokens * price.cacheReadFactor;
  return ((input / 1e6) * price.input + (usage.outputTokens / 1e6) * price.output) * factor;
}

/**
 * Budget reservation of each request of a batch before it is sent (ruling M4-P6): the rendered prompt at 4
 * characters per token times the input price plus `maxTokens` times the output price, all times the batch discount.
 * It errs high: billing counts actual tokens and most answers stay far below `maxTokens`. Per request, because
 * prompts differ in length, so a planner can size a batch to the budget headroom (ruling M4-C-R2). Attachments are
 * not counted, so a task with attachments is refused instead of being under-reserved.
 */
export function estimateBatchItemCostsEur<I>(
  config: AppConfig,
  task: ModelTask<I, unknown>,
  inputs: I[],
  modelOverride?: string,
  promptVersion?: number,
): number[] {
  const { taskConfig, price } = resolveTaskModel(config, task.name, modelOverride, promptVersion);
  const prompt = loadPrompt(task.name, taskConfig.promptVersion);
  const perOutput = (taskConfig.maxTokens / 1e6) * price.output;
  return inputs.map((input) => {
    if ((task.attachments?.(input) ?? []).length > 0) {
      throw new Error(`Task ${task.name} sends attachments, which the batch estimate cannot count: not supported in batches`);
    }
    const vars = task.variables(input);
    const chars = renderPrompt(prompt.system, vars).length + renderPrompt(prompt.user, vars).length;
    return ((chars / 4 / 1e6) * price.input + perOutput) * config.models.batch.discount;
  });
}

/** Budget reservation of a whole batch: the sum of `estimateBatchItemCostsEur`. */
export function estimateBatchCostEur<I>(
  config: AppConfig,
  task: ModelTask<I, unknown>,
  inputs: I[],
  modelOverride?: string,
  promptVersion?: number,
): number {
  return estimateBatchItemCostsEur(config, task, inputs, modelOverride, promptVersion).reduce((sum, cost) => sum + cost, 0);
}

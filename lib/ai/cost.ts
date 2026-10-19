import type { AppConfig, ModelTaskConfig } from "@/lib/config";
import { loadPrompt, renderPrompt } from "./prompts";
import type { ModelTask, ModelUsage } from "./types";

export type ModelPrice = AppConfig["models"]["pricesEurPerMTok"][string];

/** The configuration of a task and the model it runs on (`override` replaces the configured one). */
export function resolveTaskModel(
  config: AppConfig,
  taskName: string,
  override?: string,
): { taskConfig: ModelTaskConfig; model: string; price: ModelPrice } {
  const taskConfig = config.models.tasks[taskName];
  if (!taskConfig) throw new Error(`No model configured for task ${taskName} in config/models.json`);
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
 * Budget reservation of a batch before it is sent (ruling M4-P6): per request the rendered prompt at 4 characters
 * per token times the input price plus `maxTokens` times the output price, all times the batch discount. It errs high:
 * billing counts actual tokens and most answers stay far below `maxTokens`.
 */
export function estimateBatchCostEur<I>(
  config: AppConfig,
  task: ModelTask<I, unknown>,
  inputs: I[],
  modelOverride?: string,
): number {
  const { taskConfig, price } = resolveTaskModel(config, task.name, modelOverride);
  const prompt = loadPrompt(task.name, taskConfig.promptVersion);
  let chars = 0;
  for (const input of inputs) {
    const vars = task.variables(input);
    chars += renderPrompt(prompt.system, vars).length + renderPrompt(prompt.user, vars).length;
  }
  const perOutput = (taskConfig.maxTokens / 1e6) * price.output;
  return ((chars / 4 / 1e6) * price.input + inputs.length * perOutput) * config.models.batch.discount;
}

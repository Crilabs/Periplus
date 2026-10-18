import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { getConfig, type AppConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { assertWithinBudget, recordExternalCall } from "@/lib/domain/costs";
import { createLogger } from "@/lib/logger";
import { loadPrompt, renderPrompt } from "./prompts";
import { ModelOutputInvalid, type ModelClient, type ModelResult, type ModelTask } from "./types";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("ai.anthropic"));

const MAX_TOKENS = 4096;

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

export function createAnthropicClient(db: Db, config: AppConfig = getConfig(), options: AnthropicClientOptions = {}): ModelClient {
  let sdk = options.sdk;
  return {
    async call<I, O>(task: ModelTask<I, O>, input: I, ctx?: { runId?: string; stage?: string }): Promise<ModelResult<O>> {
      const taskConfig = config.models.tasks[task.name];
      if (!taskConfig) throw new Error(`No model configured for task ${task.name} in config/models.json`);
      const { model, promptVersion } = taskConfig;
      const price = config.models.pricesEurPerMTok[model];
      if (!price) throw new Error(`No price configured for model ${model} (task ${task.name}) in config/models.json`);

      const prompt = loadPrompt(task.name, promptVersion);
      const vars = task.variables(input);
      const system = renderPrompt(prompt.system, vars);
      const user = renderPrompt(prompt.user, vars);

      await assertWithinBudget(db, "anthropic", config.budgets, options.now?.());

      sdk ??= defaultSdk();
      const response = await sdk.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort: "low", format: { type: "json_schema", schema: z.toJSONSchema(task.output) } },
      });

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const costEur = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
      await recordExternalCall(db, {
        service: "anthropic",
        operation: task.name,
        units: inputTokens + outputTokens,
        unit: "tokens",
        costEur,
        runId: ctx?.runId,
        stage: ctx?.stage,
        meta: { model, promptVersion, inputTokens, outputTokens },
        ...(options.now ? { at: options.now() } : {}),
      });
      getLog().debug({ task: task.name, model, inputTokens, outputTokens, costEur }, "model call finished");

      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        throw new ModelOutputInvalid(task.name, `stop_reason ${response.stop_reason}`);
      }
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        throw new ModelOutputInvalid(task.name, "response is not valid JSON", { cause: error });
      }
      const parsed = task.output.safeParse(json);
      if (!parsed.success) throw new ModelOutputInvalid(task.name, parsed.error.message, { cause: parsed.error });
      return { output: parsed.data, model, promptVersion, usage: { inputTokens, outputTokens }, costEur };
    },
  };
}

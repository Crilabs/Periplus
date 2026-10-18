import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import { budgetsSchema, modelsSchema, queuesSchema, type AppConfig } from "./schemas";

export type { AppConfig, BudgetService, QueueConfig } from "./schemas";

function readJson<T>(dir: string, name: string, schema: ZodType<T>): T {
  const file = join(dir, `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read config ${file}: ${(error as Error).message}`, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid config ${file}: ${issues}`);
  }
  return parsed.data;
}

/** Loads and validates all config files; throws on any invalid or missing file. */
export function loadConfig(dir = "config"): AppConfig {
  return {
    queues: readJson(dir, "queues", queuesSchema),
    budgets: readJson(dir, "budgets", budgetsSchema),
    models: readJson(dir, "models", modelsSchema),
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

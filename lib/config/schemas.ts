import { z } from "zod";

export const queueConfigSchema = z.object({
  concurrency: z.number().int().min(1),
  retryLimit: z.number().int().min(0),
  retryDelaySeconds: z.number().int().min(0),
  retryBackoff: z.boolean(),
});

export const budgetServices = ["anthropic", "voyage", "dataforseo", "firecrawl", "jina"] as const;
export type BudgetService = (typeof budgetServices)[number];

export const queuesSchema = z.record(z.string(), queueConfigSchema);

export const budgetsSchema = z.strictObject({
  anthropic: z.strictObject({ dailyEur: z.number().positive() }),
  voyage: z.strictObject({ dailyEur: z.number().positive() }),
  dataforseo: z.strictObject({ dailyEur: z.number().positive() }),
  firecrawl: z.strictObject({ dailyEur: z.number().positive() }),
  jina: z.strictObject({ dailyEur: z.number().positive() }),
});

export const modelsSchema = z.object({
  tasks: z.record(
    z.string(),
    z.object({ model: z.string().min(1), promptVersion: z.number().int().min(1) }),
  ),
  pricesEurPerMTok: z.record(
    z.string(),
    z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
  ),
});

export type QueueConfig = z.infer<typeof queueConfigSchema>;
export type AppConfig = {
  queues: Record<string, QueueConfig>;
  budgets: z.infer<typeof budgetsSchema>;
  models: z.infer<typeof modelsSchema>;
};

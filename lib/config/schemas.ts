import { z } from "zod";

export const queueConfigSchema = z.object({
  concurrency: z.number().int().min(1),
  retryLimit: z.number().int().min(0),
  retryDelaySeconds: z.number().int().min(0),
  retryBackoff: z.boolean(),
});

export const BUDGET_SERVICES = ["anthropic", "voyage", "dataforseo", "firecrawl", "jina"] as const;
export type BudgetService = (typeof BUDGET_SERVICES)[number];

export const queuesSchema = z.record(z.string(), queueConfigSchema);

const budgetEntrySchema = z.strictObject({ dailyEur: z.number().positive() });

export const budgetsSchema = z.strictObject(
  Object.fromEntries(BUDGET_SERVICES.map((s) => [s, budgetEntrySchema])) as Record<
    BudgetService,
    typeof budgetEntrySchema
  >,
);

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
  budgets: Record<BudgetService, { dailyEur: number }>;
  models: z.infer<typeof modelsSchema>;
};

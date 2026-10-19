import { desc, eq } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { modelComparisons, runs, type RunStatus } from "@/lib/db/schema";
import {
  compareRuns,
  comparisonOverview,
  deviationSample,
  estimateComparisonCostEur,
  getModelComparison,
  ratingSummary,
  type ComparisonOverview,
  type ComparisonSummary,
  type DeviationItem,
  type RatingSummary,
} from "@/lib/domain/extraction/comparison";

/*
 * The data of `/compare/models` (Task 19): the comparisons, and for the chosen one its sample, cost estimate, run,
 * counters per model, agreement, the deviation sample with its verdicts and the current model decision.
 */

export type ComparisonListItem = { id: string; label: string; createdAt: Date; createdBy: string; runId: string | null; runStatus: RunStatus | null };

export type ComparisonDetail = ComparisonOverview & {
  id: string;
  label: string;
  models: string[];
  runId: string | null;
  runStatus: RunStatus | null;
  estimateEur: number;
  summary: ComparisonSummary;
  sample: DeviationItem[];
  /** Items of the sample with a verdict. */
  ratedInSample: number;
  ratings: RatingSummary;
};

export type ModelDecision = { model: string; status: "provisional" | "decided"; note: string | null };

/** The comparisons, newest first, with the status of their run. */
export async function listModelComparisons(db: Db): Promise<ComparisonListItem[]> {
  const rows = await db
    .select({
      id: modelComparisons.id,
      label: modelComparisons.label,
      createdAt: modelComparisons.createdAt,
      createdBy: modelComparisons.createdBy,
      runId: modelComparisons.runId,
      runStatus: runs.status,
    })
    .from(modelComparisons)
    .leftJoin(runs, eq(runs.id, modelComparisons.runId))
    .orderBy(desc(modelComparisons.createdAt), desc(modelComparisons.id));
  return rows.map((r) => ({ ...r, runStatus: r.runStatus ?? null }));
}

/** Everything the page shows of one comparison; null when it does not exist. */
export async function modelComparisonDetail(db: Db, comparisonId: string, cfg: AppConfig = getConfig()): Promise<ComparisonDetail | null> {
  const comparison = await getModelComparison(db, comparisonId);
  if (!comparison) return null;
  const [run] = comparison.runId ? await db.select({ status: runs.status }).from(runs).where(eq(runs.id, comparison.runId)) : [];
  const [overview, estimateEur, summary, sample, ratings] = [
    await comparisonOverview(db, comparisonId),
    await estimateComparisonCostEur(db, comparisonId, cfg),
    await compareRuns(db, comparisonId, cfg),
    await deviationSample(db, comparisonId, cfg.extraction.comparison.ratingSample, cfg),
    await ratingSummary(db, comparisonId),
  ];
  return {
    ...overview,
    id: comparison.id,
    label: comparison.label,
    models: comparison.models,
    runId: comparison.runId,
    runStatus: run?.status ?? null,
    estimateEur,
    summary,
    sample,
    ratedInSample: sample.filter((d) => d.verdict !== null).length,
    ratings,
  };
}

/** The current model decision of the extraction (`config/models.json`, task `extract-facts`). */
export function extractionModelDecision(cfg: AppConfig = getConfig()): ModelDecision {
  const task = cfg.models.tasks["extract-facts"];
  if (!task) throw new Error("no extract-facts task in config/models.json");
  return { model: task.model, status: task.decision?.status ?? "provisional", note: task.decision?.note ?? null };
}

import { eq } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { applyBerthVerdicts, type BerthTransition } from "@/lib/domain/research/confirmation";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { researchScope } from "./search";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

/*
 * Stage `research.confirm` (plan N2, spec 5.6): one job applies the confirmation rule (`applyBerthVerdicts`) to all
 * candidates of the run. Its status changes are returned for the follow-up run of newly confirmed berths (task 7).
 */

export const RESEARCH_CONFIRM_STAGE = "research.confirm";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.research.confirm"));

export type ConfirmJob = { runId: string; stage: string; key: string };

/** Plan of the stage `research.confirm`: one job for all candidates of the run (the job reads the run's scope). */
export async function planResearchConfirm(): Promise<JobData[]> {
  return [{ key: "confirm" }];
}

/** Job `research.confirm`: the confirmation rule over the run's candidates (`params.subdivisionKey` or `params.placeIds`). */
export async function confirmBerths(db: Db, job: ConfirmJob, config: AppConfig = getConfig(), now: Date = new Date()): Promise<BerthTransition[]> {
  const [run] = await db.select({ params: runs.params }).from(runs).where(eq(runs.id, job.runId));
  if (!run) throw new Error(`run ${job.runId} does not exist`);
  const placeIds = await researchCandidates(db, researchScope(run.params as Record<string, unknown>));
  const transitions = await applyBerthVerdicts(db, placeIds, now, config);
  getLog().info({ runId: job.runId, places: placeIds.length, transitions: transitions.length }, "berths decided");
  return transitions;
}

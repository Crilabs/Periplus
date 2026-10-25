import { z } from "zod";
import { getConfig } from "@/lib/config";
import { startBerthFollowupRun } from "@/lib/pipeline/berth-followup-run";
import { confirmBerths, researchChanges } from "@/lib/pipeline/research/confirm";
import type { JobContext, JobData, JobHandler } from "@/lib/jobs/worker";

// Own file, imported only by the registry: the run starters reach the stage registry, which imports the other
// research handlers (ruling M5-P11).

const jobSchema = z.object({ runId: z.uuid(), stage: z.string().min(1), key: z.string().min(1) });

export type ConfirmStarters = { followup: typeof startBerthFollowupRun };

const STARTERS: ConfirmStarters = { followup: startBerthFollowupRun };

/**
 * Applies the confirmation rule (`confirmBerths`), then, derived from the database (`researchChanges`) so a retry redoes
 * it: the follow-up run of the run's berths that are confirmed now (spec 5.7b; a change away from `confirmed` starts
 * none, the delivery filters on it). No consolidation: the berth state (`research.state`) of the follow-up run is the
 * successor of the profile. If the starter fails the job throws, so the queue's retry takes effect (the start is
 * idempotent: images skip done keys).
 */
export async function confirmAndFollowUp(data: JobData, ctx: JobContext, starters: ConfirmStarters = STARTERS): Promise<void> {
  const job = jobSchema.parse(data);
  const transitions = await confirmBerths(ctx.db, job, getConfig());
  const { confirmed } = await researchChanges(ctx.db, job.runId);
  if (confirmed.length === 0) return;
  const run = await starters.followup(ctx.db, ctx.boss, confirmed, "system");
  ctx.log.info({ runId: job.runId, startedRunId: run?.id ?? null, transitions: transitions.length }, "follow-up run of confirmed berths started");
}

export const researchConfirmHandler: JobHandler<JobData> = (data, ctx) => confirmAndFollowUp(data, ctx);

import { z } from "zod";
import { getConfig } from "@/lib/config";
import { startBerthFollowupRun } from "@/lib/pipeline/berth-followup-run";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { confirmBerths, researchChanges, withdrawnSubdivisions } from "@/lib/pipeline/research/confirm";
import type { JobContext, JobData, JobHandler } from "@/lib/jobs/worker";

// Own file, imported only by the registry: the run starters reach the stage registry, which imports the other
// research handlers (ruling M5-P11).

const jobSchema = z.object({ runId: z.uuid(), stage: z.string().min(1), key: z.string().min(1) });

export type ConfirmStarters = { followup: typeof startBerthFollowupRun; delivery: typeof startDeliveryRun };

const STARTERS: ConfirmStarters = { followup: startBerthFollowupRun, delivery: startDeliveryRun };

/**
 * Applies the confirmation rule (`confirmBerths`), then, derived from the database (`researchChanges`) so a retry redoes
 * it: the follow-up run of the run's berths that are confirmed now (spec 5.7b; a change away from `confirmed` starts
 * none, the delivery filters on it). No consolidation: the berth state (`research.state`) of the follow-up run is the
 * successor of the profile. A withdrawal (a place that left `confirmed`, `withdrawnSubdivisions`) starts a delivery
 * build of its subdivision, so the package drops the place at once (design 5.7b); a failed delivery start is logged and
 * never fails the stage (the deliveries page and the runbook cover a missed rebuild). If the follow-up starter fails the
 * job throws after the delivery starts, so the queue's retry takes effect (the starts are idempotent: images skip done keys).
 */
export async function confirmAndFollowUp(data: JobData, ctx: JobContext, starters: ConfirmStarters = STARTERS): Promise<void> {
  const job = jobSchema.parse(data);
  const transitions = await confirmBerths(ctx.db, job, getConfig());
  const { confirmed } = await researchChanges(ctx.db, job.runId);
  let failure: unknown = null;
  if (confirmed.length > 0) {
    try {
      const run = await starters.followup(ctx.db, ctx.boss, confirmed, "system");
      ctx.log.info({ runId: job.runId, startedRunId: run?.id ?? null, transitions: transitions.length }, "follow-up run of confirmed berths started");
    } catch (err) {
      ctx.log.error({ err, runId: job.runId }, "follow-up run of confirmed berths not started");
      failure = err;
    }
  }
  for (const key of await withdrawnSubdivisions(ctx.db, job.runId)) {
    try {
      const run = await starters.delivery(ctx.db, ctx.boss, key, "system");
      ctx.log.info({ runId: job.runId, startedRunId: run.id, subdivision: key }, "delivery build after withdrawal started");
    } catch (err) {
      ctx.log.error({ err, runId: job.runId, subdivision: key }, "delivery build after withdrawal not started; rebuild the subdivision by hand");
    }
  }
  if (failure !== null) throw failure;
}

export const researchConfirmHandler: JobHandler<JobData> = (data, ctx) => confirmAndFollowUp(data, ctx);

import { z } from "zod";
import { getConfig } from "@/lib/config";
import { startBerthFollowupRun } from "@/lib/pipeline/berth-followup-run";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { confirmBerths, researchChanges, withdrawnSubdivisions } from "@/lib/pipeline/research/confirm";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import type { JobContext, JobData, JobHandler } from "@/lib/jobs/worker";

// Own file, imported only by the registry: the run starters reach the stage registry, which imports the other
// research handlers (ruling M5-P11).

const jobSchema = z.object({ runId: z.uuid(), stage: z.string().min(1), key: z.string().min(1) });

export type ConfirmStarters = { followup: typeof startBerthFollowupRun; consolidation: typeof startConsolidationRun; delivery: typeof startDeliveryRun };

const STARTERS: ConfirmStarters = { followup: startBerthFollowupRun, consolidation: startConsolidationRun, delivery: startDeliveryRun };

/**
 * Applies the confirmation rule (`confirmBerths`), then, derived from the database (`researchChanges`) so a retry redoes
 * it: the follow-up run of the run's berths that are confirmed now (spec 5.7b; a change away from `confirmed` starts
 * none, the delivery filters on it) and a consolidation of the objects whose status changed, so profiles and
 * `place_new` follow (the consolidation no longer confirms). Both starters are tried; an object the consolidation
 * refuses (`RunScopeNotReady`) is skipped and logged alone; if a starter failed for any other reason the job throws
 * after both were tried, so the queue's retry takes effect (the starts are idempotent: images skip done keys).
 * A withdrawal (a place that left `confirmed`, `withdrawnSubdivisions`) starts a delivery build of its subdivision, so
 * the package drops the place at once (design 5.7b); a failed start is logged and never fails the stage (the verdicts
 * are committed; the deliveries page and the runbook cover a missed rebuild).
 */
export async function confirmAndFollowUp(data: JobData, ctx: JobContext, starters: ConfirmStarters = STARTERS): Promise<void> {
  const job = jobSchema.parse(data);
  const transitions = await confirmBerths(ctx.db, job, getConfig());
  const { changed, confirmed } = await researchChanges(ctx.db, job.runId);
  const failures: unknown[] = [];
  const attempt = async (what: string, start: () => Promise<{ id: string } | null>) => {
    try {
      const run = await start();
      ctx.log.info({ runId: job.runId, startedRunId: run?.id ?? null, transitions: transitions.length }, `${what} started`);
    } catch (err) {
      ctx.log.error({ err, runId: job.runId }, `${what} not started`);
      failures.push(err);
    }
  };

  if (confirmed.length > 0) await attempt("follow-up run of confirmed berths", () => starters.followup(ctx.db, ctx.boss, confirmed, "system"));
  if (changed.length > 0) {
    const ids = changed.map((c) => c.geoObjectId);
    const start = (geoObjectIds: string[]) => starters.consolidation(ctx.db, ctx.boss, { scope: { geoObjectIds }, triggeredBy: "system" });
    await attempt("consolidation of changed berths", async () => {
      try {
        return await start(ids);
      } catch (err) {
        if (!(err instanceof RunScopeNotReady)) throw err;
        // one refused object must not drop the rest: start per object, skip the refused ones
        let last: { id: string } | null = null;
        const errors: unknown[] = [];
        for (const id of ids) {
          try {
            last = await start([id]);
          } catch (e) {
            if (e instanceof RunScopeNotReady) ctx.log.warn({ geoObjectId: id, reason: e.reason }, "object not consolidated");
            else errors.push(e);
          }
        }
        if (errors.length > 0) throw errors[0];
        return last;
      }
    });
  }
  for (const key of await withdrawnSubdivisions(ctx.db, job.runId)) {
    try {
      const run = await starters.delivery(ctx.db, ctx.boss, key, "system");
      ctx.log.info({ runId: job.runId, startedRunId: run.id, subdivision: key }, "delivery build after withdrawal started");
    } catch (err) {
      ctx.log.error({ err, runId: job.runId, subdivision: key }, "delivery build after withdrawal not started; rebuild the subdivision by hand");
    }
  }
  if (failures.length > 0) throw failures[0];
}

export const researchConfirmHandler: JobHandler<JobData> = (data, ctx) => confirmAndFollowUp(data, ctx);

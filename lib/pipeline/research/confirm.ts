import { eq, sql } from "drizzle-orm";
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
  const transitions = await applyBerthVerdicts(db, placeIds, now, config, job.runId);
  getLog().info({ runId: job.runId, places: placeIds.length, transitions: transitions.length }, "berths decided");
  return transitions;
}

/**
 * The places the research rule moved in this run (a `place_status` decision `rule: research` of `system` with this
 * `runId`), with their current state: `changed` objects for the consolidation (a place demoted to `no_anchoring`
 * included, though it is no candidate any more), `confirmed` places (still `confirmed`, with a public id) for the
 * follow-up run. Read from the database rather than from `confirmBerths`' result, so a retried job (which changes
 * nothing any more) redoes its follow-ups.
 */
export async function researchChanges(db: Db, runId: string): Promise<{ changed: Array<{ placeId: string; geoObjectId: string }>; confirmed: string[] }> {
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} does not exist`);
  const { rows } = await db.execute<{ id: string; geo_object_id: string; status: string; public_id: string | null }>(sql`
    select p.id, p.geo_object_id, p.status::text as status, p.public_id
    from places p
    where exists (
        select 1 from review_tasks t join review_decisions d on d.task_id = t.id
        where t.kind = 'place_candidate' and t.subject_type = 'place_status' and t.subject_id = p.id::text
          and d.decided_by = 'system' and d.decision->>'rule' = 'research' and d.decision->>'runId' = ${runId})
    order by p.id`);
  return {
    changed: rows.map((r) => ({ placeId: r.id, geoObjectId: r.geo_object_id })),
    confirmed: rows.filter((r) => r.status === "confirmed" && r.public_id !== null).map((r) => r.id),
  };
}

/**
 * The keys of the subdivisions in which this run's research rule moved a place away from `confirmed` (a withdrawal:
 * the place is `no_anchoring`, `candidate` or the like now; design 5.7b "fällt sofort aus der Lieferung"). The decision's
 * pseudo task keeps the previous status (`context.previous`); a place confirmed again later in the run is not a withdrawal.
 * Read from the database like `researchChanges`, so a retried job redoes the rebuild. Sorted, each key once.
 */
export async function withdrawnSubdivisions(db: Db, runId: string): Promise<string[]> {
  const { rows } = await db.execute<{ key: string }>(sql`
    select distinct s.key
    from places p
    join geo_objects g on g.id = p.geo_object_id
    join subdivisions s on s.id = g.subdivision_id
    where p.status <> 'confirmed'
      and exists (
        select 1 from review_tasks t join review_decisions d on d.task_id = t.id
        where t.kind = 'place_candidate' and t.subject_type = 'place_status' and t.subject_id = p.id::text
          and t.context->>'previous' = 'confirmed'
          and d.decided_by = 'system' and d.decision->>'rule' = 'research' and d.decision->>'runId' = ${runId})
    order by s.key`);
  return rows.map((r) => r.key);
}

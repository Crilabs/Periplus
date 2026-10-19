import { and, eq, inArray, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { resolveTaskModel } from "@/lib/ai/cost";
import { extractRouteTask, type ExtractRouteInput, type ExtractRouteOutput } from "@/lib/ai/tasks/extract-route";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documentVersions, extractionRuns, runs } from "@/lib/db/schema";
import { routeSections, storeRoute } from "@/lib/domain/extraction/routes";
import { effectiveVersionMeta } from "@/lib/domain/mentions/classification";
import { jsonUuids } from "@/lib/domain/mentions/scope";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { ensureExtractionRun } from "./extract";
import { submitStageJobBatch } from "./stage-batch";
import { frozenRunVersions, textRunParamsSchema } from "./versions";

/*
 * Stage `extraction.route` (spec 06): the route of every trip report of the run (effective document type
 * `trip_report`) that has none in the run's `extract-route` extraction run yet. A report goes to the model in sections
 * (`routeSections`: whole up to `routeSectionWords` words, else cut at headings), one batch item per section
 * (`subjectId` `<versionId>:<section>`, from 1). The batch handler stores the route once every section of its version
 * has an answer, wherever its items ended up (a section the budget pushed into a follow-on batch counts as well). A
 * section that fails for good or is never sent leaves its version without a route; the run's stats say so
 * (`routeRunStats`).
 */

export const ROUTE_STAGE = "extraction.route";
export const ROUTE_QUEUE = "extraction.route" as const;
export const EXTRACT_ROUTE_TASK = "extract-route";
const SUBJECT = "route_section";

const task = extractRouteTask as ModelTask<unknown, unknown>;

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.text.routes"));

export type RouteJob = { runId: string; stage: string; key: string; extractionRunId: string; versionIds?: string[]; sectionIds?: string[] };
export type RouteDeps = BatchDeps & { archive: Pick<Archive, "get"> };

const sectionId = (versionId: string, section: number) => `${versionId}:${section}`;

function parseSectionId(id: string): { versionId: string; section: number } {
  const at = id.lastIndexOf(":");
  return { versionId: id.slice(0, at), section: Number(id.slice(at + 1)) };
}

/** Of the versions, those with a route in the extraction run. */
async function versionsWithRoute(db: Db, extractionRunId: string, versionIds: string[]): Promise<Set<string>> {
  if (versionIds.length === 0) return new Set();
  const { rows } = await db.execute<{ id: string }>(sql`
    select document_version_id as id from routes
    where extraction_run_id = ${extractionRunId} and document_version_id in ${jsonUuids(versionIds)}
  `);
  return new Set(rows.map((r) => r.id));
}

/**
 * Of `versionIds`, those with a route of another regular or reprocess extraction run (not `except`) on this model and
 * prompt version (not a comparison run, not failed).
 */
async function versionsRoutedBefore(
  db: Db,
  on: { model: string; promptVersion: number; except: string },
  versionIds: string[],
): Promise<Set<string>> {
  if (versionIds.length === 0) return new Set();
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct ro.document_version_id as id from routes ro
    join extraction_runs r on r.id = ro.extraction_run_id
    where r.task = ${EXTRACT_ROUTE_TASK} and r.model = ${on.model} and r.prompt_version = ${on.promptVersion}
      and r.purpose <> 'comparison' and r.status <> 'failed' and r.id <> ${on.except}
      and ro.document_version_id in ${jsonUuids(versionIds)}
  `);
  return new Set(rows.map((r) => r.id));
}

/** The versions of the run's frozen set whose effective document type is `trip_report`, in the set's order. */
async function tripReports(db: Db, params: Record<string, unknown>): Promise<string[]> {
  const reports: string[] = [];
  for (const versionId of await frozenRunVersions(db, params)) {
    if ((await effectiveVersionMeta(db, versionId)).docType === "trip_report") reports.push(versionId);
  }
  return reports;
}

/**
 * Plan, from the run's frozen version set (ruling M4-E-R2): its versions of effective type `trip_report` without a
 * route in the run's `extract-route` extraction run (created here, with the configured model, when there is work or
 * once it exists), `unitsPerBatch` versions per job in id order.
 */
export async function planRoutes(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const params = textRunParamsSchema.parse(run.params);
  const reports = await tripReports(db, run.params);
  const [existing] = await db
    .select({ id: extractionRuns.id })
    .from(extractionRuns)
    .where(and(eq(extractionRuns.runId, run.id), eq(extractionRuns.task, EXTRACT_ROUTE_TASK)));
  if (reports.length === 0 && !existing) return [];
  const { model, taskConfig } = resolveTaskModel(config, EXTRACT_ROUTE_TASK);
  const { id: extractionRunId } =
    existing ??
    (await ensureExtractionRun(
      db,
      { runId: run.id, task: EXTRACT_ROUTE_TASK, model, promptVersion: taskConfig.promptVersion, purpose: params.reprocess ? "reprocess" : "regular" },
      config,
    ));
  const done = await versionsWithRoute(db, extractionRunId, reports);
  // Only a reprocess pays for a route again: a regular, tile or rematch run skips reports routed before with this
  // model and prompt version.
  if (!params.reprocess) {
    for (const id of await versionsRoutedBefore(db, { model, promptVersion: taskConfig.promptVersion, except: extractionRunId }, reports)) done.add(id);
  }
  const todo = reports.filter((id) => !done.has(id));
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < todo.length; i++) {
    jobs.push({ key: `route:${i}`, extractionRunId, versionIds: todo.slice(i * size, (i + 1) * size) });
  }
  getLog().info({ runId: run.id, extractionRunId, reports: reports.length, todo: todo.length, jobs: jobs.length }, "routes planned");
  return jobs;
}

/** The sections of the versions' archived Markdown; a version whose Markdown is missing is left out and logged. */
async function sectionsOf(db: Db, archive: Pick<Archive, "get">, versionIds: string[], config: AppConfig): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (versionIds.length === 0) return out;
  const rows = await db.select({ id: documentVersions.id, mdKey: documentVersions.mdKey }).from(documentVersions).where(inArray(documentVersions.id, versionIds));
  for (const row of rows) {
    const body = await archive.get(row.mdKey);
    if (body === null) {
      getLog().warn({ versionId: row.id, mdKey: row.mdKey }, "archived markdown missing, no route for this version");
      continue;
    }
    out.set(row.id, routeSections(new TextDecoder().decode(body), config.extraction.routeSectionWords));
  }
  return out;
}

/**
 * One route job: its versions (all their sections) or, for a follow-on job, its sections go out as one message batch
 * on the extraction run's model and prompt version, sized to the budget headroom (`submitStageJobBatch`; the rest goes
 * to one follow-on job with `sectionIds`). Sections of versions that have a route already are not sent. A retried job
 * reuses its batch (the sections of the archived Markdown are the same). Never call it inside a transaction.
 */
export async function extractRoutes(db: Db, deps: RouteDeps, job: RouteJob): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  const [run] = await db
    .select({ model: extractionRuns.model, promptVersion: extractionRuns.promptVersion })
    .from(extractionRuns)
    .where(eq(extractionRuns.id, job.extractionRunId));
  if (!run) throw new Error(`extraction run ${job.extractionRunId} does not exist`);
  const named = (job.sectionIds ?? []).map(parseSectionId);
  const versionIds = [...new Set([...(job.versionIds ?? []), ...named.map((s) => s.versionId)])];
  const sections = await sectionsOf(db, deps.archive, versionIds, config);
  const subjects: string[] = [];
  for (const versionId of job.versionIds ?? []) {
    const parts = sections.get(versionId);
    if (parts) parts.forEach((_, i) => subjects.push(sectionId(versionId, i + 1)));
  }
  for (const s of named) if (sections.get(s.versionId)?.[s.section - 1] !== undefined) subjects.push(sectionId(s.versionId, s.section));
  const observedAt = new Map<string, string>();
  for (const versionId of sections.keys()) observedAt.set(versionId, (await effectiveVersionMeta(db, versionId)).observedAt);

  return submitStageJobBatch(db, deps, {
    task,
    queue: ROUTE_QUEUE,
    job,
    subjectIds: subjects,
    modelOverride: run.model,
    promptVersionOverride: run.promptVersion,
    open: async (ids) => {
      const routed = await versionsWithRoute(db, job.extractionRunId, [...new Set(ids.map((id) => parseSectionId(id).versionId))]);
      return ids.filter((id) => !routed.has(parseSectionId(id).versionId));
    },
    inputs: async (ids) =>
      ids.map((id): BatchItemInput => {
        const { versionId, section } = parseSectionId(id);
        const parts = sections.get(versionId)!;
        const input: ExtractRouteInput = {
          section,
          sections: parts.length,
          observedAt: observedAt.get(versionId)!,
          maxStops: config.extraction.routeMaxStops,
          quoteMinChars: config.extraction.quote.minChars,
          quoteMaxChars: config.extraction.quote.maxChars,
          stopNameMaxChars: config.extraction.routeStop.nameMaxChars,
          maxBeaufort: config.extraction.routeStop.maxBeaufort,
          text: parts[section - 1]!,
        };
        return { subjectType: SUBJECT, subjectId: id, input };
      }),
    remainderData: (ids) => ({ extractionRunId: job.extractionRunId, sectionIds: ids }),
  });
}

/**
 * Batch handler of `extract-route`: when every section of the item's version has an answer (succeeded items of this
 * run, stage and model, in any batch; of several answers to a section the latest, by creation and attempt), the route
 * is stored from them in section order (`storeRoute`, idempotent), in
 * the distribution transaction; before that it waits. An answer that does not fit the output schema leaves the
 * version without a route (logged; the same answer would fail again).
 */
export const routeSectionBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const { versionId } = parseSectionId(item.subjectId);
    const total = (item.input as ExtractRouteInput).sections;
    const { rows } = await db.execute<{ subject_id: string; output: unknown }>(sql`
      select distinct on (i.subject_id) i.subject_id, i.output
      from ai_batch_items i join ai_batches b on b.id = i.batch_id
      where b.run_id = ${item.batch.runId} and b.stage = ${item.batch.stage} and b.model = ${item.batch.model}
        and i.subject_type = ${SUBJECT} and i.status = 'succeeded' and i.subject_id like ${`${versionId}:%`}
      order by i.subject_id, i.created_at desc, i.attempt desc, i.id desc
    `);
    if (rows.length < total) return;
    const outputs: ExtractRouteOutput[] = [];
    for (const row of rows.sort((a, b) => parseSectionId(a.subject_id).section - parseSectionId(b.subject_id).section)) {
      const parsed = extractRouteTask.output.safeParse(row.output);
      if (!parsed.success) {
        getLog().warn({ versionId, subjectId: row.subject_id, error: parsed.error.message }, "route section answer does not fit the output schema, no route");
        return;
      }
      outputs.push(parsed.data);
    }
    const [run] = await db
      .select({ id: extractionRuns.id })
      .from(extractionRuns)
      .where(and(eq(extractionRuns.runId, item.batch.runId), eq(extractionRuns.task, EXTRACT_ROUTE_TASK), eq(extractionRuns.model, item.batch.model)));
    if (!run) throw new Error(`extraction run of run ${item.batch.runId} (${EXTRACT_ROUTE_TASK}, ${item.batch.model}) does not exist`);
    const stored = await storeRoute(db, { versionId, extractionRunId: run.id, sections: outputs }, ctx.config);
    getLog().info({ versionId, extractionRunId: run.id, sections: total, ...stored }, "route stored");
  },
};

export type RouteRunStats = {
  /** Trip report versions of the run (its frozen version set), sent or not. */
  versions: number;
  /** Sections of the versions sent, by the section count each was cut into (also those of its sections never sent). */
  sections: number;
  /** Of these, the sections without an answer (failed for good, or never sent): their version gets no route. */
  sectionsFailed: number;
  /** Trip report versions of which no section was sent (archived Markdown missing, stage closed first). */
  versionsNotSent: number;
  /** Trip report versions left out because another run routed them on this model and prompt (not in `versions`). */
  versionsRoutedBefore: number;
  routes: number;
  /** Versions without a stored route (not sent, a failed section, or no verifiable stop). */
  versionsWithoutRoute: number;
  stops: number;
  assigned: number;
  /** Stops answered for versions with every section answered, but not stored (no verifiable quote, over the limit). */
  droppedStops: number;
  costEur: number;
};

/** The counters of an `extract-route` extraction run, written to `extraction_runs.stats`. */
export async function routeRunStats(db: Db, extractionRunId: string): Promise<RouteRunStats> {
  const [run] = await db
    .select({ runId: extractionRuns.runId, model: extractionRuns.model, promptVersion: extractionRuns.promptVersion, params: runs.params })
    .from(extractionRuns)
    .innerJoin(runs, eq(runs.id, extractionRuns.runId))
    .where(eq(extractionRuns.id, extractionRunId));
  if (!run) throw new Error(`extraction run ${extractionRunId} does not exist`);
  const params = (run.params ?? {}) as Record<string, unknown>;
  const allReports = await tripReports(db, params);
  const routedBefore = textRunParamsSchema.parse(params).reprocess
    ? new Set<string>()
    : await versionsRoutedBefore(db, { model: run.model, promptVersion: run.promptVersion, except: extractionRunId }, allReports);
  const reports = allReports.filter((id) => !routedBefore.has(id));
  const { rows } = await db.execute<{
    sent_versions: string[];
    sections: number;
    sections_failed: number;
    proposed: number;
    cost_eur: number;
  }>(sql`
    with items as (
      select i.subject_id, i.status, i.output, i.cost_eur, i.input, i.created_at, i.attempt, i.id,
        split_part(i.subject_id, ':', 1) as version_id
      from ai_batch_items i join ai_batches b on b.id = i.batch_id
      where b.run_id = ${run.runId} and b.stage = ${ROUTE_STAGE} and b.model = ${run.model} and i.subject_type = ${SUBJECT}
    ),
    answered as (
      select distinct on (subject_id) subject_id, version_id, output from items where status = 'succeeded'
      order by subject_id, created_at desc, attempt desc, id desc
    ),
    totals as (select version_id, max((input ->> 'sections')::int) as total from items group by version_id),
    complete as (
      select t.version_id from totals t where (select count(*) from answered a where a.version_id = t.version_id) >= t.total
    )
    select
      coalesce((select array_agg(version_id) from totals), '{}') as sent_versions,
      (select coalesce(sum(total), 0) from totals)::int as sections,
      ((select coalesce(sum(total), 0) from totals) - (select count(*) from answered))::int as sections_failed,
      (select coalesce(sum(jsonb_array_length(coalesce(a.output -> 'stops', '[]'::jsonb))), 0) from answered a
        where a.version_id in (select version_id from complete))::int as proposed,
      (select coalesce(sum(cost_eur), 0) from items)::float8 as cost_eur
  `);
  const { rows: stored } = await db.execute<{ routes: number; stops: number; assigned: number }>(sql`
    select count(distinct r.id)::int as routes, count(s.id)::int as stops, count(s.geo_object_id)::int as assigned
    from routes r left join route_stops s on s.route_id = r.id
    where r.extraction_run_id = ${extractionRunId}
  `);
  const r = rows[0]!;
  const st = stored[0]!;
  const sent = new Set(r.sent_versions);
  const versions = new Set([...reports, ...sent]).size;
  const stats: RouteRunStats = {
    versions,
    sections: Number(r.sections),
    sectionsFailed: Number(r.sections_failed),
    versionsNotSent: reports.filter((id) => !sent.has(id)).length,
    versionsRoutedBefore: [...routedBefore].filter((id) => !sent.has(id)).length,
    routes: Number(st.routes),
    versionsWithoutRoute: versions - Number(st.routes),
    stops: Number(st.stops),
    assigned: Number(st.assigned),
    droppedStops: Math.max(0, Number(r.proposed) - Number(st.stops)),
    costEur: Number(Number(r.cost_eur).toFixed(6)),
  };
  await db.update(extractionRuns).set({ stats }).where(eq(extractionRuns.id, extractionRunId));
  return stats;
}

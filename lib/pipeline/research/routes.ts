import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { extractRouteTask, type ExtractRouteInput } from "@/lib/ai/tasks/extract-route";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documentVersions, pageAssessments } from "@/lib/db/schema";
import { routeSections } from "@/lib/domain/extraction/routes";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { matchStops, storeRouteStops, type RouteSectionAnswer } from "@/lib/domain/research/discovery";
import { jsonUuids } from "@/lib/domain/mentions/scope";
import type { QueueName } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { routeSectionBatchEntry } from "@/lib/pipeline/text/routes";
import { submitStageJobBatch } from "@/lib/pipeline/text/stage-batch";
import { researchScope } from "./search";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

/*
 * Stages `research.routes` and `research.discover` (plan N2, spec 5.5). `research.routes`: the route of every actively
 * assessed, not generated trip report among the run's hit pages that has no stops of the active `extract-route` model
 * and prompt yet, read by the existing task `extract-route` in sections (`routeSections`, as `extraction.route` does),
 * one batch item per section (`subjectId` `<versionId>:<section>`). The handler stores the stops into
 * `research_route_stops` once every section of the version has an answer. `research.discover`: one job per page with
 * open stops, assigning them to places (`matchStops`). Pages linked there are extracted by the next research run.
 */

export const RESEARCH_ROUTES_STAGE = "research.routes";
export const RESEARCH_DISCOVER_STAGE = "research.discover";
// The queues are registered with the stages (plan N2, task 7, which removes these casts).
export const RESEARCH_ROUTES_QUEUE = "research.routes" as QueueName;
const SUBJECT = "research_route_section";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.research.routes"));

const task = extractRouteTask as ModelTask<unknown, unknown>;

export type ResearchRoutesJob = { runId: string; stage: string; key: string; versionIds?: string[]; sectionIds?: string[] };
export type ResearchRoutesDeps = BatchDeps & { archive: Pick<Archive, "get"> };
export type ResearchDiscoverJob = { runId: string; stage: string; key: string; documentVersionId: string };

/** A batch item's input: the task input plus the page's fetch time (for dating stops); only the task input reaches the prompt. */
export type ResearchRouteItemInput = ExtractRouteInput & { fetchedAt: string };

const sectionId = (versionId: string, section: number) => `${versionId}:${section}`;

function parseSectionId(id: string): { versionId: string; section: number } {
  const at = id.lastIndexOf(":");
  return { versionId: id.slice(0, at), section: Number(id.slice(at + 1)) };
}

/** The version id of a section item. */
const itemVersion = sql`split_part(i.subject_id, ':', 1)`;

/** `from … where …` of the items of the stage's batches on the active route model and prompt whose version fits `versionCondition`. */
function routeItems(versionCondition: SQL, config: AppConfig): SQL {
  const { model, promptVersion } = activeRouteExtractor(config);
  return sql`
    from ai_batch_items i join ai_batches b on b.id = i.batch_id
    where b.task = ${extractRouteTask.name} and b.stage = ${RESEARCH_ROUTES_STAGE} and b.model = ${model} and b.prompt_version = ${promptVersion}
      and i.subject_type = ${SUBJECT} and ${versionCondition}`;
}

/**
 * The current, actively assessed, not generated `trip_report` versions among the hit pages of the places, in id order,
 * without those that have stops of the active route model and prompt, those a batch still holds (another run must not
 * send them twice) and those whose every section was answered (an answer without a verifiable stop is not paid again).
 */
async function reportsToRoute(db: Db, placeIds: string[], config: AppConfig): Promise<string[]> {
  if (placeIds.length === 0) return [];
  const assessor = activeAssessor(config);
  const route = activeRouteExtractor(config);
  const items = routeItems(sql`${itemVersion} = d.current_version_id::text`, config);
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct d.current_version_id as id
    from research_hits h
    join documents d on d.url_normalized = h.url_normalized
    join page_assessments a on a.document_version_id = d.current_version_id
      and a.model = ${assessor.model} and a.prompt_version = ${assessor.promptVersion}
    where h.place_id in ${jsonUuids(placeIds)} and a.generated = false and a.page_kind = 'trip_report'
      and not exists (select 1 from research_route_stops s where s.document_version_id = d.current_version_id
        and s.model = ${route.model} and s.prompt_version = ${route.promptVersion})
      and not exists (select 1 ${items} and b.status not in ('distributed', 'failed'))
      and (select count(distinct i.subject_id) ${items} and i.status = 'succeeded')
        < coalesce((select max((i.input ->> 'sections')::int) ${items}), 1)
    order by id`);
  return rows.map((r) => r.id);
}

/**
 * Plan of the stage `research.routes`: the trip reports among the hit pages of the run's candidates still to route
 * (`reportsToRoute`), `extraction.unitsPerBatch` versions per job.
 */
export async function planResearchRoutes(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const todo = await reportsToRoute(db, await researchCandidates(db, researchScope(run.params)), config);
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < todo.length; i++) jobs.push({ key: `routes:${i}`, versionIds: todo.slice(i * size, (i + 1) * size) });
  return jobs;
}

type Report = { sections: string[]; observedAt: string; fetchedAt: Date };

/** The sections, observation date (active assessment) and fetch time of the versions; a version without Markdown or assessment is left out and logged. */
async function reportsOf(db: Db, archive: Pick<Archive, "get">, versionIds: string[], config: AppConfig): Promise<Map<string, Report>> {
  const out = new Map<string, Report>();
  if (versionIds.length === 0) return out;
  const assessor = activeAssessor(config);
  const rows = await db
    .select({ id: documentVersions.id, mdKey: documentVersions.mdKey, fetchedAt: documentVersions.fetchedAt, observedAt: pageAssessments.observedAt })
    .from(documentVersions)
    .innerJoin(
      pageAssessments,
      and(
        eq(pageAssessments.documentVersionId, documentVersions.id),
        eq(pageAssessments.model, assessor.model),
        eq(pageAssessments.promptVersion, assessor.promptVersion),
        eq(pageAssessments.generated, false),
      ),
    )
    .where(inArray(documentVersions.id, versionIds));
  for (const row of rows) {
    const body = await archive.get(row.mdKey);
    if (body === null) {
      getLog().warn({ versionId: row.id, mdKey: row.mdKey }, "archived markdown missing, no route for this version");
      continue;
    }
    out.set(row.id, { sections: routeSections(new TextDecoder().decode(body), config.extraction.routeSectionWords), observedAt: row.observedAt, fetchedAt: row.fetchedAt });
  }
  return out;
}

/**
 * Of the section ids, those still to send: their version has no stops of the active route model and prompt, the
 * section has no answer yet, and no unfinished batch holds it (another run's job may have sent it).
 */
async function openSections(db: Db, ids: string[], config: AppConfig): Promise<string[]> {
  if (ids.length === 0) return [];
  const route = activeRouteExtractor(config);
  const versionIds = [...new Set(ids.map((id) => parseSectionId(id).versionId))];
  const { rows: routed } = await db.execute<{ id: string }>(sql`
    select distinct document_version_id as id from research_route_stops
    where document_version_id in ${jsonUuids(versionIds)} and model = ${route.model} and prompt_version = ${route.promptVersion}`);
  const { rows: held } = await db.execute<{ subject_id: string }>(sql`
    select distinct i.subject_id
    ${routeItems(sql`${itemVersion} in (select value from jsonb_array_elements_text(${JSON.stringify(versionIds)}::jsonb))`, config)}
      and (i.status = 'succeeded' or b.status not in ('distributed', 'failed'))`);
  const done = new Set(routed.map((r) => r.id));
  const busy = new Set(held.map((r) => r.subject_id));
  return ids.filter((id) => !done.has(parseSectionId(id).versionId) && !busy.has(id));
}

/**
 * One route job: its versions (all their sections) or, for a follow-on job, its sections go out as one message batch on
 * the active route model and prompt, sized to the budget headroom (`submitStageJobBatch`). A retried job reuses its
 * batch. Never call it inside a transaction.
 */
export async function extractResearchRoutes(
  db: Db,
  deps: ResearchRoutesDeps,
  job: ResearchRoutesJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  const named = (job.sectionIds ?? []).map(parseSectionId);
  const reports = await reportsOf(db, deps.archive, [...new Set([...(job.versionIds ?? []), ...named.map((s) => s.versionId)])], config);
  const subjects: string[] = [];
  for (const versionId of job.versionIds ?? []) reports.get(versionId)?.sections.forEach((_, i) => subjects.push(sectionId(versionId, i + 1)));
  for (const s of named) if (reports.get(s.versionId)?.sections[s.section - 1] !== undefined) subjects.push(sectionId(s.versionId, s.section));

  return submitStageJobBatch(db, deps, {
    task,
    queue: RESEARCH_ROUTES_QUEUE,
    job,
    subjectIds: subjects,
    open: (ids) => openSections(db, ids, config),
    inputs: async (ids) =>
      ids.map((id): BatchItemInput => {
        const { versionId, section } = parseSectionId(id);
        const report = reports.get(versionId)!;
        const input: ResearchRouteItemInput = {
          section,
          sections: report.sections.length,
          observedAt: report.observedAt,
          maxStops: config.research.extraction.routeMaxStops,
          quoteMinChars: config.extraction.quote.minChars,
          quoteMaxChars: config.extraction.quote.maxChars,
          stopNameMaxChars: config.extraction.routeStop.nameMaxChars,
          maxBeaufort: config.extraction.routeStop.maxBeaufort,
          text: report.sections[section - 1]!,
          fetchedAt: report.fetchedAt.toISOString(),
        };
        return { subjectType: SUBJECT, subjectId: id, input };
      }),
    remainderData: (ids) => ({ sectionIds: ids }),
  });
}

/**
 * Stores the route of an item's version once every section has an answer (succeeded items of the stage on the
 * active route model and prompt, in any run and batch; of several answers to a section the latest), in the
 * distribution transaction (`storeRouteStops`, idempotent); before that it waits. A result of another model or prompt
 * version is dropped and logged. An answer that does not fit the output schema leaves the version without stops.
 */
const researchRouteHandle: BatchHandlerEntry["handle"] = async (db, item, ctx) => {
  const active = activeRouteExtractor(ctx.config);
  if (item.batch.model !== active.model || item.batch.promptVersion !== active.promptVersion) {
    getLog().warn({ subjectId: item.subjectId, model: item.batch.model, promptVersion: item.batch.promptVersion, active }, "stale route dropped");
    return;
  }
  const { versionId } = parseSectionId(item.subjectId);
  const total = (item.input as ResearchRouteItemInput).sections;
  const { rows } = await db.execute<{ subject_id: string; input: ResearchRouteItemInput; output: unknown }>(sql`
    select distinct on (i.subject_id) i.subject_id, i.input, i.output ${routeItems(sql`${itemVersion} = ${versionId}`, ctx.config)} and i.status = 'succeeded'
    order by i.subject_id, i.created_at desc, i.attempt desc, i.id desc`);
  const bySection = new Map(rows.map((r) => [parseSectionId(r.subject_id).section, r]));
  const sections: RouteSectionAnswer[] = [];
  for (let n = 1; n <= total; n++) {
    const row = bySection.get(n);
    if (!row) return;
    const parsed = extractRouteTask.output.safeParse(row.output);
    if (!parsed.success) {
      getLog().warn({ versionId, subjectId: row.subject_id, error: parsed.error.message }, "route section answer does not fit the output schema, no stops");
      return;
    }
    sections.push({ text: row.input.text, output: parsed.data });
  }
  const input = item.input as ResearchRouteItemInput;
  const stored = await storeRouteStops(
    db,
    { documentVersionId: versionId, ...active, observedAt: input.observedAt, fetchedAt: new Date(input.fetchedAt), sections },
    ctx.config,
  );
  getLog().info({ versionId, sections: total, ...stored }, "research route stored");
};

/**
 * Batch handler of `extract-route` for both stages that use the task: items of `research.routes` are stored as research
 * route stops, all others as before by `extraction.route` (`routeSectionBatchEntry`).
 */
export const extractRouteBatchEntry: BatchHandlerEntry = {
  task,
  handle: (db, item, ctx) => (item.batch.stage === RESEARCH_ROUTES_STAGE ? researchRouteHandle(db, item, ctx) : routeSectionBatchEntry.handle(db, item, ctx)),
};

/**
 * Plan of the stage `research.discover`: one job per current version among the hit pages of the run's candidates that
 * has open route stops of the active route model and prompt.
 */
export async function planResearchDiscover(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const placeIds = await researchCandidates(db, researchScope(run.params));
  if (placeIds.length === 0) return [];
  const route = activeRouteExtractor(config);
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct d.current_version_id as id
    from research_hits h join documents d on d.url_normalized = h.url_normalized
    where h.place_id in ${jsonUuids(placeIds)}
      and exists (select 1 from research_route_stops s where s.document_version_id = d.current_version_id
        and s.model = ${route.model} and s.prompt_version = ${route.promptVersion} and s.place_id is null)
    order by id`);
  return rows.map((r) => ({ key: r.id, documentVersionId: r.id }));
}

/** Job `research.discover`: assigns the open route stops of one page (`matchStops`). */
export async function discoverStops(db: Db, job: ResearchDiscoverJob, config: AppConfig = getConfig()) {
  const result = await matchStops(db, job.documentVersionId, config);
  getLog().info({ runId: job.runId, versionId: job.documentVersionId, ...result }, "route stops matched");
  return result;
}

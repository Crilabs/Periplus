import { and, asc, eq, inArray, lt, ne, notExists, notInArray, or, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { extractLandsideTask, type ExtractLandsideInput } from "@/lib/ai/tasks/extract-landside";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, documentVersions, pageAssessments, researchUnits } from "@/lib/db/schema";
import type { ObservedAtBasis } from "@/lib/db/schema/sources";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { noDrops } from "@/lib/domain/research/extraction";
import {
  activeLandsideExtractor,
  LANDSIDE_NOT_NAMED_REASON,
  landsideSubjectNames,
  planLandsideUnits,
  storeLandsideExtraction,
} from "@/lib/domain/research/landside-extraction";
import { candidateNames } from "@/lib/domain/research/queries";
import { expandOffsetRuns, namesOccur, offsetRuns, unitText, type OffsetRun } from "@/lib/domain/research/unit-text";
import type { QueueName } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { submitStageJobBatch } from "@/lib/pipeline/stage-batch";
import { failUnit, GENERATED_REASON, skipUnit } from "./extract";
import { researchScope } from "./search";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

/*
 * Stage `research.landside_extract` (plan N4b): one research unit of kind `landside` per page version and confirmed
 * place whose landside page names one of the place's subjects (`planLandsideUnits`), read by the active model and
 * prompt version of `extract-landside`, as message batches of at most `extraction.unitsPerBatch` units per job. The
 * batch handler stores the verified facts of things on land; the units are never evidence of a berth.
 */

export const RESEARCH_LANDSIDE_EXTRACT_STAGE = "research.landside_extract";
export const RESEARCH_LANDSIDE_EXTRACT_QUEUE = "research.landside_extract" satisfies QueueName;
const SUBJECT = "research_unit";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.research.landside-extract"));

const task = extractLandsideTask as ModelTask<unknown, unknown>;

export type LandsideExtractJob = { runId: string; stage: string; key: string; unitIds: string[] };
export type LandsideExtractDeps = BatchDeps & { archive: Pick<Archive, "get"> };

/** A batch item's input: the task input plus what the handler needs to store the answer against the text the model saw. */
export type LandsideItemInput = ExtractLandsideInput & { offsetRuns: OffsetRun[] | null; observedAtBasis: ObservedAtBasis; fetchedAt: string };

/**
 * Plan of the stage `research.landside_extract`: the landside units of the run's confirmed places
 * (`planLandsideUnits`) are created as `pending` for the active model and prompt version (an existing unit stays as it
 * is), and every unit still pending goes into a job, `unitsPerBatch` per job. A failed unit below
 * `research.extraction.maxAttempts` and a unit skipped for missing Markdown, assessment or as not named (it may name a
 * subject now) are set back to pending when still wanted; a done unit, one failed that often and one skipped as
 * generated text are not planned again. A pending unit of a judged pair that no longer qualifies is skipped.
 */
export async function planLandsideExtract(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
  archive: Pick<Archive, "get">,
): Promise<JobData[]> {
  const placeIds = await researchCandidates(db, researchScope(run.params));
  const { units: plans, judgedPairs } = await planLandsideUnits(db, placeIds, config, archive);
  const { model, promptVersion } = activeLandsideExtractor(config);
  const kept = new Set(plans.map((p) => `${p.documentVersionId}:${p.placeId}`));
  if (judgedPairs.length > 0) {
    const stale = await db
      .select({ id: researchUnits.id, documentVersionId: researchUnits.documentVersionId, placeId: researchUnits.placeId })
      .from(researchUnits)
      .where(
        and(
          inArray(researchUnits.placeId, [...new Set(judgedPairs.map((p) => p.placeId))]),
          inArray(researchUnits.documentVersionId, [...new Set(judgedPairs.map((p) => p.documentVersionId))]),
          eq(researchUnits.kind, "landside"),
          eq(researchUnits.model, model),
          eq(researchUnits.promptVersion, promptVersion),
          eq(researchUnits.status, "pending"),
        ),
      );
    const judged = new Set(judgedPairs.map((p) => `${p.documentVersionId}:${p.placeId}`));
    for (const u of stale) {
      const key = `${u.documentVersionId}:${u.placeId}`;
      if (!judged.has(key) || kept.has(key)) continue;
      await db.update(researchUnits).set({ status: "skipped", reason: LANDSIDE_NOT_NAMED_REASON }).where(and(eq(researchUnits.id, u.id), eq(researchUnits.status, "pending")));
      getLog().warn({ unitId: u.id, reason: LANDSIDE_NOT_NAMED_REASON }, "landside unit skipped");
    }
  }
  if (plans.length === 0) return [];
  await db
    .insert(researchUnits)
    .values(plans.map((p) => ({ ...p, kind: "landside" as const, model, promptVersion, status: "pending" as const, dropped: noDrops(), runId: run.id })))
    .onConflictDoNothing();
  const pairKey = sql`${researchUnits.documentVersionId}::text || ':' || ${researchUnits.placeId}::text`;
  await db
    .update(researchUnits)
    .set({ status: "pending", reason: null })
    .where(
      and(
        inArray(pairKey, [...kept]),
        eq(researchUnits.kind, "landside"),
        eq(researchUnits.model, model),
        eq(researchUnits.promptVersion, promptVersion),
        or(
          and(eq(researchUnits.status, "failed"), lt(researchUnits.attempts, config.research.extraction.maxAttempts)),
          and(eq(researchUnits.status, "skipped"), ne(researchUnits.reason, GENERATED_REASON)),
        ),
      ),
    );
  const rows = await db
    .select({ id: researchUnits.id, documentVersionId: researchUnits.documentVersionId, placeId: researchUnits.placeId })
    .from(researchUnits)
    .where(
      and(
        inArray(researchUnits.documentVersionId, [...new Set(plans.map((p) => p.documentVersionId))]),
        eq(researchUnits.kind, "landside"),
        eq(researchUnits.model, model),
        eq(researchUnits.promptVersion, promptVersion),
        eq(researchUnits.status, "pending"),
      ),
    )
    .orderBy(asc(researchUnits.documentVersionId), asc(researchUnits.placeId));
  const todo = rows.filter((r) => kept.has(`${r.documentVersionId}:${r.placeId}`)).map((r) => r.id);
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < todo.length; i++) jobs.push({ key: `landside-extract:${i}`, unitIds: todo.slice(i * size, (i + 1) * size) });
  return jobs;
}

/** Of `ids`, the landside units still pending for the active extractor and not already in an unfinished batch of the task. */
async function openUnits(db: Db, ids: string[], config: AppConfig): Promise<string[]> {
  if (ids.length === 0) return [];
  const { model, promptVersion } = activeLandsideExtractor(config);
  const rows = await db
    .select({ id: researchUnits.id })
    .from(researchUnits)
    .where(
      and(
        inArray(researchUnits.id, ids),
        eq(researchUnits.kind, "landside"),
        eq(researchUnits.status, "pending"),
        eq(researchUnits.model, model),
        eq(researchUnits.promptVersion, promptVersion),
        notExists(
          db
            .select({ one: aiBatchItems.id })
            .from(aiBatchItems)
            .innerJoin(aiBatches, eq(aiBatches.id, aiBatchItems.batchId))
            .where(
              and(
                eq(aiBatchItems.subjectType, SUBJECT),
                eq(aiBatchItems.subjectId, sql`${researchUnits.id}::text`),
                eq(aiBatches.task, extractLandsideTask.name),
                notInArray(aiBatches.status, ["distributed", "failed"]),
              ),
            ),
        ),
      ),
    );
  const open = new Set(rows.map((r) => r.id));
  return ids.filter((id) => open.has(id));
}

/**
 * The batch items of the landside units, in the given order: the unit text of the page around the place's subject
 * names, the page's kind and observation date from its active assessment. A unit whose page has no active, not
 * generated assessment, whose Markdown is missing or whose page names no subject any more is marked `skipped` with the
 * reason and not sent.
 */
export async function landsideInputs(db: Db, archive: Pick<Archive, "get">, ids: string[], config: AppConfig): Promise<BatchItemInput[]> {
  if (ids.length === 0) return [];
  const assessor = activeAssessor(config);
  const units = await db
    .select({
      id: researchUnits.id,
      placeId: researchUnits.placeId,
      mdKey: documentVersions.mdKey,
      fetchedAt: documentVersions.fetchedAt,
      pageKind: pageAssessments.pageKind,
      generated: pageAssessments.generated,
      observedAt: pageAssessments.observedAt,
      observedAtBasis: pageAssessments.observedAtBasis,
    })
    .from(researchUnits)
    .innerJoin(documentVersions, eq(documentVersions.id, researchUnits.documentVersionId))
    .leftJoin(
      pageAssessments,
      and(
        eq(pageAssessments.documentVersionId, researchUnits.documentVersionId),
        eq(pageAssessments.model, assessor.model),
        eq(pageAssessments.promptVersion, assessor.promptVersion),
      ),
    )
    .where(and(inArray(researchUnits.id, ids), eq(researchUnits.kind, "landside")));
  const placeIds = [...new Set(units.map((u) => u.placeId))];
  const subjects = await landsideSubjectNames(db, placeIds, config);
  const placeNames = new Map<string, string>();
  for (const placeId of placeIds) {
    const c = await candidateNames(db, placeId);
    placeNames.set(placeId, c.names.en ?? Object.values(c.names)[0] ?? "(unnamed)");
  }
  const { minChars, maxChars } = config.extraction.quote;
  const markdown = new Map<string, string | null>();
  const byId = new Map(units.map((u) => [u.id, u]));
  const items: BatchItemInput[] = [];
  for (const id of ids) {
    const unit = byId.get(id);
    if (!unit) continue;
    if (!unit.pageKind || unit.generated || !unit.observedAt || !unit.observedAtBasis) {
      await skipUnit(db, id, unit.generated ? GENERATED_REASON : "page has no active assessment");
      continue;
    }
    if (!markdown.has(unit.mdKey)) {
      const body = await archive.get(unit.mdKey);
      markdown.set(unit.mdKey, body === null ? null : new TextDecoder().decode(body));
    }
    const md = markdown.get(unit.mdKey);
    if (md === null || md === undefined) {
      await skipUnit(db, id, `archived markdown missing (${unit.mdKey})`);
      continue;
    }
    const names = subjects.get(unit.placeId) ?? [];
    const { text, offset } = unitText(md, names, config.research.extraction);
    // the unit exists for the subject names: a page that names none of them (any more) is no landside page
    if (!namesOccur(md, names)) {
      await skipUnit(db, id, LANDSIDE_NOT_NAMED_REASON);
      continue;
    }
    const input: LandsideItemInput = {
      place: placeNames.get(unit.placeId)!,
      subjects: names,
      pageKind: unit.pageKind,
      observedAt: unit.observedAt,
      text,
      limits: { quoteMinChars: minChars, quoteMaxChars: maxChars },
      offsetRuns: offsetRuns(offset),
      observedAtBasis: unit.observedAtBasis,
      fetchedAt: unit.fetchedAt.toISOString(),
    };
    items.push({ subjectType: SUBJECT, subjectId: id, input });
  }
  return items;
}

/** One landside extraction job: its pending units go out as one message batch (see `extractUnits`). Never call it inside a transaction. */
export async function extractLandsideUnits(
  db: Db,
  deps: LandsideExtractDeps,
  job: LandsideExtractJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  return submitStageJobBatch(db, deps, {
    task,
    queue: RESEARCH_LANDSIDE_EXTRACT_QUEUE,
    job,
    subjectIds: job.unitIds,
    open: (ids) => openUnits(db, ids, config),
    inputs: (ids) => landsideInputs(db, deps.archive, ids, config),
    remainderData: (ids) => ({ unitIds: ids }),
  });
}

/**
 * Batch handler of `extract-landside`: stores one unit's verified facts and marks it done, in the distribution
 * transaction. Only a result of the poll's active model and prompt version writes; a stale one is dropped and logged.
 * A unit already done or skipped is left alone; an answer that does not fit the output schema fails only its own unit.
 */
export const extractLandsideBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const active = activeLandsideExtractor(ctx.config);
    if (item.batch.model !== active.model || item.batch.promptVersion !== active.promptVersion) {
      getLog().warn({ unitId: item.subjectId, model: item.batch.model, promptVersion: item.batch.promptVersion, active }, "stale landside extraction dropped");
      return;
    }
    const [unit] = await db.select().from(researchUnits).where(eq(researchUnits.id, item.subjectId)).for("update");
    if (!unit) throw new Error(`research unit ${item.subjectId} does not exist`);
    if (unit.status === "done" || unit.status === "skipped") return;
    if (unit.kind !== "landside") throw new Error(`research unit ${unit.id} is no landside unit`);
    const parsed = extractLandsideTask.output.safeParse(item.output);
    if (!parsed.success) return failUnit(db, unit.id, `answer does not fit the output schema: ${parsed.error.message}`);
    const input = item.input as LandsideItemInput;
    await storeLandsideExtraction(
      db,
      {
        id: unit.id,
        placeId: unit.placeId,
        documentVersionId: unit.documentVersionId,
        text: input.text,
        offset: expandOffsetRuns(input.offsetRuns),
        observedAt: input.observedAt,
        observedAtBasis: input.observedAtBasis,
        fetchedAt: new Date(input.fetchedAt),
      },
      parsed.data,
      ctx.config,
    );
  },
  fail: (db, item) => failUnit(db, item.subjectId, item.error),
};

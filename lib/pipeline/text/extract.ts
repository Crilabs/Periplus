import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import { extractFactsTask, type ExtractFactsInput } from "@/lib/ai/tasks/extract-facts";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, extractionRuns, extractionUnits, facts, type ExtractionPurpose } from "@/lib/db/schema";
import { mentionsExtractedBefore } from "@/lib/domain/extraction/active-run";
import { comparisonMentionIds } from "@/lib/domain/extraction/comparison";
import { failUnitMentions } from "@/lib/domain/extraction/unit-status";
import { completeUnit, emptyFactStats, FACT_STAT_KEYS, processFactOutput, type FactStats } from "@/lib/domain/extraction/facts";
import { planUnits } from "@/lib/domain/extraction/units";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { effectiveVersionMeta } from "@/lib/domain/mentions/classification";
import { jsonUuids } from "@/lib/domain/mentions/scope";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { batchOutcomeKey, type BatchDeps, type BatchHandlerEntry, type BatchItemInput } from "@/lib/pipeline/batches";
import { candidateDetails } from "./disambiguate";
import { submitStageJobBatch } from "./stage-batch";
import { frozenRunVersions, textRunParamsSchema } from "./versions";

/*
 * Stage `extraction.mention` (spec 06, stage 7): the mentions of the run's versions become extraction units (per
 * version and geo object, with neighbour chunks), which go to the `extract-facts` task as message batches of
 * `unitsPerBatch` units per job. All units of a run and model belong to one extraction run (`extraction_runs`), whose
 * facts carry its id. The batch handler stores the verified facts of a unit and marks it done with its counters,
 * tokens and cost (ruling M4-P9); a unit whose request failed for good is marked failed, and so are its mentions
 * (ruling M4-G-R3). Model, prompt version and fact schema version are those of the extraction run, frozen when it was
 * planned: a config change in the middle of a run does not split it.
 */

export const EXTRACT_STAGE = "extraction.mention";
export const EXTRACT_QUEUE = "extraction.mention" as const;
export const EXTRACT_FACTS_TASK = "extract-facts";
const SUBJECT = "extraction_unit";

const task = extractFactsTask as ModelTask<unknown, unknown>;

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.text.extract"));

export type ExtractJob = { runId: string; stage: string; key: string; extractionRunId: string; unitIds: string[] };

/**
 * The extraction run of a text run for a task and model, created once: unique per `(runId, task, model)`, so a
 * repeated plan finds the same one. Its fact schema version is the active one; model, prompt version and fact schema
 * version stay frozen on the row, and every request and fact of the run takes them from there.
 *
 * Lifecycle (ruling M4-G-R3 f, for Tasks 15 and 17): the row is created `running` here; finishing it (`finished` or
 * `blocked` with `finished_at`, after the quote check) and writing `extractionRunStats` belong to the stage
 * `extraction.check`, which must also run for a comparison run's extraction runs.
 */
export async function ensureExtractionRun(
  db: Db,
  input: { runId: string; task: "extract-facts" | "extract-route"; model: string; promptVersion: number; purpose: ExtractionPurpose; comparisonId?: string },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  await db
    .insert(extractionRuns)
    .values({
      runId: input.runId,
      task: input.task,
      model: input.model,
      promptVersion: input.promptVersion,
      factSchemaVersion: config.factSchema.version,
      purpose: input.purpose,
      comparisonId: input.comparisonId ?? null,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: extractionRuns.id })
    .from(extractionRuns)
    .where(and(eq(extractionRuns.runId, input.runId), eq(extractionRuns.task, input.task), eq(extractionRuns.model, input.model)));
  if (!row) throw new Error(`extraction run of run ${input.runId} (${input.task}, ${input.model}) was not created`);
  return row;
}

/**
 * Plan (in the stage's plan transaction), from the run's frozen version set (ruling M4-E-R2):
 * - regular and rematch runs claim the pending mentions of the versions (`pending → done`, conditional, ruling
 *   M4-P17), so two overlapping runs never extract the same mention; claimed mentions of objects without a fact level
 *   become `skipped` and cost nothing; claimed mentions an eligible extraction run has extracted already (a reprocess
 *   run's match added them, `mentionsExtractedBefore`) stay `done` and are not paid for again;
 * - a reprocess run (`params.reprocess`) takes every mention of the versions, whatever its status, and claims nothing;
 * - a model comparison run (`params.comparisonId`) plans `planComparisonExtraction` instead.
 * The units go into the extraction run of the configured model (purpose `regular` or `reprocess`); one job per
 * `unitsPerBatch` of the run's pending units, in id order (a repeated plan plans the same jobs).
 */
export async function planExtraction(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const params = textRunParamsSchema.parse(run.params);
  if (params.comparisonId) return planComparisonExtraction(db, run.id, params.comparisonId, params.models ?? config.models.comparison.models, config);
  const versions = await frozenRunVersions(db, run.params);
  if (versions.length === 0) return [];
  const reprocess = params.reprocess === true;
  let mentionIds: string[];
  if (reprocess) mentionIds = await allMentions(db, versions);
  else {
    const claimed = await claimPendingMentions(db, versions);
    const before = new Set(await mentionsExtractedBefore(db, claimed, config));
    mentionIds = claimed.filter((id) => !before.has(id));
  }
  const { units, skipped } = await planUnits(db, mentionIds, config.extraction.unit);
  if (!reprocess && skipped.length > 0) {
    await db.execute(sql`update mentions set extraction_status = 'skipped' where id in ${jsonUuids(skipped)} and extraction_status = 'done'`);
  }
  const existing = await db
    .select({ id: extractionRuns.id })
    .from(extractionRuns)
    .where(and(eq(extractionRuns.runId, run.id), eq(extractionRuns.task, EXTRACT_FACTS_TASK)));
  if (units.length === 0 && existing.length === 0) return [];

  const { model, taskConfig } = resolveTaskModel(config, EXTRACT_FACTS_TASK);
  const { id: extractionRunId } = await ensureExtractionRun(
    db,
    { runId: run.id, task: EXTRACT_FACTS_TASK, model, promptVersion: taskConfig.promptVersion, purpose: reprocess ? "reprocess" : "regular" },
    config,
  );
  if (units.length > 0) {
    await db
      .insert(extractionUnits)
      .values(
        units.map((u) => ({
          extractionRunId,
          documentVersionId: u.documentVersionId,
          geoObjectId: u.geoObjectId,
          part: u.part,
          level: u.level,
          mentionIds: u.mentionIds,
          chunkIds: u.chunkIds,
        })),
      )
      .onConflictDoNothing();
  }
  const pending = await db
    .select({ id: extractionUnits.id })
    .from(extractionUnits)
    .where(and(eq(extractionUnits.extractionRunId, extractionRunId), eq(extractionUnits.status, "pending")))
    .orderBy(asc(extractionUnits.id));
  const ids = pending.map((r) => r.id);
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < ids.length; i++) {
    jobs.push({ key: `extract:${i}`, extractionRunId, unitIds: ids.slice(i * size, (i + 1) * size) });
  }
  getLog().info({ runId: run.id, extractionRunId, units: units.length, skipped: skipped.length, jobs: jobs.length }, "extraction planned");
  return jobs;
}

/**
 * Plan of a model comparison run (spec 06, Task 19): the comparison's units (`model_comparison_units`) are planned like
 * regular units and go into one extraction run per comparison model (purpose `comparison`, with the comparison's id,
 * the configured prompt version and the active fact schema), each with its own jobs (`compare:<model index>:<n>`). No
 * mention is claimed or changes status: the regular extraction of these mentions is not touched.
 */
async function planComparisonExtraction(db: Db, runId: string, comparisonId: string, models: string[], config: AppConfig): Promise<JobData[]> {
  const { units } = await planUnits(db, await comparisonMentionIds(db, comparisonId), config.extraction.unit);
  const { taskConfig } = resolveTaskModel(config, EXTRACT_FACTS_TASK);
  const jobs: JobData[] = [];
  for (const [index, model] of models.entries()) {
    const { id: extractionRunId } = await ensureExtractionRun(
      db,
      { runId, task: EXTRACT_FACTS_TASK, model, promptVersion: taskConfig.promptVersion, purpose: "comparison", comparisonId },
      config,
    );
    if (units.length > 0) {
      await db
        .insert(extractionUnits)
        .values(units.map((u) => ({ extractionRunId, documentVersionId: u.documentVersionId, geoObjectId: u.geoObjectId, part: u.part, level: u.level, mentionIds: u.mentionIds, chunkIds: u.chunkIds })))
        .onConflictDoNothing();
    }
    const pending = await db
      .select({ id: extractionUnits.id })
      .from(extractionUnits)
      .where(and(eq(extractionUnits.extractionRunId, extractionRunId), eq(extractionUnits.status, "pending")))
      .orderBy(asc(extractionUnits.id));
    const ids = pending.map((r) => r.id);
    const size = config.extraction.unitsPerBatch;
    for (let i = 0; i * size < ids.length; i++) {
      jobs.push({ key: `compare:${index}:${i}`, extractionRunId, unitIds: ids.slice(i * size, (i + 1) * size) });
    }
  }
  getLog().info({ runId, comparisonId, models, units: units.length, jobs: jobs.length }, "comparison extraction planned");
  return jobs;
}

/** Claims the pending mentions of the versions for this plan (`pending → done`), returning the claimed ids. */
async function claimPendingMentions(db: Db, versions: string[]): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    update mentions set extraction_status = 'done'
    where document_version_id in ${jsonUuids(versions)} and extraction_status = 'pending'
    returning id
  `);
  return rows.map((r) => r.id);
}

async function allMentions(db: Db, versions: string[]): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`select id from mentions where document_version_id in ${jsonUuids(versions)}`);
  return rows.map((r) => r.id);
}

/**
 * The task inputs of extraction units: level, the fact schema version of the unit's extraction run, the fact limit
 * from config, the object (name, type, parents), the version's effective document type and observation date, and the
 * unit's chunks numbered from 1. A unit that does not exist, or whose object or chunks
 * are gone, is left out and logged.
 */
export async function unitInputs(db: Db, unitIds: string[], config: AppConfig = getConfig()): Promise<Map<string, ExtractFactsInput>> {
  const out = new Map<string, ExtractFactsInput>();
  if (unitIds.length === 0) return out;
  const units = await db.select().from(extractionUnits).where(inArray(extractionUnits.id, unitIds));
  const runIds = [...new Set(units.map((u) => u.extractionRunId))];
  const runRows =
    runIds.length === 0
      ? []
      : await db.select({ id: extractionRuns.id, factSchemaVersion: extractionRuns.factSchemaVersion }).from(extractionRuns).where(inArray(extractionRuns.id, runIds));
  const schemaOf = new Map(runRows.map((r) => [r.id, r.factSchemaVersion]));
  const chunkIds = [...new Set(units.flatMap((u) => u.chunkIds))];
  const chunkRows = chunkIds.length === 0 ? [] : await db.select({ id: chunks.id, text: chunks.text }).from(chunks).where(inArray(chunks.id, chunkIds));
  const texts = new Map(chunkRows.map((c) => [c.id, c.text]));
  const objects = await candidateDetails(db, [...new Set(units.map((u) => u.geoObjectId))]);
  const metas = new Map<string, Awaited<ReturnType<typeof effectiveVersionMeta>>>();
  for (const versionId of new Set(units.map((u) => u.documentVersionId))) metas.set(versionId, await effectiveVersionMeta(db, versionId));
  for (const u of units) {
    const object = objects.get(u.geoObjectId);
    const unitTexts = u.chunkIds.map((id) => texts.get(id));
    if (!object || unitTexts.some((t) => t === undefined)) {
      getLog().warn({ unitId: u.id }, "extraction unit's object or chunks missing, left out of the batch");
      continue;
    }
    const meta = metas.get(u.documentVersionId)!;
    out.set(u.id, {
      level: u.level as FactLevel,
      factSchemaVersion: schemaOf.get(u.extractionRunId) ?? config.factSchema.version,
      maxFacts: config.extraction.maxFactsPerUnit,
      limits: { quoteMinChars: config.extraction.quote.minChars, quoteMaxChars: config.extraction.quote.maxChars, nameMaxChars: config.extraction.properNameMaxChars },
      object: { name: object.name, type: object.type, parents: object.parents },
      docType: meta.docType,
      observedAt: meta.observedAt,
      chunks: unitTexts.map((text, i) => ({ n: i + 1, text: text! })),
    });
  }
  for (const id of unitIds) if (!units.some((u) => u.id === id)) getLog().warn({ unitId: id }, "extraction unit missing, left out of the batch");
  return out;
}

/** The task input of one extraction unit (`unitInputs`); throws when it cannot be built. */
export async function unitInput(db: Db, unitId: string, config: AppConfig = getConfig()): Promise<ExtractFactsInput> {
  const input = (await unitInputs(db, [unitId], config)).get(unitId);
  if (!input) throw new Error(`extraction unit ${unitId}, its object or its chunks do not exist`);
  return input;
}

/** Of `ids`, the units still pending, in the given order. */
async function pendingUnits(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: extractionUnits.id })
    .from(extractionUnits)
    .where(and(inArray(extractionUnits.id, ids), eq(extractionUnits.status, "pending")));
  const open = new Set(rows.map((r) => r.id));
  return ids.filter((id) => open.has(id));
}

/**
 * One extraction job: its pending units go out as one message batch on the extraction run's model and prompt version,
 * sized to the
 * budget headroom (`submitStageJobBatch`; the rest goes to one follow-on job); the units in the batch become
 * `submitted`. A retried job reuses its batch. Never call it inside a transaction.
 */
export async function extractUnits(
  db: Db,
  deps: BatchDeps,
  job: ExtractJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const [run] = await db
    .select({ model: extractionRuns.model, promptVersion: extractionRuns.promptVersion })
    .from(extractionRuns)
    .where(eq(extractionRuns.id, job.extractionRunId));
  if (!run) throw new Error(`extraction run ${job.extractionRunId} does not exist`);
  const result = await submitStageJobBatch(db, deps, {
    task,
    queue: EXTRACT_QUEUE,
    job,
    subjectIds: job.unitIds,
    modelOverride: run.model,
    promptVersionOverride: run.promptVersion,
    open: (ids) => pendingUnits(db, ids),
    inputs: async (ids) => {
      const inputs = await unitInputs(db, ids, deps.config);
      const items: BatchItemInput[] = [];
      for (const id of ids) {
        const input = inputs.get(id);
        if (input) items.push({ subjectType: SUBJECT, subjectId: id, input });
      }
      return items;
    },
    remainderData: (ids) => ({ extractionRunId: job.extractionRunId, unitIds: ids }),
  });
  await db.execute(sql`
    update extraction_units set status = 'submitted', updated_at = now()
    where status = 'pending' and id::text in (
      select i.subject_id from ai_batch_items i join ai_batches b on b.id = i.batch_id
      where b.run_id = ${job.runId} and b.stage = ${job.stage} and b.outcome_key = ${batchOutcomeKey(job.key)}
        and i.subject_type = ${SUBJECT}
    )
  `);
  return result;
}

/** Tokens and cost billed for a unit over all its batch attempts (a retried first attempt is billed too). */
async function billedOfUnit(db: Db, unitId: string): Promise<{ usage: { inputTokens: number; outputTokens: number }; costEur: number }> {
  const { rows } = await db.execute<{ input_tokens: number; output_tokens: number; cost_eur: number }>(sql`
    select coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens,
      coalesce(sum(cost_eur), 0)::float8 as cost_eur
    from ai_batch_items where subject_type = ${SUBJECT} and subject_id = ${unitId}
  `);
  const row = rows[0]!;
  return { usage: { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) }, costEur: Number(row.cost_eur) };
}

/**
 * Marks a unit failed with what it was billed and its claimed mentions `failed`; a done unit stays done. Idempotent,
 * so a fail reported more than once changes nothing more.
 */
async function failUnit(db: Db, unitId: string, error: string | null): Promise<void> {
  const billed = await billedOfUnit(db, unitId);
  const rows = await db
    .update(extractionUnits)
    .set({
      status: "failed",
      inputTokens: billed.usage.inputTokens,
      outputTokens: billed.usage.outputTokens,
      costEur: billed.costEur.toFixed(6),
      updatedAt: sql`now()`,
    })
    .where(and(eq(extractionUnits.id, unitId), sql`${extractionUnits.status} <> 'done'`))
    .returning({ id: extractionUnits.id });
  if (rows.length === 0) return;
  await failUnitMentions(db, [unitId]);
  getLog().warn({ unitId, error }, "extraction unit failed");
}

/**
 * Batch handler of `extract-facts`: stores the verified facts of one unit and marks it done with its counters and the
 * tokens and cost of all its attempts, in the distribution transaction (ruling M4-P9); a unit already done is left
 * alone. An answer that does not fit the output schema fails only its own unit (no retry: the same answer would fail
 * again; the other items are distributed as usual). An item that failed for good, or that is given up undistributed,
 * marks its unit failed (at least once, idempotent).
 */
export const extractFactsBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const [unit] = await db.select().from(extractionUnits).where(eq(extractionUnits.id, item.subjectId)).for("update");
    if (!unit) throw new Error(`extraction unit ${item.subjectId} does not exist`);
    if (unit.status === "done") return;
    const parsed = extractFactsTask.output.safeParse(item.output);
    if (!parsed.success) return failUnit(db, unit.id, `answer does not fit the output schema: ${parsed.error.message}`);
    const stats = await processFactOutput(
      db,
      {
        id: unit.id,
        extractionRunId: unit.extractionRunId,
        documentVersionId: unit.documentVersionId,
        geoObjectId: unit.geoObjectId,
        level: unit.level as FactLevel,
        mentionIds: unit.mentionIds,
        chunkIds: unit.chunkIds,
      },
      parsed.data,
      ctx.config,
    );
    const billed = await billedOfUnit(db, unit.id);
    await completeUnit(db, unit.id, stats, billed.usage, billed.costEur);
  },
  fail: (db, item) => failUnit(db, item.subjectId, item.error),
};

export type ExtractionRunStats = { units: number; done: number; failed: number; facts: number } & FactStats & {
    costEur: number;
    costPerMentionEur: number | null;
  };

/**
 * The counters of an extraction run, written to `extraction_runs.stats`: units (all, done, failed), stored facts, the
 * summed fact counters of its units, its cost (every billed batch item of its units, all attempts) and the cost per
 * mention sent to the model (null without any).
 */
export async function extractionRunStats(db: Db, extractionRunId: string): Promise<ExtractionRunStats> {
  const units = await db
    .select({ status: extractionUnits.status, stats: extractionUnits.stats, costEur: extractionUnits.costEur, mentionIds: extractionUnits.mentionIds })
    .from(extractionUnits)
    .where(eq(extractionUnits.extractionRunId, extractionRunId));
  const [factCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(facts)
    .where(eq(facts.extractionRunId, extractionRunId));
  // Every billed attempt of every unit, also a retried first attempt and what the booking of an expired batch wrote
  // onto its failed items (ruling M4-G-R3), so the cost per mention is not understated.
  const { rows: billed } = await db.execute<{ cost_eur: number }>(sql`
    select coalesce(sum(i.cost_eur), 0)::float8 as cost_eur
    from ai_batch_items i join extraction_units u on i.subject_type = ${SUBJECT} and i.subject_id = u.id::text
    where u.extraction_run_id = ${extractionRunId}
  `);
  const costEur = Number(billed[0]!.cost_eur);
  const sums = emptyFactStats();
  const mentionIds = new Set<string>();
  for (const u of units) {
    const s = (u.stats ?? {}) as Partial<FactStats>;
    for (const k of FACT_STAT_KEYS) sums[k] += Number(s[k] ?? 0);
    for (const id of u.mentionIds) mentionIds.add(id);
  }
  const stats: ExtractionRunStats = {
    units: units.length,
    done: units.filter((u) => u.status === "done").length,
    failed: units.filter((u) => u.status === "failed").length,
    facts: factCount!.n,
    ...sums,
    costEur: Number(costEur.toFixed(6)),
    costPerMentionEur: mentionIds.size > 0 ? Number((costEur / mentionIds.size).toFixed(6)) : null,
  };
  await db.update(extractionRuns).set({ stats }).where(eq(extractionRuns.id, extractionRunId));
  return stats;
}

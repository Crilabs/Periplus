import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import { extractFactsTask, type ExtractFactsInput } from "@/lib/ai/tasks/extract-facts";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, extractionRuns, extractionUnits, facts, type ExtractionPurpose } from "@/lib/db/schema";
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
 * tokens and cost (ruling M4-P9); a unit whose request failed for good is marked failed.
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
 * repeated plan finds the same one. Its fact schema version is the active one.
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
 *   become `skipped` and cost nothing;
 * - a reprocess run (`params.reprocess`) takes every mention of the versions, whatever its status, and claims nothing.
 * The units go into the extraction run of the configured model (purpose `regular` or `reprocess`); one job per
 * `unitsPerBatch` of the run's pending units, in id order (a repeated plan plans the same jobs).
 */
export async function planExtraction(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const params = textRunParamsSchema.parse(run.params);
  const versions = await frozenRunVersions(db, run.params);
  if (versions.length === 0) return [];
  const reprocess = params.reprocess === true;
  const mentionIds = reprocess ? await allMentions(db, versions) : await claimPendingMentions(db, versions);
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
 * The task inputs of extraction units: level, the object (name, type, parents), the version's effective document type
 * and observation date, and the unit's chunks numbered from 1. A unit that does not exist, or whose object or chunks
 * are gone, is left out and logged.
 */
export async function unitInputs(db: Db, unitIds: string[]): Promise<Map<string, ExtractFactsInput>> {
  const out = new Map<string, ExtractFactsInput>();
  if (unitIds.length === 0) return out;
  const units = await db.select().from(extractionUnits).where(inArray(extractionUnits.id, unitIds));
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
export async function unitInput(db: Db, unitId: string): Promise<ExtractFactsInput> {
  const input = (await unitInputs(db, [unitId])).get(unitId);
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
 * One extraction job: its pending units go out as one message batch on the extraction run's model, sized to the
 * budget headroom (`submitStageJobBatch`; the rest goes to one follow-on job); the units in the batch become
 * `submitted`. A retried job reuses its batch. Never call it inside a transaction.
 */
export async function extractUnits(
  db: Db,
  deps: BatchDeps,
  job: ExtractJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const [run] = await db.select({ model: extractionRuns.model }).from(extractionRuns).where(eq(extractionRuns.id, job.extractionRunId));
  if (!run) throw new Error(`extraction run ${job.extractionRunId} does not exist`);
  const result = await submitStageJobBatch(db, deps, {
    task,
    queue: EXTRACT_QUEUE,
    job,
    subjectIds: job.unitIds,
    modelOverride: run.model,
    open: (ids) => pendingUnits(db, ids),
    inputs: async (ids) => {
      const inputs = await unitInputs(db, ids);
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

/**
 * Batch handler of `extract-facts`: stores the verified facts of one unit and marks it done with its counters, tokens
 * and cost, in the distribution transaction (ruling M4-P9); a unit already done is left alone. An item that failed for
 * good marks its unit failed (with what it was billed).
 */
export const extractFactsBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const [unit] = await db.select().from(extractionUnits).where(eq(extractionUnits.id, item.subjectId)).for("update");
    if (!unit) throw new Error(`extraction unit ${item.subjectId} does not exist`);
    if (unit.status === "done") return;
    const out = extractFactsTask.output.parse(item.output);
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
      out,
      ctx.config,
    );
    await completeUnit(db, unit.id, stats, item.usage, item.costEur);
  },
  fail: async (db, item) => {
    await db
      .update(extractionUnits)
      .set({
        status: "failed",
        inputTokens: item.usage.inputTokens,
        outputTokens: item.usage.outputTokens,
        costEur: item.costEur.toFixed(6),
        updatedAt: sql`now()`,
      })
      .where(and(eq(extractionUnits.id, item.subjectId), sql`${extractionUnits.status} <> 'done'`));
    getLog().warn({ unitId: item.subjectId, error: item.error }, "extraction unit failed");
  },
};

export type ExtractionRunStats = { units: number; done: number; failed: number; facts: number } & FactStats & {
    costEur: number;
    costPerMentionEur: number | null;
  };

/**
 * The counters of an extraction run, written to `extraction_runs.stats`: units (all, done, failed), stored facts, the
 * summed fact counters of its units, its cost (tokens billed for done and failed units) and the cost per mention sent
 * to the model (null without any).
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
  const sums = emptyFactStats();
  let costEur = 0;
  const mentionIds = new Set<string>();
  for (const u of units) {
    const s = (u.stats ?? {}) as Partial<FactStats>;
    for (const k of FACT_STAT_KEYS) sums[k] += Number(s[k] ?? 0);
    costEur += Number(u.costEur ?? 0);
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

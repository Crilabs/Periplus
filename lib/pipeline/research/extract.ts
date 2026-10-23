import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { resolveTaskModel } from "@/lib/ai/cost";
import { extractBerthTask, type ExtractBerthInput } from "@/lib/ai/tasks/extract-berth";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documentVersions, geoNames, pageAssessments, places, researchUnits } from "@/lib/db/schema";
import type { ObservedAtBasis } from "@/lib/db/schema/sources";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { unitsForPlaces } from "@/lib/domain/research/assign";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { berthAttributes, storeExtraction } from "@/lib/domain/research/extraction";
import { candidateNames } from "@/lib/domain/research/queries";
import { expandOffsetRuns, offsetRuns, unitText, type OffsetRun } from "@/lib/domain/research/unit-text";
import type { QueueName } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { submitStageJobBatch } from "@/lib/pipeline/text/stage-batch";
import { researchScope } from "./search";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

/*
 * Stage `research.extract` (plan N2): one research unit per page version and berth candidate the page treats
 * (`unitsForPlaces`), read by the active model and prompt version of `extract-berth`, as message batches of at most
 * `extraction.unitsPerBatch` units per job. Two berths on one page are two units, two requests and two answers: each
 * answer is stored only at its own berth. The batch handler stores the verified elements (`storeExtraction`).
 */

export const RESEARCH_EXTRACT_STAGE = "research.extract";
// The queue is registered with the stage (plan N2, task 7, which removes this cast); until then it is only the target of follow-on jobs.
export const RESEARCH_EXTRACT_QUEUE = "research.extract" as QueueName;
const SUBJECT = "research_unit";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.research.extract"));

const task = extractBerthTask as ModelTask<unknown, unknown>;

export type ExtractJob = { runId: string; stage: string; key: string; unitIds: string[] };
export type ExtractDeps = BatchDeps & { archive: Pick<Archive, "get"> };

/**
 * A batch item's input: the task input plus what the handler needs to store the answer against the text the model
 * saw (the offset map as runs, the page's observation basis and fetch time). Only the task input reaches the prompt.
 */
export type ExtractItemInput = ExtractBerthInput & { offsetRuns: OffsetRun[] | null; observedAtBasis: ObservedAtBasis; fetchedAt: string };

/** The model and prompt version the configuration extracts with now. */
export function activeExtractor(config: AppConfig = getConfig()): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, extractBerthTask.name);
  return { model, promptVersion: taskConfig.promptVersion };
}

/**
 * Plan of the stage `research.extract`: the research units of the run's candidates (`unitsForPlaces`) are created as
 * `pending` for the active model and prompt version (an existing unit stays as it is), and every unit still pending
 * goes into a job, `unitsPerBatch` per job. Units already `done` or `failed` are not planned again.
 */
export async function planResearchExtract(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const placeIds = await researchCandidates(db, researchScope(run.params));
  const plans = await unitsForPlaces(db, placeIds, config);
  const pairs = plans.flatMap((p) => p.placeIds.map((placeId) => ({ documentVersionId: p.documentVersionId, placeId })));
  if (pairs.length === 0) return [];
  const { model, promptVersion } = activeExtractor(config);
  await db
    .insert(researchUnits)
    .values(pairs.map((p) => ({ ...p, model, promptVersion, status: "pending" as const, dropped: { quote: 0, value: 0, verbatim: 0 }, runId: run.id })))
    .onConflictDoNothing();
  const wanted = new Set(pairs.map((p) => `${p.documentVersionId}:${p.placeId}`));
  const rows = await db
    .select({ id: researchUnits.id, documentVersionId: researchUnits.documentVersionId, placeId: researchUnits.placeId })
    .from(researchUnits)
    .where(
      and(
        inArray(researchUnits.documentVersionId, [...new Set(pairs.map((p) => p.documentVersionId))]),
        eq(researchUnits.model, model),
        eq(researchUnits.promptVersion, promptVersion),
        eq(researchUnits.status, "pending"),
      ),
    )
    .orderBy(asc(researchUnits.documentVersionId), asc(researchUnits.placeId));
  const todo = rows.filter((r) => wanted.has(`${r.documentVersionId}:${r.placeId}`)).map((r) => r.id);
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < todo.length; i++) {
    jobs.push({ key: `extract:${i}`, unitIds: todo.slice(i * size, (i + 1) * size) });
  }
  return jobs;
}

/** Of `ids`, the units still pending for the active model and prompt version, in the given order. */
async function openUnits(db: Db, ids: string[], config: AppConfig): Promise<string[]> {
  if (ids.length === 0) return [];
  const { model, promptVersion } = activeExtractor(config);
  const rows = await db
    .select({ id: researchUnits.id })
    .from(researchUnits)
    .where(
      and(inArray(researchUnits.id, ids), eq(researchUnits.status, "pending"), eq(researchUnits.model, model), eq(researchUnits.promptVersion, promptVersion)),
    );
  const open = new Set(rows.map((r) => r.id));
  return ids.filter((id) => open.has(id));
}

type Berth = ExtractBerthInput["berth"];

/** Name, all valid names, kind and island of each place; the name is the preferred English one where there is one. */
async function berthsOf(db: Db, placeIds: string[]): Promise<Map<string, Berth>> {
  const out = new Map<string, Berth>();
  if (placeIds.length === 0) return out;
  const rows = await db
    .select({ placeId: places.id, kind: places.kind, name: geoNames.name })
    .from(places)
    .leftJoin(geoNames, and(eq(geoNames.geoObjectId, places.geoObjectId), isNull(geoNames.validTo)))
    .where(inArray(places.id, placeIds))
    .orderBy(asc(geoNames.name));
  const all = new Map<string, { kind: Berth["kind"]; names: string[] }>();
  for (const r of rows) {
    const entry = all.get(r.placeId) ?? all.set(r.placeId, { kind: r.kind, names: [] }).get(r.placeId)!;
    if (r.name && !entry.names.includes(r.name)) entry.names.push(r.name);
  }
  for (const [placeId, { kind, names }] of all) {
    const preferred = await candidateNames(db, placeId);
    const name = preferred.names.en ?? Object.values(preferred.names)[0] ?? names[0] ?? "(unnamed)";
    const island = preferred.island ? (preferred.island.en ?? Object.values(preferred.island)[0] ?? null) : null;
    out.set(placeId, { name, names: names.length > 0 ? names : [name], kind, island });
  }
  return out;
}

/**
 * The batch items of the units, in the given order: the unit text of the page around the berth's names, the other
 * berths of the page (the other units of the version), the page's kind and observation date from its active
 * assessment. A unit whose page has no active, not generated assessment or whose Markdown is missing is skipped.
 */
export async function extractInputs(db: Db, archive: Pick<Archive, "get">, ids: string[], config: AppConfig): Promise<BatchItemInput[]> {
  if (ids.length === 0) return [];
  const assessor = activeAssessor(config);
  const units = await db
    .select({
      id: researchUnits.id,
      placeId: researchUnits.placeId,
      versionId: researchUnits.documentVersionId,
      model: researchUnits.model,
      promptVersion: researchUnits.promptVersion,
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
    .where(inArray(researchUnits.id, ids));
  const versionIds = [...new Set(units.map((u) => u.versionId))];
  const siblings = versionIds.length === 0 ? [] : await db
    .select({ versionId: researchUnits.documentVersionId, placeId: researchUnits.placeId, model: researchUnits.model, promptVersion: researchUnits.promptVersion })
    .from(researchUnits)
    .where(and(inArray(researchUnits.documentVersionId, versionIds), ne(researchUnits.status, "skipped")));
  const berths = await berthsOf(db, [...new Set([...units.map((u) => u.placeId), ...siblings.map((s) => s.placeId)])]);
  const attributes = berthAttributes(config.research.extraction.factSchema);
  const { minChars, maxChars } = config.extraction.quote;
  const markdown = new Map<string, string | null>();

  const byId = new Map(units.map((u) => [u.id, u]));
  const items: BatchItemInput[] = [];
  for (const id of ids) {
    const unit = byId.get(id);
    if (!unit) continue;
    if (!unit.pageKind || unit.generated || !unit.observedAt || !unit.observedAtBasis) {
      getLog().warn({ unitId: id, versionId: unit.versionId }, "page without an active, not generated assessment, unit not extracted");
      continue;
    }
    if (!markdown.has(unit.mdKey)) {
      const body = await archive.get(unit.mdKey);
      markdown.set(unit.mdKey, body === null ? null : new TextDecoder().decode(body));
    }
    const md = markdown.get(unit.mdKey);
    if (md === null || md === undefined) {
      getLog().warn({ unitId: id, mdKey: unit.mdKey }, "archived markdown missing, unit not extracted");
      continue;
    }
    const berth = berths.get(unit.placeId)!;
    const otherBerths = [
      ...new Set(
        siblings
          .filter((s) => s.versionId === unit.versionId && s.placeId !== unit.placeId && s.model === unit.model && s.promptVersion === unit.promptVersion)
          .map((s) => berths.get(s.placeId)?.name)
          .filter((n): n is string => !!n && n !== berth.name),
      ),
    ].sort();
    const { text, offset } = unitText(md, berth.names, config.research.extraction);
    const input: ExtractItemInput = {
      berth,
      otherBerths,
      pageKind: unit.pageKind,
      observedAt: unit.observedAt,
      attributes,
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

/**
 * One extraction job: its units still pending go out as one message batch, sized to today's anthropic headroom; what
 * does not fit goes to a follow-on job, no room at all defers the job (`BudgetExceeded`). A retried job reuses its
 * batch. Never call it inside a transaction.
 */
export async function extractUnits(
  db: Db,
  deps: ExtractDeps,
  job: ExtractJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  return submitStageJobBatch(db, deps, {
    task,
    queue: RESEARCH_EXTRACT_QUEUE,
    job,
    subjectIds: job.unitIds,
    open: (ids) => openUnits(db, ids, config),
    inputs: (ids) => extractInputs(db, deps.archive, ids, config),
    remainderData: (ids) => ({ unitIds: ids }),
  });
}

/** Marks a unit failed with the reason; a unit already done stays done (idempotent). */
async function failUnit(db: Db, unitId: string, reason: string | null): Promise<void> {
  const rows = await db
    .update(researchUnits)
    .set({ status: "failed", reason: reason ?? "failed" })
    .where(and(eq(researchUnits.id, unitId), ne(researchUnits.status, "done")))
    .returning({ id: researchUnits.id });
  if (rows.length > 0) getLog().warn({ unitId, reason }, "research unit failed");
}

/**
 * Batch handler of `extract-berth`: stores one unit's verified elements and marks it done, in the distribution
 * transaction. Only a result of the poll's active model and prompt version (`ctx.config`) writes; a stale one is
 * dropped and logged. A unit already done is left alone; an answer that does not fit the output schema fails only its
 * own unit. An item that failed for good, or that is given up undistributed, marks its unit failed with the reason.
 */
export const extractBerthBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const active = activeExtractor(ctx.config);
    if (item.batch.model !== active.model || item.batch.promptVersion !== active.promptVersion) {
      getLog().warn({ unitId: item.subjectId, model: item.batch.model, promptVersion: item.batch.promptVersion, active }, "stale berth extraction dropped");
      return;
    }
    const [unit] = await db.select().from(researchUnits).where(eq(researchUnits.id, item.subjectId)).for("update");
    if (!unit) throw new Error(`research unit ${item.subjectId} does not exist`);
    if (unit.status === "done") return;
    const parsed = extractBerthTask.output.safeParse(item.output);
    if (!parsed.success) return failUnit(db, unit.id, `answer does not fit the output schema: ${parsed.error.message}`);
    const input = item.input as ExtractItemInput;
    await storeExtraction(
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

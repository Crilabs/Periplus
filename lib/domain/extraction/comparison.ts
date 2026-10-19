import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import {
  DOC_TYPES,
  modelComparisonRatings,
  modelComparisons,
  modelComparisonUnits,
  type ComparisonVerdict,
  type DocType,
} from "@/lib/db/schema";
import { levelFor } from "@/lib/domain/facts/levels";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { factViewsByIds, type FactView } from "@/lib/domain/geo-facts";
import { planUnits } from "./units";

/*
 * The model comparison of the extraction (spec 06): "200 Erwähnungen aus mindestens 8 Quellen und allen
 * Dokumenttypen", extracted by both comparison models (`config/models.json` `comparison.models`) in one run, then
 * compared per (unit, attribute) and judged by hand on a "Stichprobe von 50 Abweichungen". A unit of the comparison is
 * a (document version, geo object) with its mentions, as in the regular extraction. Model A is `models[0]`, model B
 * `models[1]`. The comparison's facts stay in the database; they count only once the model decision names a model
 * (`activeExtractionRun`).
 */

export type ComparisonConfig = AppConfig["extraction"]["comparison"];

export type ComparisonUnit = { documentVersionId: string; geoObjectId: string; mentionIds: string[]; sourceId: string; docType: DocType };

export type ComparisonPick = { units: ComparisonUnit[]; sources: number; docTypes: DocType[]; shortfall: string[] };

/** Key of a unit in comparisons and ratings: `<documentVersionId>:<geoObjectId>`. */
export const unitKeyOf = (documentVersionId: string, geoObjectId: string) => `${documentVersionId}:${geoObjectId}`;

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/**
 * What a sample lacks against the spec, as codes the UI and the scripts put into words: `units:<n>/<target>` (fewer
 * units than wanted), `sources:<n>/<min>` (fewer than `minSources` sources), `doc_type:<type>` for each document type of
 * the candidates that the sample misses.
 */
export function comparisonShortfall(units: ComparisonUnit[], candidateDocTypes: Iterable<DocType>, cfg: ComparisonConfig): string[] {
  const out: string[] = [];
  if (units.length < cfg.units) out.push(`units:${units.length}/${cfg.units}`);
  const sources = new Set(units.map((u) => u.sourceId)).size;
  if (sources < cfg.minSources) out.push(`sources:${sources}/${cfg.minSources}`);
  const sampled = new Set(units.map((u) => u.docType));
  for (const type of DOC_TYPES) if (new Set(candidateDocTypes).has(type) && !sampled.has(type)) out.push(`doc_type:${type}`);
  return out;
}

/** Takes one item from each queue in turn until every queue is empty. */
function roundRobin<T>(queues: T[][]): T[] {
  const out: T[] = [];
  const rest = queues.map((q) => [...q]);
  while (rest.some((q) => q.length > 0)) for (const q of rest) if (q.length > 0) out.push(q.shift()!);
  return out;
}

/**
 * The sample of a model comparison: candidates are the (current version of an active document, geo object) pairs with
 * mentions whose object takes facts (`levelFor` not null); they are ordered round-robin over the document types
 * (effective type: classification before the fetch type), within a type round-robin over its sources, within a source
 * by `md5(versionId || geoObjectId)` (stable, spread over documents), and the first `units` are taken. `shortfall`
 * reports fewer than `minSources` sources and document types of the candidates the sample misses. `scope` limits the
 * candidates to the given sources (tests, ruling M4-P23: a test asserts only on its own rows).
 */
export async function pickComparisonUnits(db: Db, cfg: ComparisonConfig, scope?: ComparisonScope): Promise<ComparisonPick> {
  const sourceFilter = scope
    ? sql`and d.source_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(scope.sourceIds)}::jsonb))`
    : sql``;
  const { rows } = await db.execute<{
    version_id: string;
    geo_object_id: string;
    mention_ids: string[];
    source_id: string;
    doc_type: DocType;
    sort_key: string;
  }>(sql`
    select m.document_version_id as version_id, m.geo_object_id, array_agg(m.id order by m.char_start, m.id)::text[] as mention_ids,
      d.source_id, coalesce(v.classified_doc_type, v.doc_type) as doc_type,
      md5(m.document_version_id::text || m.geo_object_id::text) as sort_key
    from mentions m
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id and d.current_version_id = v.id
    where d.status = 'active' and d.valid_to is null ${sourceFilter}
    group by m.document_version_id, m.geo_object_id, d.source_id, coalesce(v.classified_doc_type, v.doc_type)
    order by sort_key
  `);
  const levels = new Map<string, FactLevel | null>();
  const candidates: ComparisonUnit[] = [];
  for (const r of rows) {
    if (!levels.has(r.geo_object_id)) levels.set(r.geo_object_id, await levelFor(db, r.geo_object_id));
    if (levels.get(r.geo_object_id) === null) continue;
    candidates.push({ documentVersionId: r.version_id, geoObjectId: r.geo_object_id, mentionIds: r.mention_ids, sourceId: r.source_id, docType: r.doc_type });
  }
  // Candidates are in md5 order already; group by type, then by source, keeping that order inside each source.
  const byType = new Map<DocType, Map<string, ComparisonUnit[]>>();
  for (const c of candidates) {
    const sources = byType.get(c.docType) ?? new Map<string, ComparisonUnit[]>();
    sources.set(c.sourceId, [...(sources.get(c.sourceId) ?? []), c]);
    byType.set(c.docType, sources);
  }
  const typeQueues = DOC_TYPES.filter((t) => byType.has(t)).map((t) => {
    const sources = byType.get(t)!;
    return roundRobin([...sources.keys()].sort().map((s) => sources.get(s)!));
  });
  const units = roundRobin(typeQueues).slice(0, cfg.units);
  const docTypes = DOC_TYPES.filter((t) => units.some((u) => u.docType === t));
  return {
    units,
    sources: new Set(units.map((u) => u.sourceId)).size,
    docTypes,
    shortfall: comparisonShortfall(units, byType.keys(), cfg),
  };
}

/** Limits a comparison sample to some sources (tests only; the pilot draws from every source). */
export type ComparisonScope = { sourceIds: string[] };

/** Two distinct comparison models are needed; the same model twice compares nothing. */
export class ComparisonModelsInvalid extends Error {
  constructor(models: string[]) {
    super(`a model comparison needs two different models, got ${models.join(", ")}`);
    this.name = "ComparisonModelsInvalid";
  }
}

/**
 * "Vergleich anlegen": draws the sample (`pickComparisonUnits`) and stores it with the two comparison models, in one
 * transaction (a comparison never exists without its units).
 */
export async function createModelComparison(
  db: Db,
  input: { label: string; createdBy: string; cfg?: AppConfig; scope?: ComparisonScope },
): Promise<{ id: string; units: number; shortfall: string[] }> {
  const cfg = input.cfg ?? getConfig();
  const models = cfg.models.comparison.models.slice(0, 2);
  if (models.length !== 2 || models[0] === models[1]) throw new ComparisonModelsInvalid(models);
  return db.transaction(async (tx) => {
    const pick = await pickComparisonUnits(tx, cfg.extraction.comparison, input.scope);
    const [row] = await tx
      .insert(modelComparisons)
      .values({ label: input.label, models, shortfall: pick.shortfall, createdBy: input.createdBy })
      .returning({ id: modelComparisons.id });
    if (pick.units.length > 0) {
      await tx.insert(modelComparisonUnits).values(pick.units.map((u) => ({ comparisonId: row!.id, ...u })));
    }
    return { id: row!.id, units: pick.units.length, shortfall: pick.shortfall };
  });
}

/** The comparison row, or null. */
export async function getModelComparison(db: Db, comparisonId: string) {
  const [row] = await db.select().from(modelComparisons).where(eq(modelComparisons.id, comparisonId));
  return row ?? null;
}

/** Every mention id of the comparison's units, in unit order (for the extraction plan). */
export async function comparisonMentionIds(db: Db, comparisonId: string): Promise<string[]> {
  const rows = await db
    .select({ mentionIds: modelComparisonUnits.mentionIds })
    .from(modelComparisonUnits)
    .where(eq(modelComparisonUnits.comparisonId, comparisonId))
    .orderBy(modelComparisonUnits.documentVersionId, modelComparisonUnits.geoObjectId);
  return rows.flatMap((r) => r.mentionIds);
}

/**
 * The cost estimate of the comparison run in EUR (both models, batch API): the units are planned like the extraction
 * plans them (parts of at most `maxChunksPerUnit` chunks with neighbours); per unit the input is its chunk characters
 * / 4 plus `systemTokens` (system prompt, fact schema), the output `outputTokensPerUnit` (thinking included, ruling
 * M4-P7); per model at its price times `batch.discount`. It errs high: billing counts actual tokens.
 */
export async function estimateComparisonCostEur(db: Db, comparisonId: string, cfg: AppConfig = getConfig()): Promise<number> {
  const comparison = await getModelComparison(db, comparisonId);
  if (!comparison) throw new Error(`model comparison ${comparisonId} does not exist`);
  const { units } = await planUnits(db, await comparisonMentionIds(db, comparisonId), cfg.extraction.unit);
  const chunkIds = [...new Set(units.flatMap((u) => u.chunkIds))];
  const { rows } =
    chunkIds.length === 0
      ? { rows: [] as Array<{ id: string; chars: number }> }
      : await db.execute<{ id: string; chars: number }>(sql`
          select id, length(text)::int as chars from chunks
          where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(chunkIds)}::jsonb))
        `);
  const chars = new Map(rows.map((r) => [r.id, Number(r.chars)]));
  const { systemTokens, outputTokensPerUnit } = cfg.extraction.comparison;
  const inputTokens = units.reduce((sum, u) => sum + u.chunkIds.reduce((n, id) => n + (chars.get(id) ?? 0), 0) / 4 + systemTokens, 0);
  const outputTokens = units.length * outputTokensPerUnit;
  let total = 0;
  for (const model of comparison.models) {
    const price = cfg.models.pricesEurPerMTok[model];
    if (!price) throw new Error(`no price configured for model ${model}`);
    total += ((inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output) * cfg.models.batch.discount;
  }
  return Number(total.toFixed(4));
}

/** Refused before anything is started: the cost estimate is above the allowed maximum. */
export class ComparisonTooExpensive extends Error {
  constructor(
    readonly estimateEur: number,
    readonly maxEur: number,
  ) {
    super(`estimated cost ${estimateEur.toFixed(2)} EUR is above the maximum of ${maxEur.toFixed(2)} EUR`);
    this.name = "ComparisonTooExpensive";
  }
}

/** Throws `ComparisonTooExpensive` when the estimate is above `maxEur`. */
export function assertComparisonCost(estimateEur: number, maxEur: number): void {
  if (estimateEur > maxEur) throw new ComparisonTooExpensive(estimateEur, maxEur);
}

export type ComparisonOverview = { units: number; sources: number; docTypes: DocType[]; shortfall: string[] };

/** Units, sources and document types of the comparison's sample, with the shortfall noted when it was drawn. */
export async function comparisonOverview(db: Db, comparisonId: string): Promise<ComparisonOverview> {
  const comparison = await getModelComparison(db, comparisonId);
  if (!comparison) throw new Error(`model comparison ${comparisonId} does not exist`);
  const rows = await db
    .select({ sourceId: modelComparisonUnits.sourceId, docType: modelComparisonUnits.docType })
    .from(modelComparisonUnits)
    .where(eq(modelComparisonUnits.comparisonId, comparisonId));
  return {
    units: rows.length,
    sources: new Set(rows.map((r) => r.sourceId)).size,
    docTypes: DOC_TYPES.filter((t) => rows.some((r) => r.docType === t)),
    shortfall: comparison.shortfall,
  };
}

/**
 * `npm run compare:models`: creates the comparison and estimates its cost in one transaction, which is rolled back
 * (nothing stays) when the estimate is above `maxEur` (`ComparisonTooExpensive`).
 */
export async function createModelComparisonWithinBudget(
  db: Db,
  input: { label: string; createdBy: string; maxEur: number; cfg?: AppConfig; scope?: ComparisonScope },
): Promise<ComparisonOverview & { id: string; estimateEur: number }> {
  const cfg = input.cfg ?? getConfig();
  return db.transaction(async (tx) => {
    const { id } = await createModelComparison(tx, { label: input.label, createdBy: input.createdBy, cfg, scope: input.scope });
    const estimateEur = await estimateComparisonCostEur(tx, id, cfg);
    assertComparisonCost(estimateEur, input.maxEur);
    return { id, estimateEur, ...(await comparisonOverview(tx, id)) };
  });
}

/** The extraction runs (task `extract-facts`) of the comparison's current run, keyed by model. */
async function comparisonRuns(db: Db, comparisonId: string): Promise<{ models: string[]; byModel: Map<string, string> }> {
  const comparison = await getModelComparison(db, comparisonId);
  if (!comparison) throw new Error(`model comparison ${comparisonId} does not exist`);
  const byModel = new Map<string, string>();
  if (comparison.runId) {
    const { rows } = await db.execute<{ id: string; model: string }>(sql`
      select id, model from extraction_runs
      where comparison_id = ${comparisonId} and run_id = ${comparison.runId} and task = 'extract-facts' and purpose = 'comparison'
    `);
    for (const r of rows) byModel.set(r.model, r.id);
  }
  return { models: comparison.models, byModel };
}

/**
 * Whether two fact values agree: numbers (also 0–1 scales) within `tolerance`, arrays as sets (order and repeats do not
 * count), objects key by key by the same rules, anything else by its canonical JSON.
 */
export function valuesAgree(a: unknown, b: unknown, tolerance: number): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tolerance + 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) {
    const as = new Set(a.map(canonicalJson));
    const bs = new Set(b.map(canonicalJson));
    return as.size === bs.size && [...as].every((x) => bs.has(x));
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (canonicalJson(ak) !== canonicalJson(bk)) return false;
    return ak.every((k) => valuesAgree((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tolerance));
  }
  return canonicalJson(a) === canonicalJson(b);
}

type PairFact = { id: string; value: unknown; confidence: number };
type Pair = { unitKey: string; attribute: string; a: PairFact | null; b: PairFact | null; kind: "same" | "deviation" | "onlyA" | "onlyB" };

/**
 * The comparison's facts paired per (unit, attribute): of each model the fact of highest confidence (ties by id),
 * classified as same, deviation, only model A, only model B. In key order.
 */
async function pairFacts(db: Db, comparisonId: string, cfg: AppConfig): Promise<{ pairs: Pair[]; models: string[]; byModel: Map<string, string> }> {
  const { models, byModel } = await comparisonRuns(db, comparisonId);
  const runA = byModel.get(models[0]!);
  const runB = byModel.get(models[1]!);
  const runIds = [runA, runB].filter((id): id is string => id !== undefined);
  if (runIds.length === 0) return { pairs: [], models, byModel };
  const { rows } = await db.execute<{ id: string; extraction_run_id: string; unit_key: string; attribute: string; value: unknown; confidence: number }>(sql`
    select distinct on (f.extraction_run_id, m.document_version_id, f.geo_object_id, f.attribute)
      f.id, f.extraction_run_id, m.document_version_id::text || ':' || f.geo_object_id::text as unit_key, f.attribute, f.value, f.confidence
    from facts f join mentions m on m.id = f.mention_id
    where f.extraction_run_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(runIds)}::jsonb))
    order by f.extraction_run_id, m.document_version_id, f.geo_object_id, f.attribute, f.confidence desc, f.id
  `);
  const byKey = new Map<string, { unitKey: string; attribute: string; a: PairFact | null; b: PairFact | null }>();
  for (const r of rows) {
    const key = `${r.unit_key}|${r.attribute}`;
    const entry = byKey.get(key) ?? { unitKey: r.unit_key, attribute: r.attribute, a: null, b: null };
    const fact = { id: r.id, value: r.value, confidence: Number(r.confidence) };
    if (r.extraction_run_id === runA) entry.a = fact;
    else entry.b = fact;
    byKey.set(key, entry);
  }
  const tolerance = cfg.extraction.comparison.numericTolerance;
  const pairs = [...byKey.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([, e]): Pair => {
      const kind = !e.b ? "onlyA" : !e.a ? "onlyB" : valuesAgree(e.a.value, e.b.value, tolerance) ? "same" : "deviation";
      return { ...e, kind };
    });
  return { pairs, models, byModel };
}

export type ComparisonRunSummary = {
  extractionRunId: string;
  model: string;
  units: number;
  facts: number;
  rejectedQuote: number;
  invalidValue: number;
  unknownAttribute: number;
  costEur: number;
  costPerUnitEur: number;
};

export type ComparisonSummary = {
  runs: ComparisonRunSummary[];
  agreement: { same: number; deviation: number; onlyA: number; onlyB: number; pct: number };
};

/**
 * Counters per model (units, stored facts, rejected quotes, invalid values, unknown attributes from the units' fact
 * counters, cost of every billed attempt of its units) and the agreement of the two models per (unit, attribute):
 * `pct` = share of keys with the same value, in percent (0 without any key).
 */
export async function compareRuns(db: Db, comparisonId: string, cfg: AppConfig = getConfig()): Promise<ComparisonSummary> {
  const { pairs, models, byModel } = await pairFacts(db, comparisonId, cfg);
  const runs: ComparisonRunSummary[] = [];
  for (const model of models) {
    const extractionRunId = byModel.get(model);
    if (!extractionRunId) continue;
    const { rows } = await db.execute<{
      units: number;
      facts: number;
      rejected_quote: number;
      invalid_value: number;
      unknown_attribute: number;
      cost_eur: number;
    }>(sql`
      select
        (select count(*)::int from extraction_units where extraction_run_id = ${extractionRunId}) as units,
        (select count(*)::int from facts where extraction_run_id = ${extractionRunId}) as facts,
        (select coalesce(sum((stats->>'rejectedQuote')::int), 0)::int from extraction_units where extraction_run_id = ${extractionRunId}) as rejected_quote,
        (select coalesce(sum((stats->>'invalidValue')::int), 0)::int from extraction_units where extraction_run_id = ${extractionRunId}) as invalid_value,
        (select coalesce(sum((stats->>'unknownAttribute')::int), 0)::int from extraction_units where extraction_run_id = ${extractionRunId}) as unknown_attribute,
        (select coalesce(sum(i.cost_eur), 0)::float8 from ai_batch_items i
          join extraction_units u on i.subject_type = 'extraction_unit' and i.subject_id = u.id::text
          where u.extraction_run_id = ${extractionRunId}) as cost_eur
    `);
    const r = rows[0]!;
    const units = Number(r.units);
    const costEur = Number(Number(r.cost_eur).toFixed(6));
    runs.push({
      extractionRunId,
      model,
      units,
      facts: Number(r.facts),
      rejectedQuote: Number(r.rejected_quote),
      invalidValue: Number(r.invalid_value),
      unknownAttribute: Number(r.unknown_attribute),
      costEur,
      costPerUnitEur: units > 0 ? Number((costEur / units).toFixed(6)) : 0,
    });
  }
  const count = (kind: Pair["kind"]) => pairs.filter((p) => p.kind === kind).length;
  const same = count("same");
  return {
    runs,
    agreement: {
      same,
      deviation: count("deviation"),
      onlyA: count("onlyA"),
      onlyB: count("onlyB"),
      pct: pairs.length > 0 ? Number(((same / pairs.length) * 100).toFixed(1)) : 0,
    },
  };
}

export type DeviationItem = { unitKey: string; attribute: string; a: FactView | null; b: FactView | null; verdict: ComparisonVerdict | null };

/**
 * The "Stichprobe von 50 Abweichungen": the keys where the models disagree or only one has a fact, ordered by
 * `md5(unitKey || attribute)` (stable while the facts stay, spread over units), the first `size`, each with both
 * facts and the current verdict.
 */
export async function deviationSample(db: Db, comparisonId: string, size = 50, cfg: AppConfig = getConfig()): Promise<DeviationItem[]> {
  const { pairs } = await pairFacts(db, comparisonId, cfg);
  const picked = pairs
    .filter((p) => p.kind !== "same")
    .map((p) => ({ p, order: md5(p.unitKey + p.attribute) }))
    .sort((x, y) => x.order.localeCompare(y.order))
    .slice(0, size)
    .map(({ p }) => p);
  const views = await factViewsByIds(db, picked.flatMap((p) => [p.a?.id, p.b?.id].filter((id): id is string => id !== undefined)), cfg);
  const ratings = await db
    .select({ unitKey: modelComparisonRatings.unitKey, attribute: modelComparisonRatings.attribute, verdict: modelComparisonRatings.verdict })
    .from(modelComparisonRatings)
    .where(eq(modelComparisonRatings.comparisonId, comparisonId));
  const verdicts = new Map(ratings.map((r) => [`${r.unitKey}|${r.attribute}`, r.verdict]));
  return picked.map((p) => ({
    unitKey: p.unitKey,
    attribute: p.attribute,
    a: p.a ? (views.get(p.a.id) ?? null) : null,
    b: p.b ? (views.get(p.b.id) ?? null) : null,
    verdict: verdicts.get(`${p.unitKey}|${p.attribute}`) ?? null,
  }));
}

/** A verdict for an item that is not in the comparison's rating sample (or a comparison that does not exist). */
export class DeviationNotInSample extends Error {
  constructor(comparisonId: string, unitKey: string, attribute: string) {
    super(`(${unitKey}, ${attribute}) is not in the rating sample of model comparison ${comparisonId}`);
    this.name = "DeviationNotInSample";
  }
}

/**
 * Stores the verdict on one deviation; a second verdict on the same item replaces the first (with a new `rated_at`).
 * Only an item of the comparison's rating sample (`deviationSample`, `extraction.comparison.ratingSample`) takes a
 * verdict, so the summary counts nothing else; otherwise `DeviationNotInSample`.
 */
export async function rateDeviation(
  db: Db,
  input: { comparisonId: string; unitKey: string; attribute: string; verdict: ComparisonVerdict; by: string },
  cfg: AppConfig = getConfig(),
): Promise<void> {
  const notInSample = new DeviationNotInSample(input.comparisonId, input.unitKey, input.attribute);
  if (!(await getModelComparison(db, input.comparisonId))) throw notInSample;
  const sample = await deviationSample(db, input.comparisonId, cfg.extraction.comparison.ratingSample, cfg);
  if (!sample.some((d) => d.unitKey === input.unitKey && d.attribute === input.attribute)) throw notInSample;
  await db
    .insert(modelComparisonRatings)
    .values({
      comparisonId: input.comparisonId,
      unitKey: input.unitKey,
      attribute: input.attribute,
      verdict: input.verdict,
      ratedBy: input.by,
      ratedAt: sql`clock_timestamp()`,
    })
    .onConflictDoUpdate({
      target: [modelComparisonRatings.comparisonId, modelComparisonRatings.unitKey, modelComparisonRatings.attribute],
      set: { verdict: input.verdict, ratedBy: input.by, ratedAt: sql`clock_timestamp()` },
    });
}

export const COMPARISON_VERDICTS = ["a_correct", "b_correct", "both_ok", "both_wrong", "unclear"] as const satisfies readonly ComparisonVerdict[];

export type RatingSummary = { rated: number; counts: Record<ComparisonVerdict, number>; shares: Record<ComparisonVerdict, number> };

/** Verdicts of the comparison: how many items are rated and the count and share (0–1) of each verdict. */
export async function ratingSummary(db: Db, comparisonId: string): Promise<RatingSummary> {
  const rows = await db
    .select({ verdict: modelComparisonRatings.verdict, n: sql<number>`count(*)::int` })
    .from(modelComparisonRatings)
    .where(and(eq(modelComparisonRatings.comparisonId, comparisonId)))
    .groupBy(modelComparisonRatings.verdict);
  const counts = Object.fromEntries(COMPARISON_VERDICTS.map((v) => [v, 0])) as Record<ComparisonVerdict, number>;
  for (const r of rows) counts[r.verdict] = Number(r.n);
  const rated = Object.values(counts).reduce((a, b) => a + b, 0);
  const shares = Object.fromEntries(COMPARISON_VERDICTS.map((v) => [v, rated > 0 ? Number((counts[v] / rated).toFixed(4)) : 0])) as Record<
    ComparisonVerdict,
    number
  >;
  return { rated, counts, shares };
}

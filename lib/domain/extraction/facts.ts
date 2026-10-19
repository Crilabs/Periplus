import { eq, inArray, sql } from "drizzle-orm";
import type { ExtractedFact, ExtractFactsOutput } from "@/lib/ai/tasks/extract-facts";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, extractionRuns, extractionUnits, facts, mentions, unmatchedNames } from "@/lib/db/schema";
import { validateTextFact } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { effectiveVersionMeta, plausibleDate } from "@/lib/domain/mentions/classification";
import { findNameHits, type MatchHit, type NameForm } from "@/lib/domain/mentions/match";
import { nameForms } from "@/lib/domain/mentions/ngrams";
import { tileIdFor } from "@/lib/domain/tiles";
import { locateQuote } from "./quote";

/*
 * Processing of an `extract-facts` answer (spec 06): "Ein Fact ohne wörtliches Zitat existiert nicht." Each proposed
 * fact is checked in order — value is JSON in the attribute's text format (`validateTextFact`), the quote is found
 * verbatim in a chunk of the unit (`locateQuote`, the stated chunk first) — and gets the unit's mention nearest to the
 * quote. Of an attribute proposed twice the more confident one stays. The kept facts are stored with the located quote
 * span (append-only, unique per mention, attribute and extraction run: a repeated answer adds nothing). A highlight
 * with a proper name becomes a mention of a gazetteer POI within `poiMatchRadiusM`, or an unmatched name with hint
 * `poi:<category>` that goes the way of new place names.
 */

export type FactStats = {
  proposed: number;
  stored: number;
  rejectedQuote: number;
  invalidValue: number;
  unknownAttribute: number;
  duplicate: number;
  poiMentions: number;
  poiUnmatched: number;
  /** Facts beyond `maxFactsPerUnit`, not looked at. */
  overLimit: number;
};

export const FACT_STAT_KEYS = [
  "proposed",
  "stored",
  "rejectedQuote",
  "invalidValue",
  "unknownAttribute",
  "duplicate",
  "poiMentions",
  "poiUnmatched",
  "overLimit",
] as const satisfies ReadonlyArray<keyof FactStats>;

export const emptyFactStats = (): FactStats =>
  Object.fromEntries(FACT_STAT_KEYS.map((k) => [k, 0])) as FactStats;

export type ProcessUnit = {
  id: string;
  extractionRunId: string;
  documentVersionId: string;
  geoObjectId: string;
  level: FactLevel;
  mentionIds: string[];
  /** In the order the model saw them: chunk `n` is `chunkIds[n - 1]`. */
  chunkIds: string[];
};

/** Longest proper name a highlight may carry (fact schema v2 `properName`). */
const MAX_POI_NAME = 80;
const HIGHLIGHT = "highlight.";

type UnitChunk = { id: string; ordinal: number; text: string };
type UnitMention = { id: string; chunkId: string; charStart: number; charEnd: number };
type Located = { chunk: UnitChunk; start: number; end: number };
type Kept = {
  fact: ExtractedFact;
  value: unknown;
  located: Located;
  mentionId: string;
  confidence: number;
  observedAt: string;
  poiName: string | null;
};

/** The quote in the stated chunk, else in the unit's other chunks in order; null when it is in none. */
function locateInUnit(fact: ExtractedFact, unitChunks: UnitChunk[], cfg: AppConfig["extraction"]["quote"]): Located | null {
  const stated = Number.isInteger(fact.chunk) ? unitChunks[fact.chunk - 1] : undefined;
  const order = stated ? [stated, ...unitChunks.filter((c) => c !== stated)] : unitChunks;
  for (const chunk of order) {
    const hit = locateQuote(chunk.text, fact.quote, cfg);
    if (hit.ok) return { chunk, start: hit.start, end: hit.end };
  }
  return null;
}

/** Characters between two spans (0 when they overlap). */
const gap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, a.start - b.end, b.start - a.end);

/**
 * The unit's mention a fact belongs to: in the quote's chunk the one nearest to the quote, else the one in the chunk
 * nearest by ordinal (ties: the earlier chunk, then the earlier mention).
 */
function nearestMention(located: Located, unitMentions: UnitMention[], ordinalOf: Map<string, number>): string {
  const ranked = unitMentions
    .map((m) => ({
      m,
      chunkDistance: Math.abs((ordinalOf.get(m.chunkId) ?? Number.MAX_SAFE_INTEGER) - located.chunk.ordinal),
      ordinal: ordinalOf.get(m.chunkId) ?? Number.MAX_SAFE_INTEGER,
      textDistance: m.chunkId === located.chunk.id ? gap({ start: m.charStart, end: m.charEnd }, located) : 0,
    }))
    .sort(
      (a, b) =>
        a.chunkDistance - b.chunkDistance ||
        a.ordinal - b.ordinal ||
        a.textDistance - b.textDistance ||
        a.m.charStart - b.m.charStart ||
        a.m.id.localeCompare(b.m.id),
    );
  return ranked[0]!.m.id;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Validates, quote-checks and stores the facts of one answer for one extraction unit; returns its counters. Runs in the
 * caller's transaction (the batch handler's, which also marks the unit done). Storing is idempotent: the same answer
 * processed twice stores nothing new (`stored` then counts 0).
 */
export async function processFactOutput(db: Db, unit: ProcessUnit, output: ExtractFactsOutput, cfg: AppConfig): Promise<FactStats> {
  const stats = emptyFactStats();
  stats.proposed = output.facts.length;
  const considered = output.facts.slice(0, cfg.extraction.maxFactsPerUnit);
  stats.overLimit = output.facts.length - considered.length;
  if (considered.length === 0) return stats;

  const chunkRows = await db
    .select({ id: chunks.id, ordinal: chunks.ordinal, text: chunks.text })
    .from(chunks)
    .where(inArray(chunks.id, unit.chunkIds));
  const byId = new Map(chunkRows.map((c) => [c.id, c]));
  const unitChunks = unit.chunkIds.map((id) => byId.get(id)).filter((c): c is UnitChunk => c !== undefined);
  const unitMentions: UnitMention[] =
    unit.mentionIds.length === 0
      ? []
      : await db
          .select({ id: mentions.id, chunkId: mentions.chunkId, charStart: mentions.charStart, charEnd: mentions.charEnd })
          .from(mentions)
          .where(inArray(mentions.id, unit.mentionIds));
  if (unitMentions.length === 0) throw new Error(`extraction unit ${unit.id} has no mentions`);
  const ordinalOf = new Map(unitChunks.map((c) => [c.id, c.ordinal]));
  const meta = await effectiveVersionMeta(db, unit.documentVersionId);
  const version = cfg.factSchema.version;

  const kept = new Map<string, Kept>();
  for (const fact of considered) {
    let raw: unknown;
    try {
      raw = JSON.parse(fact.value);
    } catch {
      stats.invalidValue++;
      continue;
    }
    const checked = validateTextFact(unit.level, fact.attribute, raw, version);
    if (!checked.ok) {
      if (checked.reason === "invalid_value") stats.invalidValue++;
      else stats.unknownAttribute++;
      continue;
    }
    const located = locateInUnit(fact, unitChunks, cfg.extraction.quote);
    if (!located) {
      stats.rejectedQuote++;
      continue;
    }
    const poiName = fact.poi_name?.trim() ?? "";
    const candidate: Kept = {
      fact,
      value: checked.value,
      located,
      mentionId: nearestMention(located, unitMentions, ordinalOf),
      confidence: clamp01(fact.confidence),
      observedAt: plausibleDate(fact.observed_at, meta.fetchedAt, cfg.extraction.earliestDate, true) ?? meta.observedAt,
      poiName: fact.attribute.startsWith(HIGHLIGHT) && poiName.length > 0 && poiName.length <= MAX_POI_NAME ? poiName : null,
    };
    const prev = kept.get(fact.attribute);
    if (prev) stats.duplicate++;
    if (!prev || candidate.confidence > prev.confidence) kept.set(fact.attribute, candidate);
  }
  if (kept.size === 0) return stats;

  const stored = await db
    .insert(facts)
    .values(
      [...kept.values()].map((k) => ({
        geoObjectId: unit.geoObjectId,
        attribute: k.fact.attribute,
        value: k.value as object,
        mentionId: k.mentionId,
        quote: k.fact.quote,
        quoteVerified: true,
        quoteChunkId: k.located.chunk.id,
        quoteStart: k.located.start,
        quoteEnd: k.located.end,
        observedAt: k.observedAt,
        confidence: k.confidence,
        extractionRunId: unit.extractionRunId,
        factSchemaVersion: version,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: facts.id });
  stats.stored = stored.length;

  const highlights = [...kept.values()].filter((k) => k.poiName !== null);
  if (highlights.length > 0) {
    const [run] = await db
      .select({ model: extractionRuns.model, promptVersion: extractionRuns.promptVersion, runId: extractionRuns.runId })
      .from(extractionRuns)
      .where(eq(extractionRuns.id, unit.extractionRunId));
    if (!run) throw new Error(`extraction run ${unit.extractionRunId} does not exist`);
    for (const k of highlights) {
      const poi = await matchPoi(db, unit.geoObjectId, k.poiName!, cfg);
      if (poi) {
        await db
          .insert(mentions)
          .values({
            documentVersionId: unit.documentVersionId,
            chunkId: k.located.chunk.id,
            geoObjectId: poi.geoObjectId,
            surface: k.located.chunk.text.slice(k.located.start, k.located.end),
            charStart: k.located.start,
            charEnd: k.located.end,
            observedAt: k.observedAt,
            confidence: k.confidence,
            matchKind: "model",
            matchScore: poi.similarity,
            model: run.model,
            promptVersion: run.promptVersion,
            extractionStatus: "done",
            runId: run.runId,
          })
          .onConflictDoNothing();
        stats.poiMentions++;
      } else {
        const nameNormalized = normalizeName(k.poiName!);
        if (nameNormalized.length === 0) continue;
        await db
          .insert(unmatchedNames)
          .values({
            nameNormalized,
            displayName: k.poiName!,
            hint: `poi:${k.fact.attribute.slice(HIGHLIGHT.length)}`,
            documentVersionId: unit.documentVersionId,
            chunkId: k.located.chunk.id,
            sourceId: meta.sourceId,
            tileId: await objectTile(db, unit.geoObjectId),
          })
          .onConflictDoNothing();
        stats.poiUnmatched++;
      }
    }
  }
  return stats;
}

/**
 * The gazetteer POI a highlight's proper name means: a valid, unmerged `poi` object within `poiMatchRadiusM` of the
 * unit's object whose name matches exactly or with `similarity ≥ poiSimilarity` (`findNameHits`, so Greek names are
 * compared transliterated too); the best hit, or null.
 */
export async function matchPoi(
  db: Db,
  geoObjectId: string,
  name: string,
  cfg: AppConfig,
): Promise<{ geoObjectId: string; similarity: number } | null> {
  const radius = cfg.extraction.poiMatchRadiusM;
  const { rows } = await db.execute<{ id: string }>(sql`
    select o.id from geo_objects a
    join geo_objects o on o.type = 'poi' and o.id <> a.id
      and o.geom && ST_Expand(a.geom, ${radius} / (111320 * greatest(cos(radians(ST_Y(a.centroid))), 0.1)))
      and ST_DWithin(o.geom::geography, a.geom::geography, ${radius})
    where a.id = ${geoObjectId}
      and o.merged_into_id is null
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
  `);
  if (rows.length === 0) return null;
  const forms: NameForm[] = nameForms(name).map((form) => ({
    ngram: 0,
    form,
    start: 0,
    end: name.length,
    surface: name,
    words: form.split(" ").length,
    hint: null,
  }));
  const hits = await findNameHits(
    db,
    forms,
    rows.map((r) => r.id),
    { mentions: cfg.mentions, nameAffixes: cfg.nameAffixes },
  );
  const best = hits
    .filter((h) => h.exact || h.similarity >= cfg.extraction.poiSimilarity)
    .sort((a: MatchHit, b: MatchHit) => Number(b.exact) - Number(a.exact) || b.similarity - a.similarity || a.geoObjectId.localeCompare(b.geoObjectId))[0];
  return best ? { geoObjectId: best.geoObjectId, similarity: best.similarity } : null;
}

/** The tile of a geo object for its unmatched names: the one holding its centroid when assigned, else its first. */
async function objectTile(db: Db, geoObjectId: string): Promise<string | null> {
  const { rows } = await db.execute<{ tile_id: string; lon: number; lat: number }>(sql`
    select tgo.tile_id, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from tile_geo_objects tgo join geo_objects o on o.id = tgo.geo_object_id
    where tgo.geo_object_id = ${geoObjectId}
    order by tgo.tile_id
  `);
  if (rows.length === 0) return null;
  const own = tileIdFor(Number(rows[0]!.lon), Number(rows[0]!.lat));
  return rows.find((r) => r.tile_id === own)?.tile_id ?? rows[0]!.tile_id;
}

/**
 * Marks a unit done with its counters and the tokens and cost of its batch item (ruling M4-P9), in the transaction
 * that stored its facts; a unit already done keeps its first result. Returns whether it was marked.
 */
export async function completeUnit(
  db: Db,
  unitId: string,
  stats: FactStats,
  usage: { inputTokens: number; outputTokens: number },
  costEur: number,
): Promise<boolean> {
  const rows = await db
    .update(extractionUnits)
    .set({
      status: "done",
      stats,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costEur: costEur.toFixed(6),
      updatedAt: sql`now()`,
    })
    .where(sql`${extractionUnits.id} = ${unitId} and ${extractionUnits.status} <> 'done'`)
    .returning({ id: extractionUnits.id });
  return rows.length > 0;
}

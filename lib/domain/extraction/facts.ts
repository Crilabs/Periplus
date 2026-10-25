import { eq, inArray, sql } from "drizzle-orm";
import type { ExtractedFact, ExtractFactsOutput } from "@/lib/ai/tasks/extract-facts";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, extractionRuns, extractionUnits, facts, mentions, unmatchedNames } from "@/lib/db/schema";
import { canonicalJson, getFactSchema, isEntryListAttribute, SAFETY_LIST_ATTRIBUTES, validateTextFact } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { effectiveVersionMeta } from "@/lib/domain/mentions/classification";
import { plausibleDate } from "@/lib/domain/research/util/dates";
import { findNameHits, type MatchHit, type NameForm } from "@/lib/domain/mentions/match";
import { nameForms } from "@/lib/domain/mentions/ngrams";
import { tileIdFor } from "@/lib/domain/tiles";
import { locateQuote, nameInQuote } from "@/lib/domain/research/text/quote";
import { blockLateResults } from "./run-status";
import { restoreUnitMentions } from "./unit-status";

/*
 * Processing of an `extract-facts` answer (spec 06): "Ein Fact ohne wörtliches Zitat existiert nicht." Each proposed
 * fact is checked in order — value is JSON in the attribute's text format (`validateTextFact`), the quote is found
 * verbatim in a chunk of the unit (`locateQuote`, the stated chunk first) — and gets the unit's mention nearest to the
 * quote. Of a scalar attribute proposed twice the more confident one stays. A list attribute (rule `union` or
 * `prohibitions`: bans, hazards, restricted zones …) is never cut down to one fact (ruling M7-G-R2): every proposal
 * with its own quote span is stored as its own fact with that quote, and proposals sharing one span are merged into
 * one fact holding the union of their entries. The kept facts are stored with the located quote span (append-only,
 * unique per mention, attribute, extraction run and quote span: a repeated answer adds nothing). Values are
 * checked against the fact schema version of the extraction run (frozen when it was planned, ruling M4-G-R3), not the
 * one active when the answer arrives. A highlight's proper names (`poi_name` and every entry of `names`) count only
 * when they occur in the quote (normalized like the quote check, ruling M4-G-R4): the others are dropped from the value
 * and counted. The same holds for every other proper name of a text value (`textNames` in the fact schema: charter
 * bases, supply ports, named hazards and restricted zones, ruling M4-G-R5); a name list left empty is not stored.
 * Every highlight name that counts becomes a mention of a gazetteer POI of the highlight's category within
 * `poiMatchRadiusM`, or an unmatched name with hint `poi:<category>` that goes the way of new place names.
 */

export type FactStats = {
  proposed: number;
  stored: number;
  rejectedQuote: number;
  invalidValue: number;
  unknownAttribute: number;
  duplicate: number;
  /** List-attribute proposals merged into another proposal with the same quote span (ruling M7-G-R2). */
  merged: number;
  poiMentions: number;
  poiUnmatched: number;
  /** Highlight names (`poi_name` or in `names`) dropped because the quote does not contain them. */
  poiNameRejected: number;
  /** Other proper names (charter bases, supply ports, named hazards and zones) dropped: not in the quote. */
  nameRejected: number;
  /** Facts not stored because none of their proper names is in the quote (a name list left empty). */
  nameEmptied: number;
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
  "merged",
  "poiMentions",
  "poiUnmatched",
  "poiNameRejected",
  "nameRejected",
  "nameEmptied",
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
};

type HighlightValue = { present: boolean; names: string[] };

/** The entries of `a` followed by those of `b` not in `a` (by canonical JSON). */
function unionEntries(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set(a.map(canonicalJson));
  return [...a, ...b.filter((e) => !seen.has(canonicalJson(e)))];
}

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
 * The proper names of a kept highlight that the quote supports (ruling M4-G-R4): its `names` without those the quote
 * does not contain (the value is changed accordingly) plus its `poi_name` when the quote contains it, once per
 * normalized name; `rejected` counts the names dropped.
 */
function highlightNames(k: Kept, maxNameChars: number): { names: string[]; rejected: number } {
  const value = k.value as HighlightValue;
  const kept = value.names.filter((name) => nameInQuote(name, k.fact.quote));
  let rejected = value.names.length - kept.length;
  if (rejected > 0) k.value = { ...value, names: kept };
  const all = [...kept];
  const poiName = k.fact.poi_name?.trim() ?? "";
  if (poiName.length > 0) {
    if (poiName.length <= maxNameChars && nameInQuote(poiName, k.fact.quote)) all.push(poiName);
    else rejected++;
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of all) {
    const key = normalizeName(name);
    if (key.length === 0) {
      rejected++;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return { names, rejected };
}

/**
 * The facts with the entries of the safety lists (`SAFETY_LIST_ATTRIBUTES`: prohibitions, hazards, restricted zones)
 * first, otherwise in the model's order (a stable partition): the fact limit then drops other facts before any safety
 * entry, as prompt v5 asks of the model (ruling M7-FIN-R1, GR-7).
 */
export function safetyFirst(facts: ExtractedFact[]): ExtractedFact[] {
  const safety = new Set<string>(SAFETY_LIST_ATTRIBUTES);
  return [...facts.filter((f) => safety.has(f.attribute)), ...facts.filter((f) => !safety.has(f.attribute))];
}

/**
 * Validates, quote-checks and stores the facts of one answer for one extraction unit; returns its counters. Runs in the
 * caller's transaction (the batch handler's, which also marks the unit done). Storing is idempotent: the same answer
 * processed twice stores nothing new (`stored` then counts 0).
 */
export async function processFactOutput(db: Db, unit: ProcessUnit, output: ExtractFactsOutput, cfg: AppConfig): Promise<FactStats> {
  const stats = emptyFactStats();
  stats.proposed = output.facts.length;
  const considered = safetyFirst(output.facts).slice(0, cfg.extraction.maxFactsPerUnit);
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
  const [run] = await db
    .select({
      model: extractionRuns.model,
      promptVersion: extractionRuns.promptVersion,
      runId: extractionRuns.runId,
      factSchemaVersion: extractionRuns.factSchemaVersion,
    })
    .from(extractionRuns)
    .where(eq(extractionRuns.id, unit.extractionRunId));
  if (!run) throw new Error(`extraction run ${unit.extractionRunId} does not exist`);
  // The schema the prompt showed: the extraction run's, frozen at plan time (ruling M4-G-R3).
  const version = run.factSchemaVersion;

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
    // Proper names outside highlights count only when the quote contains them (ruling M4-G-R5), before the dedupe,
    // so a fact whose names the quote does not support cannot push out a supported one.
    let value = checked.value;
    const def = getFactSchema(version).levels[unit.level].find((d) => d.key === fact.attribute);
    const textNames = def?.textNames;
    if (textNames) {
      const supported = textNames(value, (name) => nameInQuote(name, fact.quote));
      stats.nameRejected += supported.rejected;
      if (supported.value === null) {
        stats.nameEmptied++;
        continue;
      }
      value = supported.value;
    }
    const candidate: Kept = {
      fact,
      value,
      located,
      mentionId: nearestMention(located, unitMentions, ordinalOf),
      confidence: clamp01(fact.confidence),
      observedAt: plausibleDate(fact.observed_at, meta.fetchedAt, cfg.extraction.earliestDate, true) ?? meta.observedAt,
    };
    // A list attribute is keyed by its quote span: another span is another fact, never a dropped one (ruling M7-G-R2).
    const list = isEntryListAttribute(def);
    const key = list ? `${fact.attribute}\u0000${located.chunk.id}:${located.start}:${located.end}` : fact.attribute;
    const prev = kept.get(key);
    if (prev && list && Array.isArray(prev.value) && Array.isArray(candidate.value)) {
      // one quote, two proposals: one fact with the entries of both, the more confident one's confidence and date
      stats.merged++;
      const lead = candidate.confidence > prev.confidence ? candidate : prev;
      kept.set(key, { ...lead, value: unionEntries(prev.value, candidate.value) });
      continue;
    }
    if (prev) stats.duplicate++;
    if (!prev || candidate.confidence > prev.confidence) kept.set(key, candidate);
  }
  if (kept.size === 0) return stats;

  const highlights: Array<{ k: Kept; names: string[] }> = [];
  for (const k of kept.values()) {
    if (!k.fact.attribute.startsWith(HIGHLIGHT)) continue;
    const { names, rejected } = highlightNames(k, cfg.extraction.properNameMaxChars);
    stats.poiNameRejected += rejected;
    if (names.length > 0) highlights.push({ k, names });
  }

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

  for (const { k, names } of highlights) {
    const category = k.fact.attribute.slice(HIGHLIGHT.length);
    for (const name of names) {
      const poi = await matchPoi(db, unit.geoObjectId, name, category, cfg);
      if (poi) {
        const inserted = await db
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
          .onConflictDoNothing()
          .returning({ id: mentions.id });
        stats.poiMentions += inserted.length;
      } else {
        const hint = `poi:${category}`;
        // The name may be unmatched in this chunk already (the matcher's row, hint null or a place word): it is a POI.
        const written = await db
          .insert(unmatchedNames)
          .values({
            nameNormalized: normalizeName(name),
            displayName: name,
            hint,
            documentVersionId: unit.documentVersionId,
            chunkId: k.located.chunk.id,
            sourceId: meta.sourceId,
            tileId: await objectTile(db, unit.geoObjectId),
          })
          .onConflictDoUpdate({
            target: [unmatchedNames.nameNormalized, unmatchedNames.chunkId],
            set: { hint },
            setWhere: sql`${unmatchedNames.hint} is null or ${unmatchedNames.hint} not like 'poi:%'`,
          })
          .returning({ id: unmatchedNames.id });
        stats.poiUnmatched += written.length;
      }
    }
  }
  return stats;
}

/**
 * The gazetteer POI a highlight's proper name means: a valid, unmerged `poi` object of the highlight's category (or
 * without a category) within `poiMatchRadiusM` of the unit's object whose name matches exactly or with
 * `similarity ≥ poiSimilarity` (`findNameHits`, so Greek names are compared transliterated too); the best hit, or null.
 * The highlight categories are the `poi_category` values, so a beach named like a nearby chapel finds the beach.
 */
export async function matchPoi(
  db: Db,
  geoObjectId: string,
  name: string,
  category: string,
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
      and (o.category::text = ${category} or o.category is null)
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
 * Marks a unit done with its counters and the tokens and cost billed for it (ruling M4-P9: every attempt, M4-G-R3),
 * in the transaction that stored its facts; a unit already done keeps its first result. A unit that had failed before
 * (completed by a revived batch) turns its mentions back to `done`; one completed after the extraction run's check blocks
 * the run (`late_results`, ruling M4-H-R3). Returns whether it was marked.
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
    .returning({ id: extractionUnits.id, extractionRunId: extractionUnits.extractionRunId });
  if (rows.length === 0) return false;
  await restoreUnitMentions(db, unitId);
  await blockLateResults(db, rows[0]!.extractionRunId);
  return true;
}

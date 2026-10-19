import { sql } from "drizzle-orm";
import type { MentionsConfig, NameAffixesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { GeoObjectType } from "@/lib/db/schema";
import { isStopName, stripAffix, type Hint } from "./affixes";
import { nameForms, type Ngram } from "./ngrams";

/*
 * Deterministic name match (spec 06): "exakter Treffer oder `similarity ≥ 0,75` (pg_trgm) bei Namen ≥ 5 Zeichen";
 * mehrdeutig = "gleicher Name mehrfach, Transliteration unsicher, Similarity 0,6–0,75". The n-gram forms of a chunk
 * (and their forms without a generic affix) are compared with the valid names of the candidate objects (and the names
 * without their affix) in one query per chunk; `resolveHits` keeps the longest non-overlapping spans and decides
 * whether a span is sure or goes to the disambiguation.
 */

export type MatchConfig = { mentions: MentionsConfig; nameAffixes: NameAffixesConfig };

/** One comparison form of an n-gram; `ngram` is the n-gram's index, the span fields are copied from it. */
export type NameForm = {
  ngram: number;
  form: string;
  start: number;
  end: number;
  surface: string;
  words: number;
  hint: Hint | null;
};

/**
 * A candidate object for a text span. `objectType` (beyond the planned shape) lets `resolveHits` apply the affix hint.
 */
export type MatchHit = {
  start: number;
  end: number;
  surface: string;
  geoObjectId: string;
  similarity: number;
  exact: boolean;
  hint: Hint | null;
  objectType: GeoObjectType;
};

export type MatchCandidate = { geoObjectId: string; similarity: number };

export type ResolvedMatch =
  | { kind: "sure"; hit: MatchHit }
  | { kind: "ambiguous"; start: number; end: number; surface: string; hint: Hint | null; candidates: MatchCandidate[] };

/** Object types an affix hint points at ("Bay" → a bay, "Marina"/"Hafen" → a harbour). */
const HINT_TYPES: Record<Hint, readonly GeoObjectType[]> = {
  bay: ["bay"],
  harbour: ["harbour"],
  marina: ["harbour"],
  cape: ["cape"],
  island: ["island", "islet"],
  anchorage: [],
};

const WORD = /[\p{L}\p{N}\p{M}]+(?:['’\-‐‑][\p{L}\p{N}\p{M}]+)*/gu;

/** The type hint of an n-gram: the hint of the affix it carries ("Kolona Bay" → bay), else null. */
export function ngramHint(ngram: Ngram, affixes: NameAffixesConfig): Hint | null {
  for (const form of ngram.forms) {
    const stripped = stripAffix(form, affixes);
    if (stripped) return stripped.hint;
  }
  return null;
}

/**
 * The comparison forms of n-grams: every form (normalized, transliterated) and its core without a generic affix;
 * stop names (`isStopName`) never take part.
 */
export function nameFormsOf(ngrams: Ngram[], cfg: MatchConfig): NameForm[] {
  const out: NameForm[] = [];
  ngrams.forEach((ngram, i) => {
    const hint = ngramHint(ngram, cfg.nameAffixes);
    const seen = new Set<string>();
    const add = (form: string) => {
      if (seen.has(form) || isStopName(form, cfg.mentions, cfg.nameAffixes)) return;
      seen.add(form);
      out.push({ ngram: i, form, start: ngram.start, end: ngram.end, surface: ngram.surface, words: ngram.words, hint });
    };
    for (const form of ngram.forms) {
      add(form);
      const stripped = stripAffix(form, cfg.nameAffixes);
      if (stripped) add(stripped.core);
    }
  });
  return out;
}

/** Better hits first: exact, then by similarity, then by id (deterministic). */
const byScore = (a: MatchHit, b: MatchHit) =>
  Number(b.exact) - Number(a.exact) || b.similarity - a.similarity || a.geoObjectId.localeCompare(b.geoObjectId);

/** Names that can never be matched: stop names and affixes on their own. */
function blockedNames(cfg: MatchConfig): string[] {
  return [...new Set([...cfg.mentions.stopNames, ...cfg.nameAffixes.map((a) => a.affix)])];
}

/**
 * The hits of a chunk's forms among the valid names of `objectIds`, in one query: exact (`=`) against a name or its
 * core without affix, and `similarity ≥ uncertainSimilarity` against a name when both have at least `fuzzyMinChars`
 * characters and the same number of words (so "in Agia Marina" never fuzzily matches "Agia Marina"). The `%` operator
 * lets the trigram index prefilter; its threshold is set by the caller's transaction (`setTrigramThreshold`), the
 * explicit `similarity` check holds either way. One hit per (span, object), with its best similarity.
 */
export async function findNameHits(db: Db, forms: NameForm[], objectIds: string[], cfg: MatchConfig): Promise<MatchHit[]> {
  if (forms.length === 0 || objectIds.length === 0) return [];
  const m = cfg.mentions;
  const formsJson = JSON.stringify(forms.map((f, i) => ({ i, form: f.form, w: f.form.split(" ").length })));
  const affixJson = JSON.stringify(cfg.nameAffixes.map((a) => ({ affix: a.affix, pos: a.position })));
  const { rows } = await db.execute<{ i: number; geo_object_id: string; type: GeoObjectType; similarity: number; exact: boolean }>(sql`
    with f as (
      select * from jsonb_to_recordset(${formsJson}::jsonb) as f(i int, form text, w int)
    ),
    cand as (
      select o.id, o.type from geo_objects o
      where o.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(objectIds)}::jsonb))
        and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
        and o.merged_into_id is null
    ),
    nm as (
      select gn.geo_object_id, gn.name_normalized as full_name
      from geo_names gn join cand on cand.id = gn.geo_object_id
      where gn.valid_from <= current_date and (gn.valid_to is null or gn.valid_to > current_date)
    ),
    nv as (
      select geo_object_id, full_name as v from nm
      union
      select nm.geo_object_id, c.core from nm cross join lateral (
        select case when a.pos = 'prefix' then substr(nm.full_name, length(a.affix) + 2)
                    else left(nm.full_name, length(nm.full_name) - length(a.affix) - 1) end as core
        from jsonb_to_recordset(${affixJson}::jsonb) as a(affix text, pos text)
        where (a.pos = 'prefix' and nm.full_name like a.affix || ' %') or (a.pos = 'suffix' and nm.full_name like '% ' || a.affix)
        order by length(a.affix) desc
        limit 1
      ) c
    ),
    usable as (
      select geo_object_id, v from nv
      where length(v) >= ${m.exactMinChars}
        and v not in (select value from jsonb_array_elements_text(${JSON.stringify(blockedNames(cfg))}::jsonb))
        and v !~ '^[0-9 ]+$'
    ),
    hits as (
      select f.i, u.geo_object_id, 1::real as similarity, true as exact
      from f join usable u on u.v = f.form
      union all
      select f.i, gn.geo_object_id, similarity(gn.name_normalized, f.form) as similarity, false as exact
      from f
      join geo_names gn on gn.name_normalized % f.form
      join cand on cand.id = gn.geo_object_id
      where length(f.form) >= ${m.fuzzyMinChars}
        and length(gn.name_normalized) >= ${m.fuzzyMinChars}
        and array_length(string_to_array(gn.name_normalized, ' '), 1) = f.w
        and similarity(gn.name_normalized, f.form) >= ${m.uncertainSimilarity}
        and gn.name_normalized not in (select value from jsonb_array_elements_text(${JSON.stringify(blockedNames(cfg))}::jsonb))
        and gn.valid_from <= current_date and (gn.valid_to is null or gn.valid_to > current_date)
    )
    select h.i, h.geo_object_id, cand.type, max(h.similarity)::float8 as similarity, bool_or(h.exact) as exact
    from hits h join cand on cand.id = h.geo_object_id
    group by h.i, h.geo_object_id, cand.type
  `);
  // Several forms of one n-gram (full, core, transliteration) can hit the same object: keep its best.
  const best = new Map<string, MatchHit>();
  for (const r of rows) {
    const form = forms[r.i]!;
    const key = `${form.start}:${form.end}:${r.geo_object_id}`;
    const hit: MatchHit = {
      start: form.start,
      end: form.end,
      surface: form.surface,
      geoObjectId: r.geo_object_id,
      similarity: r.exact ? 1 : Number(r.similarity),
      exact: r.exact,
      hint: form.hint,
      objectType: r.type,
    };
    const prev = best.get(key);
    if (!prev || byScore(hit, prev) < 0) best.set(key, hit);
  }
  return [...best.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.geoObjectId.localeCompare(b.geoObjectId));
}

/** Sets the trigram threshold of the `%` operator for the rest of the transaction (no effect outside one). */
export async function setTrigramThreshold(db: Db, threshold: number): Promise<void> {
  await db.execute(sql`select set_config('pg_trgm.similarity_threshold', ${String(threshold)}, true)`);
}

type Span = {
  start: number;
  end: number;
  surface: string;
  hint: Hint | null;
  words: number;
  best: number;
  hits: MatchHit[];
  /** Exact or sure hits of shorter spans inside this band-only span: offered to the model as further candidates. */
  inner: MatchHit[];
};

const LOWERCASE_START = /^\p{Ll}/u;

/** All configured common words (every language), normalized. */
function commonWordsOf(cfg: MatchConfig): Set<string> {
  return new Set(Object.values(cfg.mentions.commonWords).flat());
}

/**
 * A one-word span that may be an ordinary word rather than a name (ruling M4-E-R3): written lowercase in the text, or
 * a configured common word (άμμος/ammos, petra, skala, strand, bay …), and not backed by an affix. Such a span is never
 * sure; it goes to the disambiguation ("im Zweifel weglassen").
 */
function maybeCommonWord(span: Span, common: Set<string>): boolean {
  if (span.words !== 1 || span.hint !== null) return false;
  return LOWERCASE_START.test(span.surface) || nameForms(span.surface).some((f) => common.has(f));
}

/** The best hit per object, best first. */
function bestPerObject(hits: MatchHit[]): MatchHit[] {
  const best = new Map<string, MatchHit>();
  for (const h of hits) {
    const prev = best.get(h.geoObjectId);
    if (!prev || byScore(h, prev) < 0) best.set(h.geoObjectId, h);
  }
  return [...best.values()].sort(byScore);
}

/**
 * Decides the hits of a chunk: per text span its objects; spans are taken by (words descending, best similarity
 * descending, start), and a span overlapping one already taken is dropped. A span is sure when one object stands out:
 * the only object with an exact hit, else the only one with `similarity ≥ sureSimilarity`; among several such objects
 * an affix hint picks the one object of its type. Otherwise the span is ambiguous with at most `maxCandidates`
 * objects by similarity, also when its only object lies in the uncertain band. Two refinements (rulings M4-E-R3,
 * M4-E-R5): a one-word span written lowercase or listed in `commonWords` is never sure without an affix; and a
 * band-only span (no exact or sure hit of its own) that swallows a shorter span with an exact or sure hit offers that
 * inner span's objects as candidates too, so the right object reaches the model.
 */
export function resolveHits(hits: MatchHit[], cfg: MatchConfig): ResolvedMatch[] {
  const spans = new Map<string, Span>();
  for (const hit of hits) {
    const key = `${hit.start}:${hit.end}`;
    let span = spans.get(key);
    if (!span) {
      const words = hit.surface.match(WORD)?.length ?? 1;
      span = { start: hit.start, end: hit.end, surface: hit.surface, hint: hit.hint, words, best: 0, hits: [], inner: [] };
      spans.set(key, span);
    }
    span.hits.push(hit);
    span.best = Math.max(span.best, hit.similarity);
  }
  const sureLevel = cfg.mentions.sureSimilarity;
  const strongOf = (span: Span) => span.hits.some((h) => h.exact || h.similarity >= sureLevel);
  const ordered = [...spans.values()].sort((a, b) => b.words - a.words || b.best - a.best || a.start - b.start);
  const taken: Span[] = [];
  for (const span of ordered) {
    const over = taken.find((t) => span.start < t.end && t.start < span.end);
    if (!over) {
      taken.push(span);
      continue;
    }
    const inside = over.start <= span.start && span.end <= over.end;
    if (inside && !strongOf(over) && strongOf(span)) over.inner.push(...span.hits.filter((h) => h.exact || h.similarity >= sureLevel));
  }
  taken.sort((a, b) => a.start - b.start);

  const common = commonWordsOf(cfg);
  const out: ResolvedMatch[] = [];
  for (const span of taken) {
    const all = [...span.hits].sort(byScore);
    const exact = all.filter((h) => h.exact);
    const strong = exact.length > 0 ? exact : all.filter((h) => h.similarity >= sureLevel);
    let sure: MatchHit | null = null;
    if (strong.length === 1) sure = strong[0]!;
    else if (strong.length > 1 && span.hint) {
      const types = HINT_TYPES[span.hint];
      const ofType = strong.filter((h) => types.includes(h.objectType));
      if (ofType.length === 1) sure = ofType[0]!;
    }
    if (sure && !maybeCommonWord(span, common)) {
      out.push({ kind: "sure", hit: sure });
      continue;
    }
    out.push({
      kind: "ambiguous",
      start: span.start,
      end: span.end,
      surface: span.surface,
      hint: span.hint,
      candidates: bestPerObject([...all, ...span.inner])
        .slice(0, cfg.mentions.maxCandidates)
        .map((h) => ({ geoObjectId: h.geoObjectId, similarity: h.similarity })),
    });
  }
  return out;
}

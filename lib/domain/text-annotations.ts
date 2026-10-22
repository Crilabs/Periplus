import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { MatchKind } from "@/lib/db/schema";
import { activeExtractionRun } from "@/lib/domain/extraction/active-run";
import type { Span } from "@/lib/domain/extraction/quote";
import { displayNameSql } from "@/lib/domain/gazetteer/names";

/*
 * Mentions and quotes of a document version for the document page (spec 06, "Facts mit hervorgehobenem Zitat in der
 * UI"): per chunk its text with the spans of its mentions and of the quotes of its facts, as stored offsets into the
 * chunk text. The UI highlights them by splitting the text at these offsets (`AnnotatedText`), never as HTML. A chunk
 * carried over from an earlier version keeps the mentions and facts of the chunk it was carried from (its text is the
 * same), so they are taken from that chunk.
 */

/** Characters of chunk text shown before and after a quote (`quoteContext`). */
export const QUOTE_CONTEXT_CHARS = 200;

export type ChunkMention = { id: string; geoObjectId: string; name: string | null; matchKind: MatchKind; confidence: number };

/** A place the chunk's page is bound to (spec 16 C): shown as a line above the text, never as a span. */
export type ChunkBound = { id: string; geoObjectId: string; name: string | null };

export type ChunkFact = {
  id: string;
  geoObjectId: string;
  attribute: string;
  value: unknown;
  confidence: number;
  model: string | null;
  extractionRunId: string | null;
  /** The run the extraction run belongs to (for the link to its run page). */
  runId: string | null;
  /** From the active extraction run of its (version, geo object) (ruling M4-H-R2); others are shown greyed. */
  active: boolean;
};

export type ChunkAnnotations = {
  chunkId: string;
  ordinal: number;
  text: string;
  /** The chunk of an earlier version this one was carried over from (its mentions and facts are shown). */
  carriedFrom: string | null;
  spans: Span[];
  mentions: ChunkMention[];
  /** The places of the chunk's bound mentions (zero-length, `match_kind = 'bound'`), not in `mentions` or `spans`. */
  bound: ChunkBound[];
  facts: ChunkFact[];
};

/**
 * Whether each (document version, geo object) pair's facts of `extractionRunId` come from its active extraction run;
 * memoised per pair.
 */
export function activeRunCache(db: Db, cfg: AppConfig) {
  const cache = new Map<string, Promise<string | null>>();
  return async (documentVersionId: string, geoObjectId: string, extractionRunId: string | null): Promise<boolean> => {
    if (!extractionRunId) return false;
    const key = `${documentVersionId}|${geoObjectId}`;
    let active = cache.get(key);
    if (!active) {
      active = activeExtractionRun(db, documentVersionId, geoObjectId, cfg).then((r) => r?.id ?? null);
      cache.set(key, active);
    }
    return (await active) === extractionRunId;
  };
}

/** The chunks of a version in order, with mentions, facts and their spans (see the module comment). */
export async function versionAnnotations(db: Db, versionId: string, cfg: AppConfig = getConfig()): Promise<ChunkAnnotations[]> {
  // The root of each chunk's carry chain: the chunk that was matched and extracted.
  const { rows: chunkRows } = await db.execute<{ id: string; ordinal: number; text: string; carried_from: string | null; root: string }>(sql`
    with recursive chain as (
      select c.id as chunk_id, c.id, c.carried_from_chunk_id, 0 as depth
      from chunks c where c.document_version_id = ${versionId}
      union all
      select chain.chunk_id, p.id, p.carried_from_chunk_id, chain.depth + 1
      from chain join chunks p on p.id = chain.carried_from_chunk_id
      where chain.depth < 100
    )
    select c.id, c.ordinal, c.text, c.carried_from_chunk_id as carried_from,
      (select ch.id from chain ch where ch.chunk_id = c.id and ch.carried_from_chunk_id is null limit 1) as root
    from chunks c
    where c.document_version_id = ${versionId}
    order by c.ordinal
  `);
  if (chunkRows.length === 0) return [];
  const sources = new Map<string, string[]>();
  for (const c of chunkRows) sources.set(c.id, [...new Set([c.id, c.root ?? c.id])]);
  const allSources = [...new Set([...sources.values()].flat())];
  const list = sql`(select value::uuid from jsonb_array_elements_text(${JSON.stringify(allSources)}::jsonb))`;

  const { rows: mentionRows } = await db.execute<{
    id: string;
    chunk_id: string;
    geo_object_id: string;
    name: string | null;
    match_kind: MatchKind;
    confidence: number;
    char_start: number;
    char_end: number;
  }>(sql`
    select m.id, m.chunk_id, m.geo_object_id, ${displayNameSql(sql`m.geo_object_id`)} as name, m.match_kind, m.confidence,
      m.char_start, m.char_end
    from mentions m where m.chunk_id in ${list}
    order by m.char_start, m.id
  `);
  const { rows: factRows } = await db.execute<{
    id: string;
    chunk_id: string;
    geo_object_id: string;
    attribute: string;
    value: unknown;
    confidence: number;
    model: string | null;
    extraction_run_id: string | null;
    run_id: string | null;
    quote_start: number;
    quote_end: number;
    version_id: string;
  }>(sql`
    select f.id, f.quote_chunk_id as chunk_id, f.geo_object_id, f.attribute, f.value, f.confidence, r.model,
      f.extraction_run_id, r.run_id, f.quote_start, f.quote_end, m.document_version_id as version_id
    from facts f
    join mentions m on m.id = f.mention_id
    left join extraction_runs r on r.id = f.extraction_run_id
    where f.quote_chunk_id in ${list}
    order by f.quote_start, f.attribute, f.id
  `);
  const isActive = activeRunCache(db, cfg);

  const out: ChunkAnnotations[] = [];
  for (const c of chunkRows) {
    const from = new Set(sources.get(c.id));
    const named = mentionRows.filter((m) => from.has(m.chunk_id));
    const ms = named.filter((m) => m.match_kind !== "bound");
    const bound = named.filter((m) => m.match_kind === "bound");
    const fs = factRows.filter((f) => from.has(f.chunk_id));
    const facts: ChunkFact[] = [];
    for (const f of fs) {
      facts.push({
        id: f.id,
        geoObjectId: f.geo_object_id,
        attribute: f.attribute,
        value: f.value,
        confidence: Number(f.confidence),
        model: f.model,
        extractionRunId: f.extraction_run_id,
        runId: f.run_id,
        active: await isActive(f.version_id, f.geo_object_id, f.extraction_run_id),
      });
    }
    out.push({
      chunkId: c.id,
      ordinal: c.ordinal,
      text: c.text,
      carriedFrom: c.carried_from,
      spans: [
        ...ms.map((m): Span => ({ start: m.char_start, end: m.char_end, kind: "mention", ref: m.id })),
        // A quote of a fact outside the active run is highlighted apart (dashed, grey), like the fact in the table.
        // `facts[i]` is the fact of `fs[i]` (built in the same order).
        ...fs.map((f, i): Span => ({
          start: f.quote_start,
          end: f.quote_end,
          kind: facts[i]!.active ? "quote" : "inactive-quote",
          ref: f.id,
        })),
      ],
      mentions: ms.map((m) => ({
        id: m.id,
        geoObjectId: m.geo_object_id,
        name: m.name,
        matchKind: m.match_kind,
        confidence: Number(m.confidence),
      })),
      bound: bound.map((m) => ({ id: m.id, geoObjectId: m.geo_object_id, name: m.name })),
      facts,
    });
  }
  return out;
}

/**
 * The quote `text[start, end)` with up to `chars` characters before and after it, cut at word boundaries: a word the
 * cut would split is left out, and a cut side starts or ends with "…".
 */
export function quoteContext(text: string, start: number, end: number, chars = QUOTE_CONTEXT_CHARS): { before: string; quote: string; after: string } {
  const from = Math.max(0, start - chars);
  const to = Math.min(text.length, end + chars);
  let before = text.slice(from, start);
  let after = text.slice(end, to);
  if (from > 0) {
    // Cut inside a word: drop its rest up to the next whitespace.
    if (/\S/.test(text[from - 1]!) && /\S/.test(text[from]!)) {
      const ws = before.search(/\s/);
      before = ws < 0 ? "" : before.slice(ws);
    }
    before = `… ${before.trimStart()}`;
  }
  if (to < text.length) {
    if (/\S/.test(text[to - 1]!) && /\S/.test(text[to]!)) {
      const ws = after.search(/\s\S*$/);
      after = ws < 0 ? "" : after.slice(0, ws);
    }
    after = `${after.trimEnd()} …`;
  }
  return { before, quote: text.slice(start, end), after };
}

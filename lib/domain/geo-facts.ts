import { sql, type SQL } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { MatchKind } from "@/lib/db/schema";
import { getFactSchema } from "@/lib/domain/facts/schema";
import { activeRunCache, quoteContext, QUOTE_CONTEXT_CHARS } from "@/lib/domain/text-annotations";

/*
 * The facts and mentions of a geo object for its geo and place pages (spec 06, spec 09): every fact with where it
 * comes from (a quoted text, a computation, a review, an observation), the quote with its context in the chunk, the
 * source and the extraction run. A text fact counts as active only when it comes from the active extraction run of its
 * (document version, geo object) (ruling M4-H-R2); facts of other runs (an older model or prompt, a comparison, a
 * blocked run) stay visible but marked, never mixed in silently.
 */

export type FactView = {
  id: string;
  attribute: string;
  value: unknown;
  confidence: number;
  observedAt: string;
  origin: "text" | "computed" | "review" | "observed";
  quote: string | null;
  /** Up to 200 characters of chunk text before and after the quote, cut at word boundaries. */
  context: { before: string; quote: string; after: string } | null;
  source: { domain: string; weight: number } | null;
  documentId: string | null;
  model: string | null;
  extractionRunId: string | null;
  /** The run the extraction run belongs to (for the link to its run page). */
  runId: string | null;
  /** From the active extraction run of its version and object, or a computation, review or observation. */
  active: boolean;
};

export type AttributeFacts = { attribute: string; facts: FactView[] };

/** Attribute keys in fact schema order (all levels, first occurrence), for sorting. */
function schemaOrder(cfg: AppConfig): Map<string, number> {
  const order = new Map<string, number>();
  for (const defs of Object.values(getFactSchema(cfg.factSchema.version).levels)) {
    for (const d of defs) if (!order.has(d.key)) order.set(d.key, order.size);
  }
  return order;
}

type FactRow = {
  id: string;
  geo_object_id: string;
  attribute: string;
  value: unknown;
  confidence: number;
  observed_at: string;
  mention_id: string | null;
  computation_id: string | null;
  review_decision_id: string | null;
  quote: string | null;
  quote_start: number | null;
  quote_end: number | null;
  chunk_text: string | null;
  version_id: string | null;
  document_id: string | null;
  domain: string | null;
  weight: number | null;
  model: string | null;
  extraction_run_id: string | null;
  run_id: string | null;
};

/** The facts matching `where` (on `facts f`) as `FactView`s, newest observation first. */
async function loadFactViews(db: Db, where: SQL, cfg: AppConfig): Promise<FactView[]> {
  const { rows } = await db.execute<FactRow>(sql`
    select f.id, f.geo_object_id, f.attribute, f.value, f.confidence, f.observed_at::text as observed_at, f.mention_id,
      f.computation_id, f.review_decision_id, f.quote, f.quote_start, f.quote_end, c.text as chunk_text,
      m.document_version_id as version_id, v.document_id, s.domain, s.weight, r.model, f.extraction_run_id, r.run_id
    from facts f
    left join chunks c on c.id = f.quote_chunk_id
    left join mentions m on m.id = f.mention_id
    left join document_versions v on v.id = m.document_version_id
    left join documents d on d.id = v.document_id
    left join sources s on s.id = d.source_id
    left join extraction_runs r on r.id = f.extraction_run_id
    where ${where}
    order by f.observed_at desc, f.created_at desc, f.id
  `);
  const isActive = activeRunCache(db, cfg);
  const views: FactView[] = [];
  for (const f of rows) {
    const origin: FactView["origin"] = f.mention_id ? "text" : f.computation_id ? "computed" : f.review_decision_id ? "review" : "observed";
    const active = origin === "text" ? await isActive(f.version_id!, f.geo_object_id, f.extraction_run_id) : true;
    const context =
      origin === "text" && f.chunk_text !== null && f.quote_start !== null && f.quote_end !== null
        ? quoteContext(f.chunk_text, f.quote_start, f.quote_end, QUOTE_CONTEXT_CHARS)
        : null;
    views.push({
      id: f.id,
      attribute: f.attribute,
      value: f.value,
      confidence: Number(f.confidence),
      observedAt: f.observed_at,
      origin,
      quote: f.quote,
      context,
      source: f.domain !== null ? { domain: f.domain, weight: Number(f.weight) } : null,
      documentId: f.document_id,
      model: f.model,
      extractionRunId: f.extraction_run_id,
      runId: f.run_id,
      active,
    });
  }
  return views;
}

/** The facts with the given ids as `FactView`s, keyed by id (a missing id is left out). */
export async function factViewsByIds(db: Db, ids: string[], cfg: AppConfig = getConfig()): Promise<Map<string, FactView>> {
  if (ids.length === 0) return new Map();
  const views = await loadFactViews(db, sql`f.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`, cfg);
  return new Map(views.map((v) => [v.id, v]));
}

/**
 * The facts of a geo object grouped by attribute (fact schema order, unknown keys after them by name), each group
 * newest observation first. `runs: "active"` keeps only active facts, `"all"` shows every fact with its `active` flag.
 */
export async function geoFacts(
  db: Db,
  geoObjectId: string,
  opts: { runs: "active" | "all" },
  cfg: AppConfig = getConfig(),
): Promise<AttributeFacts[]> {
  const groups = new Map<string, FactView[]>();
  for (const view of await loadFactViews(db, sql`f.geo_object_id = ${geoObjectId}`, cfg)) {
    if (opts.runs === "active" && !view.active) continue;
    groups.set(view.attribute, [...(groups.get(view.attribute) ?? []), view]);
  }
  const order = schemaOrder(cfg);
  const rank = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([attribute, facts]) => ({ attribute, facts }));
}

/** Mentions shown per page of the geo page. */
export const MENTIONS_PER_PAGE = 50;
/** Characters of chunk text shown around a mention. */
const MENTION_SNIPPET_CHARS = 120;

export type GeoMentionRow = {
  id: string;
  documentId: string;
  url: string;
  domain: string;
  observedAt: string;
  matchKind: MatchKind;
  confidence: number;
  /** The mention with chunk text around it (cut at word boundaries). */
  snippet: { before: string; quote: string; after: string };
};

/** One page (from 1) of the geo object's mentions, newest observation first, and their total. */
export async function geoMentions(db: Db, geoObjectId: string, page: number): Promise<{ rows: GeoMentionRow[]; total: number }> {
  const offset = (Math.max(1, Math.floor(page)) - 1) * MENTIONS_PER_PAGE;
  const { rows } = await db.execute<{
    id: string;
    document_id: string;
    url: string;
    domain: string;
    observed_at: string;
    match_kind: MatchKind;
    confidence: number;
    text: string;
    char_start: number;
    char_end: number;
    total: number;
  }>(sql`
    select m.id, d.id as document_id, d.url, s.domain, m.observed_at::text as observed_at, m.match_kind, m.confidence,
      c.text, m.char_start, m.char_end, count(*) over ()::int as total
    from mentions m
    join chunks c on c.id = m.chunk_id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    join sources s on s.id = d.source_id
    where m.geo_object_id = ${geoObjectId}
    order by m.observed_at desc, m.id
    limit ${MENTIONS_PER_PAGE} offset ${offset}
  `);
  let total = rows[0] ? Number(rows[0].total) : 0;
  if (rows.length === 0 && offset > 0) {
    const { rows: counted } = await db.execute<{ n: number }>(sql`select count(*)::int as n from mentions where geo_object_id = ${geoObjectId}`);
    total = Number(counted[0]!.n);
  }
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      url: r.url,
      domain: r.domain,
      observedAt: r.observed_at,
      matchKind: r.match_kind,
      confidence: Number(r.confidence),
      snippet: quoteContext(r.text, r.char_start, r.char_end, MENTION_SNIPPET_CHARS),
    })),
  };
}

import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ConverterName } from "@/lib/adapters/fetch";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { converterOutputs, converterSamples, sources } from "@/lib/db/schema";
import { CONVERTERS } from "@/lib/domain/sources/crawl-rules";

/** Spec 05: the converters are compared on 50 pages, 5 from each of the 10 largest approved sources. */
export const CONVERTER_SAMPLE = { pages: 50, sources: 10, perSource: 5 } as const;

/** An admin's verdict on one converter's Markdown of a sample page; `tablesKept` null = the page has no tables. */
export type Rating = { mainContent: boolean; boilerplateRemoved: boolean; tablesKept: boolean | null };

export const ratingSchema = z.strictObject({
  mainContent: z.boolean(),
  boilerplateRemoved: z.boolean(),
  tablesKept: z.boolean().nullable(),
});

export type ConverterSummary = {
  converter: ConverterName;
  /** Output rows (successful or failed). */
  pages: number;
  errors: number;
  rated: number;
  /** Shares of the rated pages in percent; null without a rated page (tables: without a rated page with tables). */
  mainContentPct: number | null;
  boilerplatePct: number | null;
  tablesPct: number | null;
  /** Averages over the successful outputs. */
  avgCostEur: number;
  avgDurationMs: number;
  avgChars: number;
};

/** Archive key of one converter's Markdown of a sample page. */
export function comparisonMdKey(sampleId: string, converter: ConverterName): string {
  return `comparison/converters/${sampleId}/${converter}.md`;
}

/**
 * Adds pages to the comparison sample: the `CONVERTER_SAMPLE.sources` current approved sources with the most active
 * HTML documents (current version archived as HTML, uploads excluded), from each the first `perSource` documents by
 * `md5(url_normalized)` (stable, but not alphabetical). The existing sample stays; pages already in it are skipped and
 * the sample never grows beyond `CONVERTER_SAMPLE.pages`. Returns the pages added and the sources picked from.
 */
export async function pickConverterSample(db: Db): Promise<{ added: number; sources: number }> {
  const [{ n: existing }] = (await db.select({ n: count() }).from(converterSamples)) as [{ n: number }];
  const room = CONVERTER_SAMPLE.pages - existing;
  const { rows } = await db.execute<{ source_id: string; url: string; url_normalized: string }>(sql`
    with html_docs as (
      select d.source_id, d.url, d.url_normalized
      from documents d
      join document_versions v on v.id = d.current_version_id
      join sources s on s.id = d.source_id
      where s.status = 'approved' and s.valid_to is null
        and d.status = 'active' and d.valid_to is null
        and d.url not like 'upload://%'
        and v.raw_key like '%.raw.html'
    ),
    largest as (
      select h.source_id
      from html_docs h join sources s on s.id = h.source_id
      group by h.source_id, s.domain
      order by count(*) desc, s.domain
      limit ${CONVERTER_SAMPLE.sources}
    ),
    ranked as (
      select h.*, row_number() over (partition by h.source_id order by md5(h.url_normalized), h.url_normalized) as rn
      from html_docs h where h.source_id in (select source_id from largest)
    )
    select source_id, url, url_normalized from ranked
    where rn <= ${CONVERTER_SAMPLE.perSource}
    order by source_id, rn
  `);
  const picked = new Set(rows.map((r) => r.source_id)).size;
  if (room <= 0 || rows.length === 0) return { added: 0, sources: picked };
  const known = new Set(
    (
      await db
        .select({ url: converterSamples.urlNormalized })
        .from(converterSamples)
        .where(inArray(converterSamples.urlNormalized, rows.map((r) => r.url_normalized)))
    ).map((r) => r.url),
  );
  const fresh = rows.filter((r) => !known.has(r.url_normalized)).slice(0, room);
  if (fresh.length === 0) return { added: 0, sources: picked };
  const added = await db
    .insert(converterSamples)
    .values(fresh.map((r) => ({ sourceId: r.source_id, url: r.url, urlNormalized: r.url_normalized })))
    .onConflictDoNothing({ target: converterSamples.urlNormalized })
    .returning({ id: converterSamples.id });
  return { added: added.length, sources: picked };
}

/** Samples that lack a successful output of at least one converter (the jobs of a comparison run). */
export async function samplesToCompare(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: converterSamples.id })
    .from(converterSamples)
    .leftJoin(converterOutputs, and(eq(converterOutputs.sampleId, converterSamples.id), isNull(converterOutputs.error)))
    .groupBy(converterSamples.id)
    .having(sql`count(${converterOutputs.id}) < ${CONVERTERS.length}`)
    .orderBy(asc(converterSamples.id));
  return rows.map((r) => r.id);
}

/** The output of `converter` for the sample has no successful Markdown to rate. */
export class OutputNotRateable extends Error {
  constructor(sampleId: string, converter: ConverterName) {
    super(`no successful ${converter} output for sample ${sampleId}`);
    this.name = "OutputNotRateable";
  }
}

/** Stores an admin's rating of one successful output (a new rating replaces the old one). */
export async function rateConverterOutput(
  db: Db,
  input: { sampleId: string; converter: ConverterName; rating: Rating; by: string },
): Promise<void> {
  const rating = ratingSchema.parse(input.rating);
  const updated = await db
    .update(converterOutputs)
    .set({ rating, ratedBy: input.by, ratedAt: sql`now()` })
    .where(
      and(
        eq(converterOutputs.sampleId, input.sampleId),
        eq(converterOutputs.converter, input.converter),
        isNull(converterOutputs.error),
        isNotNull(converterOutputs.mdKey),
      ),
    )
    .returning({ id: converterOutputs.id });
  if (updated.length === 0) throw new OutputNotRateable(input.sampleId, input.converter);
}

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((1000 * part) / whole) / 10);

/** Per converter: outputs, errors, rated pages, the shares of the criteria among rated pages and the averages. */
export async function converterSummary(db: Db): Promise<ConverterSummary[]> {
  const rows = await db
    .select({
      converter: converterOutputs.converter,
      pages: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${converterOutputs.error} is not null)::int`,
      rated: sql<number>`count(*) filter (where ${converterOutputs.error} is null and ${converterOutputs.rating} is not null)::int`,
      mainContent: sql<number>`count(*) filter (where ${converterOutputs.error} is null and (${converterOutputs.rating} ->> 'mainContent')::boolean)::int`,
      boilerplate: sql<number>`count(*) filter (where ${converterOutputs.error} is null and (${converterOutputs.rating} ->> 'boilerplateRemoved')::boolean)::int`,
      withTables: sql<number>`count(*) filter (where ${converterOutputs.error} is null and jsonb_typeof(${converterOutputs.rating} -> 'tablesKept') = 'boolean')::int`,
      tablesKept: sql<number>`count(*) filter (where ${converterOutputs.error} is null and (${converterOutputs.rating} ->> 'tablesKept')::boolean)::int`,
      avgCost: sql<string>`coalesce(avg(${converterOutputs.costEur}) filter (where ${converterOutputs.error} is null), 0)`,
      avgDuration: sql<string>`coalesce(avg(${converterOutputs.durationMs}) filter (where ${converterOutputs.error} is null), 0)`,
      avgChars: sql<string>`coalesce(avg(${converterOutputs.chars}) filter (where ${converterOutputs.error} is null), 0)`,
    })
    .from(converterOutputs)
    .groupBy(converterOutputs.converter);
  const byName = new Map(rows.map((r) => [r.converter, r]));
  return CONVERTERS.map((converter) => {
    const r = byName.get(converter);
    if (!r) {
      return { converter, pages: 0, errors: 0, rated: 0, mainContentPct: null, boilerplatePct: null, tablesPct: null, avgCostEur: 0, avgDurationMs: 0, avgChars: 0 };
    }
    return {
      converter,
      pages: r.pages,
      errors: r.errors,
      rated: r.rated,
      mainContentPct: pct(r.mainContent, r.rated),
      boilerplatePct: pct(r.boilerplate, r.rated),
      tablesPct: pct(r.tablesKept, r.withTables),
      avgCostEur: Number(r.avgCost),
      avgDurationMs: Math.round(Number(r.avgDuration)),
      avgChars: Math.round(Number(r.avgChars)),
    };
  });
}

export type OutputState = { error: string | null; rating: Rating | null };

export type SampleRow = {
  id: string;
  url: string;
  domain: string;
  outputs: Partial<Record<ConverterName, OutputState>>;
};

/** Whether every converter has an output and each successful one is rated (a failed conversion needs no rating). */
export function sampleRated(sample: Pick<SampleRow, "outputs">): boolean {
  return CONVERTERS.every((c) => {
    const o = sample.outputs[c];
    return o !== undefined && (o.error !== null || o.rating !== null);
  });
}

/** Every sample page (by source domain and URL) with the state of each converter's output. */
export async function listConverterSamples(db: Db): Promise<SampleRow[]> {
  const rows = await db
    .select({
      id: converterSamples.id,
      url: converterSamples.url,
      domain: sources.domain,
      converter: converterOutputs.converter,
      error: converterOutputs.error,
      rating: converterOutputs.rating,
    })
    .from(converterSamples)
    .innerJoin(sources, eq(sources.id, converterSamples.sourceId))
    .leftJoin(converterOutputs, eq(converterOutputs.sampleId, converterSamples.id))
    .orderBy(asc(sources.domain), asc(converterSamples.urlNormalized));
  const samples = new Map<string, SampleRow>();
  for (const r of rows) {
    let sample = samples.get(r.id);
    if (!sample) {
      sample = { id: r.id, url: r.url, domain: r.domain, outputs: {} };
      samples.set(r.id, sample);
    }
    if (r.converter) sample.outputs[r.converter] = { error: r.error, rating: (r.rating as Rating | null) ?? null };
  }
  return [...samples.values()];
}

export type SampleOutput = {
  converter: ConverterName;
  markdown: string | null;
  chars: number;
  durationMs: number;
  costEur: number;
  error: string | null;
  rating: Rating | null;
  ratedBy: string | null;
};

/** One sample page with each converter's output and Markdown (read from the archive); null when unknown. */
export async function converterSampleDetail(
  db: Db,
  archive: Archive,
  sampleId: string,
): Promise<{ id: string; url: string; domain: string; outputs: SampleOutput[] } | null> {
  const [sample] = await db
    .select({ id: converterSamples.id, url: converterSamples.url, domain: sources.domain })
    .from(converterSamples)
    .innerJoin(sources, eq(sources.id, converterSamples.sourceId))
    .where(eq(converterSamples.id, sampleId));
  if (!sample) return null;
  const rows = await db.select().from(converterOutputs).where(eq(converterOutputs.sampleId, sampleId));
  const outputs = await Promise.all(
    rows.map(async (r): Promise<SampleOutput> => {
      const bytes = r.mdKey ? await archive.get(r.mdKey) : null;
      return {
        converter: r.converter,
        markdown: bytes ? new TextDecoder().decode(bytes) : null,
        chars: r.chars,
        durationMs: r.durationMs,
        costEur: Number(r.costEur),
        error: r.error,
        rating: (r.rating as Rating | null) ?? null,
        ratedBy: r.ratedBy,
      };
    }),
  );
  outputs.sort((a, b) => CONVERTERS.indexOf(a.converter) - CONVERTERS.indexOf(b.converter));
  return { ...sample, outputs };
}

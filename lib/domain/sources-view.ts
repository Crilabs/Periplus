import { asc, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  crawlFrontier,
  documents,
  documentVersions,
  externalCalls,
  frontierStatusEnum,
  sources,
  sourceStatusEnum,
  type DocType,
  type DocumentStatus,
  type FrontierStatus,
  type RunKind,
  type RunScopeType,
  type RunStatus,
  type SourceStatus,
} from "@/lib/db/schema";
import { getSource, type Source } from "./sources/store";

/** Rows per page of the source list and of a source's documents. */
export const SOURCES_PAGE_SIZE = 50;

export type SourceRow = {
  id: string;
  domain: string;
  name: string;
  status: SourceStatus;
  type: DocType;
  weight: number;
  documents: number;
  versions: number;
  lastRun: { id: string; status: RunStatus; finishedAt: Date | null } | null;
  costEur30d: number;
};

export type SourceFilter = { status?: SourceStatus; type?: DocType; q?: string; page: number };

/** A run touches a source when its scope is the source or `params.sourceIds` names it. */
const runOfSource = (sourceId: SQL) =>
  sql`((r.scope_type = 'source' and r.scope_id = ${sourceId}::text) or coalesce(r.params -> 'sourceIds', '[]'::jsonb) ? ${sourceId}::text)`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Current (not ended) sources, `SOURCES_PAGE_SIZE` per page (`page` from 1), ordered by status (enum order) and
 * domain; filtered by status, type and `q` (part of the domain or name, case-insensitive). Per source: its documents,
 * their versions, its newest run (scope or `params.sourceIds`) and its costs of the last 30 days
 * (`external_calls.source_id`).
 */
export async function listSources(db: Db, filter: SourceFilter): Promise<{ rows: SourceRow[]; total: number }> {
  const conditions: SQL[] = [sql`s.valid_to is null`];
  if (filter.status) conditions.push(sql`s.status = ${filter.status}`);
  if (filter.type) conditions.push(sql`s.type = ${filter.type}`);
  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(sql`(s.domain ilike ${pattern} or s.name ilike ${pattern})`);
  }
  const where = sql.join(conditions, sql` and `);
  const page = Math.max(1, Math.floor(filter.page));

  const [{ total }] = (
    await db.execute<{ total: number }>(sql`select count(*)::int as total from sources s where ${where}`)
  ).rows as [{ total: number }];
  const { rows } = await db.execute<{
    id: string;
    domain: string;
    name: string;
    status: SourceStatus;
    type: DocType;
    weight: number;
    documents: number;
    versions: number;
    run_id: string | null;
    run_status: RunStatus | null;
    run_finished_at: string | Date | null;
    cost: string;
  }>(sql`
    select s.id, s.domain, s.name, s.status, s.type, s.weight,
      (select count(*)::int from documents d where d.source_id = s.id) as documents,
      (select count(*)::int from document_versions v join documents d on d.id = v.document_id where d.source_id = s.id) as versions,
      lr.id as run_id, lr.status as run_status, lr.finished_at as run_finished_at,
      (select coalesce(sum(e.cost_eur), 0) from external_calls e
        where e.source_id = s.id and e.at > now() - interval '30 days') as cost
    from sources s
    left join lateral (
      select r.id, r.status, r.finished_at from runs r where ${runOfSource(sql`s.id`)} order by r.id desc limit 1
    ) lr on true
    where ${where}
    order by s.status, s.domain
    limit ${SOURCES_PAGE_SIZE} offset ${(page - 1) * SOURCES_PAGE_SIZE}`);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      name: r.name,
      status: r.status,
      type: r.type,
      weight: Number(r.weight),
      documents: r.documents,
      versions: r.versions,
      lastRun: r.run_id
        ? { id: r.run_id, status: r.run_status!, finishedAt: r.run_finished_at ? new Date(r.run_finished_at) : null }
        : null,
      costEur30d: Number(r.cost),
    })),
  };
}

/** Number of current (not ended) sources per status. */
export async function sourceStatusCounts(db: Db): Promise<Record<SourceStatus, number>> {
  const rows = await db
    .select({ status: sources.status, n: count() })
    .from(sources)
    .where(isNull(sources.validTo))
    .groupBy(sources.status);
  const counts = Object.fromEntries(sourceStatusEnum.enumValues.map((s) => [s, 0])) as Record<SourceStatus, number>;
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

/** Domains of the given sources (unknown ids left out), by domain. */
export async function sourceDomains(db: Db, ids: string[]): Promise<Array<{ id: string; domain: string }>> {
  if (ids.length === 0) return [];
  return db.select({ id: sources.id, domain: sources.domain }).from(sources).where(inArray(sources.id, ids)).orderBy(asc(sources.domain));
}

export type SourceDocumentRow = {
  id: string;
  url: string;
  status: DocumentStatus;
  versions: number;
  lastCheckedAt: Date | null;
  /** Language of the current version. */
  language: string | null;
};

export type SourceRunRow = {
  id: string;
  kind: RunKind;
  scopeType: RunScopeType;
  scopeId: string;
  status: RunStatus;
  stages: string[];
  createdAt: Date;
  finishedAt: Date | null;
};

export type SourceDetail = {
  source: Source & { validTo: string | null; createdAt: Date };
  frontier: Record<FrontierStatus, number>;
  documents: SourceDocumentRow[];
  documentTotal: number;
  /** The 10 newest runs of the source (scope or `params.sourceIds`). */
  runs: SourceRunRow[];
  costs: { totalEur: number; byService: Array<{ service: string; calls: number; costEur: number }> };
};

/**
 * A source with its rules and status reason, its frontier rows per status, its documents (`SOURCES_PAGE_SIZE` per
 * `docPage`, by URL), its 10 newest runs and its costs in total and per service (`external_calls.source_id`);
 * null when unknown.
 */
export async function sourceDetail(db: Db, id: string, opts: { docPage: number }): Promise<SourceDetail | null> {
  const source = await getSource(db, id);
  if (!source) return null;
  const [meta] = await db.select({ validTo: sources.validTo, createdAt: sources.createdAt }).from(sources).where(eq(sources.id, id));

  const frontierRows = await db
    .select({ status: crawlFrontier.status, n: count() })
    .from(crawlFrontier)
    .where(eq(crawlFrontier.sourceId, id))
    .groupBy(crawlFrontier.status);
  const frontier = Object.fromEntries(frontierStatusEnum.enumValues.map((s) => [s, 0])) as Record<FrontierStatus, number>;
  for (const r of frontierRows) frontier[r.status] = r.n;

  const [{ n: documentTotal }] = (await db.select({ n: count() }).from(documents).where(eq(documents.sourceId, id))) as [{ n: number }];
  const page = Math.max(1, Math.floor(opts.docPage));
  const docRows = await db
    .select({
      id: documents.id,
      url: documents.url,
      status: documents.status,
      lastCheckedAt: documents.lastCheckedAt,
      language: documentVersions.language,
      versions: sql<number>`(select count(*)::int from document_versions v where v.document_id = ${documents.id})`,
    })
    .from(documents)
    .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(eq(documents.sourceId, id))
    .orderBy(asc(documents.urlNormalized), asc(documents.id))
    .limit(SOURCES_PAGE_SIZE)
    .offset((page - 1) * SOURCES_PAGE_SIZE);

  const { rows: runRows } = await db.execute<{
    id: string;
    kind: RunKind;
    scope_type: RunScopeType;
    scope_id: string;
    status: RunStatus;
    stages: string[];
    created_at: string | Date;
    finished_at: string | Date | null;
  }>(sql`
    select r.id, r.kind, r.scope_type, r.scope_id, r.status, r.stages, r.created_at, r.finished_at
    from runs r where ${runOfSource(sql`${id}`)}
    order by r.id desc limit 10`);

  const costRows = await db
    .select({
      service: externalCalls.service,
      calls: count(),
      costEur: sql<string>`coalesce(sum(${externalCalls.costEur}), 0)`,
    })
    .from(externalCalls)
    .where(eq(externalCalls.sourceId, id))
    .groupBy(externalCalls.service)
    .orderBy(asc(externalCalls.service));
  const byService = costRows.map((r) => ({ service: r.service, calls: r.calls, costEur: Number(r.costEur) }));

  return {
    source: { ...source, validTo: meta!.validTo, createdAt: meta!.createdAt },
    frontier,
    documents: docRows.map((d) => ({ ...d, versions: Number(d.versions) })),
    documentTotal,
    runs: runRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      status: r.status,
      stages: r.stages,
      createdAt: new Date(r.created_at),
      finishedAt: r.finished_at ? new Date(r.finished_at) : null,
    })),
    costs: { totalEur: byService.reduce((sum, c) => sum + c.costEur, 0), byService },
  };
}

/**
 * The document `documentId` when it belongs to another source than `sourceId` (an upload of a PDF archived there
 * first): its id and the domain of its source, for the notice on the uploading source's page; null otherwise.
 */
export async function documentOfOtherSource(
  db: Db,
  documentId: string,
  sourceId: string,
): Promise<{ documentId: string; sourceDomain: string } | null> {
  const [row] = await db
    .select({ sourceId: documents.sourceId, domain: sources.domain })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .where(eq(documents.id, documentId));
  if (!row || row.sourceId === sourceId) return null;
  return { documentId, sourceDomain: row.domain };
}

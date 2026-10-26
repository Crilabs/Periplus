import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/*
 * Read functions of the MCP server (plan 2026-10-26-periplus-mcp) that no admin page has yet. Read only.
 */

export type Overview = {
  subdivisions: Array<{ key: string; name: string | null; status: string; places: Record<string, number> }>;
  runs: Array<{ id: string; kind: string; scope: string; status: string; startedAt: string | null; finishedAt: string | null }>;
  openReviewTasks: Record<string, number>;
  failedJobsLast24h: number;
  costEur: { today: number; last7Days: number };
};

/** Subdivisions with their places per status, the last 10 runs, open review tasks per kind, failed jobs, costs. */
export async function overview(db: Db, now: Date = new Date()): Promise<Overview> {
  const { rows: subs } = await db.execute<{ key: string; name: string | null; status: string; place_status: string | null; n: number }>(sql`
    select s.key, (select n.name from geo_names n where n.geo_object_id = s.geo_object_id and n.valid_to is null
                   order by (n.language = 'de') desc, n.name limit 1) as name,
           s.status::text as status, p.status::text as place_status, count(p.id)::int as n
    from subdivisions s
    left join geo_objects g on g.subdivision_id = s.id and g.valid_to is null
    left join places p on p.geo_object_id = g.id and p.valid_to is null and p.merged_into_id is null
    where s.valid_to is null
    group by s.key, s.geo_object_id, s.status, p.status
    order by s.key`);
  const bySub = new Map<string, Overview["subdivisions"][number]>();
  for (const r of subs) {
    const entry = bySub.get(r.key) ?? { key: r.key, name: r.name, status: r.status, places: {} };
    if (r.place_status) entry.places[r.place_status] = r.n;
    bySub.set(r.key, entry);
  }
  const { rows: runs } = await db.execute<{ id: string; kind: string; scope: string; status: string; started_at: Date | null; finished_at: Date | null }>(sql`
    select id, kind::text as kind, scope_type::text || ':' || scope_id as scope, status::text as status, started_at, finished_at
    from runs order by created_at desc limit 10`);
  const { rows: review } = await db.execute<{ kind: string; n: number }>(sql`
    select kind::text as kind, count(*)::int as n from review_tasks where status = 'open' group by kind order by kind`);
  const since = new Date(now.getTime() - 86_400_000);
  const { rows: failed } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from review_tasks where kind = 'failed_job' and created_at >= ${since}`);
  const { rows: cost } = await db.execute<{ today: string | null; week: string | null }>(sql`
    select sum(cost_eur) filter (where created_at >= date_trunc('day', ${now}::timestamptz)) as today,
           sum(cost_eur) filter (where created_at >= ${now}::timestamptz - interval '7 days') as week
    from external_calls`);
  return {
    subdivisions: [...bySub.values()],
    runs: runs.map((r) => ({
      id: r.id, kind: r.kind, scope: r.scope, status: r.status,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    })),
    openReviewTasks: Object.fromEntries(review.map((r) => [r.kind, r.n])),
    failedJobsLast24h: failed[0]?.n ?? 0,
    costEur: { today: round2(Number(cost[0]?.today ?? 0)), last7Days: round2(Number(cost[0]?.week ?? 0)) },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The "failed job" review tasks of a run (any status): queue, stage, job key, error text as recorded, when. */
export async function failedJobsOfRun(
  db: Db,
  runId: string,
  limit = 50,
): Promise<Array<{ taskId: string; status: string; queue: unknown; stage: unknown; key: unknown; error: unknown; createdAt: string }>> {
  const { rows } = await db.execute<{ id: string; status: string; context: Record<string, unknown>; created_at: Date }>(sql`
    select id, status::text as status, context, created_at from review_tasks
    where kind = 'failed_job' and context->>'runId' = ${runId}
    order by created_at desc limit ${limit}`);
  return rows.map((r) => ({
    taskId: r.id, status: r.status, queue: r.context.queue, stage: r.context.stage, key: r.context.key, error: r.context.error,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export const SQL_ROW_LIMIT = 500;
export const SQL_TIMEOUT_MS = 15_000;

export type SqlResult = { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean };

/**
 * One read-only query on `reader`, a connection as the role `periplus_mcp_reader` (`getReaderDb`): its own login with
 * SELECT on the domain tables only (no users, logins, API keys, MCP tokens, rate limits), read only and with a
 * statement timeout on the role, so a query cannot widen its rights. Runs in a READ ONLY transaction, always rolled
 * back; one statement only (the extended protocol refuses several). At most `SQL_ROW_LIMIT` rows are returned.
 */
export async function readOnlySql(reader: Db, query: string): Promise<SqlResult> {
  const text = query.trim().replace(/;\s*$/, "");
  if (text === "") throw new SqlRejected("Leere Abfrage");
  let result: SqlResult | null = null;
  try {
    await reader.transaction(async (tx) => {
      await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw(`set local statement_timeout = ${SQL_TIMEOUT_MS}`));
      const res = await tx.execute(sql`${sql.raw(text)}`);
      const fields = ((res as unknown as { fields?: Array<{ name: string }> }).fields ?? []).map((f) => f.name);
      const rows = res.rows as Array<Record<string, unknown>>;
      const columns = fields.length > 0 ? fields : Object.keys(rows[0] ?? {});
      result = {
        columns,
        rows: rows.slice(0, SQL_ROW_LIMIT).map((r) => columns.map((c) => r[c])),
        rowCount: rows.length,
        truncated: rows.length > SQL_ROW_LIMIT,
      };
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw new SqlRejected(postgresMessage(e));
  }
  return result!;
}

const ROLLBACK = Symbol("rollback");

/** A query Postgres refused (syntax, permission, read only, timeout); the message is Postgres' own, without the query. */
export class SqlRejected extends Error {}

function postgresMessage(e: unknown): string {
  const err = (e as { cause?: unknown })?.cause ?? e;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Failed query:[\s\S]*?\n/, "").slice(0, 500);
}

export type PlaceBasics = {
  placeId: string;
  publicId: string | null;
  geoObjectId: string;
  kind: string;
  status: string;
  statusReason: string | null;
  name: string | null;
  subdivisionKey: string | null;
  lon: number;
  lat: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Places by id (`places.id`), public id (`sp_…`) or name (case-insensitive substring of any valid name), at most 20. */
export async function findPlaces(db: Db, ref: string, subdivisionKey?: string): Promise<PlaceBasics[]> {
  const term = ref.trim();
  if (term === "") return [];
  const where = UUID.test(term)
    ? sql`p.id = ${term}::uuid`
    : /^sp_/i.test(term)
      ? sql`p.public_id = ${term}`
      : sql`exists (select 1 from geo_names n where n.geo_object_id = p.geo_object_id and n.valid_to is null and n.name ilike ${"%" + term.replace(/[%_\\]/g, "\\$&") + "%"})`;
  const sub = subdivisionKey ? sql`and s.key = ${subdivisionKey}` : sql``;
  const { rows } = await db.execute<{
    place_id: string; public_id: string | null; geo_object_id: string; kind: string; status: string; status_reason: string | null;
    name: string | null; subdivision_key: string | null; lon: number; lat: number;
  }>(sql`
    select p.id as place_id, p.public_id, p.geo_object_id, p.kind::text as kind, p.status::text as status, p.status_reason,
           (select n.name from geo_names n where n.geo_object_id = p.geo_object_id and n.valid_to is null
            order by (n.language = 'en') desc, (n.language = 'de') desc, n.name limit 1) as name,
           s.key as subdivision_key, ST_X(p.position::geometry) as lon, ST_Y(p.position::geometry) as lat
    from places p
    join geo_objects g on g.id = p.geo_object_id
    left join subdivisions s on s.id = g.subdivision_id
    where p.valid_to is null and ${where} ${sub}
    order by (p.status = 'confirmed') desc, p.id
    limit 20`);
  return rows.map((r) => ({
    placeId: r.place_id, publicId: r.public_id, geoObjectId: r.geo_object_id, kind: r.kind, status: r.status, statusReason: r.status_reason,
    name: r.name, subdivisionKey: r.subdivision_key, lon: Number(r.lon), lat: Number(r.lat),
  }));
}

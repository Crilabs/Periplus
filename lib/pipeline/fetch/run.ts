import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { documents, runs, sources } from "@/lib/db/schema";
import { EMBED_STAGE } from "../embed";
import { startRun } from "../runs";
import { RunScopeNotReady } from "../tile-scope";
import { FETCH_SOURCE_STAGE } from "./source";
import { FETCH_URL_STAGE } from "./url";

// Kept apart from ./source and ./url: the job handlers import those, and this module reaches the stage registry
// through ../runs, which would close an import cycle through the handlers (ruling M3-P1).

/** Stages of a crawl run: prepare the sources, fetch their pages, embed the new chunks. */
export const FETCH_RUN_STAGES = [FETCH_SOURCE_STAGE, FETCH_URL_STAGE, EMBED_STAGE];

/** Pages of a test crawl. */
export const TEST_CRAWL_MAX_PAGES = 10;

/**
 * Starts the run "Quellen abrufen" for the given sources or all approved ones (`"approved"`, resolved to the IDs
 * approved now and stored in `params.sourceIds`). Checked before the run exists: at least one source, every given
 * source exists and is approved, and none is fetched by another queued or running run (`RunScopeNotReady`; ruling
 * M3-C-R6: overlapping crawls of one source are prevented). Scope `source` with the only ID, or `"approved"`.
 */
export async function startFetchRun(
  db: Db,
  boss: PgBoss,
  input: { sourceIds: string[] | "approved"; triggeredBy: string; maxPages?: number },
): Promise<{ id: string }> {
  let sourceIds: string[];
  if (input.sourceIds === "approved") {
    sourceIds = (await db.select({ id: sources.id }).from(sources).where(eq(sources.status, "approved"))).map((s) => s.id);
    if (sourceIds.length === 0) throw new RunScopeNotReady("no_approved_sources", "No source is approved yet");
  } else {
    sourceIds = [...new Set(input.sourceIds)];
    if (sourceIds.length === 0) throw new RunScopeNotReady("no_approved_sources", "No source given");
    await assertApproved(db, sourceIds);
  }
  await assertNoActiveFetchRun(db, sourceIds);
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "source", id: input.sourceIds === "approved" ? "approved" : sourceIds.length === 1 ? sourceIds[0]! : "selection" },
    params: { sourceIds, ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}) },
    stages: FETCH_RUN_STAGES,
    triggeredBy: input.triggeredBy,
  });
}

/** Every source of `sourceIds` exists and is approved, else `RunScopeNotReady` `source_not_approved`. */
async function assertApproved(db: Db, sourceIds: string[]): Promise<void> {
  const approved = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(inArray(sources.id, sourceIds), eq(sources.status, "approved")));
  if (approved.length !== sourceIds.length) {
    const ok = new Set(approved.map((s) => s.id));
    throw new RunScopeNotReady("source_not_approved", `Sources not approved: ${sourceIds.filter((id) => !ok.has(id)).join(", ")}`);
  }
}

/** Of `sourceIds`, those a queued or running run crawls (a run with stage `fetch.url` naming them in `params.sourceIds`). */
export async function sourcesBeingFetched(db: Db, sourceIds: string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const ids = sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const active = await db
    .select({ params: runs.params })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["queued", "running"]),
        sql`${FETCH_URL_STAGE} = any(${runs.stages})`,
        sql`(${runs.params} -> 'sourceIds') ?| array[${ids}]::text[]`,
      ),
    );
  const busy = new Set(active.flatMap((r) => ((r.params as { sourceIds?: unknown }).sourceIds as string[] | undefined) ?? []));
  return sourceIds.filter((id) => busy.has(id));
}

/** None of `sourceIds` is being fetched by another run, else `RunScopeNotReady` `source_run_active`. */
async function assertNoActiveFetchRun(db: Db, sourceIds: string[]): Promise<void> {
  const busy = await sourcesBeingFetched(db, sourceIds);
  if (busy.length > 0) throw new RunScopeNotReady("source_run_active", `Sources already being fetched: ${busy.join(", ")}`);
}

/** Test crawl of one approved source: at most `TEST_CRAWL_MAX_PAGES` pages. */
export function startTestCrawl(db: Db, boss: PgBoss, sourceId: string, triggeredBy: string): Promise<{ id: string }> {
  return startFetchRun(db, boss, { sourceIds: [sourceId], triggeredBy, maxPages: TEST_CRAWL_MAX_PAGES });
}

/** Archives an uploaded PDF (`upload://<sha256>` document): only `fetch.url`, with `params.documentIds`. */
export async function startUploadFetchRun(db: Db, boss: PgBoss, documentId: string, triggeredBy: string): Promise<{ id: string }> {
  const [doc] = await db.select({ url: documents.url, sourceId: documents.sourceId }).from(documents).where(eq(documents.id, documentId));
  if (!doc || !doc.url.startsWith("upload://")) {
    throw new RunScopeNotReady("document_not_upload", `Document ${documentId} is not an uploaded file`);
  }
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "source", id: doc.sourceId },
    params: { documentIds: [documentId] },
    stages: FETCH_RUN_STAGES.filter((s) => s !== FETCH_SOURCE_STAGE),
    triggeredBy,
  });
}

/** Scope id of an embedding backfill run (scope type `system`). */
export const EMBED_BACKFILL_SCOPE = "embeddings";

/** Embeds every chunk still without an embedding (`params.all`; a plan takes at most `EMBED_PLAN_LIMIT`). */
export function startEmbedBackfillRun(db: Db, boss: PgBoss, triggeredBy: string): Promise<{ id: string }> {
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "system", id: EMBED_BACKFILL_SCOPE },
    params: { all: true },
    stages: [EMBED_STAGE],
    triggeredBy,
  });
}


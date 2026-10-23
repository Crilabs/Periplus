import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { documents, runs, sources } from "@/lib/db/schema";
import { createRun } from "@/lib/domain/runs";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { crawlableSourceIds, ensureWhitelistSources, sourceIdByDomain } from "@/lib/domain/sources/store";
import { EMBED_STAGE } from "../embed";
import { enqueueStage, startRun } from "../runs";
import { WIKIVOYAGE_DOMAIN, WIKIVOYAGE_STAGE } from "../sources/wikivoyage";
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
 * Starts the run "Quellen abrufen" for the given sources or all approved ones (`"approved"`, resolved to the IDs of
 * the current sources approved now and stored in `params.sourceIds`). Checked before the run exists: at least one
 * source, every given source exists, is not ended and is approved, and none is fetched by another queued or running run (`RunScopeNotReady`; ruling
 * M3-C-R6: overlapping crawls of one source are prevented). With `skipBusy` (ruling M3-D-R3, "Alle freigegebenen
 * crawlen") busy sources are left out instead: returned in `skipped` and kept in `params.skippedSourceIds`; only
 * when every source is busy the start is refused. Scope `source` with the only ID, `"approved"` or `"selection"`.
 */
export async function startFetchRun(
  db: Db,
  boss: PgBoss,
  input: { sourceIds: string[] | "approved"; triggeredBy: string; maxPages?: number; skipBusy?: boolean },
): Promise<{ id: string; skipped: string[] }> {
  let sourceIds: string[];
  if (input.sourceIds === "approved") {
    sourceIds = await crawlableSourceIds(db);
    if (sourceIds.length === 0) throw new RunScopeNotReady("no_approved_sources", "No source is approved yet");
  } else {
    sourceIds = [...new Set(input.sourceIds)];
    if (sourceIds.length === 0) throw new RunScopeNotReady("no_approved_sources", "No source given");
    await assertApproved(db, sourceIds);
  }
  const scopeId = input.sourceIds === "approved" ? "approved" : sourceIds.length === 1 ? sourceIds[0]! : "selection";
  return startExclusiveFetchRun(db, boss, sourceIds, { skipBusy: input.skipBusy ?? false }, (ids, skipped) => ({
    kind: "stage",
    scope: { type: "source", id: scopeId },
    params: {
      sourceIds: ids,
      ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
      ...(skipped.length > 0 ? { skippedSourceIds: skipped } : {}),
    },
    stages: FETCH_RUN_STAGES,
    triggeredBy: input.triggeredBy,
  }));
}

/**
 * Creates a crawl run of `sourceIds` (the run `build` describes for the sources taken and those skipped) and enqueues
 * its first stage. The check "no other queued or running run fetches these sources" and the run insert happen in one
 * transaction under a transaction-scoped advisory lock per source, taken in id order: of two concurrent starts the
 * second waits and then sees the first run. Busy sources refuse the start (`source_run_active`), or with `skipBusy`
 * are left out (refused only when all are busy).
 */
export async function startExclusiveFetchRun(
  db: Db,
  boss: PgBoss,
  sourceIds: string[],
  opts: { skipBusy: boolean },
  build: (ids: string[], skipped: string[]) => Parameters<typeof createRun>[1],
): Promise<{ id: string; skipped: string[] }> {
  const created = await db.transaction(async (tx) => {
    for (const id of [...sourceIds].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fetch-run:${id}`}))`);
    }
    const busy = await sourcesBeingFetched(tx, sourceIds);
    if (busy.length > 0 && (!opts.skipBusy || busy.length === sourceIds.length)) {
      throw new RunScopeNotReady("source_run_active", `Sources already being fetched: ${busy.join(", ")}`);
    }
    const input = build(
      sourceIds.filter((id) => !busy.includes(id)),
      busy,
    );
    const { id } = await createRun(tx, input);
    return { id, skipped: busy, firstStage: input.stages[0] };
  });
  if (created.firstStage) await enqueueStage(db, boss, created.id, created.firstStage);
  return { id: created.id, skipped: created.skipped };
}

/** Every source of `sourceIds` exists, is current (not ended), approved and no research source (never crawled), else `RunScopeNotReady` `source_not_approved`. */
async function assertApproved(db: Db, sourceIds: string[]): Promise<void> {
  const approved = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(inArray(sources.id, sourceIds), eq(sources.status, "approved"), isNull(sources.validTo), ne(sources.origin, "research")));
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

/** Test crawl of one approved source: at most `TEST_CRAWL_MAX_PAGES` pages. */
export async function startTestCrawl(db: Db, boss: PgBoss, sourceId: string, triggeredBy: string): Promise<{ id: string }> {
  const { id } = await startFetchRun(db, boss, { sourceIds: [sourceId], triggeredBy, maxPages: TEST_CRAWL_MAX_PAGES });
  return { id };
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

/**
 * Embeds every chunk still without an embedding (`params.all`; a plan takes at most `EMBED_PLAN_LIMIT`). Refused
 * (`embed_backfill_active`) while another backfill is queued or running: both would plan, and pay for, the same
 * chunks. The check and the run insert happen in one transaction under an advisory lock, so of two concurrent starts
 * the second waits and then sees the first run.
 */
export async function startEmbedBackfillRun(db: Db, boss: PgBoss, triggeredBy: string): Promise<{ id: string }> {
  const { id } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${EMBED_BACKFILL_LOCK}))`);
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["queued", "running"]),
          eq(runs.scopeType, "system"),
          eq(runs.scopeId, EMBED_BACKFILL_SCOPE),
          sql`${EMBED_STAGE} = any(${runs.stages})`,
        ),
      )
      .limit(1);
    if (active) throw new RunScopeNotReady("embed_backfill_active", `Embedding backfill run ${active.id} is still active`);
    return createRun(tx, {
      kind: "stage",
      scope: { type: "system", id: EMBED_BACKFILL_SCOPE },
      params: { all: true },
      stages: [EMBED_STAGE],
      triggeredBy,
    });
  });
  await enqueueStage(db, boss, id, EMBED_STAGE);
  return { id };
}

/** Advisory lock key of the backfill start. */
const EMBED_BACKFILL_LOCK = "embed-backfill-run";

/**
 * Starts the run "Wikivoyage" for a subdivision: creates the whitelist sources that are missing, then queues its
 * Wikivoyage articles (`sources.wikivoyage`) and crawls them like any source (`FETCH_RUN_STAGES`). Checked before the
 * run exists: the subdivision exists (an area key fails with the replacement hint), the Wikivoyage source is not ended (`wikivoyage_source_ended`), approved and
 * not being fetched already.
 */
export async function startWikivoyageRun(db: Db, boss: PgBoss, subdivisionKey: string, triggeredBy: string): Promise<{ id: string }> {
  await requireSubdivision(db, subdivisionKey);
  await ensureWhitelistSources(db);
  const sourceId = await sourceIdByDomain(db, WIKIVOYAGE_DOMAIN);
  if (!sourceId) {
    // ensureWhitelistSources leaves a domain with any row alone: an ended source is not recreated.
    const [ended] = await db.select({ id: sources.id }).from(sources).where(eq(sources.domain, WIKIVOYAGE_DOMAIN)).limit(1);
    if (ended) throw new RunScopeNotReady("wikivoyage_source_ended", `The source ${WIKIVOYAGE_DOMAIN} has ended`);
    throw new RunScopeNotReady("source_not_approved", `No source for ${WIKIVOYAGE_DOMAIN}`);
  }
  await assertApproved(db, [sourceId]);
  const { id } = await startExclusiveFetchRun(db, boss, [sourceId], { skipBusy: false }, () => ({
    kind: "stage",
    scope: { type: "subdivision", id: subdivisionKey },
    params: { subdivisionKey, sourceIds: [sourceId] },
    stages: [WIKIVOYAGE_STAGE, ...FETCH_RUN_STAGES],
    triggeredBy,
  }));
  return { id };
}

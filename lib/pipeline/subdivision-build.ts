import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { AREA_IMPORT_STAGE } from "@/lib/pipeline/areas-import";
import { DATASETS_STAGE } from "@/lib/pipeline/datasets";
import { SUBDIVISION_DISCOVERY_STAGES } from "@/lib/pipeline/discovery-run";
import { GAZETTEER_STAGES } from "@/lib/pipeline/gazetteer/stages";
import { GEOMETRY_RUN_STAGES } from "@/lib/pipeline/geometry-run";
import { startRun } from "@/lib/pipeline/runs";
import { PLACE_WEBSITE_STAGE } from "@/lib/pipeline/places/stage-name";
import { REREAD_STAGE } from "@/lib/pipeline/text/reread";
import { SEED_STAGE } from "@/lib/pipeline/tile-scope";

/*
 * „Aufbauen“ of a subdivision (spec 14 „Landesteil-Lauf“, „Admin-UI“): one run of kind `full` with the stages of the
 * gazetteer, dataset, seed, marina website (`places.website`, spec 15 C), geometry and discovery runs, with the Revier import and then the mentions re-read between
 * geometry and discovery, in that order. Fetch, text, consolidation of texts and the
 * package stay separate runs: they wait on source approval. Each stage plans when it is reached, so the run needs no
 * tiles to start (the gazetteer creates them). A queue per country („Alle offenen aufbauen“) builds one subdivision
 * after the other: `queued_at` marks the waiting ones, and the end of a build (finished, failed or ended by an admin,
 * `afterBuildRunEnded`) starts the oldest waiting one of the same country.
 */

/** The stages of a subdivision build, in order. */
export const SUBDIVISION_BUILD_STAGES = [
  ...GAZETTEER_STAGES,
  DATASETS_STAGE,
  SEED_STAGE,
  // the websites of the seeded marinas and ports become approved sources (spec 15 C); their crawl stays a separate run
  PLACE_WEBSITE_STAGE,
  ...GEOMETRY_RUN_STAGES,
  AREA_IMPORT_STAGE,
  // after the Revier import, so Reviere this build created count in the re-read's prepass; the build does not wait
  REREAD_STAGE,
  ...SUBDIVISION_DISCOVERY_STAGES,
] as const;

/** Run params that mark a run as a subdivision build. */
const BUILD_MARK = "subdivisionBuild";

/** The id of the queued or running build of `key`, if any. */
async function runningBuild(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select id from runs
    where kind = 'full' and scope_type = 'subdivision' and scope_id = ${key} and status in ('queued', 'running')
    order by created_at desc limit 1
  `);
  return rows[0]?.id ?? null;
}

/**
 * Starts the build of subdivision `key` (also of a built one: „Aufbauen“ again). An unknown or excluded subdivision
 * is refused (`requireSubdivision`); a queued or running build of the same key is returned as `alreadyRunning`
 * instead of a second run. Serialised per key, so two clicks never start two runs. The started subdivision leaves
 * the queue.
 */
export async function startSubdivisionBuild(
  db: Db,
  boss: PgBoss,
  key: string,
  triggeredBy: string,
): Promise<{ id: string } | { alreadyRunning: string }> {
  return db.transaction(async (tx) => {
    const sub = await requireSubdivision(tx, key);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`subdivision-build:${sub.key}`}))`);
    const running = await runningBuild(tx, sub.key);
    if (running) return { alreadyRunning: running };
    await tx.execute(sql`update subdivisions set queued_at = null where id = ${sub.id} and queued_at is not null`);
    return startRun(tx, boss, {
      kind: "full",
      scope: { type: "subdivision", id: sub.key },
      stages: [...SUBDIVISION_BUILD_STAGES],
      // the geometry and consolidation stages keep the rules active now (ruling M7-E-R1)
      params: { subdivisionKey: sub.key, rulesVersion: await activeRulesVersion(tx), [BUILD_MARK]: true },
      triggeredBy,
    });
  });
}

/**
 * Starts the oldest queued subdivision of `country` (by `queued_at`, then key) unless a build of the country runs.
 * Serialised per country. Returns the started run's id, or null.
 */
export async function startNextQueued(db: Db, boss: PgBoss, country: string, triggeredBy: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`subdivision-queue:${country}`}))`);
    const { rows: busy } = await tx.execute(sql`
      select 1 from runs r join subdivisions s on s.key = r.scope_id and s.valid_to is null
      where r.kind = 'full' and r.scope_type = 'subdivision' and r.status in ('queued', 'running') and s.country = ${country}
      limit 1
    `);
    if (busy.length > 0) return null;
    const { rows } = await tx.execute<{ key: string }>(sql`
      select key from subdivisions
      where country = ${country} and valid_to is null and status = 'active' and queued_at is not null
      order by queued_at, key limit 1
    `);
    if (!rows[0]) return null;
    const started = await startSubdivisionBuild(tx, boss, rows[0].key, triggeredBy);
    return "id" in started ? started.id : started.alreadyRunning;
  });
}

/**
 * „Alle offenen aufbauen“ for `country`: queues every active subdivision of it that was never built, is not queued
 * and has no build running, then starts one unless a build of the country runs. A second call queues nothing new.
 */
export async function queueCountry(
  db: Db,
  boss: PgBoss,
  country: string,
  triggeredBy: string,
): Promise<{ queued: number; started: string | null }> {
  const { rows } = await db.execute<{ key: string }>(sql`
    update subdivisions s set queued_at = now()
    where s.country = ${country} and s.valid_to is null and s.status = 'active' and s.built_at is null and s.queued_at is null
      and not exists (
        select 1 from runs r
        where r.kind = 'full' and r.scope_type = 'subdivision' and r.scope_id = s.key and r.status in ('queued', 'running')
      )
    returning s.key
  `);
  const started = await startNextQueued(db, boss, country, triggeredBy);
  return { queued: rows.length, started };
}

/**
 * Called when a run ended (its last stage finished, a stage failed completely, a stage transition failed, or an admin
 * ended it). For a subdivision build: a finished one sets `built_at`; every end clears `queued_at`; then the next
 * queued subdivision of the same country starts, so a failed build never stops the queue. Any other run: nothing.
 */
export async function afterBuildRunEnded(db: Db, boss: PgBoss, runId: string): Promise<void> {
  const { rows } = await db.execute<{ scope_id: string; status: string; triggered_by: string; country: string | null }>(sql`
    select r.scope_id, r.status, r.triggered_by,
           (select s.country from subdivisions s where s.key = r.scope_id and s.valid_to is null) as country
    from runs r
    where r.id = ${runId} and r.kind = 'full' and r.scope_type = 'subdivision' and (r.params ->> ${BUILD_MARK})::boolean is true
  `);
  const run = rows[0];
  if (!run || run.status === "queued" || run.status === "running") return;
  await db.execute(sql`
    update subdivisions
    set queued_at = null${run.status === "finished" ? sql`, built_at = now()` : sql``}
    where key = ${run.scope_id} and valid_to is null
  `);
  if (run.country) await startNextQueued(db, boss, run.country, run.triggered_by);
}

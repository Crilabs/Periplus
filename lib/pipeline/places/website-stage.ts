import { eq, sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places, runs } from "@/lib/db/schema";
import { findPlaceWebsite, placesNeedingWebsite, type FindDeps, type FoundWebsite, type PlaceRef } from "@/lib/domain/places/website-find";
import { attachPlaceWebsite } from "@/lib/domain/places/website-source";
import { currentPlaceWebsite } from "@/lib/domain/places/websites";
import { FETCH_URL_STAGE } from "@/lib/pipeline/fetch/url";
import { textRunVersions } from "@/lib/pipeline/text/versions";

// No import of ../runs here: the job handler imports this module, which must not reach the stage registry (import
// cycle); the starter and the stage list live in ../place-website-run.

/** What one `places.website` job did; `attached_before`: a retried job found the place's website already recorded. */
export type PlaceWebsiteJobResult = {
  outcome: FoundWebsite["outcome"] | "attached_before";
  url?: string;
  sourceId?: string | null;
  bound?: boolean;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Plan of the stage `places.website`: one job per place of `params.subdivisionKey` without website (`placesNeedingWebsite`). */
export async function planPlaceWebsites(db: Db, run: { params: Record<string, unknown> }) {
  const key = run.params.subdivisionKey;
  if (typeof key !== "string" || key === "") throw new Error("subdivisionKey is required");
  return (await placesNeedingWebsite(db, key)).map((p) => ({ key: p.placeId, placeId: p.placeId, geoObjectId: p.geoObjectId }));
}

/**
 * Adds sources to the run's `params.sourceIds`, which its `fetch.source` stage plans from (pattern of
 * `freezeRevisitRun`: under a row lock of the run, each id once). In a run that crawls (`fetch.url` among its stages) a
 * source another queued or running crawl fetches is left out and kept in `params.skippedSourceIds` (ruling M3-C-R6, as
 * `startExclusiveFetchRun`); the check takes the same advisory lock per source as a crawl start, so the two never miss
 * each other.
 */
export async function addRunSources(db: Db, runId: string, sourceIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select({ params: runs.params, stages: runs.stages }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!run) throw new Error(`run ${runId} not found`);
    const params = (run.params ?? {}) as Record<string, unknown>;
    const known = new Set([...strings(params.sourceIds), ...strings(params.skippedSourceIds)]);
    const fresh = [...new Set(sourceIds)].filter((id) => !known.has(id)).sort();
    if (fresh.length === 0) return;
    let busy: string[] = [];
    if (run.stages.includes(FETCH_URL_STAGE)) {
      for (const id of fresh) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fetch-run:${id}`}))`);
      const { rows } = await tx.execute<{ id: string }>(sql`
        select distinct ids.id from runs r, jsonb_array_elements_text(r.params -> 'sourceIds') as ids(id)
        where r.id <> ${runId}::uuid and r.status in ('queued', 'running') and ${FETCH_URL_STAGE} = any(r.stages)
          and ids.id in (select value from jsonb_array_elements_text(${JSON.stringify(fresh)}::jsonb))
      `);
      busy = rows.map((r) => r.id);
    }
    const taken = fresh.filter((id) => !busy.includes(id));
    await tx
      .update(runs)
      .set({
        params: {
          ...params,
          sourceIds: [...strings(params.sourceIds), ...taken],
          ...(busy.length > 0 ? { skippedSourceIds: [...strings(params.skippedSourceIds), ...busy] } : {}),
        },
      })
      .where(eq(runs.id, runId));
  });
}

/**
 * Job `places.website` for one place: finds its website (`findPlaceWebsite`), records it and approves its source
 * (`attachPlaceWebsite`) and adds that source to the run (`addRunSources`). A place whose website is recorded already
 * (a retried job) only adds its source again, which changes nothing.
 */
export async function runPlaceWebsiteJob(
  db: Db,
  job: PlaceRef & { runId: string },
  deps: FindDeps,
): Promise<PlaceWebsiteJobResult> {
  const recorded = await currentPlaceWebsite(db, job.placeId);
  if (recorded) {
    if (recorded.sourceId) await addRunSources(db, job.runId, [recorded.sourceId]);
    return { outcome: "attached_before", url: recorded.url, sourceId: recorded.sourceId, bound: recorded.bound };
  }
  const [place] = await db.select({ tileId: places.tileId }).from(places).where(eq(places.id, job.placeId));
  const found = await findPlaceWebsite(db, job, deps, { runId: job.runId, tileId: place?.tileId ?? null });
  if (!found.url || !found.origin) return { outcome: found.outcome };
  const { url, origin } = found;
  return db.transaction(async (tx) => {
    const attached = await attachPlaceWebsite(tx, {
      placeId: job.placeId,
      geoObjectId: job.geoObjectId,
      url,
      origin,
      ...(found.serpQueryId ? { serpQueryId: found.serpQueryId } : {}),
      ...(found.quote !== undefined ? { quote: found.quote } : {}),
      ...(found.confidence !== undefined ? { confidence: found.confidence } : {}),
      runId: job.runId,
    });
    if (attached.sourceId) await addRunSources(tx, job.runId, [attached.sourceId]);
    return { outcome: found.outcome, url, ...attached };
  });
}

/** What `places.website.freeze` wrote into the run's params. */
export type PlaceWebsiteFreeze = { documentVersionIds: string[]; frozenBefore: boolean };

/**
 * Freezes a marina website run once its crawl has finished (pattern of `freezeRevisitRun`, ruling M4-E-R2): the text
 * stages take exactly the pending versions of the run's sources (`textRunVersions({ pending, sourceIds })`), not the
 * subdivision of its `subdivisionKey`. Idempotent: a retried job keeps the list a former attempt wrote.
 */
export async function freezePlaceWebsiteRun(db: Db, runId: string, cfg: AppConfig = getConfig()): Promise<PlaceWebsiteFreeze> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!run) throw new Error(`run ${runId} not found`);
    const params = (run.params ?? {}) as Record<string, unknown>;
    if (Array.isArray(params.documentVersionIds)) return { documentVersionIds: strings(params.documentVersionIds), frozenBefore: true };
    const documentVersionIds = await textRunVersions(tx, { pending: true, sourceIds: strings(params.sourceIds) }, cfg);
    await tx
      .update(runs)
      .set({ params: { ...params, documentVersionIds } })
      .where(eq(runs.id, runId));
    return { documentVersionIds, frozenBefore: false };
  });
}

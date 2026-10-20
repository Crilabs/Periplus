import { eq, sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { scopeSources, scopeTiles, textRunVersions } from "@/lib/pipeline/text/versions";

// No import of ./runs here: the job handler reads this module, which must not reach the stage registry (import cycle,
// rulings M6-P17, M7-P5); the starter and the stage list live in ./revisit-run.

/**
 * Stage of a revisit run between the crawl and the text stages (ruling M7-P6): one job freezes the run's version set
 * and the objects of the documents the crawl found gone.
 */
export const REVISIT_FREEZE_STAGE = "revisit.freeze";

/** What `revisit.freeze` wrote into the run's params. */
export type RevisitFreeze = { documentVersionIds: string[]; goneGeoObjectIds: string[]; frozenBefore: boolean };

/**
 * Freezes a revisit run once its crawl has finished (rulings M7-P6, M7-P7, M4-E-R2): `params.documentVersionIds` =
 * `textRunVersions({ areaKey, documentVersionIds: <the current versions this run's crawl wrote of the area's pages> })`
 * (a page of a source of the area, or of a document that mentioned an object of the area's tiles before, ruling
 * M7-G-R4), i.e. those new versions plus what an area text run takes (the current versions mentioning objects of the area and the pending
 * versions of its sources); and `params.goneGeoObjectIds` = the objects with facts of finished extraction runs on
 * documents this run's crawl marked `gone` (`goneGeoObjectsOfRun`), which `consolidationTargets` adds to the run's
 * targets, so a value only a vanished page supported is judged again (spec 10). The crawl's versions are taken by
 * their `run_id`, not as the database-wide `pending` set: that would pull in the unmatched versions of every other
 * area and source. Idempotent: a retried job keeps the list a former attempt wrote (`frozenBefore`), under a row lock
 * of the run.
 */
export async function freezeRevisitRun(db: Db, runId: string, cfg: AppConfig = getConfig()): Promise<RevisitFreeze> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!run) throw new Error(`run ${runId} not found`);
    const params = (run.params ?? {}) as Record<string, unknown>;
    if (Array.isArray(params.documentVersionIds)) {
      return {
        documentVersionIds: params.documentVersionIds as string[],
        goneGeoObjectIds: Array.isArray(params.goneGeoObjectIds) ? (params.goneGeoObjectIds as string[]) : [],
        frozenBefore: true,
      };
    }
    if (typeof params.areaKey !== "string" || params.areaKey === "") throw new Error(`revisit run ${runId} has no areaKey`);
    // Only the area's pages (ruling M7-G-R4): a source of the area, or a document an earlier version of which mentions
    // an object of the area's tiles; the other areas' pages the crawl wrote wait for their own run.
    const scope = { areaKey: params.areaKey };
    const { rows } = await tx.execute<{ id: string }>(sql`
      select v.id from document_versions v join documents d on d.current_version_id = v.id
      where v.run_id = ${runId} and d.status = 'active' and d.valid_to is null
        and (
          d.source_id in (${scopeSources(scope)})
          or exists (
            select 1 from document_versions dv
            join mentions m on m.document_version_id = dv.id
            join tile_geo_objects tgo on tgo.geo_object_id = m.geo_object_id
            where dv.document_id = d.id and tgo.tile_id in (${scopeTiles(scope)})
          )
        )
    `);
    const documentVersionIds = await textRunVersions(tx, { areaKey: params.areaKey, documentVersionIds: rows.map((r) => r.id) }, cfg);
    const goneGeoObjectIds = await goneGeoObjectsOfRun(tx, runId, cfg);
    await tx
      .update(runs)
      .set({ params: { ...params, documentVersionIds, goneGeoObjectIds } })
      .where(eq(runs.id, runId));
    return { documentVersionIds, goneGeoObjectIds, frozenBefore: false };
  });
}

/**
 * The geo objects with facts of finished extraction runs on documents the run's crawl marked `gone`: the run's
 * `fetch.url` stage recorded the miss (`crawl_frontier.last_run_id` = the run, status `failed`, reason `HTTP 4xx`), and
 * that miss reached `fetch.goneAfter` (a page gone before the run, answering 404 again, is not new). Sorted, unique.
 */
export async function goneGeoObjectsOfRun(db: Db, runId: string, cfg: AppConfig = getConfig()): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct f.geo_object_id as id
    from crawl_frontier cf
    join documents d on d.source_id = cf.source_id and d.url_normalized = cf.url_normalized
    join document_versions v on v.document_id = d.id
    join mentions m on m.document_version_id = v.id
    join facts f on f.mention_id = m.id
    join extraction_runs er on er.id = f.extraction_run_id and er.status = 'finished'
    where cf.last_run_id = ${runId} and cf.status = 'failed' and cf.reason like 'HTTP 4%'
      and d.status = 'gone' and d.consecutive_gone = ${cfg.fetch.goneAfter}
    order by 1
  `);
  return rows.map((r) => r.id);
}

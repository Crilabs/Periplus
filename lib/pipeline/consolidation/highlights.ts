import { sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { consolidationBlocked, consolidationTargets } from "@/lib/domain/consolidation/targets";
import { openPairTask } from "@/lib/domain/gazetteer/merge";
import { isSelectedSql, selectedPoiIds } from "@/lib/domain/highlights/selections";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { consolidateJobs } from "./geo";

/*
 * Stage `consolidation.highlights` (spec 16): right after `consolidation.geo`, the POIs the run's places selected as
 * highlights are consolidated (one `consolidateGeoJob` per POI), so they get a current profile and, in the summary
 * stage, a summary; a POI no place selects is never consolidated by a run's scope. No import of `lib/pipeline/runs`:
 * the job handlers import this module.
 */

/**
 * Plan of `consolidation.highlights`: nothing when the run's quote fidelity blocks its consolidation (the geo stage
 * consolidated nothing); else the POIs selected by the run's places (`consolidationTargets`, the targets the geo stage
 * consolidated; `selectedPoiIds` keeps only rows of valid places), without those the geo stage consolidated already
 * (an explicit `geoObjectIds` run), one job each in the geo stage's job shape (`consolidateJobs`). A regular run first
 * opens the pair tasks among these highlights (`openHighlightPairTasks`); an evaluation run opens none.
 */
export async function consolidationHighlightJobs(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  if (await consolidationBlocked(db, run.id)) return [];
  const targets = await consolidationTargets(db, run);
  const selected = await selectedPoiIds(db, targets);
  if (run.params.evaluation !== true && selected.length > 0) {
    const pairs = await openHighlightPairTasks(db, selected);
    if (pairs > 0) createLogger("consolidation").info({ runId: run.id, pairs }, "highlight pair tasks");
  }
  const consolidated = new Set(targets);
  return consolidateJobs(run, selected.filter((id) => !consolidated.has(id)));
}

/**
 * Opens a `place_candidate` pair task (`openPairTask`, source `computed`) for each pair of highlights of the same
 * category, one of them in `poiIds`, both selected by some place (`isSelectedSql`), whose names are similar (the highest
 * pg_trgm similarity of their valid normalized names ≥ `gazetteer.merge.uncertainTrigramMin`) and that lie closer than
 * `gazetteer.merge.highlightPairM` (2 km). A pair sharing a normalized name needs at least
 * `delivery.validation.highlightDuplicateM` (500 m): nearer, the selection counts them as one already (spec 16
 * „Dubletten“). Returns the number of pairs found (an open or decided task for a pair is kept, `openPairTask`).
 */
export async function openHighlightPairTasks(db: Db, poiIds: string[]): Promise<number> {
  if (poiIds.length === 0) return 0;
  const config = getConfig();
  const { uncertainTrigramMin, highlightPairM } = config.gazetteer.merge;
  const duplicateM = config.delivery.validation.highlightDuplicateM;
  const { rows } = await db.execute<{ a: string; b: string; similarity: number; same_name: boolean; distance_m: number }>(sql`
    with a as (
      select o.id, o.geom, o.category from geo_objects o
      where o.id = any(${sql.param(poiIds)}::uuid[]) and o.type = 'poi' and o.category is not null
        and ${isSelectedSql(sql`o.id`)}
    )
    select a.id as a, b.id as b, x.similarity, x.same_name, ST_Distance(a.geom::geography, b.geom::geography) as distance_m
    from a
    join geo_objects b on b.type = 'poi' and b.category = a.category and b.id <> a.id
      -- box first (gist index on geom), then the exact distance in metres
      and b.geom && ST_Expand(a.geom, ${highlightPairM}::float8 / (111320 * greatest(cos(radians(ST_Y(ST_Centroid(a.geom)))), 0.1)))
      and ST_DWithin(a.geom::geography, b.geom::geography, ${highlightPairM}::float8)
    cross join lateral (
      select max(similarity(na.name_normalized, nb.name_normalized)) as similarity,
             bool_or(na.name_normalized = nb.name_normalized) as same_name
      from geo_names na join geo_names nb on nb.geo_object_id = b.id and nb.valid_to is null
      where na.geo_object_id = a.id and na.valid_to is null
    ) x
    where ${isSelectedSql(sql`b.id`)} and x.similarity >= ${uncertainTrigramMin}
    order by a.id, b.id
  `);
  const pairs = new Map<string, { a: string; b: string; similarity: number; distanceM: number }>();
  for (const row of rows) {
    const distanceM = Number(row.distance_m);
    if (row.same_name && distanceM < duplicateM) continue;
    const key = [row.a, row.b].sort().join(":");
    if (!pairs.has(key)) pairs.set(key, { a: row.a, b: row.b, similarity: Number(row.similarity), distanceM: Math.round(distanceM) });
  }
  for (const p of pairs.values()) await openPairTask(db, p.a, p.b, { similarity: p.similarity, distanceM: p.distanceM, source: "computed" });
  return pairs.size;
}

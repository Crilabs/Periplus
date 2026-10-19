import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getConfig, getConsolidationConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { ConsolidationParams } from "@/lib/domain/consolidation/targets";
import { levelFor } from "@/lib/domain/facts/levels";
import type { RunScope } from "@/lib/domain/runs";
import { startRun } from "@/lib/pipeline/runs";
import { areaGeoObjectId, RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { CONSOLIDATION_GEO_STAGE, CONSOLIDATION_STAGES } from "./stages";

/*
 * Starter of consolidation runs (ruling M5-P16: only the starter lives here; no stage or handler imports this module).
 */

/** Scope id of a consolidation run over given objects or a comparison set (scope type `system`). */
export const CONSOLIDATION_RUN_SCOPE = "consolidation";

export type ConsolidationScope = { tileId: string } | { areaKey: string } | { geoObjectIds: string[] } | { comparisonSetArea: string };

export type StartConsolidationInput = {
  scope: ConsolidationScope;
  triggeredBy: string;
  evaluation?: true;
  rulesVersion?: string;
  stagesOnly?: string[];
};

const validToday = (alias: string) =>
  sql.raw(`${alias}.valid_from <= current_date and (${alias}.valid_to is null or ${alias}.valid_to > current_date)`);

/**
 * Checks the scope before the run exists (`RunScopeNotReady`) and returns the run's scope: a valid tile; a configured
 * area with valid tiles; geo objects that are valid, unmerged and have a fact level (scope `place` with the place id for
 * exactly one object with a valid place, else `system`); an area whose comparison set is not empty (`system`).
 */
async function checkedScope(db: Db, scope: ConsolidationScope, config: AppConfig): Promise<RunScope> {
  if ("tileId" in scope) {
    const { rows } = await db.execute(sql`select 1 from tiles t where t.id = ${scope.tileId} and ${validToday("t")}`);
    if (rows.length === 0) throw new RunScopeNotReady("unknown_tile", `tile ${scope.tileId} is not a valid tile`);
    return { type: "tile", id: scope.tileId };
  }
  if ("areaKey" in scope) {
    if (!config.areas.some((a) => a.key === scope.areaKey)) throw new RunScopeNotReady("unknown_area", `area ${scope.areaKey} is not configured`);
    const { rows } = await db.execute(sql`
      select 1 from tiles t join geo_objects a on a.id = t.area_id and a.type = 'area'
      where a.config_key = ${scope.areaKey} and ${validToday("t")} limit 1
    `);
    if (rows.length === 0) throw new RunScopeNotReady("area_without_tiles", `area ${scope.areaKey} has no tiles yet`);
    return { type: "area", id: scope.areaKey };
  }
  if ("geoObjectIds" in scope) {
    const ids = [...new Set(scope.geoObjectIds)].sort();
    if (ids.length === 0) throw new RunScopeNotReady("geo_object_not_consolidatable", "no geo object given");
    const { rows } = await db.execute<{ id: string; place_id: string | null }>(sql`
      select o.id, (
        select p.id from places p
        where p.geo_object_id = o.id and p.merged_into_id is null and ${validToday("p")}
        order by p.created_at, p.id limit 1
      ) as place_id
      from geo_objects o
      where o.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
        and o.merged_into_id is null and ${validToday("o")}
    `);
    const valid = new Map(rows.map((r) => [r.id, r.place_id]));
    for (const id of ids) {
      if (!valid.has(id) || (await levelFor(db, id)) === null) {
        throw new RunScopeNotReady("geo_object_not_consolidatable", `geo object ${id} is unknown, ended, merged or takes no facts`);
      }
    }
    const placeId = ids.length === 1 ? valid.get(ids[0]!) : null;
    return placeId ? { type: "place", id: placeId } : { type: "system", id: CONSOLIDATION_RUN_SCOPE };
  }
  if (!config.areas.some((a) => a.key === scope.comparisonSetArea)) {
    throw new RunScopeNotReady("unknown_area", `area ${scope.comparisonSetArea} is not configured`);
  }
  const areaId = await areaGeoObjectId(db, scope.comparisonSetArea);
  const { rows } = areaId
    ? await db.execute(sql`select 1 from comparison_set where area_id = ${areaId}::uuid limit 1`)
    : { rows: [] };
  if (rows.length === 0) throw new RunScopeNotReady("comparison_set_empty", `the comparison set of area ${scope.comparisonSetArea} is empty`);
  return { type: "system", id: CONSOLIDATION_RUN_SCOPE };
}

/**
 * Starts a consolidation run ("Konsolidieren", "Profil neu berechnen", the follow-up of a profile decision). Kind
 * `stage` with every consolidation stage (`CONSOLIDATION_STAGES`), or only `stagesOnly` (a subset, in stage order);
 * an evaluation run is kind `reprocess` with `params.evaluation`, only `consolidation.geo` and the rules version to
 * evaluate (default the active one; an unknown version throws). The scope is checked before the run exists
 * (`RunScopeNotReady`, see `checkedScope`); the params carry the scope (`ConsolidationParams`).
 */
export async function startConsolidationRun(
  db: Db,
  boss: PgBoss,
  input: StartConsolidationInput,
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  if (input.stagesOnly) {
    for (const stage of input.stagesOnly) {
      if (!(CONSOLIDATION_STAGES as readonly string[]).includes(stage)) throw new Error(`${stage} is no consolidation stage`);
    }
  }
  const rulesVersion = input.rulesVersion ?? (input.evaluation ? getConsolidationConfig().version : undefined);
  if (rulesVersion !== undefined) getConsolidationConfig(rulesVersion);
  const scope = await checkedScope(db, input.scope, config);
  const stages = input.evaluation
    ? [CONSOLIDATION_GEO_STAGE]
    : input.stagesOnly
      ? CONSOLIDATION_STAGES.filter((s) => input.stagesOnly!.includes(s))
      : [...CONSOLIDATION_STAGES];
  const params: ConsolidationParams = {
    ...("geoObjectIds" in input.scope ? { geoObjectIds: [...new Set(input.scope.geoObjectIds)].sort() } : input.scope),
    ...(input.evaluation ? { evaluation: true as const } : {}),
    ...(rulesVersion !== undefined ? { rulesVersion } : {}),
    ...(input.stagesOnly ? { stagesOnly: stages } : {}),
  };
  return startRun(db, boss, {
    kind: input.evaluation ? "reprocess" : "stage",
    scope,
    stages,
    params,
    triggeredBy: input.triggeredBy,
  });
}

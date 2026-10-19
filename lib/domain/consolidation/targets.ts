import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { belegtreue } from "@/lib/domain/extraction/fidelity";

/*
 * What a run consolidates (plan Task 16): the geo objects of its scope, and whether its quote fidelity blocks it.
 */

/** Params of a consolidation run (`startConsolidationRun`); a text run's params carry `documentVersionIds` instead. */
export type ConsolidationParams = {
  tileId?: string;
  areaKey?: string;
  geoObjectIds?: string[];
  comparisonSetArea?: string;
  /** An evaluation run: profiles into `evaluation_profiles`, nothing into profiles, the change feed or tasks. */
  evaluation?: true;
  rulesVersion?: string;
  /** Only these consolidation stages ran (e.g. `["consolidation.summary"]` for "Neu erzeugen"). */
  stagesOnly?: string[];
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
const ids = (rows: Array<{ id: string }>) => sorted(rows.map((r) => r.id));

/** Valid, unmerged geo object (alias `o`) today. */
const validObject = sql`o.merged_into_id is null and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)`;
/** Valid tile (alias `t`) today. */
const validTile = sql`t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)`;
/** The valid area object of a configured area key (alias `a`). */
const areaObject = (areaKey: string) =>
  sql`a.type = 'area' and a.config_key = ${areaKey} and a.valid_from <= current_date and (a.valid_to is null or a.valid_to > current_date)`;

/**
 * The geo objects a run consolidates, sorted and without duplicates:
 * - a text run (its params carry the frozen `documentVersionIds`): the objects with facts of its extraction runs and
 *   the objects with mentions it wrote; its own `tileId` / `areaKey` only selected its versions;
 * - `geoObjectIds`: exactly these;
 * - `tileId`: the valid objects of the tile (`tile_geo_objects`);
 * - `areaKey`: the valid objects of every valid coast tile of the area;
 * - `comparisonSetArea`: the geo objects of the places in the area's comparison set;
 * - otherwise as a text run.
 */
export async function consolidationTargets(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<string[]> {
  const p = run.params;
  if (!Array.isArray(p.documentVersionIds)) {
    if (Array.isArray(p.geoObjectIds)) return sorted(strings(p.geoObjectIds));
    if (typeof p.tileId === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select o.id from tile_geo_objects tgo join geo_objects o on o.id = tgo.geo_object_id
        where tgo.tile_id = ${p.tileId} and ${validObject}
      `);
      return ids(rows);
    }
    if (typeof p.areaKey === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select distinct o.id
        from geo_objects a
        join tiles t on t.area_id = a.id and t.has_coast and ${validTile}
        join tile_geo_objects tgo on tgo.tile_id = t.id
        join geo_objects o on o.id = tgo.geo_object_id and ${validObject}
        where ${areaObject(p.areaKey)}
      `);
      return ids(rows);
    }
    if (typeof p.comparisonSetArea === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select distinct p.geo_object_id as id
        from geo_objects a
        join comparison_set c on c.area_id = a.id
        join places p on p.id = c.place_id
        where ${areaObject(p.comparisonSetArea)}
      `);
      return ids(rows);
    }
  }
  const { rows } = await db.execute<{ id: string }>(sql`
    select f.geo_object_id as id from facts f join extraction_runs r on r.id = f.extraction_run_id where r.run_id = ${run.id}
    union
    select m.geo_object_id from mentions m where m.run_id = ${run.id}
  `);
  return ids(rows);
}

/**
 * Whether the run's quote fidelity blocks its consolidation (spec 10, ruling M5-P15): it has extraction runs and not
 * every checked item verified (`belegtreue.verified < belegtreue.facts`, not the rounded ratio).
 */
export async function consolidationBlocked(db: Db, runId: string): Promise<boolean> {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from extraction_runs where run_id = ${runId}`);
  if (Number(rows[0]?.n ?? 0) === 0) return false;
  const fidelity = await belegtreue(db, runId);
  return fidelity.verified < fidelity.facts;
}

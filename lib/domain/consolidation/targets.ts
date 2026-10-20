import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { belegtreue } from "@/lib/domain/extraction/fidelity";
import { takesFactsSql } from "@/lib/domain/facts/levels";
import { runDate } from "@/lib/domain/runs";

/*
 * What a run consolidates (plan Task 16): the geo objects of its scope, and whether its quote fidelity blocks it.
 */

/** A configuration to evaluate against the active one (at least one part; spec 10 „Regression“, ruling M7-P11). */
export type EvaluationCandidate = { rulesVersion?: string; extraction?: { model: string; promptVersion: number } };

/** Params of a consolidation run (`startConsolidationRun`); a text run's params carry `documentVersionIds` instead. */
export type ConsolidationParams = {
  tileId?: string;
  areaKey?: string;
  geoObjectIds?: string[];
  comparisonSetArea?: string;
  /** An evaluation run: profiles into `evaluation_profiles`, nothing into profiles, the change feed or tasks. */
  evaluation?: true;
  /** The rules version the run consolidates with (set at the start: the given or the active one, ruling M7-P10). */
  rulesVersion?: string;
  /** An evaluation run's extraction candidate (ruling M7-P11): the extraction runs of this model and prompt are the active ones. */
  extraction?: { model: string; promptVersion: number };
  /** What an evaluation run evaluates (spec 10 regression): the rules version, the extraction candidate or both. */
  candidate?: EvaluationCandidate;
  /** Only these consolidation stages ran (e.g. `["consolidation.summary"]` for "Neu erzeugen"). */
  stagesOnly?: string[];
  /**
   * „Summary neu erzeugen“ (ruling M6-H-R1): the summary stage writes a new summary of each target's newest version even
   * when an `ok` one exists (only with `stagesOnly` = the summary stage).
   */
  regenerateSummary?: true;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
const ids = (rows: Array<{ id: string }>) => sorted(rows.map((r) => r.id));

/** Valid, unmerged geo object (alias `o`) on `day`. */
const validObject = (day: string) =>
  sql`o.merged_into_id is null and o.valid_from <= ${day}::date and (o.valid_to is null or o.valid_to > ${day}::date)`;
/** Valid tile (alias `t`) on `day`. */
const validTile = (day: string) => sql`t.valid_from <= ${day}::date and (t.valid_to is null or t.valid_to > ${day}::date)`;
/** The valid area object of a configured area key (alias `a`) on `day`. */
const areaObject = (areaKey: string, day: string) =>
  sql`a.type = 'area' and a.config_key = ${areaKey} and a.valid_from <= ${day}::date and (a.valid_to is null or a.valid_to > ${day}::date)`;

/** Keeps the valid, unmerged geo objects (alias `o`) that take facts (ruling M5-H-R2 M-2). */
const consolidatable = (day: string) => sql`${validObject(day)} and ${takesFactsSql}`;

/**
 * The geo objects a run consolidates, sorted and without duplicates:
 * - a text run (its params carry the frozen `documentVersionIds`): the objects with facts of its extraction runs and
 *   the objects with mentions it wrote in its frozen versions; its own `tileId` / `areaKey` only selected its versions;
 *   a revisit run also the objects its freeze stage found on documents gone in its crawl (`goneGeoObjectIds`, ruling
 *   M7-P7);
 * - `geoObjectIds`: exactly these (the starter checked them);
 * - `tileId`: the objects of the tile (`tile_geo_objects`);
 * - `areaKey`: the objects of every valid coast tile of the area;
 * - `comparisonSetArea`: the geo objects of the places in the area's comparison set;
 * - a geometry run (`placeIds` or `tileIds`; its `areaKey` is the area case): the geo objects of its places, i.e. the
 *   given places or the places on the given tiles (final review I-2: status, exclusion and computed values reach
 *   the profile in the same run);
 * - otherwise as a text run.
 * Except for `geoObjectIds`, only valid, unmerged objects that take facts (a settlement would only be skipped). Validity
 * is judged on `today`, default the run date (`runDate`, final review M-7), as `consolidateGeo` judges it.
 */
export async function consolidationTargets(db: Db, run: { id: string; params: Record<string, unknown> }, today?: string): Promise<string[]> {
  const p = run.params;
  if (!Array.isArray(p.documentVersionIds) && Array.isArray(p.geoObjectIds)) return sorted(strings(p.geoObjectIds));
  const day = today ?? (await runDate(db, run.id));
  if (!Array.isArray(p.documentVersionIds)) {
    if (typeof p.tileId === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select o.id from tile_geo_objects tgo join geo_objects o on o.id = tgo.geo_object_id
        where tgo.tile_id = ${p.tileId} and ${consolidatable(day)}
      `);
      return ids(rows);
    }
    if (typeof p.areaKey === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select distinct o.id
        from geo_objects a
        join tiles t on t.area_id = a.id and t.has_coast and ${validTile(day)}
        join tile_geo_objects tgo on tgo.tile_id = t.id
        join geo_objects o on o.id = tgo.geo_object_id and ${consolidatable(day)}
        where ${areaObject(p.areaKey, day)}
      `);
      return ids(rows);
    }
    const placeIds = strings(p.placeIds);
    const tileIds = strings(p.tileIds);
    if (Array.isArray(p.placeIds) || Array.isArray(p.tileIds)) {
      const scope = Array.isArray(p.placeIds)
        ? sql`pl.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(placeIds)}::jsonb))`
        : sql`pl.tile_id in (select value from jsonb_array_elements_text(${JSON.stringify(tileIds)}::jsonb))`;
      const { rows } = await db.execute<{ id: string }>(sql`
        select distinct o.id
        from places pl
        join geo_objects o on o.id = pl.geo_object_id and ${consolidatable(day)}
        where ${scope} and pl.merged_into_id is null
          and pl.valid_from <= ${day}::date and (pl.valid_to is null or pl.valid_to > ${day}::date)
      `);
      return ids(rows);
    }
    if (typeof p.comparisonSetArea === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select distinct o.id
        from geo_objects a
        join comparison_set c on c.area_id = a.id
        join places pl on pl.id = c.place_id and pl.merged_into_id is null
          and pl.valid_from <= ${day}::date and (pl.valid_to is null or pl.valid_to > ${day}::date)
        join geo_objects o on o.id = pl.geo_object_id and ${consolidatable(day)}
        where ${areaObject(p.comparisonSetArea, day)}
      `);
      return ids(rows);
    }
  }
  // Mentions only through the frozen versions (indexed), facts through the run's extraction runs (ruling M5-H-R2 M-1);
  // a revisit run adds the objects of the documents its crawl found gone (ruling M7-P7).
  const versions = JSON.stringify(strings(p.documentVersionIds));
  const gone = JSON.stringify(strings(p.goneGeoObjectIds));
  const { rows } = await db.execute<{ id: string }>(sql`
    select o.id
    from (
      select f.geo_object_id as id from extraction_runs r join facts f on f.extraction_run_id = r.id where r.run_id = ${run.id}
      union
      select m.geo_object_id from mentions m
      where m.document_version_id in (select value::uuid from jsonb_array_elements_text(${versions}::jsonb))
        and m.run_id = ${run.id}
      union
      select value::uuid from jsonb_array_elements_text(${gone}::jsonb)
    ) t
    join geo_objects o on o.id = t.id
    where ${consolidatable(day)}
  `);
  return ids(rows);
}

/**
 * Whether the run's quote fidelity blocks its consolidation (spec 10, ruling M5-P15): it has extraction runs and not
 * every checked item verified (`belegtreue.verified < belegtreue.facts`, not the rounded ratio), or one of them is
 * blocked for another reason or not checked yet (a failed or ended run, late results: its facts are not active, so a
 * catch-up waits for „Belegtreue neu prüfen“, ruling M5-H-R2).
 */
export async function consolidationBlocked(db: Db, runId: string): Promise<boolean> {
  const { rows } = await db.execute<{ n: number; open: number }>(sql`
    select count(*)::int as n, count(*) filter (where status in ('blocked', 'running'))::int as open
    from extraction_runs where run_id = ${runId}
  `);
  if (Number(rows[0]?.n ?? 0) === 0) return false;
  if (Number(rows[0]?.open ?? 0) > 0) return true;
  const fidelity = await belegtreue(db, runId);
  return fidelity.verified < fidelity.facts;
}

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { belegtreue } from "@/lib/domain/extraction/fidelity";
import { takesFactsSql } from "@/lib/domain/facts/levels";
import { runDate } from "@/lib/domain/runs";
import { subdivisionTilesSql } from "@/lib/domain/gazetteer/tiles-ensure";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { consolidationConfigFor } from "./active-rules";

/*
 * What a run consolidates (plan Task 16): the geo objects of its scope, and whether its quote fidelity blocks it.
 */

/** A configuration to evaluate against the active one (at least one part; spec 10 „Regression“, ruling M7-P11). */
export type EvaluationCandidate = { rulesVersion?: string; extraction?: { model: string; promptVersion: number } };

/** Params of a consolidation run (`startConsolidationRun`); a text run's params carry `documentVersionIds` instead. */
export type ConsolidationParams = {
  tileId?: string;
  subdivisionKey?: string;
  geoObjectIds?: string[];
  comparisonSetSubdivision?: string;
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
/** Keeps the valid, unmerged geo objects (alias `o`) that take facts (ruling M5-H-R2 M-2). */
const consolidatable = (day: string) => sql`${validObject(day)} and ${takesFactsSql}`;

/**
 * The geo objects a run consolidates in full, sorted and without duplicates:
 * - a text run (its params carry the frozen `documentVersionIds`): the objects with facts of its extraction runs and
 *   the objects with mentions it wrote in its frozen versions; its own `tileId` / `subdivisionKey` only selected its versions;
 *   a revisit run also the objects its freeze stage found on documents gone in its crawl (`goneGeoObjectIds`, ruling
 *   M7-P7); a revisit run not frozen (failed or ended before `revisit.freeze`): only its `goneGeoObjectIds`, i.e.
 *   none (ruling M7-G-R4), never the subdivision of its `subdivisionKey`;
 * - `geoObjectIds`: exactly these (the starter checked them), POIs included (ruling 2 of plan 16);
 * - `tileId`: the objects of the tile (`tile_geo_objects`);
 * - `subdivisionKey`: the objects of every tile of the subdivision's run scope (`subdivisionTilesSql`: coast tiles whose
 *   box meets its polygon, border tiles included whatever their label says);
 * - `comparisonSetSubdivision`: the geo objects of the places in the subdivision's comparison set;
 * - a geometry run (`placeIds` or `tileIds`; its `subdivisionKey` is the subdivision case): the geo objects of its places, i.e. the
 *   given places or the places on the given tiles (final review I-2: status, exclusion and computed values reach
 *   the profile in the same run);
 * - otherwise as a text run.
 * Except for `geoObjectIds`, only valid, unmerged objects that take facts (a settlement would only be skipped). Validity
 * is judged on `today`, default the run date (`runDate`, final review M-7), as `consolidateGeo` judges it. Except for
 * `geoObjectIds` too, rules with `highlights` (spec 16) leave the POIs out: a POI's own profile comes from the highlights
 * stage, and the places its importance may change only re-select (`reselectionTargets`). These targets are the ones
 * the summary (`stagesOnly`), follow-up discovery and title images look at; the neighbours re-selected never are.
 */
export async function consolidationTargets(db: Db, run: { id: string; params: Record<string, unknown> }, today?: string): Promise<string[]> {
  const p = run.params;
  if (isExplicit(p)) return sorted(strings(p.geoObjectIds));
  const day = today ?? (await runDate(db, run.id));
  const scope = await scopeTargets(db, run, day);
  if (!(await consolidationConfigFor(db, p.rulesVersion)).highlights) return scope;
  return withoutPois(db, scope);
}

/**
 * The run's scope with its POIs (`consolidationTargets` before the POIs leave it; `geoObjectIds` as given): what a
 * catch-up of a skipped run names, so its explicit run consolidates the POIs and re-selects their neighbours.
 */
export async function consolidationScope(db: Db, run: { id: string; params: Record<string, unknown> }, today?: string): Promise<string[]> {
  const p = run.params;
  if (isExplicit(p)) return sorted(strings(p.geoObjectIds));
  return scopeTargets(db, run, today ?? (await runDate(db, run.id)));
}

/**
 * Spec 16 „Aktualität“: the places whose highlight selection a POI of the run's scope may change, without the run's
 * own targets (`consolidationTargets`): the geo objects of the valid, unmerged, not rejected places within
 * `max(highlights.reachKm)` of such a POI (distance from the place's anchor, else its position, as
 * `loadHighlightCandidates` measures), themselves consolidatable on `today`. They only re-select (`reselectHighlights`):
 * no full consolidation, summary only for a changed selection, no follow-up discovery, no title image (final review
 * C1). Empty for rules without `highlights` (v1) and for explicit `geoObjectIds` runs.
 */
export async function reselectionTargets(db: Db, run: { id: string; params: Record<string, unknown> }, today?: string): Promise<string[]> {
  const p = run.params;
  const highlights = (await consolidationConfigFor(db, p.rulesVersion)).highlights;
  if (!highlights) return [];
  if (isExplicit(p)) return [];
  const day = today ?? (await runDate(db, run.id));
  const scope = await scopeTargets(db, run, day);
  if (scope.length === 0) return [];
  const own = new Set(await withoutPois(db, scope));
  const reachM = Math.max(...highlights.reachKm) * 1000;
  // one box per POI; the places with an anchor by `anchor_position && box`, the
  // others by `position && box`, so each side uses its gist index (places_anchor_position_gist,
  // places_position_gist); then the exact distance in metres
  const { rows } = await db.execute<{ id: string }>(sql`
    with t as (
      select o.geom,
             ST_Expand(o.geom, ${reachM}::float8 / (111320 * greatest(cos(radians(ST_Y(ST_Centroid(o.geom)))), 0.1))) as box
      from geo_objects o
      where o.type = 'poi' and o.id = any(${sql.param(scope)}::uuid[])
    )
    select distinct o.id from t
    cross join lateral (
      select p.geo_object_id, p.anchor_position as pt, p.merged_into_id, p.status, p.valid_from, p.valid_to
      from places p where p.anchor_position && t.box
      union all
      select p.geo_object_id, p.position, p.merged_into_id, p.status, p.valid_from, p.valid_to
      from places p where p.position && t.box and p.anchor_position is null
    ) pl
    join geo_objects o on o.id = pl.geo_object_id and ${consolidatable(day)}
    where ST_DWithin(t.geom::geography, pl.pt::geography, ${reachM}::float8)
      and pl.merged_into_id is null and pl.status <> 'rejected'
      and pl.valid_from <= ${day}::date and (pl.valid_to is null or pl.valid_to > ${day}::date)
  `);
  return ids(rows).filter((id) => !own.has(id));
}

/** An explicit run (`geoObjectIds`, not a text run's frozen versions): its targets are exactly the given objects. */
const isExplicit = (p: Record<string, unknown>) => !Array.isArray(p.documentVersionIds) && Array.isArray(p.geoObjectIds);

/** The ids without the POIs, sorted. */
async function withoutPois(db: Db, targets: string[]): Promise<string[]> {
  if (targets.length === 0) return targets;
  const { rows } = await db.execute<{ id: string }>(sql`
    select o.id from geo_objects o where o.id = any(${sql.param(targets)}::uuid[]) and o.type <> 'poi'
  `);
  return ids(rows);
}

/** The geo objects of the run's scope (see `consolidationTargets`), POIs included. */
async function scopeTargets(db: Db, run: { id: string; params: Record<string, unknown> }, day: string): Promise<string[]> {
  const p = run.params;
  if (!Array.isArray(p.documentVersionIds) && (await isRevisitRun(db, run.id))) {
    // A revisit stopped before `revisit.freeze` evaluated nothing: only the objects of pages its crawl found gone,
    // never the subdivision its `subdivisionKey` names (ruling M7-G-R4).
    const gone = JSON.stringify(strings(p.goneGeoObjectIds));
    const { rows } = await db.execute<{ id: string }>(sql`
      select o.id from geo_objects o
      where o.id in (select value::uuid from jsonb_array_elements_text(${gone}::jsonb)) and ${consolidatable(day)}
    `);
    return ids(rows);
  }
  if (!Array.isArray(p.documentVersionIds)) {
    if (typeof p.tileId === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select o.id from tile_geo_objects tgo join geo_objects o on o.id = tgo.geo_object_id
        where tgo.tile_id = ${p.tileId} and ${consolidatable(day)}
      `);
      return ids(rows);
    }
    if (typeof p.subdivisionKey === "string") {
      const sub = await subdivisionByKey(db, p.subdivisionKey);
      if (!sub) return [];
      const { rows } = await db.execute<{ id: string }>(sql`
        select distinct o.id
        from tile_geo_objects tgo
        join geo_objects o on o.id = tgo.geo_object_id and ${consolidatable(day)}
        where tgo.tile_id in (${subdivisionTilesSql(sql`${sub.id}::uuid`)})
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
    if (typeof p.comparisonSetSubdivision === "string") {
      const { rows } = await db.execute<{ id: string }>(sql`
        select distinct o.id
        from subdivisions s
        join comparison_set c on c.subdivision_id = s.id
        join places pl on pl.id = c.place_id and pl.merged_into_id is null
          and pl.valid_from <= ${day}::date and (pl.valid_to is null or pl.valid_to > ${day}::date)
        join geo_objects o on o.id = pl.geo_object_id and ${consolidatable(day)}
        where s.key = ${p.comparisonSetSubdivision} and s.valid_to is null
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

async function isRevisitRun(db: Db, runId: string): Promise<boolean> {
  const { rows } = await db.execute<{ kind: string }>(sql`select kind from runs where id = ${runId}`);
  return rows[0]?.kind === "revisit";
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

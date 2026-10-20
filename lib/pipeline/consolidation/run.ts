import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runStages, runs } from "@/lib/db/schema";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import type { ExtractionCandidate } from "@/lib/domain/consolidation/inputs";
import { clearConsolidationCatchUp, consolidationSkipOf, recordConsolidationCatchUp } from "@/lib/domain/consolidation/skipped";
import { consolidationBlocked, consolidationTargets, type ConsolidationParams } from "@/lib/domain/consolidation/targets";
import { levelFor } from "@/lib/domain/facts/levels";
import { validAtAlias } from "@/lib/domain/timeline";
import { createRun, failRun, type RunScope } from "@/lib/domain/runs";
import { createLogger } from "@/lib/logger";
import { enqueueStage, startRun } from "@/lib/pipeline/runs";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { CONSOLIDATION_GEO_STAGE, CONSOLIDATION_STAGES, CONSOLIDATION_SUMMARY_STAGE } from "./stages";

/*
 * Starter of consolidation runs (ruling M5-P16: only the starter lives here; no stage or handler imports this module).
 */

/** Scope id of a consolidation run over given objects or a comparison set (scope type `system`). */
export const CONSOLIDATION_RUN_SCOPE = "consolidation";

export type ConsolidationScope = { tileId: string } | { subdivisionKey: string } | { geoObjectIds: string[] } | { comparisonSetSubdivision: string };

export type StartConsolidationInput = {
  scope: ConsolidationScope;
  triggeredBy: string;
  evaluation?: true;
  /** Default: the active version (`activeRulesVersion`), stored in the params so the whole run uses one version. */
  rulesVersion?: string;
  /** An extraction candidate to evaluate (only with `evaluation`, ruling M7-P11). */
  extraction?: ExtractionCandidate;
  stagesOnly?: string[];
  /** „Summary neu erzeugen“: only with `stagesOnly` = the summary stage (`ConsolidationParams.regenerateSummary`). */
  regenerateSummary?: true;
};

/**
 * Valid on the run date: the UTC date of the transaction, as `runDate` reads the run's `created_at` (final review M-7;
 * `current_date` would follow the session time zone).
 */
const validToday = (alias: string) => validAtAlias(alias, sql`(now() at time zone 'UTC')::date`);

/**
 * Checks the scope before the run exists (`RunScopeNotReady`) and returns the run's scope: a valid tile; a subdivision
 * with tiles in its run scope (an unknown, excluded or area key is refused by `requireSubdivision`); geo objects that are valid, unmerged and have a fact level (scope `place` with the place id for
 * exactly one object with a valid place, else `system`); a subdivision whose comparison set is not empty (`system`).
 */
async function checkedScope(db: Db, scope: ConsolidationScope): Promise<RunScope> {
  if ("tileId" in scope) {
    const { rows } = await db.execute(sql`select 1 from tiles t where t.id = ${scope.tileId} and ${validToday("t")}`);
    if (rows.length === 0) throw new RunScopeNotReady("unknown_tile", `tile ${scope.tileId} is not a valid tile`);
    return { type: "tile", id: scope.tileId };
  }
  if ("subdivisionKey" in scope) {
    const sub = await requireSubdivision(db, scope.subdivisionKey);
    if ((await subdivisionTileIds(db, sub.id)).length === 0) {
      throw new RunScopeNotReady("subdivision_without_coast_tiles", `Subdivision ${scope.subdivisionKey} has no coast tiles yet`);
    }
    return { type: "subdivision", id: scope.subdivisionKey };
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
  const sub = await requireSubdivision(db, scope.comparisonSetSubdivision);
  const { rows } = await db.execute(sql`select 1 from comparison_set where subdivision_id = ${sub.id}::uuid limit 1`);
  if (rows.length === 0) {
    throw new RunScopeNotReady("comparison_set_empty", `the comparison set of subdivision ${scope.comparisonSetSubdivision} is empty`);
  }
  return { type: "system", id: CONSOLIDATION_RUN_SCOPE };
}

/** The run `startConsolidationRun` creates, checked (scope, stages, rules version) before anything is written. */
async function consolidationRunInput(
  db: Db,
  input: StartConsolidationInput,
): Promise<Parameters<typeof createRun>[1]> {
  if (input.evaluation && input.stagesOnly) {
    // An evaluation run only ever has `consolidation.geo` (ruling M5-H-R2 M-5): refused, not silently dropped.
    throw new Error("an evaluation run takes no stagesOnly");
  }
  if (input.regenerateSummary && (input.stagesOnly?.length !== 1 || input.stagesOnly[0] !== CONSOLIDATION_SUMMARY_STAGE)) {
    throw new Error(`regenerateSummary needs stagesOnly = [${CONSOLIDATION_SUMMARY_STAGE}]`);
  }
  if (input.stagesOnly) {
    for (const stage of input.stagesOnly) {
      if (!(CONSOLIDATION_STAGES as readonly string[]).includes(stage)) throw new Error(`${stage} is no consolidation stage`);
    }
  }
  if (input.extraction && !input.evaluation) throw new Error("an extraction candidate is evaluated in an evaluation run only");
  const rulesVersion = input.rulesVersion ?? (await activeRulesVersion(db));
  const extraction = input.extraction && { model: input.extraction.model, promptVersion: input.extraction.promptVersion };
  getConsolidationConfig(rulesVersion);
  const scope = await checkedScope(db, input.scope);
  const stages = input.evaluation
    ? [CONSOLIDATION_GEO_STAGE]
    : input.stagesOnly
      ? CONSOLIDATION_STAGES.filter((s) => input.stagesOnly!.includes(s))
      : [...CONSOLIDATION_STAGES];
  const params: ConsolidationParams = {
    ...("geoObjectIds" in input.scope ? { geoObjectIds: [...new Set(input.scope.geoObjectIds)].sort() } : input.scope),
    ...(input.evaluation ? { evaluation: true as const } : {}),
    rulesVersion,
    ...(extraction ? { extraction } : {}),
    ...(input.evaluation ? { candidate: { ...(input.rulesVersion !== undefined || !extraction ? { rulesVersion } : {}), ...(extraction ? { extraction } : {}) } } : {}),
    ...(input.stagesOnly ? { stagesOnly: stages } : {}),
    ...(input.regenerateSummary ? { regenerateSummary: true as const } : {}),
  };
  return { kind: input.evaluation ? "reprocess" : "stage", scope, stages, params, triggeredBy: input.triggeredBy };
}

/**
 * Starts a consolidation run ("Konsolidieren", "Profil neu berechnen", the follow-up of a profile decision). Kind
 * `stage` with every consolidation stage (`CONSOLIDATION_STAGES`), or only `stagesOnly` (a subset, in stage order);
 * an evaluation run is kind `reprocess` with `params.evaluation`, only `consolidation.geo` and the rules version to
 * evaluate, optionally with an extraction candidate (`params.extraction`; `stagesOnly` with it throws). Every run
 * stores its rules version in `params.rulesVersion`: the given one, else the active one (`activeRulesVersion`, ruling
 * M7-P10); an unknown version throws. The scope is checked before
 * the run exists (`RunScopeNotReady`, see `checkedScope`); the params carry the scope (`ConsolidationParams`).
 */
export async function startConsolidationRun(
  db: Db,
  boss: PgBoss,
  input: StartConsolidationInput,
): Promise<{ id: string }> {
  return startRun(db, boss, await consolidationRunInput(db, input));
}

export type CatchUpResult =
  | { status: "started"; consolidationRunId: string }
  /** The run's consolidation was not skipped (it ran, or has not been reached yet). */
  | { status: "not_skipped" }
  /** Caught up on already, by `consolidationRunId`. */
  | { status: "already"; consolidationRunId: string }
  /** Its quote fidelity still blocks it. */
  | { status: "blocked" }
  /** None of its targets can be consolidated (any more). */
  | { status: "no_targets" };

/**
 * „Konsolidierung nachholen“ (ruling M5-H-R2): starts the consolidation a run skipped (its stored marker,
 * `consolidationSkipOf`), as a consolidation run over the run's targets (`consolidationTargets`), once its quote
 * fidelity no longer blocks it. With `afterRecheck` (a „Belegtreue neu prüfen“ that just committed, ruling M5-H-R2 I-1)
 * it also consolidates a run that had consolidated before a later block (late results) and one caught up on already,
 * since the recheck made facts active that no profile has seen; it leaves alone a run whose `consolidation.geo` is
 * still to come (it consolidates on its own). Only runs with a `consolidation.geo` stage (text and consolidation runs,
 * not model comparisons) are ever caught up on. The catch-up inherits the skipped run's frozen `params.rulesVersion`
 * (ruling M7-E-R1; the active version only for a run without one).
 *
 * The run row of the consolidation run and the record of it on the skipped run are written in one transaction that
 * locks the skipped run (a double click starts one run); its first stage is enqueued after that commit (when that
 * fails, the new run fails and the record is removed, so the button comes back). Never called
 * inside a decision or recheck transaction (ruling M5-F-R4).
 */
export async function catchUpConsolidation(
  db: Db,
  boss: PgBoss,
  runId: string,
  triggeredBy: string,
  opts: { afterRecheck?: boolean } = {},
): Promise<CatchUpResult> {
  const outcome = await db.transaction(async (tx): Promise<CatchUpResult & { stage?: string }> => {
    const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!run) throw new Error(`run ${runId} not found`);
    const params = (run.params ?? {}) as Record<string, unknown>;
    const [geo] = await tx
      .select({ status: runStages.status })
      .from(runStages)
      .where(and(eq(runStages.runId, runId), eq(runStages.stage, CONSOLIDATION_GEO_STAGE)));
    if (!geo || params.evaluation === true) return { status: "not_skipped" };
    const skip = consolidationSkipOf(params);
    if (opts.afterRecheck) {
      if (!skip && geo.status === "pending") return { status: "not_skipped" };
    } else {
      if (!skip) return { status: "not_skipped" };
      if (skip.catchUpRunId) return { status: "already", consolidationRunId: skip.catchUpRunId };
    }
    if (await consolidationBlocked(tx, runId)) return { status: "blocked" };
    const targets = await consolidationTargets(tx, { id: runId, params });
    if (targets.length === 0) return { status: "no_targets" };
    // the catch-up consolidates with the rules version the skipped run froze at its start (ruling M7-E-R1)
    const rulesVersion = typeof params.rulesVersion === "string" ? params.rulesVersion : undefined;
    const input = await consolidationRunInput(tx, { scope: { geoObjectIds: targets }, triggeredBy, ...(rulesVersion ? { rulesVersion } : {}) });
    const { id } = await createRun(tx, input);
    await recordConsolidationCatchUp(tx, runId, id);
    return { status: "started", consolidationRunId: id, stage: input.stages[0] };
  });
  if (outcome.status !== "started") return outcome;
  try {
    await enqueueStage(db, boss, outcome.consolidationRunId, outcome.stage!);
  } catch (e) {
    // The run never started: it fails, and the skipped run offers „Konsolidierung nachholen“ again.
    await failRun(db, outcome.consolidationRunId, "start failed: first stage not enqueued");
    await clearConsolidationCatchUp(db, runId, outcome.consolidationRunId);
    throw e;
  }
  createLogger("consolidation").info({ runId, consolidationRunId: outcome.consolidationRunId }, "skipped consolidation caught up");
  return { status: "started", consolidationRunId: outcome.consolidationRunId };
}

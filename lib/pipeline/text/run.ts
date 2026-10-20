import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { modelComparisons, modelComparisonUnits, runs } from "@/lib/db/schema";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { createRun, type RunScope } from "@/lib/domain/runs";
import { estimateComparisonCostEur } from "@/lib/domain/extraction/comparison";
import { anthropicHeadroomEur } from "@/lib/pipeline/batches";
import { CONSOLIDATION_STAGES } from "@/lib/pipeline/consolidation/stages";
import { enqueueStage, startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { CHECK_STAGE } from "./check";
import { CLASSIFY_STAGE } from "./classify";
import { DISAMBIGUATE_STAGE } from "./disambiguate";
import { EXTRACT_STAGE } from "./extract";
import { GEOCODE_STAGE } from "./geocode";
import { MENTIONS_STAGE } from "./mentions";
import { ROUTE_STAGE } from "./routes";
import { freezeTextRunParams, type TextRunParams } from "./versions";

/*
 * Starters of text runs (ruling M4-P1: only starters live here, no stage or handler imports this module): "Texte
 * auswerten" (`startTextRun`: pending versions, a tile or area, or given versions, also the rematch after a review
 * decision), "Reprozessieren" (`startReprocessRun`) and the model comparison run (`startModelComparisonRun`).
 */

/**
 * The stages of a text run, in order: the quote check (`extraction.check`) comes after the extraction of facts and
 * routes, and the consolidation of the objects the run extracted for after it (ruling M5-P16), so a run whose quote
 * fidelity is below 100 % consolidates nothing.
 */
export const TEXT_RUN_STAGES = [
  CLASSIFY_STAGE,
  MENTIONS_STAGE,
  DISAMBIGUATE_STAGE,
  GEOCODE_STAGE,
  EXTRACT_STAGE,
  ROUTE_STAGE,
  CHECK_STAGE,
  ...CONSOLIDATION_STAGES,
] as const;

function scopeOf(params: TextRunParams): RunScope {
  if (params.tileId) return { type: "tile", id: params.tileId };
  if (params.areaKey) return { type: "area", id: params.areaKey };
  return { type: "system", id: "texts" };
}

/**
 * Refuses a text run whose selection cannot be worked on, before the run exists (ruling M4-P16): a tile that is not a
 * valid tile, an area that is not configured or has no valid tile, given versions that do not exist or are no longer
 * the current version of their document. A `pending` selection with nothing to do still starts (its stages finish at
 * once).
 */
async function assertSelectionReady(db: Db, params: TextRunParams, config: AppConfig): Promise<void> {
  if (params.tileId) {
    const { rows } = await db.execute(sql`
      select 1 from tiles t where t.id = ${params.tileId} and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
    `);
    if (rows.length === 0) throw new RunScopeNotReady("unknown_tile", `tile ${params.tileId} is not a valid tile`);
  }
  if (params.areaKey) {
    if (!config.areas.some((a) => a.key === params.areaKey)) {
      throw new RunScopeNotReady("unknown_area", `area ${params.areaKey} is not configured`);
    }
    const { rows } = await db.execute(sql`
      select 1 from tiles t join geo_objects a on a.id = t.area_id and a.type = 'area'
      where a.config_key = ${params.areaKey} and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
      limit 1
    `);
    if (rows.length === 0) throw new RunScopeNotReady("area_without_tiles", `area ${params.areaKey} has no tiles yet`);
  }
  const ids = params.documentVersionIds ?? [];
  if (ids.length > 0) {
    const { rows } = await db.execute<{ id: string }>(sql`
      select v.id from document_versions v join documents d on d.current_version_id = v.id
      where v.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    `);
    if (new Set(rows.map((r) => r.id)).size < new Set(ids).size) {
      throw new RunScopeNotReady("versions_not_current", "a given document version does not exist or is not current");
    }
  }
}

/**
 * Starts a text run ("Texte auswerten", kind `stage`, every text stage) over the selected versions. The selection is
 * checked first (`RunScopeNotReady`) and frozen at the start (ruling M4-E-R2): `pending`, `tileId` and `areaKey` are
 * resolved once into `params.documentVersionIds`, and every stage plans from that list, so versions arriving mid-run
 * wait for the next run. `rematch: true` (after a review decision named a new object) matches the versions again;
 * only the mentions this creates are pending, so only they are extracted. The active rules version is frozen in
 * `params.rulesVersion` too (ruling M7-E-R1): the run's consolidation, summaries and follow-up keep it across an
 * activation.
 */
export async function startTextRun(
  db: Db,
  boss: PgBoss,
  input: TextRunParams & { triggeredBy: string },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const { triggeredBy, ...selection } = input;
  await assertSelectionReady(db, selection, config);
  const params = { ...(await freezeTextRunParams(db, selection, config)), rulesVersion: await activeRulesVersion(db) };
  return startRun(db, boss, { kind: "stage", scope: scopeOf(selection), stages: [...TEXT_RUN_STAGES], params, triggeredBy });
}

/**
 * Starts "Reprozessieren" for a tile or an area (spec 06, Reprozessierung: kind `reprocess`, every text stage,
 * `params.reprocess`): the versions with mentions there are matched again (adding nothing that exists), and every one
 * of their mentions is extracted again into a new extraction run with the configured model, prompt and fact schema;
 * the old facts stay. Pending versions are not taken in (a reprocess ignores the passes). Like a text run it freezes
 * the active rules version in `params.rulesVersion`.
 */
export async function startReprocessRun(
  db: Db,
  boss: PgBoss,
  input: { scope: { tileId: string } | { areaKey: string }; triggeredBy: string },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const selection: TextRunParams = { ...input.scope, reprocess: true };
  await assertSelectionReady(db, selection, config);
  const params = { ...(await freezeTextRunParams(db, selection, config)), rulesVersion: await activeRulesVersion(db) };
  return startRun(db, boss, { kind: "reprocess", scope: scopeOf(selection), stages: [...TEXT_RUN_STAGES], params, triggeredBy: input.triggeredBy });
}

/** The stages of a model comparison run: the extraction with both models, then the quote check of both runs. */
export const MODEL_COMPARISON_STAGES = [EXTRACT_STAGE, CHECK_STAGE] as const;
/** Scope id of model comparison runs (scope type `system`). */
export const MODEL_COMPARISON_SCOPE = "model-comparison";

/**
 * "Lauf starten" of a model comparison (Task 19): a run of kind `stage` with `MODEL_COMPARISON_STAGES` and params
 * `{ comparisonId, models, documentVersionIds }` (the versions of its units, for the record); the extraction stage
 * plans one comparison extraction run per model from the comparison's units. Refused before the run exists
 * (`RunScopeNotReady`) for an unknown comparison, one without units, one whose run is queued, running or finished (a
 * failed or ended run may be started again: a new run gets new extraction runs), and one whose cost estimate does not
 * fit today's `anthropic` headroom (spend and open batch reservations, ruling M4-P6). Comparison row and run are
 * written in one transaction under a row lock, so two starts never create two runs.
 */
export async function startModelComparisonRun(
  db: Db,
  boss: PgBoss,
  input: { comparisonId: string; triggeredBy: string; now?: Date },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const created = await db.transaction(async (tx) => {
    const [comparison] = await tx.select().from(modelComparisons).where(eq(modelComparisons.id, input.comparisonId)).for("update");
    if (!comparison) throw new RunScopeNotReady("unknown_comparison", `model comparison ${input.comparisonId} does not exist`);
    if (comparison.runId) {
      const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, comparison.runId));
      if (run && run.status !== "failed") throw new RunScopeNotReady("comparison_started", `model comparison ${comparison.id} has run ${comparison.runId}`);
    }
    const units = await tx
      .select({ versionId: modelComparisonUnits.documentVersionId })
      .from(modelComparisonUnits)
      .where(eq(modelComparisonUnits.comparisonId, comparison.id));
    if (units.length === 0) throw new RunScopeNotReady("comparison_without_units", `model comparison ${comparison.id} has no units`);
    const estimateEur = await estimateComparisonCostEur(tx, comparison.id, config);
    const headroomEur = await anthropicHeadroomEur(tx, config, input.now ?? new Date());
    if (estimateEur >= headroomEur) {
      throw new RunScopeNotReady("comparison_over_budget", `estimate ${estimateEur.toFixed(2)} EUR exceeds today's anthropic headroom ${headroomEur.toFixed(2)} EUR`);
    }
    const documentVersionIds = [...new Set(units.map((u) => u.versionId))].sort();
    const { id } = await createRun(tx, {
      kind: "stage",
      scope: { type: "system", id: MODEL_COMPARISON_SCOPE },
      stages: [...MODEL_COMPARISON_STAGES],
      params: { comparisonId: comparison.id, models: comparison.models, documentVersionIds },
      triggeredBy: input.triggeredBy,
    });
    await tx.update(modelComparisons).set({ runId: id }).where(eq(modelComparisons.id, comparison.id));
    return { id };
  });
  await enqueueStage(db, boss, created.id, MODEL_COMPARISON_STAGES[0]);
  return created;
}

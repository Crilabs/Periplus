import { and, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { loadPrompt } from "@/lib/ai/prompts";
import { consolidationVersions, getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import type { EvaluationCandidate } from "@/lib/domain/consolidation/targets";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";

// Kept apart from ./quality-stages: the job handler imports that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handler (rulings M6-P17, M7-P5).

export const MEASUREMENT_LABEL_MAX = 40;

/** The measurement runs of the subdivision (any status). */
const measurementOf = (subdivisionKey: string) =>
  sql`${runs.scopeType} = 'subdivision' and ${runs.scopeId} = ${subdivisionKey} and ${QUALITY_MEASURE_STAGE} = any(${runs.stages})`;

/**
 * Starts a measurement run „Messen“ for the subdivision (spec 10): kind `stage`, scope `subdivision` with its key, stage
 * `quality.measure`, params `{ subdivisionKey, label, from, to }` (ISO timestamps). `to` defaults to now, `from` to the latest
 * window end (`params.to`, not the start time) of the subdivision's finished measurements, so a failed or unfinished
 * measurement loses no window (ruling M7-D-R2); the subdivision's first measurement needs `from` (final review B M-13). The
 * label (trimmed, 1–40 characters) is unique per subdivision among measurements that did not fail (a failed one frees it,
 * ruling M7-D-R1): checked with the run's insert in one transaction under an advisory lock per subdivision (ruling M7-P5), so
 * two starts cannot take the same label. An unknown or excluded subdivision (or a leftover area key) is refused by
 * `requireSubdivision`. Every other refusal is a `RunScopeNotReady` with a German text: `measurement_label_invalid`, `measurement_label_taken`, `measurement_running` (a measurement of the subdivision is queued or
 * running: its window would overlap), `measurement_window_empty` (`from` not before `to`) and `measurement_from_required`
 * (no `from` for the subdivision's first measurement: it never defaults, the start of the pilot's first run is given).
 */
export async function startMeasurement(
  db: Db,
  boss: PgBoss,
  input: { subdivisionKey: string; label: string; from?: Date; to?: Date; triggeredBy: string },
): Promise<{ id: string }> {
  const label = input.label.trim();
  if (label.length < 1 || label.length > MEASUREMENT_LABEL_MAX) {
    throw new RunScopeNotReady("measurement_label_invalid", `label must have 1–${MEASUREMENT_LABEL_MAX} characters`);
  }
  await requireSubdivision(db, input.subdivisionKey);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`measure:${input.subdivisionKey}`}))`);
    const [taken] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(measurementOf(input.subdivisionKey), sql`${runs.status} <> 'failed'`, sql`${runs.params} ->> 'label' = ${label}`))
      .limit(1);
    if (taken) throw new RunScopeNotReady("measurement_label_taken", `subdivision ${input.subdivisionKey} has a measurement labelled ${label}`);
    // A second start while one waits or runs would measure an overlapping window (its `to` is not yet a finished end).
    const [open] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(measurementOf(input.subdivisionKey), sql`${runs.status} in ('queued', 'running')`))
      .limit(1);
    if (open) throw new RunScopeNotReady("measurement_running", `subdivision ${input.subdivisionKey} has measurement run ${open.id} queued or running`);

    const to = input.to ?? new Date();
    let from = input.from;
    if (!from) {
      const [previous] = await tx
        .select({ to: sql<Date | string | null>`max((${runs.params} ->> 'to')::timestamptz)` })
        .from(runs)
        .where(and(measurementOf(input.subdivisionKey), sql`${runs.status} = 'finished'`));
      // the first measurement has no default: the oldest run of the database may be a paid run of an earlier
      // acceptance, which would inflate the pilot's first cost per place (final review B M-13)
      if (!previous?.to) throw new RunScopeNotReady("measurement_from_required", `pass from for the first measurement of ${input.subdivisionKey}`);
      from = new Date(previous.to);
    }
    if (!(from.getTime() < to.getTime())) {
      throw new RunScopeNotReady("measurement_window_empty", `the window must start before it ends (${from.toISOString()} – ${to.toISOString()})`);
    }

    return startRun(tx, boss, {
      kind: "stage",
      scope: { type: "subdivision", id: input.subdivisionKey },
      stages: [QUALITY_MEASURE_STAGE],
      params: { subdivisionKey: input.subdivisionKey, label, from: from.toISOString(), to: to.toISOString() },
      triggeredBy: input.triggeredBy,
    });
  });
}

/**
 * „Bewertung starten“ (spec 10 regression): an evaluation run over the subdivision's comparison set, kind `reprocess`, only
 * `consolidation.geo` in evaluation mode (`startConsolidationRun`), so profiles go to `evaluation_profiles` and nothing
 * to profiles, the change feed or review. The candidate is a released rules version (`config/consolidation/v<n>.json`;
 * default the active one), an extraction configuration (a priced model of `config/models.json` and a prompt version of
 * `extract-facts`: its existing extraction runs are evaluated, ruling M7-P11; nothing is extracted, so nothing is
 * spent) or both. Refused (`RunScopeNotReady`): no candidate (`evaluation_candidate_missing`), an unknown version, model
 * or prompt (`evaluation_candidate_unknown`), an unknown subdivision or an empty set (as `startConsolidationRun`).
 */
export async function startEvaluation(
  db: Db,
  boss: PgBoss,
  input: { subdivisionKey: string; candidate: EvaluationCandidate; triggeredBy: string },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const { rulesVersion, extraction } = input.candidate;
  if (rulesVersion === undefined && extraction === undefined) {
    throw new RunScopeNotReady("evaluation_candidate_missing", "an evaluation needs a rules version or an extraction candidate");
  }
  if (rulesVersion !== undefined && !consolidationVersions().includes(rulesVersion)) {
    throw new RunScopeNotReady("evaluation_candidate_unknown", `rules version ${rulesVersion} is not released in config/consolidation`);
  }
  if (extraction && !knownExtraction(extraction, config)) {
    throw new RunScopeNotReady("evaluation_candidate_unknown", `extraction ${extraction.model}@p${extraction.promptVersion} is not configured`);
  }
  return startConsolidationRun(
    db,
    boss,
    {
      scope: { comparisonSetSubdivision: input.subdivisionKey },
      evaluation: true,
      ...(rulesVersion !== undefined ? { rulesVersion } : {}),
      ...(extraction ? { extraction } : {}),
      triggeredBy: input.triggeredBy,
    },
  );
}

/** A priced model of `config/models.json` and a prompt file of `extract-facts` with that version. */
function knownExtraction(e: { model: string; promptVersion: number }, config: AppConfig): boolean {
  if (!Object.hasOwn(config.models.pricesEurPerMTok, e.model) || !Number.isInteger(e.promptVersion) || e.promptVersion < 1) return false;
  try {
    loadPrompt("extract-facts", e.promptVersion);
    return true;
  } catch {
    return false;
  }
}

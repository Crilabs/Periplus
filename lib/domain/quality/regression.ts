import { and, desc, eq, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { COMPARISON_ATTRIBUTES, configActivations, runs, type ComparisonAttribute, type RunStatus } from "@/lib/db/schema";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import { activeRulesVersion, consolidationConfigFor, extractionVersion } from "@/lib/domain/consolidation/active-rules";
import { formatProfileValue, profileAttributeLabel } from "@/lib/domain/consolidation/format";
import { attributeIn } from "@/lib/domain/rules/weights";
import { profileEntryKey } from "@/lib/domain/profile-view";
import type { EvaluationCandidate } from "@/lib/domain/consolidation/targets";
import { latestComparisonResults } from "./comparison-results";
import { comparisonValues, loadComparisonSubjects } from "./comparison-values";
import { coverageMetric, factPrecisionMetric } from "./metrics";

/*
 * Regression gate (spec 10 „Regression“): „Für Attribute, deren Wert sich gegenüber dem zuletzt geprüften Profil nicht
 * geändert hat, gilt das alte Ergebnis weiter; geänderte Werte gehen zur erneuten Prüfung. Übereinstimmung und
 * Abdeckung dürfen nicht sinken; sonst wird die neue Konfiguration nicht aktiv geschaltet (`/quality` zeigt den
 * Vergleich alt/neu, Aktivieren ist ein bewusster Klick).“ An outcome is valid for the value hash it was given for, so
 * an unchanged hash carries it to the candidate's profile; a changed hash without an outcome is pending. Activation
 * writes `config_activations` (ruling M7-P10: the rules resolver reads it; an extraction activation is the approval
 * of a configuration that becomes effective by deploying `config/models.json`). `comparison` holds numbers only
 * (Grundprinzip 9).
 */

export type { EvaluationCandidate };
export { extractionVersion };

type Side = { precision: number | null; coverage: number | null; compared: number };

export type RegressionComparison = {
  evaluationRunId: string;
  subdivisionKey: string;
  candidate: EvaluationCandidate;
  /** The evaluation run's status: only a finished run can pass. */
  status: RunStatus;
  old: Side;
  next: Side;
  /** Attributes whose own value differs between the current and the candidate's profile; `checked` = outcome for the new value. */
  changed: Array<{ placeId: string; name: string | null; attribute: ComparisonAttribute; oldDisplay: string; newDisplay: string; checked: boolean }>;
  pending: number;
  /**
   * Safety values the candidate loses at a set place (GR-2): an entry of a safety list (`change.additiveLists`:
   * prohibitions, hazards, restricted zones) the current profile has and the candidate's lacks, or an exclusion the
   * candidate lifts. Any of them closes the gate.
   */
  safetyLosses: Array<{ placeId: string; name: string | null; attribute: string; display: string }>;
  passes: boolean;
  reasons: string[];
};

/** Activation refused: the comparison does not pass (`reasons` in German). */
export class RegressionGateClosed extends Error {
  constructor(readonly reasons: string[]) {
    super(`regression gate closed: ${reasons.join("; ")}`);
    this.name = "RegressionGateClosed";
  }
}

/** The run is no evaluation run of a comparison set. */
export class NotAnEvaluationRun extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} is no evaluation run of a comparison set`);
    this.name = "NotAnEvaluationRun";
  }
}

const percent = (v: number | null) =>
  `${((v ?? 0) * 100).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
/** `null` counts as 0; a tiny float difference is no drop. */
const drops = (next: number | null, old: number | null) => (next ?? 0) < (old ?? 0) - 1e-9;

type EvaluationRun = { id: string; status: RunStatus; subdivisionKey: string; candidate: EvaluationCandidate };

/** The evaluation run with its subdivision and candidate (`params.candidate`, else the rules version of a CLI evaluation). */
async function evaluationRun(db: Db, runId: string): Promise<EvaluationRun> {
  const [run] = await db.select({ id: runs.id, status: runs.status, params: runs.params }).from(runs).where(eq(runs.id, runId));
  const params = (run?.params ?? {}) as Record<string, unknown>;
  if (!run || params.evaluation !== true || typeof params.comparisonSetSubdivision !== "string") throw new NotAnEvaluationRun(runId);
  const stored = params.candidate as EvaluationCandidate | undefined;
  const candidate: EvaluationCandidate =
    stored && (stored.rulesVersion !== undefined || stored.extraction !== undefined)
      ? stored
      : { rulesVersion: typeof params.rulesVersion === "string" ? params.rulesVersion : undefined };
  return { id: run.id, status: run.status, subdivisionKey: params.comparisonSetSubdivision, candidate };
}

/**
 * Old/new comparison of an evaluation run over its subdivision's comparison set: `old` = the current profiles, `next` = the
 * run's `evaluation_profiles`, both through `factPrecisionMetric` (an outcome counts for the value hash it was given
 * for, so an unchanged value carries its old outcome) and `coverageMetric`. `changed` lists every attribute whose
 * value hash differs; one without an outcome for the new hash is pending. `passes` = run finished, the set not empty,
 * at least one compared value on the candidate's side (an activation always rests on a checked outcome), no set place
 * with a profile row written after the run finished (the comparison would judge the candidate against data it never
 * saw: evaluate again, ruling M7-E-R2), no activation of the same kind from another run since this run started (an
 * older evaluation would silently roll a newer activation back, final review B M-4), nothing pending, precision and
 * coverage not lower (`null` counts as 0), and no safety value lost at a set place (`safetyLosses`: a prohibition,
 * hazard or restricted-zone entry, or an exclusion; GR-2); `reasons` say in German why not.
 */
export async function compareEvaluation(db: Db, evaluationRunId: string): Promise<RegressionComparison> {
  const run = await evaluationRun(db, evaluationRunId);
  const scope = { subdivisionKey: run.subdivisionKey };
  const [oldPrecision, nextPrecision, coverage] = [
    await factPrecisionMetric(db, scope),
    await factPrecisionMetric(db, scope, { evaluationRunId }),
    // the evaluation changes profiles, never which places are confirmed: one coverage for both sides
    await coverageMetric(db, scope),
  ];

  const navily = getConfig().quality.navily;
  const current = new Map((await loadComparisonSubjects(db, run.subdivisionKey)).map((s) => [s.placeId, s]));
  const evaluated = await loadComparisonSubjects(db, run.subdivisionKey, { evaluationRunId });
  const latest = await latestComparisonResults(db, evaluated.map((s) => s.placeId));
  const changed: RegressionComparison["changed"] = [];
  for (const subject of evaluated) {
    const before = current.get(subject.placeId);
    if (!before) continue;
    const [oldValues, newValues] = [comparisonValues(before, navily), comparisonValues(subject, navily)];
    for (const attribute of COMPARISON_ATTRIBUTES) {
      const [o, n] = [oldValues[attribute], newValues[attribute]];
      if (o.hash === n.hash) continue;
      changed.push({
        placeId: subject.placeId,
        name: subject.name,
        attribute,
        oldDisplay: o.display,
        newDisplay: n.display,
        checked: latest.has(`${subject.placeId}|${attribute}|${n.hash}`),
      });
    }
  }

  const cfg = await consolidationConfigFor(db);
  const safetyLosses = evaluated.flatMap((subject) => {
    const before = current.get(subject.placeId);
    return before ? lostSafetyValues(before.attributes, subject.attributes, cfg).map((l) => ({ placeId: subject.placeId, name: subject.name, ...l })) : [];
  });

  const old: Side = { precision: oldPrecision.value, coverage: coverage.value, compared: Number(oldPrecision.details.compared) };
  const next: Side = { precision: nextPrecision.value, coverage: coverage.value, compared: Number(nextPrecision.details.compared) };
  const pending = changed.filter((c) => !c.checked).length;
  const reasons: string[] = [];
  if (run.status !== "finished") reasons.push("Bewertungslauf ist noch nicht abgeschlossen");
  if (evaluated.length === 0) reasons.push("Vergleichssatz leer");
  else if (next.compared === 0) reasons.push("Kein geprüfter Vergleichswert – erst Werte im Navily-Abgleich prüfen");
  const stale = run.status === "finished" ? await placesChangedSince(db, evaluated.map((s) => s.placeId), run.id) : 0;
  if (stale > 0) reasons.push(`Profile seit der Bewertung geändert (${stale} ${stale === 1 ? "Ort" : "Orte"}) – neu bewerten`);
  if (await activatedSince(db, run)) reasons.push("Nach dieser Bewertung wurde eine andere Konfiguration aktiviert – neu bewerten");
  if (pending > 0) reasons.push(`${pending} geänderte${pending === 1 ? "r Wert" : " Werte"} ungeprüft`);
  if (drops(next.precision, old.precision)) reasons.push(`Präzision sinkt von ${percent(old.precision)} auf ${percent(next.precision)}`);
  if (drops(next.coverage, old.coverage)) reasons.push(`Abdeckung sinkt von ${percent(old.coverage)} auf ${percent(next.coverage)}`);
  for (const l of safetyLosses) reasons.push(`Sicherheitswert entfällt: ${l.name ?? l.placeId} – ${profileAttributeLabel(l.attribute)} ${l.display}`);
  return {
    evaluationRunId,
    subdivisionKey: run.subdivisionKey,
    candidate: run.candidate,
    status: run.status,
    old,
    next,
    changed,
    pending,
    safetyLosses,
    passes: reasons.length === 0,
    reasons,
  };
}

/**
 * The safety values `next` loses against `old` (GR-2): per safety list (`change.additiveLists`) the entries of `old`
 * whose identity key (`profileEntryKey`) `next` lacks, and an exclusion `old` has and `next` does not.
 */
export function lostSafetyValues(old: Record<string, unknown>, next: Record<string, unknown>, cfg: ConsolidationConfig): Array<{ attribute: string; display: string }> {
  const losses: Array<{ attribute: string; display: string }> = [];
  for (const [attribute, value] of Object.entries(old).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!attributeIn(attribute, cfg.change.additiveLists) || !Array.isArray(value)) continue;
    const kept = new Set((Array.isArray(next[attribute]) ? (next[attribute] as unknown[]) : []).map((e) => profileEntryKey(attribute, e, cfg)));
    for (const entry of value) {
      if (!kept.has(profileEntryKey(attribute, entry, cfg))) losses.push({ attribute, display: formatProfileValue(attribute, [entry]) });
    }
  }
  const excluded = (v: unknown) => v !== null && typeof v === "object" && (v as { excluded?: unknown }).excluded === true;
  if (excluded(old["exclude"]) && !excluded(next["exclude"])) losses.push({ attribute: "exclude", display: "aufgehoben" });
  return losses;
}

/**
 * Whether a configuration of a kind the run's candidate holds was activated from another evaluation run after this run
 * was created. Compared in SQL (microseconds).
 */
async function activatedSince(db: Db, run: EvaluationRun): Promise<boolean> {
  const kinds = [...(run.candidate.rulesVersion !== undefined ? ["consolidation_rules"] : []), ...(run.candidate.extraction ? ["extraction"] : [])];
  if (kinds.length === 0) return false;
  const { rows } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from config_activations a
    where a.kind in (select value from jsonb_array_elements_text(${JSON.stringify(kinds)}::jsonb))
      and a.evaluation_run_id <> ${run.id}::uuid
      and a.activated_at > (select r.created_at from runs r where r.id = ${run.id}::uuid)
  `);
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * How many of the places got a profile row after the run finished (a regular consolidation after the evaluation); a
 * run without `finished_at` counts from its start. Compared in SQL: a JavaScript date would cut the microseconds.
 */
async function placesChangedSince(db: Db, placeIds: string[], runId: string): Promise<number> {
  if (placeIds.length === 0) return 0;
  const { rows } = await db.execute<{ n: number }>(sql`
    select count(distinct pl.id)::int as n
    from places pl join profiles p on p.geo_object_id = pl.geo_object_id
    where pl.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(placeIds)}::jsonb))
      and p.created_at > (select coalesce(r.finished_at, r.created_at) from runs r where r.id = ${runId}::uuid)
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * „Aktivieren“ (a deliberate click): compares again and refuses unless the comparison passes (`RegressionGateClosed`
 * with the reasons); else one `config_activations` row per part of the candidate: `consolidation_rules` with the
 * rules version (from now on the active rules, `activeRulesVersion`) and/or `extraction` with `<model>@p<prompt>` (the
 * approval; effective once `config/models.json` is deployed with it). `comparison` holds the old/new numbers and
 * counts only. Under a lock per run, and a part already activated from this run is not written again (double click).
 * A rules part equal to the active version is never written (ruling M7-E-R2): the row would pin today's rules over a
 * later `active.json` without anyone having chosen them.
 */
export async function activateCandidate(db: Db, input: { evaluationRunId: string; activatedBy: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`activation:${input.evaluationRunId}`}))`);
    const c = await compareEvaluation(tx, input.evaluationRunId);
    if (!c.passes) throw new RegressionGateClosed(c.reasons);
    const comparison = { old: c.old, next: c.next, changed: c.changed.length, pending: c.pending };
    const active = await activeRulesVersion(tx);
    const parts: Array<{ kind: "consolidation_rules" | "extraction"; version: string }> = [
      ...(c.candidate.rulesVersion !== undefined && c.candidate.rulesVersion !== active ? [{ kind: "consolidation_rules" as const, version: c.candidate.rulesVersion }] : []),
      ...(c.candidate.extraction ? [{ kind: "extraction" as const, version: extractionVersion(c.candidate.extraction) }] : []),
    ];
    for (const part of parts) {
      const [done] = await tx
        .select({ id: configActivations.id })
        .from(configActivations)
        .where(and(eq(configActivations.evaluationRunId, input.evaluationRunId), eq(configActivations.kind, part.kind)))
        .limit(1);
      if (done) continue;
      await tx.insert(configActivations).values({
        ...part,
        evaluationRunId: input.evaluationRunId,
        comparison,
        activatedBy: input.activatedBy,
        // the statement's clock: two activations in one transaction keep their order
        activatedAt: sql`clock_timestamp()`,
      });
    }
  });
}

export type EvaluationRunView = {
  runId: string;
  status: RunStatus;
  createdAt: Date;
  candidate: EvaluationCandidate;
  /** Kinds already activated from this run. */
  activated: Array<"consolidation_rules" | "extraction">;
};

/** The newest `limit` evaluation runs over the subdivision's comparison set, newest first. */
export async function listEvaluations(db: Db, subdivisionKey: string, limit = 5): Promise<EvaluationRunView[]> {
  const rows = await db
    .select({ id: runs.id, status: runs.status, createdAt: runs.createdAt })
    .from(runs)
    .where(and(sql`${runs.params} @> '{"evaluation": true}'::jsonb`, sql`${runs.params} ->> 'comparisonSetSubdivision' = ${subdivisionKey}`))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit);
  const views: EvaluationRunView[] = [];
  for (const r of rows) {
    const { candidate } = await evaluationRun(db, r.id);
    const activated = await db
      .selectDistinct({ kind: configActivations.kind })
      .from(configActivations)
      .where(eq(configActivations.evaluationRunId, r.id));
    views.push({ runId: r.id, status: r.status, createdAt: r.createdAt, candidate, activated: activated.map((a) => a.kind).sort() });
  }
  return views;
}

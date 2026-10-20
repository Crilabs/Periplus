import { eq } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { comparisonSet, qualitySnapshots, type ComparisonMethod } from "@/lib/db/schema";
import { areaGeoObjectId } from "@/lib/pipeline/tile-scope";
import { latestComparisonResults, lockComparisonPlace, recordComparisonResults } from "./comparison-results";
import { COMPARISON_ATTRIBUTES, loadComparisonSubjects } from "./comparison-values";
import { coverageOfMatches } from "./navily-assistant";
import { areaTilePredicate, confirmedAreaPlaces, proposalsFor } from "./navily-compare";
import type { NavilySpot } from "./navily-sample";
import { latestMeasurement } from "./snapshot";

/*
 * The CLI pass of the Navily comparison (`npm run compare:navily`, spec 10): matches the comparison set as the page
 * `/quality/compare` does (`proposalsFor`, over the set and all confirmed places of the area) and, on request, records
 * every proposal as a machine outcome (`proposal_auto`, checked by the assistant's version; ruling M7-P24). Every
 * deviation still opens a review task (Grundprinzip 10). Grundprinzip 9: the spots live in memory only; what is
 * written is the outcome per attribute and the own value hash, what is returned are counts.
 */

export type NavilyRunResult = {
  /** Places of the comparison set. */
  places: number;
  /** Set places a Navily spot was matched to. */
  matched: number;
  written: number;
  /** Review tasks newly opened. */
  tasks: number;
  /**
   * Attributes whose newest outcome for the current value a person set (`manual`, or a proposal confirmed by a click)
   * and that differs from the proposal (kept).
   */
  skippedManual: number;
  /** Spots inside the area matched to a confirmed place of the area. */
  coverage: { spots: number; matched: number; ratio: number | null };
  /** With `writeCoverage`: the measurement run the `coverage_navily` row belongs to; else null. */
  snapshotRunId: string | null;
  /** With `writeCoverage`: whether the row was written now (false: the measurement had one already). */
  coverageWritten: boolean;
};

/** Outcomes a person gave: a machine proposal never supersedes them (bundle C review: `proposal_confirmed` like `manual`). */
const PERSON_METHODS: ReadonlySet<ComparisonMethod> = new Set(["manual", "proposal_confirmed"]);

/** The place ids of the area's comparison set, sorted (the lock order). */
async function comparisonSetPlaceIds(db: Db, areaKey: string): Promise<string[]> {
  const areaId = await areaGeoObjectId(db, areaKey);
  if (!areaId) return [];
  const rows = await db.select({ id: comparisonSet.placeId }).from(comparisonSet).where(eq(comparisonSet.areaId, areaId));
  return rows.map((r) => r.id).sort();
}

/**
 * Compares the area's comparison set with the spots. Without `acceptProposals` nothing is written; with it, all set
 * places are locked and loaded in one transaction and each gets its proposals recorded with method `proposal_auto` and
 * `checkedBy = quality.navily.proposalVersion` („navily-assistant/1“, machine-recognisable). An outcome a person set
 * (by hand or by confirming a proposal) that differs from the proposal is kept (`skippedManual`), and review outcomes
 * are kept by `recordComparisonResults` (ruling M7-P16), so a rerun writes nothing new. The coverage is always computed
 * and counts only matches to the area's confirmed, valid places.
 *
 * With `writeCoverage` the coverage is stored as the row `coverage_navily` (value = ratio, details `{ spots, matched }`,
 * counts only: Grundprinzip 9, ruling M7-P23) of the area's newest measurement (`latestMeasurement`); without one it
 * fails before writing anything („Erst messen (/quality)“); a measurement that has the row already keeps it. The row
 * is written in the same transaction as the proposals, so either both are stored or neither (ruling M7-D-R2).
 */
export async function runNavilyComparison(
  db: Db,
  input: { areaKey: string; spots: NavilySpot[]; acceptProposals: boolean; writeCoverage?: boolean; now?: Date },
): Promise<NavilyRunResult> {
  const cfg = getConfig().quality.navily;
  const settings = { cfg, affixes: getConfig().nameAffixes };

  const measurement = input.writeCoverage ? await latestMeasurement(db, input.areaKey) : null;
  if (input.writeCoverage && !measurement) throw new Error(`Erst messen (/quality): Revier ${input.areaKey} hat noch keine Messung`);

  const pass = async (tx: Db, write: boolean): Promise<NavilyRunResult> => {
    // the set's places are locked before their subjects are loaded, so no profile changes in between (bundle C review)
    if (write) for (const id of await comparisonSetPlaceIds(tx, input.areaKey)) await lockComparisonPlace(tx, id);
    const subjects = await loadComparisonSubjects(tx, input.areaKey);
    const areaPlaces = await confirmedAreaPlaces(tx, input.areaKey);
    const { proposals, places, matches } = proposalsFor(subjects, areaPlaces, input.spots, settings);
    const inArea = await areaTilePredicate(tx, input.areaKey);
    const c = coverageOfMatches(places, matches, input.spots, inArea, new Set(areaPlaces.map((p) => p.placeId)));
    const result: NavilyRunResult = {
      places: subjects.length,
      matched: subjects.filter((s) => proposals.get(s.placeId)!.match.spotIndex !== null).length,
      written: 0,
      tasks: 0,
      skippedManual: 0,
      coverage: { spots: c.spots, matched: c.matched, ratio: c.ratio },
      snapshotRunId: null,
      coverageWritten: false,
    };
    if (!write) return result;

    const latest = await latestComparisonResults(tx, subjects.map((s) => s.placeId));
    for (const subject of subjects) {
      const p = proposals.get(subject.placeId)!;
      const entries = COMPARISON_ATTRIBUTES.flatMap((attribute) => {
        const valueHash = p.values[attribute].hash;
        const proposed = p.proposals[attribute];
        const previous = latest.get(`${subject.placeId}|${attribute}|${valueHash}`);
        if (previous && PERSON_METHODS.has(previous.method) && previous.result !== proposed) {
          result.skippedManual++;
          return [];
        }
        return [{ attribute, result: proposed, valueHash, profileVersion: subject.profileVersion }];
      });
      const out = await recordComparisonResults(tx, {
        subject,
        entries,
        method: "proposal_auto",
        checkedBy: cfg.proposalVersion,
        cfg,
        now: input.now,
      });
      result.written += out.written;
      result.tasks += out.tasks;
    }
    return result;
  };

  if (!input.acceptProposals && !measurement) return pass(db, false);
  return db.transaction(async (tx) => {
    const result = await pass(tx, input.acceptProposals);
    if (!measurement) return result;
    const written = await tx
      .insert(qualitySnapshots)
      .values({
        runId: measurement.runId,
        scopeType: "area",
        scopeId: input.areaKey,
        metric: "coverage_navily",
        value: result.coverage.ratio,
        details: { spots: result.coverage.spots, matched: result.coverage.matched },
      })
      .onConflictDoNothing()
      .returning({ id: qualitySnapshots.id });
    return { ...result, snapshotRunId: measurement.runId, coverageWritten: written.length > 0 };
  });
}

/**
 * The line saying that no comparison results were written (no `--accept-proposals`), for the report and the CLI: a
 * report only when nothing was stored, else only the results were not written (a `coverage_navily` row was).
 */
export function notWrittenNote(r: NavilyRunResult): string {
  return r.snapshotRunId ? "Vergleichsergebnisse nicht geschrieben – dafür --accept-proposals" : "Nur Bericht – Ergebnisse mit --accept-proposals schreiben";
}

const percent = (ratio: number | null) =>
  ratio === null ? "–" : `${(ratio * 100).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

/** The report section of a run (German, counts only): matching, coverage and what was written, or that nothing was. */
export function renderNavilyRunSection(r: NavilyRunResult, acceptProposals: boolean): string {
  const lines = [
    "## Vergleichsergebnisse (Navily-Assistent)",
    "",
    `Orte im Vergleichssatz: ${r.places}, davon einem Navily-Ort zugeordnet: ${r.matched}`,
    "",
    `Navily-Abdeckung: ${r.coverage.matched} von ${r.coverage.spots} Navily-Orten im Revier (${percent(r.coverage.ratio)})`,
    "",
  ];
  if (r.snapshotRunId) {
    lines.push(
      r.coverageWritten
        ? "Navily-Abdeckung zur jüngsten Messung gespeichert (coverage_navily)."
        : "Die jüngste Messung hat die Navily-Abdeckung schon, nichts geändert.",
      "",
    );
  }
  if (acceptProposals) {
    lines.push(`Ergebnisse geschrieben: ${r.written}, Review-Aufgaben: ${r.tasks}`, "");
    if (r.skippedManual > 0) lines.push(`Von Hand gesetzte Ergebnisse behalten: ${r.skippedManual}`, "");
    lines.push("Maschinell übernommene Ergebnisse tragen die Methode „proposal_auto“; jede Abweichung geht ins Review.", "");
  } else {
    lines.push(notWrittenNote(r), "");
  }
  return lines.join("\n");
}

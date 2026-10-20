import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { latestComparisonResults, lockComparisonPlace, recordComparisonResults } from "./comparison-results";
import { COMPARISON_ATTRIBUTES, loadComparisonSubjects } from "./comparison-values";
import { coverageOfMatches } from "./navily-assistant";
import { areaTilePredicate, confirmedAreaPlaces, proposalsFor } from "./navily-compare";
import type { NavilySpot } from "./navily-sample";

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
  /** Attributes whose newest outcome for the current value was set by hand and differs from the proposal (kept). */
  skippedManual: number;
  /** Spots inside the area matched to a confirmed place of the area. */
  coverage: { spots: number; matched: number; ratio: number | null };
};

/**
 * Compares the area's comparison set with the spots. Without `acceptProposals` nothing is written; with it, all set
 * places are locked and loaded in one transaction and each gets its proposals recorded with method `proposal_auto` and
 * `checkedBy = quality.navily.proposalVersion` („navily-assistant/1“, machine-recognisable). As on the page, an outcome
 * set by hand that differs from the proposal is kept (`skippedManual`), and review outcomes are kept by
 * `recordComparisonResults` (ruling M7-P16), so a rerun writes nothing new. The coverage is always computed.
 */
export async function runNavilyComparison(
  db: Db,
  input: { areaKey: string; spots: NavilySpot[]; acceptProposals: boolean; now?: Date },
): Promise<NavilyRunResult> {
  const cfg = getConfig().quality.navily;
  const settings = { cfg, affixes: getConfig().nameAffixes };

  const pass = async (tx: Db, write: boolean): Promise<NavilyRunResult> => {
    const subjects = await loadComparisonSubjects(tx, input.areaKey);
    if (write) for (const id of subjects.map((s) => s.placeId).sort()) await lockComparisonPlace(tx, id);
    const areaPlaces = await confirmedAreaPlaces(tx, input.areaKey);
    const { proposals, places, matches } = proposalsFor(subjects, areaPlaces, input.spots, settings);
    const c = coverageOfMatches(places, matches, input.spots, await areaTilePredicate(tx, input.areaKey));
    const result: NavilyRunResult = {
      places: subjects.length,
      matched: subjects.filter((s) => proposals.get(s.placeId)!.match.spotIndex !== null).length,
      written: 0,
      tasks: 0,
      skippedManual: 0,
      coverage: { spots: c.spots, matched: c.matched, ratio: c.ratio },
    };
    if (!write) return result;

    const latest = await latestComparisonResults(tx, subjects.map((s) => s.placeId));
    for (const subject of subjects) {
      const p = proposals.get(subject.placeId)!;
      const entries = COMPARISON_ATTRIBUTES.flatMap((attribute) => {
        const valueHash = p.values[attribute].hash;
        const proposed = p.proposals[attribute];
        const previous = latest.get(`${subject.placeId}|${attribute}|${valueHash}`);
        if (previous?.method === "manual" && previous.result !== proposed) {
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

  return input.acceptProposals ? db.transaction((tx) => pass(tx, true)) : pass(db, false);
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
  if (acceptProposals) {
    lines.push(`Ergebnisse geschrieben: ${r.written}, Review-Aufgaben: ${r.tasks}`, "");
    if (r.skippedManual > 0) lines.push(`Von Hand gesetzte Ergebnisse behalten: ${r.skippedManual}`, "");
    lines.push("Maschinell übernommene Ergebnisse tragen die Methode „proposal_auto“; jede Abweichung geht ins Review.", "");
  } else {
    lines.push("Nur Bericht – Ergebnisse mit --accept-proposals schreiben", "");
  }
  return lines.join("\n");
}

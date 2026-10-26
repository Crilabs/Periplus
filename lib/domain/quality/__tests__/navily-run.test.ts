import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonResults, comparisonSet, places, reviewTasks, tiles } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { insertBerthState } from "@/test/berth-state";
import { withRollback } from "@/test/db";
import { NAVILY_MARKERS, rowsWrittenInTransaction } from "@/test/quality";
import { insertNamedObject, insertTestSubdivision } from "@/test/text";
import { comparisonValues, loadComparisonSubjects } from "../comparison-values";
import { recordManualComparison } from "../navily-compare";
import { loadNavilySpots } from "../navily-sample";
import { notWrittenNote, renderNavilyRunSection, runNavilyComparison } from "../navily-run";

// Synthetic subdivision around the fixture spots, shifted by DLON to 41.0–41.1° E / 35.2–35.3° N (outside the pilot box), rolled back.

const FIXTURE = path.join(process.cwd(), "test/fixtures/navily/sample.json");
/**
 * This file's whole-tile longitude shift: the fixture spots (21.0–21.1° E) and the scene move to 41° E, so no other
 * test file inserts the same tile row and waits on it until rollback (final review A M-1).
 */
const DLON = 20;
const loadSpots = async () => (await loadNavilySpots(FIXTURE)).map((s) => ({ ...s, lon: s.lon + DLON }));
const NOW = new Date("2026-10-20T08:00:00Z");
/** The (shifted) fixture spots' lat and lon, decimal point or comma, no digit around them: no stored row may carry one. */
const spotCoordinates = (spots: Array<{ lat: number; lon: number }>) =>
  new RegExp(spots.flatMap((s) => [s.lat, s.lon]).map((v) => `(?<![\\d.,])${String(Number(v.toFixed(6))).replace(".", "[.,]")}(?!\\d)`).join("|"));

/** Three set places: Kolona (spot 0 ≈ 43 m away), Poros harbour (spot 1 ≈ 60 m away), Agios (no spot nearby). */
async function scene(tx: Db) {
  const subdivisionKey = `XT-${newId()}`;
  const { id: subdivisionId } = await insertTestSubdivision(tx, subdivisionKey, [40.9, 35.0, 41.6, 35.7]);
  for (const [lon, lat] of [
    [41.0, 35.2],
    [41.05, 35.25],
  ]) {
    const id = tileIdFor(lon!, lat!);
    const [w, s, e, n] = tileBbox(id);
    await tx
      .insert(tiles)
      .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, subdivisionId, hasCoast: true })
      .onConflictDoUpdate({ target: tiles.id, set: { subdivisionId, hasCoast: true } });
  }
  const addPlace = async (name: string, lon: number, lat: number, kind: "anchorage" | "port" = "anchorage") => {
    const objectId = await insertNamedObject(tx, { type: kind === "port" ? "harbour" : "bay", names: [{ name }], lon, lat, subdivisionId });
    const [p] = await tx
      .insert(places)
      .values({
        geoObjectId: objectId,
        kind,
        status: "confirmed",
        tileId: tileIdFor(lon, lat),
        position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }),
      })
      .returning({ id: places.id });
    await tx.insert(comparisonSet).values({ placeId: p!.id, subdivisionId, addedBy: "test" });
    return { placeId: p!.id, objectId };
  };
  const kolona = await addPlace("Kolona", 41.0, 35.2);
  const poros = await addPlace("Poros", 41.0506, 35.2504, "port");
  const agios = await addPlace("Agios", 41.08, 35.22);
  await insertBerthState(tx, kolona.placeId, { "services.water": true, "shelter.N": 0.9 });
  const placeIds = [kolona.placeId, poros.placeId, agios.placeId];
  return { subdivisionKey, kolona, poros, agios, placeIds };
}

const resultRows = (tx: Db, placeIds: string[]) => tx.select().from(comparisonResults).where(inArray(comparisonResults.placeId, placeIds));

describe("runNavilyComparison", () => {
  it("without acceptProposals nothing is written, but matching and coverage are reported", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, placeIds } = await scene(tx);
      const spots = await loadSpots();
      const r = await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: false, now: NOW });
      // spot 2 (nameless, 41.1/35.3) lies in the subdivision but matches no place
      expect(r).toEqual({
        places: 3,
        matched: 2,
        written: 0,
        tasks: 0,
        skippedManual: 0,
        coverage: { spots: 3, matched: 2, ratio: 2 / 3 },
      });
      expect(await resultRows(tx, placeIds)).toEqual([]);
      expect(await rowsWrittenInTransaction(tx)).toEqual([]);
    }));

  it("with acceptProposals every set place gets 16 results by navily-assistant/1", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, kolona, agios, placeIds } = await scene(tx);
      const spots = await loadSpots();
      const r = await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: true, now: NOW });
      expect(r.written).toBe(48);
      const rows = await resultRows(tx, placeIds);
      expect(rows).toHaveLength(48);
      expect(new Set(rows.map((x) => `${x.method}|${x.checkedBy}`))).toEqual(new Set(["proposal_auto|navily-assistant/1"]));
      expect(rows.every((x) => x.checkedAt.getTime() === NOW.getTime())).toBe(true);
      // the results are the hashes of the current own values and the profile version compared
      const subjects = await loadComparisonSubjects(tx, subdivisionKey);
      const cfg = getConfig().quality.navily;
      for (const row of rows) {
        const subject = subjects.find((s) => s.placeId === row.placeId)!;
        expect(row.valueHash).toBe(comparisonValues(subject, cfg)[row.attribute].hash);
        expect(row.profileVersion).toBe(subject.profileVersion);
      }
      const of = (placeId: string, attribute: string) => rows.find((x) => x.placeId === placeId && x.attribute === attribute)?.result;
      expect([of(kolona.placeId, "existence"), of(kolona.placeId, "services.water"), of(kolona.placeId, "shelter.N")]).toEqual([
        "match",
        "match",
        "match",
      ]);
      expect([of(agios.placeId, "existence"), of(agios.placeId, "position")]).toEqual(["deviation", "not_at_navily"]);
      // every deviation goes to review (Grundprinzip 10)
      const deviations = rows.filter((x) => x.result === "deviation").length;
      expect(deviations).toBeGreaterThan(0);
      expect(r.tasks).toBe(deviations);
      const tasks = await tx.select().from(reviewTasks).where(eq(reviewTasks.kind, "comparison_deviation"));
      expect(tasks.filter((t) => placeIds.some((id) => t.subjectId.startsWith(`${id}:`)))).toHaveLength(deviations);
    }));

  it("a rerun writes nothing new", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, placeIds } = await scene(tx);
      const spots = await loadSpots();
      await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: true, now: NOW });
      const again = await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: true, now: new Date(NOW.getTime() + 60_000) });
      expect([again.written, again.tasks, again.skippedManual]).toEqual([0, 0, 0]);
      expect(await resultRows(tx, placeIds)).toHaveLength(48);
    }));

  it("an outcome set by hand that differs from the proposal is kept and counted", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, kolona, placeIds } = await scene(tx);
      const spots = await loadSpots();
      const subject = (await loadComparisonSubjects(tx, subdivisionKey)).find((s) => s.placeId === kolona.placeId)!;
      const cfg = getConfig().quality.navily;
      const valueHash = comparisonValues(subject, cfg).existence.hash;
      await recordManualComparison(tx, { placeId: kolona.placeId, subdivisionKey, attribute: "existence", result: "deviation", valueHash, checkedBy: "admin@test", cfg });

      const r = await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: true, now: NOW });
      expect([r.written, r.skippedManual]).toEqual([47, 1]);
      const existence = (await resultRows(tx, placeIds)).filter((x) => x.placeId === kolona.placeId && x.attribute === "existence");
      expect(existence.map((x) => [x.method, x.result])).toEqual([["manual", "deviation"]]);
    }));

  it("an outcome a person confirmed on the page is kept like one set by hand", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, kolona, placeIds } = await scene(tx);
      const spots = await loadSpots();
      const subject = (await loadComparisonSubjects(tx, subdivisionKey)).find((s) => s.placeId === kolona.placeId)!;
      const valueHash = comparisonValues(subject, getConfig().quality.navily).existence.hash;
      await tx.insert(comparisonResults).values({
        placeId: kolona.placeId,
        attribute: "existence",
        profileVersion: subject.profileVersion,
        valueHash,
        result: "deviation",
        method: "proposal_confirmed",
        checkedBy: "admin@test",
      });

      const r = await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: true, now: NOW });
      expect([r.written, r.skippedManual]).toEqual([47, 1]);
      const existence = (await resultRows(tx, placeIds)).filter((x) => x.placeId === kolona.placeId && x.attribute === "existence");
      expect(existence.map((x) => [x.method, x.result])).toEqual([["proposal_confirmed", "deviation"]]);
    }));

  it("the coverage counts only matches to the subdivision's confirmed, valid places", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, kolona } = await scene(tx);
      const spots = await loadSpots();
      // Kolona stays in the set with status confirmed, but has ended: it no longer covers its spot
      await tx.update(places).set({ validTo: sql`current_date` }).where(eq(places.id, kolona.placeId));
      const r = await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: false, now: NOW });
      expect(r.coverage).toEqual({ spots: 3, matched: 1, ratio: 1 / 3 });
    }));

  it("no navily name, id, url or coordinate appears in any written row", () =>
    withRollback(async (tx) => {
      const { subdivisionKey } = await scene(tx);
      const spots = await loadSpots();
      const SPOT_COORDINATES = spotCoordinates(spots);
      const r = await runNavilyComparison(tx, { subdivisionKey, spots, acceptProposals: true, now: NOW });
      expect(r.written).toBe(48);
      // comparison_results, review_tasks (context) and quality_snapshots (details) written by this transaction
      const rows = await rowsWrittenInTransaction(tx);
      expect(rows.length).toBeGreaterThanOrEqual(48);
      for (const row of rows) {
        expect(row).not.toMatch(NAVILY_MARKERS);
        expect(row).not.toMatch(SPOT_COORDINATES);
      }
      // the result holds counts only
      expect(JSON.stringify(r)).not.toMatch(NAVILY_MARKERS);
      expect(JSON.stringify(r)).not.toMatch(SPOT_COORDINATES);
    }));

  it("an unknown subdivision has no places and no coverage", () =>
    withRollback(async (tx) => {
      const spots = await loadSpots();
      expect(await runNavilyComparison(tx, { subdivisionKey: `test-${newId()}`, spots, acceptProposals: true, now: NOW })).toEqual({
        places: 0,
        matched: 0,
        written: 0,
        tasks: 0,
        skippedManual: 0,
        coverage: { spots: 0, matched: 0, ratio: null },
      });
    }));

});

describe("renderNavilyRunSection", () => {
  const result = {
    places: 3,
    matched: 2,
    written: 48,
    tasks: 5,
    skippedManual: 1,
    coverage: { spots: 3, matched: 2, ratio: 2 / 3 },
  };

  it("reports written results and review tasks when proposals were accepted", () => {
    const md = renderNavilyRunSection(result, true);
    expect(md).toContain("Ergebnisse geschrieben: 48, Review-Aufgaben: 5");
    expect(md).toContain("Navily-Abdeckung: 2 von 3 Navily-Orten im Revier (66,7 %)");
    expect(md).toContain("Von Hand gesetzte Ergebnisse behalten: 1");
    expect(md).not.toContain("Nur Bericht");
  });

  it("without --accept-proposals says that nothing was written", () => {
    expect(notWrittenNote()).toBe("Nur Bericht – Ergebnisse mit --accept-proposals schreiben");
    const md = renderNavilyRunSection({ ...result, written: 0, tasks: 0, skippedManual: 0, coverage: { spots: 0, matched: 0, ratio: null } }, false);
    expect(md).toContain("Nur Bericht – Ergebnisse mit --accept-proposals schreiben");
    expect(md).toContain("Navily-Abdeckung: 0 von 0 Navily-Orten im Revier (–)");
    expect(md).not.toContain("Ergebnisse geschrieben");
    expect(md).not.toContain("coverage_navily");
  });
});

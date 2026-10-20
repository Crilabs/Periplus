import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSimulationMode } from "@/lib/adapters/simulation";
import { draftScenario } from "@/lib/domain/revisit/draft";
import { applyEdit, editBase, parseScenario, preflightScenario } from "@/lib/domain/revisit/scenario";
import { verifyRevisit } from "@/lib/domain/revisit/verify";
import { parseArgs, renderDraftSummary } from "@/scripts/sim/draft-scenario";
import { withRollback } from "@/test/db";
import { documentUrl, REVISIT_AREA_KEY, seedRevisitArea } from "@/test/revisit/fixture/area";
import { recordedState, revisit } from "@/test/revisit/fixture/run";
import { memoryArchive } from "@/test/s3";

/*
 * The scenario draft (plan Task 15, ruling M7-P26) on the revisit fixture area of Task 14 after „Lauf 1“, inside
 * withRollback: what the draft proposes, its gaps, the preflight, and — the point of P26 — that the drafted
 * expectations hold when the pipeline runs the drafted scenario. Few tests run „Lauf 1“: each holds the batch budget
 * lock until its rollback, which other test files wait for.
 */

const TIMEOUT = 120_000;

beforeEach(() => setSimulationMode(undefined));
afterEach(() => setSimulationMode(undefined));

describe("draftScenario on the fixture area", () => {
  it(
    "the draft quotes sentences that occur once in the current version",
    () =>
      withRollback(async (tx) => {
        const { archive, fx } = await recordedState(tx);
        const { scenario, gaps } = await draftScenario(tx, archive, { areaKey: REVISIT_AREA_KEY, seed: 1 });
        const searched = scenario.entries.flatMap((e) =>
          e.edit.op === "replace" ? [{ url: e.url, text: e.edit.from }] : e.edit.op === "delete" ? [{ url: e.url, text: e.edit.text }] : [],
        );
        expect(searched.length).toBe(3);
        for (const { url, text } of searched) {
          const doc = Object.values(fx.documents).find((d) => d.url === url)!;
          const base = (await editBase(tx, archive, doc.id))!;
          expect(base.markdown.split(text).length - 1, text).toBe(1);
          expect(() => applyEdit(base.markdown, { op: "delete", text }, url)).not.toThrow();
          expect(text).toMatch(/[.!?]$/);
        }
        // the fixture's documents, one entry each, with the M5 expectations (the fixture scenario of Task 14)
        const byUrl = new Map(scenario.entries.map((e) => [e.url, e]));
        expect(byUrl.get(documentUrl("d1"))).toMatchObject({
          edit: { op: "replace", from: "Die Taverne Nikos ist im Sommer geöffnet.", to: "Die Taverne Nikos hat geschlossen." },
          expect: { document: "new_version", events: [{ subject: fx.publicIds.A, attribute: "highlight.food", type: "changed", severity: "notable" }] },
        });
        expect(byUrl.get(documentUrl("d2"))).toMatchObject({
          edit: { op: "replace", from: "Ankertiefe 4 m über Sand.", to: "Ankertiefe 2 m über Sand." },
          expect: { document: "new_version", events: [{ subject: fx.publicIds.B, attribute: "depth.*", type: "changed", severity: "safety" }] },
        });
        expect(byUrl.get(documentUrl("d3"))).toMatchObject({ edit: { op: "gone" }, expect: { document: "gone", events: [] } });
        expect(byUrl.get(documentUrl("d4"))).toMatchObject({
          edit: { op: "append", text: "Anchoring is prohibited in Limenaki." },
          expect: { document: "new_version", events: [{ subject: fx.publicIds.M, attribute: "prohibitions", type: "changed", severity: "safety" }] },
        });
        expect(byUrl.get(documentUrl("d5"))).toMatchObject({
          edit: { op: "replace", from: "Bojen sind ausgelegt.", to: "Die Bojen wurden entfernt." },
          expect: { document: "new_version", events: [{ subject: fx.publicIds.B, attribute: "mooring.buoys", type: "uncertain", severity: "notable" }] },
        });
        expect(scenario.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
        for (const e of scenario.entries) expect(e.note).toMatch(/M5|no event/);
        // five documents: one taverna (no second source), one strong depth, one gone, one ban, one forum — nothing to touch
        expect(gaps).toEqual([
          "Taverne verneint: 1 von 2 gefunden – keine (weitere) Taverne als einziger Beleg einer Quelle mit Gewicht über change.strongWeight",
          "Taverne-Satz gestrichen: 0 von 1 gefunden – keine (weitere) Taverne, die eine zweite Quelle mit demselben Wert nennt",
          "Tiefe geändert: 1 von 2 gefunden – keine (weitere) Tiefe einer starken Quelle an einem Ort mit schwachem Raster",
          "Seite weg (404): 1 von 2 gefunden – kein (weiteres) Dokument, dessen Facts andere Quellen oder Berechnungen mit demselben Wert stützen",
          "unverändert abgerufen: 0 von 1 gefunden – kein Dokument mehr übrig",
        ]);
      }),
    TIMEOUT,
  );

  it("a missing category is reported as gap", () =>
    withRollback(async (tx) => {
      // the recorded pages without „Lauf 1“: no fact, so no category finds a document (and no model batch runs)
      const archive = memoryArchive();
      await seedRevisitArea(tx, archive);
      const { scenario, gaps } = await draftScenario(tx, archive, { areaKey: REVISIT_AREA_KEY, seed: 1 });
      expect(scenario.entries).toEqual([]);
      expect(gaps.map((g) => g.split(" – ")[0])).toEqual([
        "Taverne verneint: 0 von 2 gefunden",
        "Taverne-Satz gestrichen: 0 von 1 gefunden",
        "Tiefe geändert: 0 von 2 gefunden",
        "Seite weg (404): 0 von 2 gefunden",
        "Verbot angehängt: 0 von 1 gefunden",
        "Bojen widersprochen: 0 von 1 gefunden",
        "unverändert abgerufen: 0 von 1 gefunden",
      ]);
      await expect(draftScenario(tx, archive, { areaKey: "no-such-area", seed: 1 })).rejects.toThrow(/Revier no-such-area ist unbekannt/);
    }));

  it(
    "the draft passes preflightScenario, and its expectations hold when the pipeline runs it (ruling M7-P26)",
    () =>
      withRollback(async (tx) => {
        const { archive, fx, fromSeq } = await recordedState(tx);
        const draft = await draftScenario(tx, archive, { areaKey: REVISIT_AREA_KEY, seed: 7 });
        // the written file is a valid scenario, and every entry would be fetched and edited by the revisit
        const scenario = parseScenario(JSON.stringify(draft.scenario), "draft.json");
        const results = await preflightScenario(tx, archive, scenario);
        expect(results.length).toBe(5);
        expect(results.filter((r) => !r.ok)).toEqual([]);
        // the same seed gives the same draft
        expect((await draftScenario(tx, archive, { areaKey: REVISIT_AREA_KEY, seed: 7 })).scenario).toEqual(draft.scenario);

        setSimulationMode(true);
        for (const day of ["2026-06-01", "2026-06-08"]) await revisit(tx, archive, day, scenario);
        setSimulationMode(undefined);
        const v = await verifyRevisit(tx, scenario, { fromSeq, areaKey: fx.areaKey });
        expect(v.unexpected).toEqual([]);
        expect(v.entries.filter((e) => !e.ok)).toEqual([]);
        expect(v.passes).toBe(true);
      }),
    TIMEOUT,
  );

  it(
    "a taverna two sources state is deleted in one, the other is only fetched again, and the expectations hold",
    () =>
      withRollback(async (tx) => {
        // a trip report (S3) states the taverna of Alonaki like the pilot guide d1: no taverna is the only input any more
        const { archive, fx, extras, fromSeq } = await recordedState(tx, [
          { source: "S3", path: "/2026/alonaki-abend", markdown: "# Abend\n\nAbends in Alonaki auf Revisonisi. Die Taverne Nikos ist im Sommer geöffnet.\n", language: "de" },
        ]);
        const pages = [fx.documents.d1.url, extras[0]!.url];
        const { scenario, gaps } = await draftScenario(tx, archive, { areaKey: REVISIT_AREA_KEY, seed: 3 });
        const deleted = scenario.entries.find((e) => e.edit.op === "delete")!;
        expect(deleted).toMatchObject({ edit: { text: "Die Taverne Nikos ist im Sommer geöffnet." }, expect: { document: "new_version", events: [] } });
        expect(pages).toContain(deleted.url);
        // the other page carries the value: neither negated, dropped nor edited, only fetched again
        const other = pages.find((u) => u !== deleted.url)!;
        expect(scenario.entries.filter((e) => e.url === other).map((e) => e.edit.op)).toEqual(["touch"]);
        expect(gaps[0]).toMatch(/^Taverne verneint: 0 von 2/);
        expect(scenario.entries.map((e) => e.edit.op)).toEqual(["delete", "replace", "gone", "append", "replace", "touch"]);

        setSimulationMode(true);
        for (const day of ["2026-06-01", "2026-06-08"]) await revisit(tx, archive, day, scenario);
        setSimulationMode(undefined);
        const v = await verifyRevisit(tx, scenario, { fromSeq, areaKey: fx.areaKey });
        expect(v.unexpected).toEqual([]);
        expect(v.entries.filter((e) => !e.ok)).toEqual([]);
        expect(v.passes).toBe(true);
      }),
    TIMEOUT,
  );
});

describe("sim:draft-scenario CLI", () => {
  it("needs an area and a .json file under data/sim/; the seed defaults to 1", () => {
    expect(parseArgs(["--area", "saronic", "--out", "data/sim/scenario.json"], "/repo")).toEqual({ area: "saronic", out: "data/sim/scenario.json", seed: 1 });
    expect(parseArgs(["--area", "saronic", "--out", "data/sim/a/b.json", "--seed", "3"], "/repo")).toEqual({ area: "saronic", out: "data/sim/a/b.json", seed: 3 });
    expect(() => parseArgs(["--area", "saronic"], "/repo")).toThrow(/usage/);
    expect(() => parseArgs(["--area", "saronic", "--out", "test/revisit/scenario.json"], "/repo")).toThrow(/unter data\/sim\//);
    expect(() => parseArgs(["--area", "saronic", "--out", "data/sim/../x.json"], "/repo")).toThrow(/unter data\/sim\//);
    expect(() => parseArgs(["--area", "saronic", "--out", "data/sim/x.txt"], "/repo")).toThrow(/unter data\/sim\//);
    expect(() => parseArgs(["--area", "saronic", "--out", "data/sim/x.json", "--seed", "-1"], "/repo")).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--area", "b", "--out", "data/sim/x.json"], "/repo")).toThrow(/usage/);
  });

  it("the summary lists entries, gaps and the review reminder", () => {
    const text = renderDraftSummary(
      {
        scenario: {
          name: "entwurf-saronic-seed-1",
          entries: [
            {
              id: "e1",
              url: "https://a.test.invalid/x",
              edit: { op: "gone" },
              expect: { document: "gone", events: [] },
            },
          ],
        },
        gaps: ["Taverne-Satz gestrichen: 0 von 1 gefunden – …"],
      },
      "data/sim/s.json",
    );
    expect(text).toContain("e1 gone https://a.test.invalid/x → gone, keine Ereignisse");
    expect(text).toContain("Lücken:\n  - Taverne-Satz gestrichen");
    expect(text).toContain("von Hand prüfen");
  });
});

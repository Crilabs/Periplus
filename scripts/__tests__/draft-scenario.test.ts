import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSimulationMode } from "@/lib/adapters/simulation";
import { draftScenario } from "@/lib/domain/revisit/draft";
import { parseArgs, renderDraftSummary } from "@/scripts/sim/draft-scenario";
import { withRollback } from "@/test/db";
import { REVISIT_SUBDIVISION_KEY, seedRevisitArea } from "@/test/revisit/fixture/area";
import { memoryArchive } from "@/test/s3";

beforeEach(() => setSimulationMode(undefined));
afterEach(() => setSimulationMode(undefined));

describe("draftScenario on the fixture area", () => {

  it("a missing category is reported as gap", () =>
    withRollback(async (tx) => {
      // the recorded pages without „Lauf 1“: no fact, so no category finds a document (and no model batch runs)
      const archive = memoryArchive();
      await seedRevisitArea(tx, archive);
      const { scenario, gaps } = await draftScenario(tx, archive, { subdivisionKey: REVISIT_SUBDIVISION_KEY, seed: 1 });
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
      await expect(draftScenario(tx, archive, { subdivisionKey: "no-such-area", seed: 1 })).rejects.toThrow(/Unbekannter Landesteil no-such-area/);
      await expect(draftScenario(tx, archive, { subdivisionKey: "saronic", seed: 1 })).rejects.toThrow(/Revier-Schlüssel saronic ist kein Laufumfang mehr/);
    }));
});

describe("sim:draft-scenario CLI", () => {
  it("needs a subdivision and a .json file under data/sim/; the seed defaults to 1", () => {
    expect(parseArgs(["--subdivision", "GR-I", "--out", "data/sim/scenario.json"], "/repo")).toEqual({ subdivision: "GR-I", out: "data/sim/scenario.json", seed: 1 });
    expect(parseArgs(["--subdivision", "GR-I", "--out", "data/sim/a/b.json", "--seed", "3"], "/repo")).toEqual({ subdivision: "GR-I", out: "data/sim/a/b.json", seed: 3 });
    expect(() => parseArgs(["--subdivision", "GR-I"], "/repo")).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "GR-I", "--out", "test/revisit/scenario.json"], "/repo")).toThrow(/unter data\/sim\//);
    expect(() => parseArgs(["--subdivision", "GR-I", "--out", "data/sim/../x.json"], "/repo")).toThrow(/unter data\/sim\//);
    expect(() => parseArgs(["--subdivision", "GR-I", "--out", "data/sim/x.txt"], "/repo")).toThrow(/unter data\/sim\//);
    expect(() => parseArgs(["--subdivision", "GR-I", "--out", "data/sim/x.json", "--seed", "-1"], "/repo")).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a", "--subdivision", "b", "--out", "data/sim/x.json"], "/repo")).toThrow(/usage/);
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

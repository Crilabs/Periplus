import { describe, expect, it } from "vitest";
import { newId } from "@/lib/domain/ids";
import { parseSimVerifyReport } from "@/lib/domain/quality/reports";
import type { MeasurementView } from "@/lib/domain/quality/snapshot";
import { parseArgs as parseCostArgs, pilotDocPath } from "@/scripts/report-costs";
import { costReportLink, parseArgs as parsePilotArgs, tilesOf } from "@/scripts/report-pilot";
import type { SimVerifyReport } from "@/lib/domain/revisit/sim-verify";

// The report CLIs (plan Task 16): arguments, output paths, the tile size and the sim:verify file they read.

describe("report:costs and report:pilot arguments", () => {
  it("report:costs needs area and first run; second and revisit are optional", () => {
    expect(parseCostArgs(["--area", "saronic", "--first", "Lauf 1"])).toEqual({ area: "saronic", first: "Lauf 1" });
    expect(parseCostArgs(["--area", "saronic", "--first", "Lauf 1", "--second", "Lauf 2", "--revisit", "docs/pilot/r.json"])).toEqual({
      area: "saronic",
      first: "Lauf 1",
      second: "Lauf 2",
      revisit: "docs/pilot/r.json",
    });
    expect(() => parseCostArgs(["--area", "saronic"])).toThrow(/usage/);
    expect(() => parseCostArgs(["--area", "saronic", "--first", "a", "--first", "b"])).toThrow(/usage/);
    expect(() => parseCostArgs(["--area", "saronic", "--first", "a", "--out", "x.md"])).toThrow(/usage/);
  });

  it("report:pilot needs both runs; --consumer-ok goes with --data-version", () => {
    expect(parsePilotArgs(["--area", "saronic", "--first", "Lauf 1", "--second", "Lauf 2"])).toEqual({ area: "saronic", first: "Lauf 1", second: "Lauf 2" });
    expect(parsePilotArgs(["--area", "s", "--first", "a", "--second", "b", "--consumer-ok", "--data-version", "4", "--revisit", "r.json"])).toEqual({
      area: "s",
      first: "a",
      second: "b",
      revisit: "r.json",
      consumer: { dataVersion: 4 },
    });
    expect(parsePilotArgs(["--area", "s", "--first", "a", "--second", "b", "--cost-report", "docs/pilot/2026-06-01-kostenbericht.md"])).toEqual({
      area: "s",
      first: "a",
      second: "b",
      costReport: "docs/pilot/2026-06-01-kostenbericht.md",
    });
    expect(() => parsePilotArgs(["--area", "s", "--first", "a"])).toThrow(/usage/);
    expect(() => parsePilotArgs(["--area", "s", "--first", "a", "--second", "b", "--consumer-ok"])).toThrow(/usage/);
    expect(() => parsePilotArgs(["--area", "s", "--first", "a", "--second", "b", "--data-version", "4"])).toThrow(/usage/);
    expect(() => parsePilotArgs(["--area", "s", "--first", "a", "--second", "b", "--consumer-ok", "--data-version", "0"])).toThrow(/usage/);
  });

  it("the reports go to docs/pilot/ under the UTC date", () => {
    expect(pilotDocPath("kostenbericht", new Date("2026-06-01T23:30:00Z"))).toBe("docs/pilot/2026-06-01-kostenbericht.md");
    expect(pilotDocPath("pilotbericht", new Date("2026-06-02T00:10:00+02:00"))).toBe("docs/pilot/2026-06-01-pilotbericht.md");
  });
});

describe("costReportLink", () => {
  const today = "docs/pilot/2026-06-02-kostenbericht.md";
  const only = (...files: string[]) => async (f: string) => files.includes(f);

  it("links an existing --cost-report, else today's cost report only when it exists (M7-H-R1, M-6)", async () => {
    expect(await costReportLink("docs/pilot/2026-06-01-kostenbericht.md", today, only("docs/pilot/2026-06-01-kostenbericht.md"))).toBe("docs/pilot/2026-06-01-kostenbericht.md");
    expect(await costReportLink(undefined, today, only(today))).toBe(today);
    expect(await costReportLink(undefined, today, only())).toBeUndefined();
    await expect(costReportLink("docs/pilot/fehlt.md", today, only(today))).rejects.toThrow("Kostenbericht docs/pilot/fehlt.md nicht gefunden");
  });

  it("checks the real file system by default", async () => {
    expect(await costReportLink(undefined, "package.json")).toBe("package.json");
    expect(await costReportLink(undefined, `docs/pilot/${newId()}-kostenbericht.md`)).toBeUndefined();
  });
});

describe("tilesOf", () => {
  const view = (placesPerTile: MeasurementView["metrics"]["places_per_tile"]): MeasurementView => ({
    runId: newId(),
    label: "Lauf 2",
    from: new Date(),
    to: new Date(),
    createdAt: new Date(),
    metrics: placesPerTile ? { places_per_tile: placesPerTile } : {},
  });

  it("reads median, span and the tiles outside the target from places_per_tile", () => {
    expect(tilesOf(view({ value: 23, details: { median: 23, min: 4, max: 52, outsideTarget: ["q025:812:508"], tiles: [] } }))).toEqual({
      median: 23,
      min: 4,
      max: 52,
      outside: ["q025:812:508"],
    });
    expect(tilesOf(view({ value: null, details: { tiles: [] } }))).toBeNull();
    expect(tilesOf(view(undefined))).toBeNull();
  });
});

describe("parseSimVerifyReport", () => {
  const simReport: SimVerifyReport = {
    area: "saronic",
    scenario: "pilot",
    clonedAt: "2026-06-01T08:00:00.000Z",
    fromSeq: 42,
    verification: {
      fromSeq: 42,
      entries: [{ id: "e1", url: "https://a.test.invalid/", document: { expected: "new_version", actual: "new_version" }, events: { expected: 1, matched: 1 }, ok: true }],
      expected: 1,
      correct: 1,
      unexpected: [],
      passes: true,
    },
    asOf: { ok: false, asOf: "2026-05-31", spot: "sp_01JREV00000000000000000001", before: { dataVersion: 1 }, after: { dataVersion: 2 }, check: { ok: false, status: 200, dataVersion: 2, reason: "liefert die neue Version" } },
    costs: { totalEur: 1.48, byService: { anthropic: { calls: 3, eur: 1.4 } } },
    passes: false,
  };

  it("takes verification, asOf and costs from a sim:verify --out file", () => {
    const r = parseSimVerifyReport(JSON.stringify(simReport), "r.json");
    expect(r.verification).toEqual(simReport.verification);
    expect(r.asOf).toEqual({ ok: false, reason: "liefert die neue Version" });
    expect(r.costs).toEqual(simReport.costs);
    expect(parseSimVerifyReport(JSON.stringify({ ...simReport, asOf: null }), "r.json").asOf).toBeNull();
    expect(parseSimVerifyReport(JSON.stringify({ ...simReport, asOf: { ok: false, reason: "Kein Revisit-Lauf für das Revier" } }), "r.json").asOf).toEqual({
      ok: false,
      reason: "Kein Revisit-Lauf für das Revier",
    });
  });

  it("refuses a file that is no sim:verify output", () => {
    expect(() => parseSimVerifyReport("{", "r.json")).toThrow("r.json ist kein JSON");
    expect(() => parseSimVerifyReport(JSON.stringify({ verification: {} }), "r.json")).toThrow(/r\.json ist keine Ausgabe von sim:verify --out/);
  });
});

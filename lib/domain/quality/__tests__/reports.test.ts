import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { qualitySnapshots, type MetricKey } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { RevisitVerification } from "@/lib/domain/revisit/verify";
import { createRun } from "@/lib/domain/runs";
import { QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { withRollback } from "@/test/db";
import { NAVILY_MARKERS } from "@/test/quality";
import { costReport, extrapolate, renderCostReport, renderPilotReport, type CostReport } from "../reports";
import type { MeasurementView } from "../snapshot";

// The cost and pilot reports (plan Task 16) on synthetic measurements: snapshot rows inserted directly, rolled back.

const quality = getConfig().quality;
const baseArea = getConfig().areas[0]!;

type Metrics = Partial<Record<MetricKey, { value: number | null; details?: Record<string, unknown> }>>;

/** A measurement run of `areaKey` with these area rows, as the measurement stores them. */
async function measurement(tx: Db, areaKey: string, label: string, metrics: Metrics, window = { from: "2026-05-01T00:00:00.000Z", to: "2026-05-08T00:00:00.000Z" }) {
  const { id } = await createRun(tx, { kind: "stage", scope: { type: "area", id: areaKey }, stages: [QUALITY_MEASURE_STAGE], params: { areaKey, label, ...window }, triggeredBy: "test" });
  await tx.insert(qualitySnapshots).values(
    Object.entries(metrics).map(([metric, m]) => ({ runId: id, scopeType: "area" as const, scopeId: areaKey, metric: metric as MetricKey, value: m!.value, details: m!.details ?? {} })),
  );
  return id;
}

const costRow = (perPlace: number, places: number, extra: Record<string, unknown> = {}) => ({
  value: perPlace,
  details: {
    costEur: perPlace * places,
    directEur: perPlace * places * 0.75,
    sharedEur: perPlace * places * 0.25,
    places,
    byStage: { "fetch.url": perPlace * places * 0.25, "extraction.mention": perPlace * places * 0.75 },
    byService: { jina: perPlace * places * 0.25, anthropic: perPlace * places * 0.75 },
    oneOff: { eur: 13.5, byKind: { modelComparison: 13.5 } },
    ...extra,
  },
});

const view = (label: string, metrics: Metrics): MeasurementView => ({
  runId: newId(),
  label,
  from: new Date("2026-05-01T00:00:00Z"),
  to: new Date("2026-05-08T00:00:00Z"),
  createdAt: new Date("2026-05-08T00:00:00Z"),
  metrics: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, { value: m!.value, details: m!.details ?? {} }])),
});

const report: CostReport = {
  areaKey: "saronic",
  first: {
    label: "Lauf 1",
    window: { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-08T00:00:00Z") },
    costEur: 144,
    places: 120,
    perPlace: 1.2,
    byStage: { "fetch.url": 36, "extraction.mention": 108 },
    byService: { jina: 36, anthropic: 108 },
    oneOff: { eur: 13.5, byKind: { modelComparison: 13.5 } },
  },
  second: {
    label: "Lauf 2",
    window: { from: new Date("2026-05-15T00:00:00Z"), to: new Date("2026-05-16T00:00:00Z") },
    costEur: 36,
    places: 120,
    perPlace: 0.3,
    byStage: { "extraction.mention": 36 },
    byService: { anthropic: 36 },
    oneOff: { eur: 0, byKind: {} },
  },
  assumptions: { placesPerArea: 120, placesPerAreaSource: "pilot", areasMin: 60, areasMax: 100, cycleDays: 30, revisitsPerYear: 365 / 30, revisitIntervalDays: 14 },
  extrapolation: { initialMin: 8640, initialMax: 14400, yearlyMin: 26280, yearlyMax: 43800 },
  simulation: { totalEur: 1.48, byService: { anthropic: { calls: 3, eur: 1.4 }, voyage: { calls: 2, eur: 0.08 } } },
};

describe("extrapolate", () => {
  it("extrapolates 1.20 €/place, 120 places, 60–100 areas", () => {
    expect(extrapolate({ perPlaceFirst: 1.2, perPlaceRevisit: 0.3, placesPerArea: 120, areasMin: 60, areasMax: 100, revisitsPerYear: 12 })).toEqual({
      initialMin: 8640,
      initialMax: 14400,
      yearlyMin: 25920,
      yearlyMax: 43200,
    });
  });

  it("without a second run the yearly figures are null", () => {
    expect(extrapolate({ perPlaceFirst: 0.5, perPlaceRevisit: null, placesPerArea: 100, areasMin: 60, areasMax: 100, revisitsPerYear: 12 })).toEqual({
      initialMin: 3000,
      initialMax: 5000,
      yearlyMin: null,
      yearlyMax: null,
    });
  });
});

describe("renderCostReport", () => {
  it("the cost report names stages, assumptions and 60–100 areas", () => {
    const md = renderCostReport(report);
    for (const s of ["Kosten je Stufe", "Kosten je Dienst", "Kosten je Ort und Lauf", "Annahmen", "Hochrechnung Mittelmeer", "60–100", "8.640,00 €"]) expect(md).toContain(s);
    expect(md).toContain("| extraction.mention | 108,00 € | 36,00 € |");
    expect(md).toContain("| Lauf 1 | 2026-05-01 bis 2026-05-07 | 144,00 € | 120 | 1,20 € |");
    expect(md).toContain("- Ortszahl je Revier: 120 (bestätigte Orte des Pilotreviers)");
    expect(md).toContain("- Zyklus: 30 Tage, also 12,2 Revisits je Revier und Jahr");
    expect(md).toContain("Erstlauf (60–100 Reviere × 120 Orte): 8.640,00 € – 14.400,00 €");
    expect(md).toContain("26.280,00 € – 43.800,00 €");
    expect(md).toContain("Einmalkosten Pilot im Zeitraum von Lauf 1 (nicht in den Betriebskosten, Ruling M7-P15): 13,50 € (modelComparison 13,50 €)");
    expect(md).toContain("Simulierter Revisit (Datenbank periplus_sim, getrennt gezählt): 1,48 €");
    expect(md).toMatch(/smoke:ai/);
    expect(md).toMatch(/Kacheln ohne Revier zählen für niemanden/);
    // the revisit-interval assumption with its range (M7-H-R1, M-1): 14 days measured against a 30-day cycle
    expect(md).toContain("- Abstand der Läufe: 14 Tage (Beginn Lauf 1 bis Beginn Lauf 2); die Hochrechnung setzt die Revisit-Kosten je Ort von Lauf 2 unverändert für einen Abstand von 30 Tagen an.");
    expect(md).toContain("Obergrenze: Revisit-Kosten wachsen linear mit dem Abstand, also Faktor 2,1 (30 / 14)");
    expect(md).toContain("- Jahr, Revisit-Kosten linear auf 30 Tage Abstand hochgerechnet (Obergrenze, Faktor 2,1): 56.314,29 € – 93.857,14 €");
  });

  it("a revisit interval of at least the cycle states the assumption without an upper range", () => {
    const md = renderCostReport({ ...report, assumptions: { ...report.assumptions, revisitIntervalDays: 30 } });
    expect(md).toContain("- Abstand der Läufe: 30 Tage (Beginn Lauf 1 bis Beginn Lauf 2)");
    expect(md).not.toContain("Obergrenze");
  });

  it("a second run without cost per place says so in the yearly line", () => {
    const md = renderCostReport({ ...report, second: { ...report.second!, perPlace: null, places: 0 }, extrapolation: { ...report.extrapolation, yearlyMin: null, yearlyMax: null } });
    expect(md).toContain("Jahr (Revisits, 12,2 je Revier): – (Lauf 2 hat keine Kosten je Ort, keine bestätigten Orte)");
    expect(md).not.toContain("kein zweiter Lauf gemessen");
    expect(md).not.toContain("hochgerechnet (Obergrenze");
  });

  it("without a second run the yearly line says so", () => {
    const md = renderCostReport({ ...report, second: null, simulation: null, assumptions: { ...report.assumptions, revisitIntervalDays: null }, extrapolation: { ...report.extrapolation, yearlyMin: null, yearlyMax: null } });
    expect(md).toContain("Jahr (Revisits, 12,2 je Revier): – (kein zweiter Lauf gemessen)");
    expect(md).toContain("Simulierter Revisit: keine Angabe");
    expect(md).not.toContain("Lauf 2");
    expect(md).not.toContain("Abstand der Läufe");
  });
});

describe("costReport", () => {
  it("costReport takes places per area from the pilot when config is null", () =>
    withRollback(async (tx) => {
      const areaKey = `report-${newId()}`;
      const areas = [{ ...baseArea, key: areaKey, cycleDays: 30 }];
      await measurement(tx, areaKey, "Lauf 1", { cost_per_place: costRow(1.2, 110) });
      await measurement(tx, areaKey, "Lauf 2", { cost_per_place: costRow(0.3, 120) }, { from: "2026-05-15T00:00:00.000Z", to: "2026-05-16T00:00:00.000Z" });
      const r = await costReport(tx, { areaKey, firstLabel: "Lauf 1", secondLabel: "Lauf 2", areas, cfg: { ...quality, extrapolation: { areasMin: 60, areasMax: 100, placesPerArea: null } } });
      expect(r.assumptions).toEqual({ placesPerArea: 120, placesPerAreaSource: "pilot", areasMin: 60, areasMax: 100, cycleDays: 30, revisitsPerYear: 365 / 30, revisitIntervalDays: 14 });
      expect(r.first).toMatchObject({ label: "Lauf 1", costEur: 132, places: 110, perPlace: 1.2, byService: { jina: 33, anthropic: 99 }, oneOff: { eur: 13.5 } });
      expect(r.first.window.from.toISOString()).toBe("2026-05-01T00:00:00.000Z");
      expect(r.second).toMatchObject({ label: "Lauf 2", perPlace: 0.3, places: 120 });
      expect(r.extrapolation).toEqual(extrapolate({ perPlaceFirst: 1.2, perPlaceRevisit: 0.3, placesPerArea: 120, areasMin: 60, areasMax: 100, revisitsPerYear: 365 / 30 }));
      expect(r.simulation).toBeNull();

      // a configured place count wins; without a second run only the first counts
      const configured = await costReport(tx, { areaKey, firstLabel: "Lauf 1", areas, cfg: { ...quality, extrapolation: { areasMin: 60, areasMax: 100, placesPerArea: 150 } } });
      expect(configured.assumptions).toMatchObject({ placesPerArea: 150, placesPerAreaSource: "config" });
      expect(configured.second).toBeNull();
      expect(configured.assumptions.revisitIntervalDays).toBeNull();
      expect(configured.extrapolation).toEqual({ initialMin: 10800, initialMax: 18000, yearlyMin: null, yearlyMax: null });
      // and with only the first run, the pilot count is the first run's
      const pilotOnly = await costReport(tx, { areaKey, firstLabel: "Lauf 1", areas, cfg: { ...quality, extrapolation: { areasMin: 60, areasMax: 100, placesPerArea: null } } });
      expect(pilotOnly.assumptions.placesPerArea).toBe(110);
    }));

  it("refuses an unknown measurement, an unconfigured area and a run without cost per place", () =>
    withRollback(async (tx) => {
      const areaKey = `report-${newId()}`;
      const areas = [{ ...baseArea, key: areaKey }];
      await measurement(tx, areaKey, "leer", { cost_per_place: { value: null, details: { costEur: 0, places: 0 } } });
      await expect(costReport(tx, { areaKey, firstLabel: "Lauf 9", areas })).rejects.toThrow(`Keine Messung „Lauf 9“ für das Revier ${areaKey}`);
      await expect(costReport(tx, { areaKey: "nirgendwo", firstLabel: "leer", areas })).rejects.toThrow("Revier nirgendwo ist nicht konfiguriert");
      await expect(costReport(tx, { areaKey, firstLabel: "leer", areas })).rejects.toThrow("hat keine Kosten je Ort");
    }));
});

const verification = (correct: number, unexpected: number): RevisitVerification => ({
  fromSeq: 10,
  entries: Array.from({ length: 10 }, (_, i) => ({
    id: `e${i + 1}`,
    url: `https://pilot-${i}.test.invalid/`,
    document: { expected: "new_version", actual: "new_version" as const },
    events: { expected: 1, matched: i < correct ? 1 : 0 },
    ok: i < correct,
  })),
  expected: 10,
  correct,
  unexpected: Array.from({ length: unexpected }, (_, i) => ({ seq: 100 + i, subject: "sp_01JREV00000000000000000009", attribute: "depth.min", type: "changed" as const, severity: "safety" as const, oldValue: 5, newValue: 3 })),
  passes: correct === 10 && unexpected === 0,
});

describe("renderPilotReport", () => {
  const first = view("Lauf 1", {
    coverage: { value: 0.8 },
    coverage_navily: { value: 0.8 },
    multi_document: { value: 0.75 },
    cost_per_place: { value: 1.2 },
    review_minutes: { value: 140 },
  });
  const second = view("Lauf 2", {
    coverage: { value: 0.84 },
    coverage_navily: { value: 0.86 },
    multi_source: { value: 0.6 },
    multi_document: { value: 0.72 },
    fact_precision: { value: 0.88 },
    quote_fidelity: { value: 1, details: { facts: 50, verified: 50, runs: 2, evaluation: { facts: 10, verified: 9, runs: 1 } } },
    shelter_confidence: { value: 0.65 },
    route_reconstruction: { value: 0.75, details: { routes: 4, complete: 3, reports: [{ documentId: newId(), stops: 5, openStops: 0, complete: true }, { documentId: newId(), stops: 7, openStops: 0, complete: true }, { documentId: newId(), stops: 3, openStops: 1, complete: false }, { documentId: newId(), stops: 4, openStops: 0, complete: true }] } },
    cost_per_place: { value: 0.3 },
    review_minutes: { value: 45 },
    places_per_tile: { value: 23 },
  });
  const base = {
    areaKey: "saronic",
    first,
    second,
    targets: quality,
    revisit: verification(9, 1),
    asOf: { ok: true },
    consumer: { ok: true, dataVersion: 4 },
    tiles: { median: 23, min: 4, max: 52, outside: ["q025:812:508", "q025:813:509"] },
    costReportFile: "docs/pilot/2026-06-01-kostenbericht.md",
  };

  it("the pilot report ticks only met criteria", () => {
    const md = renderPilotReport(base);
    expect(md).toContain("- [x] Abdeckung (Navily-Vergleichssatz): 86 % (Pilotziel ≥ 85 %)");
    expect(md).toContain("- [x] Mehrbefund (≥ 2 Dokumente): 72 % (Pilotziel ≥ 70 %)");
    expect(md).toContain("- [ ] Fact-Präzision: 88 % (Pilotziel ≥ 90 %)");
    expect(md).toContain("- [x] Belegtreue: 100 % (Pilotziel ≥ 100 %)");
    expect(md).toContain("- [x] Kosten je Ort je Lauf: Lauf 1 1,20 €, Lauf 2 0,30 € (Pilotziel unter 2,00 € in jedem Lauf)");
    expect(md).toContain("- [ ] Simulierter Revisit liefert 10 von 10 Änderungen korrekt, keine falschen: 9 von 10 korrekt, 1 zusätzliche");
    expect(md).toContain("- [x] Ein Profil ist zum Stand „vor dem Revisit“ über die API abrufbar: ja");
    expect(md).toContain("- [x] Review-Aufwand für den zweiten Lauf unter 60 Minuten: 45 min");
    expect(md).toContain("- [x] Gemessene Kosten je Ort und Lauf dokumentiert, Hochrechnung für das Mittelmeer erstellt: Lauf 1 1,20 €, Lauf 2 0,30 €");
    expect(md).toContain("- [x] Die Törn-App liest Orte und Profile aus dem Export ohne eigene Nachbearbeitung: ja (Datenversion 4)");
    expect(md).toContain("- [x] Routen-Rekonstruktion an mindestens 3 Törnberichten: 4 Törnberichte mit Route, davon 3 vollständig (Stopps je Bericht: 5, 7, 3, 4)");
    expect(md).toContain("- [ ] Gazetteer der Pilot-Kacheln vollständig");
    // the metric table: both runs, both targets, the status of the newer run
    expect(md).toContain("| Abdeckung (Navily-Vergleichssatz) | 80 % | 86 % | ≥ 85 % | ≥ 95 % | erreicht | verfehlt |");
    expect(md).toContain("| Fact-Präzision | – | 88 % | ≥ 90 % | ≥ 95 % | verfehlt | verfehlt |");
    expect(md).toContain("| Review-Aufwand je 100 Orte | – | – | – | unter 30 min | ohne Ziel | kein Wert |");
    // revisit, tile size with the decision placeholder, reading, cost report
    expect(md).toContain("9 von 10 korrekt, 1 zusätzliche.");
    expect(md).toContain("- zusätzlich: sp_01JREV00000000000000000009 depth.min changed safety");
    expect(md).toContain("Orte je Küstenkachel: Median 23, Spanne 4–52 (Ziel 10–40); außerhalb: q025:812:508, q025:813:509.");
    expect(md).toContain("Entscheidung: …");
    expect(md).toContain("9 von 10 Belegen in 1 Lauf)");
    expect(md).toMatch(/Abrufdatum/);
    expect(md).toContain("`docs/pilot/2026-06-01-kostenbericht.md`");
    // counts only: the report never carries a Navily marker or value
    expect(md).not.toMatch(NAVILY_MARKERS);
  });

  it("a full revisit, missing checks and a missing second run tick accordingly", () => {
    const md = renderPilotReport({ ...base, second: null, revisit: verification(10, 0), asOf: { ok: false, reason: "Spot nicht geliefert" }, consumer: null, tiles: null });
    expect(md).toContain("- [x] Simulierter Revisit liefert 10 von 10 Änderungen korrekt, keine falschen: 10 von 10 korrekt, 0 zusätzliche");
    expect(md).toContain("- [ ] Ein Profil ist zum Stand „vor dem Revisit“ über die API abrufbar: nein (Spot nicht geliefert)");
    expect(md).toContain("- [ ] Review-Aufwand für den zweiten Lauf unter 60 Minuten: kein zweiter Lauf gemessen");
    expect(md).toContain("- [ ] Gemessene Kosten je Ort und Lauf dokumentiert, Hochrechnung für das Mittelmeer erstellt: Lauf 1 1,20 €, zweiter Lauf fehlt");
    expect(md).toContain("- [ ] Die Törn-App liest Orte und Profile aus dem Export ohne eigene Nachbearbeitung: nicht geprüft");
    expect(md).toContain("- [ ] Abdeckung (Navily-Vergleichssatz): 80 % (Pilotziel ≥ 85 %)");
    expect(md).toContain("Keine Kachelzahlen gemessen.");
    expect(md).toContain("Bewertet wird Lauf 1.");
    expect(md).toContain("- [x] Kosten je Ort je Lauf: Lauf 1 1,20 € (Pilotziel unter 2,00 € in jedem Lauf)");
  });

  it("the cost criterion is not ticked when Lauf 1 is over 2 € and Lauf 2 under (ruling M7-H-R1, I-1)", () => {
    const expensive = view("Lauf 1", { ...first.metrics, cost_per_place: { value: 3 } } as Metrics);
    const md = renderPilotReport({ ...base, first: expensive });
    expect(md).toContain("- [ ] Kosten je Ort je Lauf: Lauf 1 3,00 €, Lauf 2 0,30 € (Pilotziel unter 2,00 € in jedem Lauf)");
    // and the other way round, a missing value in one run also leaves it open
    const missing = renderPilotReport({ ...base, second: view("Lauf 2", { ...second.metrics, cost_per_place: { value: null } } as Metrics) });
    expect(missing).toContain("- [ ] Kosten je Ort je Lauf: Lauf 1 1,20 €, Lauf 2 – (Pilotziel unter 2,00 € in jedem Lauf)");
  });

  it("the evaluation runs use the German plural", () => {
    const two = view("Lauf 2", { ...second.metrics, quote_fidelity: { value: 1, details: { evaluation: { facts: 10, verified: 10, runs: 2 } } } } as Metrics);
    expect(renderPilotReport({ ...base, second: two })).toContain("10 von 10 Belegen in 2 Läufen)");
  });
});

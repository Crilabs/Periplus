import { z } from "zod";
import { getConfig } from "@/lib/config";
import type { AreaConfig, QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { changeSeverityEnum, changeTypeEnum, METRIC_KEYS, type MetricKey } from "@/lib/db/schema";
import type { RevisitVerification } from "@/lib/domain/revisit/verify";
import { METRIC_UNITS } from "./dashboard";
import type { MeasureWindow } from "./metrics";
import { measurementByLabel, metricStatus, type MeasurementView, type MetricStatus } from "./snapshot";

/*
 * The pilot's reports (spec 10, plan Task 16): the cost report („Kosten je Stufe, je Ort, Annahmen für Ortszahl je
 * Revier, Zahl der Reviere 60–100“) with the Mediterranean extrapolation, and the pilot report (the datendienst's
 * success criteria with the measured values). Both read the stored measurements (`quality_snapshots`) only and hold
 * counts, sums and own ids, never a Navily value (Grundprinzip 9). Amounts in EUR with two decimals, German number
 * format (ruling M7-P30). Pure renderers; the CLIs (`report:costs`, `report:pilot`) write them to `docs/pilot/`.
 */

/** One measured run of the cost report: the operating spend of its window (`cost_per_place` details, ruling M7-P15). */
export type CostRun = {
  label: string;
  window: MeasureWindow;
  costEur: number;
  places: number;
  perPlace: number | null;
  byStage: Record<string, number>;
  byService: Record<string, number>;
  /** One-off pilot spend of the window („Einmalkosten Pilot“): never part of the operating cost (ruling M7-P15). */
  oneOff: { eur: number; byKind: Record<string, number> };
};

export type Extrapolation = { initialMin: number; initialMax: number; yearlyMin: number | null; yearlyMax: number | null };

export type CostReport = {
  areaKey: string;
  first: CostRun;
  second: CostRun | null;
  assumptions: {
    placesPerArea: number;
    placesPerAreaSource: "pilot" | "config";
    areasMin: number;
    areasMax: number;
    cycleDays: number;
    revisitsPerYear: number;
    /** Days from the start of the first to the start of the second run; null without a second run. */
    revisitIntervalDays: number | null;
  };
  extrapolation: Extrapolation;
  /** Spend of the simulated revisit in `periplus_sim` (from `sim:verify --out`), reported apart (ruling M7-P15). */
  simulation: { totalEur: number; byService: Record<string, { calls: number; eur: number }> } | null;
};

const cents = (x: number) => Math.round(x * 100) / 100;

/**
 * The Mediterranean extrapolation: `initial = perPlaceFirst × placesPerArea × areas` (first run of every area);
 * `yearly = perPlaceRevisit × placesPerArea × areas × revisitsPerYear` (null without a second run). Rounded to cents.
 */
export function extrapolate(input: {
  perPlaceFirst: number;
  perPlaceRevisit: number | null;
  placesPerArea: number;
  areasMin: number;
  areasMax: number;
  revisitsPerYear: number;
}): Extrapolation {
  const initial = (areas: number) => cents(input.perPlaceFirst * input.placesPerArea * areas);
  const yearly = (areas: number) =>
    input.perPlaceRevisit === null ? null : cents(input.perPlaceRevisit * input.placesPerArea * areas * input.revisitsPerYear);
  return { initialMin: initial(input.areasMin), initialMax: initial(input.areasMax), yearlyMin: yearly(input.areasMin), yearlyMax: yearly(input.areasMax) };
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const record = (v: unknown): Record<string, number> =>
  typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, num(x)])) : {};

/** The cost run of a measurement from its `cost_per_place` area row. */
export function costRunOf(m: MeasurementView): CostRun {
  const row = m.metrics.cost_per_place;
  const d = row?.details ?? {};
  const oneOff = (d.oneOff ?? {}) as { eur?: unknown; byKind?: unknown };
  return {
    label: m.label,
    window: { from: m.from, to: m.to },
    costEur: num(d.costEur),
    places: num(d.places),
    perPlace: row?.value ?? null,
    byStage: record(d.byStage),
    byService: record(d.byService),
    oneOff: { eur: num(oneOff.eur), byKind: record(oneOff.byKind) },
  };
}

/** A measurement of the area by label; a missing one is refused in German (the CLI prints it). */
async function measurement(db: Db, areaKey: string, label: string): Promise<MeasurementView> {
  const m = await measurementByLabel(db, areaKey, label);
  if (!m) throw new Error(`Keine Messung „${label}“ für das Revier ${areaKey} – erst auf /quality messen`);
  return m;
}

/**
 * The cost report of the area from the stored measurements `firstLabel` and `secondLabel` (`cost_per_place` details).
 * Places per area: `extrapolation.placesPerArea` of `config/quality.json`, else the confirmed places of the pilot
 * area (the newer measurement's count). Revisits per year: `365 / cycleDays` of the area (`config/areas`). Refused when
 * the first run has no cost per place (no confirmed places).
 */
export async function costReport(
  db: Db,
  input: {
    areaKey: string;
    firstLabel: string;
    secondLabel?: string;
    simulation?: CostReport["simulation"];
    cfg?: QualityConfig;
    areas?: AreaConfig[];
  },
): Promise<CostReport> {
  const cfg = input.cfg ?? getConfig().quality;
  const area = (input.areas ?? getConfig().areas).find((a) => a.key === input.areaKey);
  if (!area) throw new Error(`Revier ${input.areaKey} ist nicht konfiguriert (config/areas)`);
  const first = costRunOf(await measurement(db, input.areaKey, input.firstLabel));
  const second = input.secondLabel === undefined ? null : costRunOf(await measurement(db, input.areaKey, input.secondLabel));
  if (first.perPlace === null) throw new Error(`Messung „${first.label}“ hat keine Kosten je Ort (keine bestätigten Orte)`);
  const configured = cfg.extrapolation.placesPerArea;
  const placesPerArea = configured ?? (second ?? first).places;
  const revisitsPerYear = 365 / area.cycleDays;
  const assumptions = {
    placesPerArea,
    placesPerAreaSource: configured === null ? ("pilot" as const) : ("config" as const),
    areasMin: cfg.extrapolation.areasMin,
    areasMax: cfg.extrapolation.areasMax,
    cycleDays: area.cycleDays,
    revisitsPerYear,
    revisitIntervalDays: second === null ? null : (second.window.from.getTime() - first.window.from.getTime()) / 86_400_000,
  };
  const extrapolation = extrapolate({
    perPlaceFirst: first.perPlace,
    perPlaceRevisit: second?.perPlace ?? null,
    placesPerArea,
    areasMin: assumptions.areasMin,
    areasMax: assumptions.areasMax,
    revisitsPerYear,
  });
  return { areaKey: input.areaKey, first, second, assumptions, extrapolation, simulation: input.simulation ?? null };
}

const decimal = (digits: number) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const EUR = decimal(2);
const ONE = decimal(1);
/** Up to one decimal, none for whole numbers (`14`, `7,5`). */
const UPTO_ONE = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

/** `8.640,00 €` (German format, two decimals, a plain space before the sign). */
export const eur = (x: number) => `${EUR.format(x)} €`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const windowText = (w: MeasureWindow) => `${day(w.from)} bis ${day(new Date(w.to.getTime() - 1))}`;

/** A table of amounts by key (stage, service) for one or two runs, keys sorted, a sum row. */
function amountTable(title: string, keyHeader: string, runs: CostRun[], pick: (r: CostRun) => Record<string, number>): string[] {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(pick(r))))].sort();
  const lines = [`## ${title}`, "", `| ${keyHeader} | ${runs.map((r) => r.label).join(" | ")} |`, `| --- | ${runs.map(() => "---:").join(" | ")} |`];
  for (const k of keys) lines.push(`| ${k === "" ? "(ohne Stufe)" : k} | ${runs.map((r) => eur(pick(r)[k] ?? 0)).join(" | ")} |`);
  lines.push(`| **Summe** | ${runs.map((r) => `**${eur(Object.values(pick(r)).reduce((a, b) => a + b, 0))}**`).join(" | ")} |`, "");
  return lines;
}

/**
 * The factor by which the yearly figure may be too low when the measured revisit came sooner than the cycle (M7-H-R1,
 * M-1): a shorter interval sees fewer changes. Upper bound = revisit cost growing linearly with the interval up to
 * `cycleDays`. 1 when the interval is unknown or not shorter than the cycle.
 */
export function revisitIntervalScale(a: CostReport["assumptions"]): number {
  const d = a.revisitIntervalDays;
  return d === null || d <= 0 || d >= a.cycleDays ? 1 : a.cycleDays / d;
}

/** The yearly range; without a value it says why (no second run, or a second run without cost per place). */
function yearlyRange(r: CostReport, scale = 1): string {
  const { yearlyMin: min, yearlyMax: max } = r.extrapolation;
  if (min === null || max === null) return r.second ? `– (${r.second.label} hat keine Kosten je Ort, keine bestätigten Orte)` : "– (kein zweiter Lauf gemessen)";
  return `${eur(cents(min * scale))} – ${eur(cents(max * scale))}`;
}

/** The revisit-interval assumption of the yearly extrapolation (M7-H-R1, M-1); empty without a second run. */
function intervalAssumption(r: CostReport): string[] {
  const a = r.assumptions;
  if (r.second === null || a.revisitIntervalDays === null) return [];
  const days = UPTO_ONE.format(a.revisitIntervalDays);
  const base = `- Abstand der Läufe: ${days} Tage (Beginn ${r.first.label} bis Beginn ${r.second.label}); die Hochrechnung setzt die Revisit-Kosten je Ort von ${r.second.label} unverändert für einen Abstand von ${a.cycleDays} Tagen an.`;
  const scale = revisitIntervalScale(a);
  if (scale === 1) return [base];
  return [
    `${base} Ein kürzerer Abstand sieht weniger Änderungen, der Jahreswert ist daher eher zu niedrig. Obergrenze: Revisit-Kosten wachsen linear mit dem Abstand, also Faktor ${ONE.format(scale)} (${a.cycleDays} / ${days}); Untergrenze: Kosten wie gemessen.`,
  ];
}

/** The cost report as Markdown (German): stages, services, per place and run, assumptions, extrapolation. */
export function renderCostReport(r: CostReport): string {
  const runs = r.second ? [r.first, r.second] : [r.first];
  const a = r.assumptions;
  const scale = revisitIntervalScale(a);
  const lines = [
    `# Kostenbericht Pilot – Revier ${r.areaKey}`,
    "",
    "Betriebskosten der gemessenen Läufe aus `external_calls` (Messungen auf /quality, Kennzahl „Kosten je Ort“). Nur Summen, keine Einzelwerte fremder Daten.",
    "",
    ...amountTable("Kosten je Stufe", "Stufe", runs, (x) => x.byStage),
    ...amountTable("Kosten je Dienst", "Dienst", runs, (x) => x.byService),
    "## Kosten je Ort und Lauf",
    "",
    "| Lauf | Zeitraum | Kosten | bestätigte Orte | je Ort |",
    "| --- | --- | ---: | ---: | ---: |",
    ...runs.map((x) => `| ${x.label} | ${windowText(x.window)} | ${eur(x.costEur)} | ${x.places} | ${x.perPlace === null ? "–" : eur(x.perPlace)} |`),
    "",
    ...runs.map(
      (x) =>
        `Einmalkosten Pilot im Zeitraum von ${x.label} (nicht in den Betriebskosten, Ruling M7-P15): ${eur(x.oneOff.eur)}${
          Object.keys(x.oneOff.byKind).length > 0
            ? ` (${Object.entries(x.oneOff.byKind)
                .map(([k, v]) => `${k} ${eur(v)}`)
                .join(", ")})`
            : ""
        }.`,
    ),
    "",
    r.simulation
      ? `Simulierter Revisit (Datenbank periplus_sim, getrennt gezählt): ${eur(r.simulation.totalEur)} (${Object.entries(r.simulation.byService)
          .map(([s, v]) => `${s}: ${v.calls} Aufrufe, ${eur(v.eur)}`)
          .join("; ") || "keine Aufrufe"}).`
      : "Simulierter Revisit: keine Angabe (`sim:verify --out` nicht übergeben).",
    "",
    "## Annahmen",
    "",
    `- Ortszahl je Revier: ${a.placesPerArea} (${a.placesPerAreaSource === "pilot" ? "bestätigte Orte des Pilotreviers" : "Vorgabe aus config/quality.json"})`,
    `- Zahl der Reviere im Mittelmeer: ${a.areasMin}–${a.areasMax}`,
    `- Zyklus: ${a.cycleDays} Tage, also ${ONE.format(a.revisitsPerYear)} Revisits je Revier und Jahr`,
    `- Erstlauf je Ort = Kosten je Ort von ${r.first.label}; Revisit je Ort = ${r.second ? `Kosten je Ort von ${r.second.label}` : "nicht gemessen (kein zweiter Lauf)"}`,
    ...intervalAssumption(r),
    "- Zuordnung der Kosten (Ruling M7-D-R1): Aufrufe mit Kachel zählen für deren Revier; Aufrufe eines Revier-Laufs ohne Kachel für das Revier; geteilte Aufrufe (Quellen-, System- und Text-Läufe, Aufrufe ohne Lauf, auch `smoke:ai` als Betriebskosten) nach dem Anteil bestätigter Orte über alle konfigurierten Reviere; Kacheln ohne Revier zählen für niemanden.",
    "- Im Kachel-Umfang erscheinen Ausgaben eines Revier-Laufs ohne Kachel als geteilte Kosten (nach Ortsanteil der Kachel); die Summe des Reviers bleibt gleich.",
    "- Einmalkosten (Konverter- und Modellvergleich, `pdf:compare`, `fixtures:record`, Kandidaten-Bewertungen) sind nicht in der Hochrechnung.",
    "",
    "## Hochrechnung Mittelmeer",
    "",
    `- Erstlauf (${a.areasMin}–${a.areasMax} Reviere × ${a.placesPerArea} Orte): ${eur(r.extrapolation.initialMin)} – ${eur(r.extrapolation.initialMax)}`,
    `- Jahr (Revisits, ${ONE.format(a.revisitsPerYear)} je Revier): ${yearlyRange(r)}`,
    ...(scale > 1 && r.extrapolation.yearlyMin !== null
      ? [
          `- Jahr, Revisit-Kosten linear auf ${a.cycleDays} Tage Abstand hochgerechnet (Obergrenze, Faktor ${ONE.format(scale)}): ${yearlyRange(r, scale)}`,
          "- Der Jahreswert liegt also voraussichtlich zwischen den beiden Jahreszeilen.",
        ]
      : []),
    "",
  ];
  return lines.join("\n");
}

/** German names of the metrics in the reports (the admin UI has its own copy in `app/(admin)/_components/labels.ts`). */
const METRIC_NAMES: Record<MetricKey, string> = {
  coverage: "Abdeckung",
  coverage_navily: "Abdeckung (Navily-Vergleichssatz)",
  multi_source: "Mehrbefund (≥ 2 Quellen)",
  multi_document: "Mehrbefund (≥ 2 Dokumente)",
  fact_precision: "Fact-Präzision",
  quote_fidelity: "Belegtreue",
  shelter_confidence: "Schutz-Konfidenz",
  route_reconstruction: "Routen-Rekonstruktion",
  cost_per_place: "Kosten je Ort",
  review_minutes: "Review-Aufwand",
  review_minutes_per_100: "Review-Aufwand je 100 Orte",
  highlight_share: "Anteil Orte mit Highlight",
  recent_observation_share: "Anteil Orte mit aktueller Beobachtung",
  places_per_tile: "Orte je Kachel",
};

/**
 * The metrics the pilot is accepted on (datendienst „Alle Pilot-Zielwerte der Qualitätsmetriken erreicht“): Abdeckung
 * and Mehrbefund in the datendienst's definition (ruling M7-P12: `coverage_navily`, `multi_document`; spec 10's
 * `coverage`, `multi_source` are shown in the table beside them).
 */
export const ACCEPTANCE_METRICS = [
  "coverage_navily",
  "multi_document",
  "fact_precision",
  "quote_fidelity",
  "shelter_confidence",
  "route_reconstruction",
  "cost_per_place",
] as const satisfies readonly MetricKey[];

/** A metric value as the reports write it: percent, euro, minutes or a count; `–` without a value. */
export function formatMetric(metric: MetricKey, value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  switch (METRIC_UNITS[metric]) {
    case "share": {
      const percent = Math.round(value * 1000) / 10;
      return `${decimal(Number.isInteger(percent) ? 0 : 1).format(percent)} %`;
    }
    case "eur":
      return eur(value);
    case "minutes":
      return `${decimal(0).format(Math.round(value))} min`;
    case "count":
      return decimal(Number.isInteger(value) ? 0 : 1).format(value);
  }
}

function target(metric: MetricKey, cfg: QualityConfig, level: "pilot" | "full"): string {
  const t = (cfg.targets as Partial<Record<MetricKey, { pilot: number | null; full: number | null; direction: "min" | "max" }>>)[metric];
  const v = t?.[level] ?? null;
  if (!t || v === null) return "–";
  return `${t.direction === "min" ? "≥" : "unter"} ${formatMetric(metric, v)}`;
}

const STATUS: Record<MetricStatus, string> = { met: "erreicht", missed: "verfehlt", no_target: "ohne Ziel", no_value: "kein Wert" };

export type PilotReportInput = {
  areaKey: string;
  first: MeasurementView;
  second: MeasurementView | null;
  targets: QualityConfig;
  revisit: RevisitVerification | null;
  asOf: { ok: boolean; reason?: string } | null;
  consumer: { ok: boolean; dataVersion: number } | null;
  tiles: { median: number; min: number; max: number; outside: string[] } | null;
  /** Where the cost report of the same runs lies (`docs/pilot/<date>-kostenbericht.md`). */
  costReportFile?: string;
};

const box = (ok: boolean) => (ok ? "[x]" : "[ ]");

/**
 * The pilot report as Markdown (German): the datendienst's success criteria as a checklist with the measured values
 * (ticked only when met), the metric table with pilot and full-operation targets and the status of the newer run,
 * the revisit („n von 10 korrekt, k zusätzliche“), the review effort of the second run against 60 minutes, the tile
 * size with a placeholder for Christian's decision, the reading of the numbers and the cost report.
 */
export function renderPilotReport(input: PilotReportInput): string {
  const { first, second, targets: cfg } = input;
  const current = second ?? first;
  const value = (m: MeasurementView | null, metric: MetricKey) => m?.metrics[metric]?.value ?? null;
  const details = (m: MeasurementView | null, metric: MetricKey) => (m?.metrics[metric]?.details ?? {}) as Record<string, unknown>;
  const lines = [`# Pilotbericht – Revier ${input.areaKey}`, "", `Messungen: ${first.label}${second ? `, ${second.label}` : ""}. Bewertet wird ${current.label}.`, ""];

  // Erfolgskriterien
  lines.push("## Erfolgskriterien", "");
  const measured = second ? [first, second] : [first];
  for (const metric of ACCEPTANCE_METRICS) {
    if (metric === "cost_per_place") {
      // The datendienst defines the cost target per place „und Lauf“: met only when every measured run is under it,
      // each run's value shown (ruling M7-H-R1, I-1).
      const met = measured.every((m) => metricStatus(metric, value(m, metric), cfg, "pilot") === "met");
      const values = measured.map((m) => `${m.label} ${formatMetric(metric, value(m, metric))}`).join(", ");
      lines.push(`- ${box(met)} ${METRIC_NAMES[metric]} je Lauf: ${values} (Pilotziel ${target(metric, cfg, "pilot")} in jedem Lauf)`);
      continue;
    }
    const v = value(current, metric);
    const met = metricStatus(metric, v, cfg, "pilot") === "met";
    lines.push(`- ${box(met)} ${METRIC_NAMES[metric]}: ${formatMetric(metric, v)} (Pilotziel ${target(metric, cfg, "pilot")})`);
  }
  lines.push("- [ ] Gazetteer der Pilot-Kacheln vollständig (Inseln, Küstenorte, benannte Buchten mit Namen in Deutsch, Englisch, Griechisch) – von Hand prüfen");
  const routes = details(current, "route_reconstruction");
  const reports = Array.isArray(routes.reports) ? (routes.reports as Array<{ stops: number; complete: boolean }>) : [];
  lines.push(
    `- ${box(reports.length >= 3)} Routen-Rekonstruktion an mindestens 3 Törnberichten: ${reports.length} Törnberichte mit Route, davon ${
      reports.filter((r) => r.complete).length
    } vollständig${reports.length > 0 ? ` (Stopps je Bericht: ${reports.map((r) => r.stops).join(", ")})` : ""}`,
  );
  const v = input.revisit;
  const revisitOk = v !== null && v.expected === 10 && v.correct === 10 && v.unexpected.length === 0;
  lines.push(
    `- ${box(revisitOk)} Simulierter Revisit liefert 10 von 10 Änderungen korrekt, keine falschen: ${
      v ? `${v.correct} von ${v.expected} korrekt, ${v.unexpected.length} zusätzliche` : "nicht geprüft"
    }`,
  );
  lines.push(
    `- ${box(input.asOf?.ok === true)} Ein Profil ist zum Stand „vor dem Revisit“ über die API abrufbar: ${
      input.asOf ? (input.asOf.ok ? "ja" : `nein${input.asOf.reason ? ` (${input.asOf.reason})` : ""}`) : "nicht geprüft"
    }`,
  );
  const review = value(second, "review_minutes");
  lines.push(
    `- ${box(review !== null && review < cfg.secondRunReviewMinutesMax)} Review-Aufwand für den zweiten Lauf unter ${cfg.secondRunReviewMinutesMax} Minuten: ${
      second ? formatMetric("review_minutes", review) : "kein zweiter Lauf gemessen"
    }`,
  );
  const costsDone = value(first, "cost_per_place") !== null && value(second, "cost_per_place") !== null;
  lines.push(
    `- ${box(costsDone)} Gemessene Kosten je Ort und Lauf dokumentiert, Hochrechnung für das Mittelmeer erstellt: ${first.label} ${formatMetric(
      "cost_per_place",
      value(first, "cost_per_place"),
    )}, ${second ? `${second.label} ${formatMetric("cost_per_place", value(second, "cost_per_place"))}` : "zweiter Lauf fehlt"}`,
  );
  lines.push(
    `- ${box(input.consumer?.ok === true)} Die Törn-App liest Orte und Profile aus dem Export ohne eigene Nachbearbeitung: ${
      input.consumer ? (input.consumer.ok ? `ja (Datenversion ${input.consumer.dataVersion})` : "nein") : "nicht geprüft"
    }`,
  );
  lines.push("");

  // Kennzahlen
  const runs = second ? [first, second] : [first];
  lines.push(
    "## Kennzahlen",
    "",
    `| Kennzahl | ${runs.map((r) => r.label).join(" | ")} | Pilotziel | Vollbetrieb | Status (Pilot) | Status (Vollbetrieb) |`,
    `| --- | ${runs.map(() => "---:").join(" | ")} | --- | --- | --- | --- |`,
  );
  for (const metric of METRIC_KEYS) {
    const cur = value(current, metric);
    lines.push(
      `| ${METRIC_NAMES[metric]} | ${runs.map((r) => formatMetric(metric, value(r, metric))).join(" | ")} | ${target(metric, cfg, "pilot")} | ${target(
        metric,
        cfg,
        "full",
      )} | ${STATUS[metricStatus(metric, cur, cfg, "pilot")]} | ${STATUS[metricStatus(metric, cur, cfg, "full")]} |`,
    );
  }
  lines.push("");

  // Revisit
  lines.push("## Simulierter Revisit", "");
  if (v) {
    lines.push(`${v.correct} von ${v.expected} korrekt, ${v.unexpected.length} zusätzliche.`, "");
    for (const e of v.entries) {
      lines.push(`- ${e.ok ? "ok" : "FEHLER"} ${e.id}: Dokument ${e.document.actual} (erwartet ${e.document.expected}), Ereignisse ${e.events.matched}/${e.events.expected}`);
    }
    for (const u of v.unexpected) lines.push(`- zusätzlich: ${u.subject ?? "?"} ${u.attribute ?? "(Objekt)"} ${u.type} ${u.severity}`);
  } else {
    lines.push("Nicht geprüft (`sim:verify --out` nicht übergeben).");
  }
  lines.push("");

  // Review-Aufwand
  lines.push(
    "## Review-Aufwand",
    "",
    `- ${first.label}: ${formatMetric("review_minutes", value(first, "review_minutes"))}${second ? `; ${second.label}: ${formatMetric("review_minutes", review)}` : ""} (Pilotziel zweiter Lauf: unter ${cfg.secondRunReviewMinutesMax} min)`,
    "- Gezählt werden die im Zeitraum entstandenen Review-Aufgaben ohne entfernte Profileinträge, Admin-Aktionen und Navily-Abweichungen (Ruling M7-P14, M7-D-R3); diese stehen getrennt in den Details der Messung.",
    "- Der Review-Aufwand des simulierten Revisits steht in der Sim-Datenbank (/quality der Sim-Umgebung) und wird daneben berichtet (Ruling M7-P28).",
    "",
  );

  // Kachelgröße
  lines.push("## Kachelgröße", "");
  if (input.tiles) {
    lines.push(
      `Orte je Küstenkachel: Median ${formatMetric("places_per_tile", input.tiles.median)}, Spanne ${input.tiles.min}–${input.tiles.max} (Ziel ${cfg.placesPerTile.min}–${cfg.placesPerTile.max}); ${
        input.tiles.outside.length === 0 ? "alle Kacheln im Ziel" : `außerhalb: ${input.tiles.outside.join(", ")}`
      }.`,
    );
  } else {
    lines.push("Keine Kachelzahlen gemessen.");
  }
  lines.push("", "Entscheidung: …", "");

  // Lesart
  const fidelity = details(current, "quote_fidelity");
  const evaluation = (fidelity.evaluation ?? {}) as { facts?: number; verified?: number; runs?: number };
  lines.push(
    "## Lesart der Zahlen",
    "",
    "- Abdeckung und Mehrbefund werden nach dem Datendienst abgenommen (Navily-Vergleichssatz, ≥ 2 Dokumente; Ruling M7-P12); die strengeren Werte aus Spec 10 stehen in der Tabelle daneben.",
    `- Belegtreue zählt die regulären Text-Läufe; Bewertungs- und Vergleichsläufe stehen getrennt (${num(evaluation.verified)} von ${num(evaluation.facts)} Belegen in ${num(evaluation.runs)} ${num(evaluation.runs) === 1 ? "Lauf" : "Läufen"}).`,
    "- Der Anteil Orte mit aktueller Beobachtung ist zu hoch: Texte ohne eigenes Datum zählen mit dem Abrufdatum (Ruling M7-D-R3).",
    "- Kosten je Ort: Zuordnung der Kosten nach Ruling M7-D-R1, Einmalkosten getrennt (Ruling M7-P15); Einzelheiten im Kostenbericht.",
    "",
    "## Kosten",
    "",
    `Siehe ${input.costReportFile ? `\`${input.costReportFile}\`` : "den Kostenbericht (`npm run report:costs`)"}.`,
    "",
  );
  return lines.join("\n");
}

const simVerifyReportSchema = z.object({
  verification: z.object({
    fromSeq: z.number(),
    entries: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        document: z.object({ expected: z.string(), actual: z.enum(["new_version", "gone", "unchanged"]) }),
        events: z.object({ expected: z.number(), matched: z.number() }),
        ok: z.boolean(),
      }),
    ),
    expected: z.number(),
    correct: z.number(),
    unexpected: z.array(
      z.object({
        seq: z.number(),
        subject: z.string().nullable(),
        attribute: z.string().nullable(),
        type: z.enum(changeTypeEnum.enumValues),
        severity: z.enum(changeSeverityEnum.enumValues),
        oldValue: z.unknown(),
        newValue: z.unknown(),
      }),
    ),
    passes: z.boolean(),
  }),
  asOf: z.object({ ok: z.boolean(), reason: z.string().optional(), check: z.object({ reason: z.string().optional() }).optional() }).nullable(),
  costs: z.object({ totalEur: z.number(), byService: z.record(z.string(), z.object({ calls: z.number(), eur: z.number() })) }),
});

export type SimVerifyResult = {
  verification: RevisitVerification;
  asOf: { ok: boolean; reason?: string } | null;
  costs: NonNullable<CostReport["simulation"]>;
};

/** The parts of a `sim:verify --out` file the reports read; an invalid file is refused naming `path`. */
export function parseSimVerifyReport(text: string, path: string): SimVerifyResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} ist kein JSON (erwartet: Ausgabe von sim:verify --out)`, { cause: error });
  }
  const parsed = simVerifyReportSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path} ist keine Ausgabe von sim:verify --out: ${z.prettifyError(parsed.error)}`);
  const { verification, asOf, costs } = parsed.data;
  const reason = asOf?.reason ?? asOf?.check?.reason;
  return {
    verification: verification as RevisitVerification,
    asOf: asOf === null ? null : { ok: asOf.ok, ...(reason ? { reason } : {}) },
    costs,
  };
}

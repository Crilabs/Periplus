import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { consolidationVersions, getConfig } from "@/lib/config";
import type { MetricKey } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { comparisonOverview } from "@/lib/domain/comparison";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { detailNumbers, METRIC_UNITS, qualityDashboard, type DashboardRow } from "@/lib/domain/quality/dashboard";
import { compareEvaluation, extractionVersion, listEvaluations, type EvaluationCandidate } from "@/lib/domain/quality/regression";
import type { MetricStatus } from "@/lib/domain/quality/snapshot";
import { MEASUREMENT_LABEL_MAX } from "@/lib/pipeline/quality-run";
import { requireAdmin } from "@/lib/security/require-admin";
import { Dialog } from "../_components/dialog";
import {
  COMPARISON_ATTRIBUTE_LABELS,
  METRIC_LABELS,
  PLACE_KIND_LABELS,
  qualityPageError,
  RUN_STATUS_LABELS,
} from "../_components/labels";
import {
  Badge,
  Button,
  ButtonLink,
  cx,
  EmptyState,
  Field,
  FilterChips,
  fmt,
  inputClass,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Panel,
  Stat,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
  type Tone,
} from "../_components/ui";
import { activateCandidateAction, startEvaluationAction, startMeasurementAction, saveComparisonSelectionAction } from "./actions";

export const metadata: Metadata = { title: "Qualität" };

const querySchema = z.object({
  area: z.string().optional().catch(undefined),
  tile: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  notice: z.string().optional().catch(undefined),
});

/** Tile columns: the tile metrics of a measurement (`TILE_METRICS`), the acceptance metric first. */
const TILE_COLUMNS = [
  "coverage",
  "multi_document",
  "multi_source",
  "fact_precision",
  "shelter_confidence",
  "cost_per_place",
  "highlight_share",
  "recent_observation_share",
] as const satisfies readonly MetricKey[];

/** Changed values listed per evaluation before „und n weitere“. */
const CHANGED_SHOWN = 20;

/** A metric value in German: shares as percent, cost in euro, review effort in minutes, „—“ without a value. */
function metricText(metric: MetricKey, value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  switch (METRIC_UNITS[metric]) {
    case "share":
      return value.toLocaleString("de-DE", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case "eur":
      return fmt.eur(value);
    case "minutes":
      return `${value.toLocaleString("de-DE", { maximumFractionDigits: 1 })} Min.`;
    default:
      return value.toLocaleString("de-DE", { maximumFractionDigits: 1 });
  }
}

/** A target: „≥ 85,0 %“ for a minimum, „unter 2,00 €“ for a maximum, „—“ without one. */
function targetText(metric: MetricKey, value: number | null, direction: "min" | "max" | undefined): string {
  if (value === null || !direction) return "—";
  return `${direction === "min" ? "≥" : "unter"} ${metricText(metric, value)}`;
}

const STATUS: Record<MetricStatus, { tone: Tone; label: string }> = {
  met: { tone: "ok", label: "erreicht" },
  missed: { tone: "danger", label: "verfehlt" },
  no_target: { tone: "neutral", label: "kein Ziel" },
  no_value: { tone: "neutral", label: "kein Wert" },
};

const percent = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("de-DE", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function candidateText(c: EvaluationCandidate): string {
  return [c.rulesVersion && `Regeln ${c.rulesVersion}`, c.extraction && `Extraktion ${extractionVersion(c.extraction)}`].filter(Boolean).join(" + ");
}

export default async function Page({ searchParams }: PageProps<"/quality">) {
  await requireAdmin();
  const config = getConfig();
  const { areas, quality } = config;
  const query = querySchema.parse(await searchParams);
  const area = areas.find((a) => a.key === query.area) ?? areas[0];
  if (!area)
    return (
      <>
        <PageHeader title="Qualität" />
        <Notice tone="warn">Kein Revier konfiguriert.</Notice>
      </>
    );
  const db = getDb();
  const overview = await comparisonOverview(db, area.key);
  const dashboard = await qualityDashboard(db, area.key, quality);
  const evaluations = await listEvaluations(db, area.key);
  const comparisons = new Map(await Promise.all(evaluations.map(async (e) => [e.runId, await compareEvaluation(db, e.runId)] as const)));
  const activeRules = await activeRulesVersion(db);
  const ruleVersions = consolidationVersions();
  const models = Object.keys(config.models.pricesEurPerMTok);

  const { candidates, size } = overview ?? { candidates: [], size: 0 };
  const target = dashboard.comparison.target;
  const tileIds = [...new Set(candidates.flatMap((c) => (c.tileId ? [c.tileId] : [])))];
  const tile = tileIds.includes(query.tile ?? "") ? query.tile : undefined;
  const shown = tile ? candidates.filter((c) => c.tileId === tile) : candidates;
  const href = (t?: string) => `/quality?${new URLSearchParams({ area: area.key, ...(t ? { tile: t } : {}) })}`;
  const remaining = Math.max(0, target - size);
  const error = qualityPageError(query.error);
  const { latest, history } = dashboard;
  const targets = quality.targets as Partial<Record<MetricKey, { direction: "min" | "max" }>>;
  const directionOf = (m: MetricKey) => (Object.hasOwn(targets, m) ? targets[m]?.direction : undefined);
  const reviewMinutes = latest?.metrics.review_minutes;
  const reviewDetails = (reviewMinutes?.details ?? {}) as { tasks?: number; decided?: number; withoutDuration?: number };
  const fidelityEvaluation = latest?.metrics.quote_fidelity?.details.evaluation as { facts?: number; verified?: number; runs?: number } | undefined;

  return (
    <>
      <PageHeader
        title="Qualität"
        description={`Kennzahlen je Revier gegen die Ziele für Pilot und Vollbetrieb, gemessen in Messläufen. Der Vergleichssatz ist eine feste Auswahl bestätigter Orte, an der die Ergebnisse gegen eine externe Referenz (Navily) geprüft werden; Ziel sind ${target} Orte.`}
        actions={
          <ButtonLink href={`/quality/compare?area=${area.key}`} variant="primary">
            Navily-Abgleich
          </ButtonLink>
        }
      />

      {areas.length > 1 && (
        <div className="mb-6">
          <FilterChips
            label="Revier"
            items={areas.map((a) => ({ href: `/quality?area=${a.key}`, label: a.names.de, current: a.key === area.key }))}
          />
        </div>
      )}

      {!overview && (
        <Notice tone="warn" className="mb-6" data-testid="area-missing">
          Revier noch nicht angelegt –{" "}
          <Link href="/runs" className="font-medium text-accent underline-offset-2 hover:underline">
            Gazetteer-Lauf starten
          </Link>
        </Notice>
      )}
      {error && (
        <Notice tone="danger" className="mb-6">
          {error}
        </Notice>
      )}
      {query.notice === "activated" && (
        <Notice tone="ok" className="mb-6">
          Kandidat aktiviert. Regelversionen gelten ab sofort für jede neue Konsolidierung; eine Extraktion ist freigegeben und
          wirkt nach dem Deploy von config/models.json.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Vergleichssatz"
          value={
            <span data-testid="comparison-count" className="tabular-nums">
              {size} von {target}
            </span>
          }
          tone={size >= target ? "ok" : "neutral"}
          hint={
            remaining > 0
              ? `Orte im Revier ${area.names.de}; noch ${remaining} auswählen`
              : `Orte im Revier ${area.names.de}; Ziel erreicht`
          }
        />
        <Stat
          label="Geprüfte Vergleichswerte"
          value={fmt.int(dashboard.comparison.checked)}
          hint={`${fmt.int(dashboard.comparison.pending)} Werte im Vergleichssatz noch ohne Ergebnis für ihren aktuellen Wert`}
          href={`/quality/compare?area=${area.key}`}
        />
        <Stat
          label="Letzte Messung"
          value={latest ? latest.label : "—"}
          hint={latest ? `${fmt.date(latest.from)} bis ${fmt.date(latest.to)}` : "Noch keine Messung für dieses Revier"}
          href={latest ? `/runs/${latest.runId}` : undefined}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Panel
          title="Kennzahlen"
          description={
            latest
              ? `Messung „${latest.label}“ vom ${fmt.dateTime(latest.createdAt)}. Für die Zahlen dahinter über einen Wert fahren.`
              : "Noch keine Messung. Mit „Messen“ die Kennzahlen des Reviers berechnen."
          }
          flush
        >
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Kennzahl</th>
                <th className={cx(thClass, "text-right")}>Wert</th>
                <th className={cx(thClass, "text-right")}>Ziel Pilot</th>
                <th className={cx(thClass, "text-right")}>Ziel Vollbetrieb</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.rows.map((row: DashboardRow) => {
                const details = latest?.metrics[row.metric]?.details;
                return (
                  <tr key={row.metric} className={trClass} data-testid={`metric-${row.metric}`}>
                    <td className={tdClass}>
                      {METRIC_LABELS[row.metric]}
                      {row.metric === "quote_fidelity" && fidelityEvaluation && Number(fidelityEvaluation.facts ?? 0) > 0 && (
                        <div className="text-xs text-muted">
                          Nur reguläre Läufe; Bewertungsläufe getrennt: {fmt.int(Number(fidelityEvaluation.verified ?? 0))} von{" "}
                          {fmt.int(Number(fidelityEvaluation.facts ?? 0))} belegt
                        </div>
                      )}
                    </td>
                    <td className={cx(tdClass, numClass, "font-medium")} title={details ? detailNumbers(details).join("\n") : undefined}>
                      {metricText(row.metric, row.value)}
                    </td>
                    <td className={cx(tdClass, numClass, "text-muted")}>{targetText(row.metric, row.pilot, directionOf(row.metric))}</td>
                    <td className={cx(tdClass, numClass, "text-muted")}>{targetText(row.metric, row.full, directionOf(row.metric))}</td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap gap-1">
                        {row.statusPilot !== "no_target" && <Badge tone={STATUS[row.statusPilot].tone}>Pilot {STATUS[row.statusPilot].label}</Badge>}
                        {row.statusFull !== "no_target" && <Badge tone={STATUS[row.statusFull].tone}>Voll {STATUS[row.statusFull].label}</Badge>}
                        {row.statusPilot === "no_target" && row.statusFull === "no_target" && <span className="text-xs text-muted">kein Ziel</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Panel>

        <div className="space-y-6">
          <Panel title="Messen" description="Berechnet alle Kennzahlen des Reviers für einen Zeitraum. Ohne „von“ schließt die Messung an die letzte an (die erste Messung braucht „von“: Beginn des ersten Pilot-Laufs), ohne „bis“ endet sie jetzt.">
            <form action={startMeasurementAction} className="flex flex-col gap-3">
              <input type="hidden" name="areaKey" value={area.key} />
              <Field label="Bezeichnung" hint="z. B. „Lauf 1“; je Revier eindeutig">
                <input name="label" required maxLength={MEASUREMENT_LABEL_MAX} className={inputClass} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="von (optional)">
                  <input type="date" name="from" className={inputClass} />
                </Field>
                <Field label="bis (optional)" hint="einschließlich dieses Tages">
                  <input type="date" name="to" className={inputClass} />
                </Field>
              </div>
              <Button variant="primary" className="self-start">
                Messen
              </Button>
            </form>
          </Panel>

          <Panel title="Review-Aufwand" description={`Pilot: zweiter Lauf unter ${quality.secondRunReviewMinutesMax} Minuten. Vollbetrieb: unter ${quality.targets.review_minutes_per_100.full ?? "—"} Minuten je 100 Orte.`}>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-xs text-muted">Minuten gesamt</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums" data-testid="review-minutes">
                  {metricText("review_minutes", reviewMinutes?.value ?? null)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">je 100 Orte</dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums">
                  {metricText("review_minutes_per_100", latest?.metrics.review_minutes_per_100?.value ?? null)}
                </dd>
              </div>
            </dl>
            {reviewMinutes && (
              <p className="mt-3 text-xs text-muted">
                {fmt.int(Number(reviewDetails.tasks ?? 0))} Aufgaben im Zeitraum, {fmt.int(Number(reviewDetails.decided ?? 0))} entschieden,{" "}
                {fmt.int(Number(reviewDetails.withoutDuration ?? 0))} ohne Bearbeitungszeit.
              </p>
            )}
          </Panel>
        </div>
      </div>

      <Panel title="Verlauf" description="Die letzten Messungen des Reviers, ältere zuerst." className="mt-6" flush>
        {history.length === 0 ? (
          <EmptyState title="Noch keine Messung">Der Verlauf zeigt je Messung eine Spalte.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Kennzahl</th>
                {history.map((m) => (
                  <th key={m.runId} className={cx(thClass, "text-right")}>
                    <Link href={`/runs/${m.runId}`} className="hover:text-ink">
                      {m.label}
                    </Link>
                    <div className="font-normal">{fmt.date(m.createdAt)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dashboard.rows.map((row) => (
                <tr key={row.metric} className={trClass}>
                  <td className={tdClass}>{METRIC_LABELS[row.metric]}</td>
                  {history.map((m) => (
                    <td key={m.runId} className={cx(tdClass, numClass)}>
                      {metricText(row.metric, m.metrics[row.metric]?.value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel
        title="Kacheln"
        description={`Kennzahlen je Küstenkachel der letzten Messung. Orte je Kachel: Ziel ${quality.placesPerTile.min}–${quality.placesPerTile.max}.`}
        className="mt-6"
        flush
      >
        {dashboard.tiles.length === 0 ? (
          <EmptyState title="Keine Kachelwerte">Die Messung schreibt eine Zeile je Küstenkachel des Reviers.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Kachel</th>
                <th className={cx(thClass, "text-right")}>Orte</th>
                {TILE_COLUMNS.map((m) => (
                  <th key={m} className={cx(thClass, "text-right")}>
                    {METRIC_LABELS[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dashboard.tiles.map((t) => (
                <tr key={t.tileId} className={trClass}>
                  <td className={tdClass}>
                    <TextLink href={`/tiles/${encodeURIComponent(t.tileId)}`}>
                      <span className="font-mono text-xs">{t.tileId}</span>
                    </TextLink>
                  </td>
                  <td className={cx(tdClass, numClass)}>
                    {t.places === null ? "—" : t.outsideTarget ? <Badge tone="warn" title="außerhalb des Zielbereichs">{t.places}</Badge> : t.places}
                  </td>
                  {TILE_COLUMNS.map((m) => (
                    <td key={m} className={cx(tdClass, numClass)}>
                      {metricText(m, t.metrics[m])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel
        title="Regression"
        description={`Eine neue Regelversion oder Extraktion wird am Vergleichssatz bewertet und nur aktiviert, wenn Präzision und Abdeckung nicht sinken und jeder geänderte Wert geprüft ist. Aktive Regelversion: ${activeRules}.`}
        className="mt-6"
      >
        <form action={startEvaluationAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="areaKey" value={area.key} />
          <Field label="Regelversion">
            <select name="rulesVersion" defaultValue="" className={inputClass}>
              <option value="">unverändert</option>
              {ruleVersions.map((v) => (
                <option key={v} value={v}>
                  {v}
                  {v === activeRules ? " (aktiv)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Modell (optional)">
            <select name="model" defaultValue="" className={inputClass}>
              <option value="">–</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prompt-Version (optional)">
            <input type="number" name="promptVersion" min={1} step={1} className={cx(inputClass, "w-28")} />
          </Field>
          <Button>Bewertung starten</Button>
        </form>
        <p className="mt-2 text-xs text-muted">
          „unverändert“ bewertet die aktiven Regeln ({activeRules}) und aktiviert keine Regelversion. Mit Modell und
          Prompt-Version werden die vorhandenen Extraktionsläufe dieser Konfiguration bewertet; die Bewertung extrahiert
          nichts neu.
        </p>

        {evaluations.length === 0 ? (
          <EmptyState title="Noch keine Bewertung">Eine Bewertung schreibt Profile nur zur Ansicht, nie in die Lieferung.</EmptyState>
        ) : (
          <ul className="mt-4 space-y-4">
            {evaluations.map((e) => {
              const c = comparisons.get(e.runId)!;
              const done = e.activated.length > 0;
              return (
                <li key={e.runId} className="rounded-lg border border-line" data-testid="evaluation">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{candidateText(c.candidate)}</p>
                      <p className="text-xs text-muted">
                        <Link href={`/runs/${e.runId}`} className="hover:text-ink">
                          <Mono>{e.runId.slice(0, 8)}</Mono>
                        </Link>{" "}
                        · {RUN_STATUS_LABELS[e.status]} · {fmt.dateTime(e.createdAt)}
                      </p>
                    </div>
                    {done ? (
                      <Badge tone="ok">aktiviert</Badge>
                    ) : c.passes ? (
                      <Dialog
                        trigger="Aktivieren"
                        triggerVariant="primary"
                        triggerSize="sm"
                        title={`${candidateText(c.candidate)} aktivieren?`}
                        description={`Die Aktivierung gilt für alle Reviere, nicht nur für ${area.names.de}, an dessen Vergleichssatz bewertet wurde. Regelversionen gelten danach für jede neue Konsolidierung, Lieferung und Zusammenfassung. Eine Extraktion gilt als freigegeben und wirkt erst nach dem Deploy von config/models.json.`}
                      >
                        <form action={activateCandidateAction} className="flex justify-end">
                          <input type="hidden" name="areaKey" value={area.key} />
                          <input type="hidden" name="evaluationRunId" value={e.runId} />
                          <Button variant="primary">Jetzt aktivieren</Button>
                        </form>
                      </Dialog>
                    ) : (
                      <Badge tone="warn">nicht aktivierbar</Badge>
                    )}
                  </div>
                  <div className="space-y-3 px-4 py-3 text-sm">
                    <Table>
                      <thead>
                        <tr>
                          <th className={thClass}></th>
                          <th className={cx(thClass, "text-right")}>Präzision</th>
                          <th className={cx(thClass, "text-right")}>Abdeckung</th>
                          <th className={cx(thClass, "text-right")}>Verglichene Werte</th>
                        </tr>
                      </thead>
                      <tbody>
                        {([["Alt (aktuelle Profile)", c.old], ["Neu (Kandidat)", c.next]] as const).map(([label, side]) => (
                          <tr key={label} className={trClass}>
                            <td className={tdClass}>{label}</td>
                            <td className={cx(tdClass, numClass)}>{percent(side.precision)}</td>
                            <td className={cx(tdClass, numClass)}>{percent(side.coverage)}</td>
                            <td className={cx(tdClass, numClass)}>{fmt.int(side.compared)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    {c.reasons.length > 0 && (
                      <Notice tone="warn" title="Gründe">
                        <ul className="list-disc pl-5">
                          {c.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </Notice>
                    )}
                    {c.changed.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted">
                          Geänderte Werte ({fmt.int(c.changed.length)}, davon {fmt.int(c.pending)} ungeprüft)
                        </p>
                        <ul className="divide-y divide-line rounded-md border border-line">
                          {c.changed.slice(0, CHANGED_SHOWN).map((ch) => (
                            <li key={`${ch.placeId}|${ch.attribute}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                              <TextLink
                                href={`/quality/compare?${new URLSearchParams({ area: area.key, evaluation: e.runId, place: ch.placeId })}`}
                                className="font-medium"
                              >
                                {ch.name ?? ch.placeId}
                              </TextLink>
                              <span className="text-muted">{COMPARISON_ATTRIBUTE_LABELS[ch.attribute]}</span>
                              <span>
                                {ch.oldDisplay} → {ch.newDisplay}
                              </span>
                              <span className="ml-auto">
                                {ch.checked ? <Badge tone="ok">geprüft</Badge> : <Badge tone="warn">ungeprüft</Badge>}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {c.changed.length > CHANGED_SHOWN && (
                          <p className="mt-1 text-xs text-muted">und {fmt.int(c.changed.length - CHANGED_SHOWN)} weitere</p>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Vergleichssatz"
        description="Haken setzen oder entfernen und „Auswahl speichern“ klicken. Nur die Ortsliste festlegen, keine Navily-Daten übernehmen."
        className="mt-6"
        flush
      >
        {tileIds.length > 0 && (
          <div className="border-b border-line px-4 py-3">
            <FilterChips
              label="Kachel"
              items={[
                { href: href(), label: "Alle Kacheln", current: !tile, count: candidates.length },
                ...tileIds.map((t) => ({
                  href: href(t),
                  label: <span className="font-mono text-xs">{t}</span>,
                  current: t === tile,
                  count: candidates.filter((c) => c.tileId === t).length,
                })),
              ]}
            />
          </div>
        )}
        {!overview ? (
          <EmptyState title="Noch keine Orte">
            Orte entstehen nach dem Gazetteer- und dem Seed-Lauf für das Revier und werden in der Prüfung bestätigt.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title="Keine bestätigten Orte">
            Ortskandidaten werden in der Prüfung bestätigt; erst dann lassen sie sich hier auswählen.
          </EmptyState>
        ) : (
          <form action={saveComparisonSelectionAction}>
            <input type="hidden" name="areaKey" value={area.key} />
            <ul className="divide-y divide-line">
              {shown.map((c) => (
                <li key={c.placeId} className="hover:bg-sunken/50">
                  <label className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                    <input type="hidden" name="shown" value={c.placeId} />
                    <input
                      type="checkbox"
                      name="include"
                      value={c.placeId}
                      defaultChecked={c.inSet}
                      aria-label={`${c.name ?? c.placeId} im Vergleichssatz`}
                      className="size-4 accent-accent"
                    />
                    <Link href={`/places/${c.placeId}`} className="font-medium text-accent hover:underline">
                      {c.name ?? c.placeId}
                    </Link>
                    <span className="text-muted">{PLACE_KIND_LABELS[c.kind]}</span>
                    {c.tileId && <Mono>{c.tileId}</Mono>}
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3">
              <span className="text-xs text-muted">Speichert alle Haken dieser Liste auf einmal.</span>
              <Button type="submit" size="sm" variant="primary">
                Auswahl speichern
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </>
  );
}

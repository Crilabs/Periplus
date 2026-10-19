import Link from "next/link";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import type { ComparisonVerdict } from "@/lib/db/schema";
import { COMPARISON_VERDICTS } from "@/lib/domain/extraction/comparison";
import type { FactView } from "@/lib/domain/geo-facts";
import { extractionModelDecision, listModelComparisons, modelComparisonDetail } from "@/lib/domain/model-comparison-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { Dialog } from "../../_components/dialog";
import { documentHref } from "../../_components/document-href";
import {
  COMPARISON_VERDICT_LABELS,
  comparisonShortfallLabel,
  DOC_TYPE_LABELS,
  factAttributeLabel,
  formatFactValue,
  modelComparePageError,
  RUN_STATUS_LABELS,
} from "../../_components/labels";
import { QuoteContext } from "../../_components/quote-context";
import { RunStatusBadge } from "../../_components/runs-table";
import {
  Badge,
  Button,
  ButtonLink,
  cx,
  DescriptionList,
  EmptyState,
  Field,
  fmt,
  inputClass,
  Meter,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Panel,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
  type Tone,
} from "../../_components/ui";
import { createComparisonAction, rateDeviationAction, startComparisonRunAction } from "./actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const VERDICT_TONES: Record<ComparisonVerdict, Tone> = {
  a_correct: "accent",
  b_correct: "accent",
  both_ok: "ok",
  both_wrong: "danger",
  unclear: "neutral",
};

const VERDICT_HINTS: Record<ComparisonVerdict, string> = {
  a_correct: "Nur der Wert von Modell A ist richtig",
  b_correct: "Nur der Wert von Modell B ist richtig",
  both_ok: "Beide Werte sind richtig",
  both_wrong: "Keiner der beiden Werte stimmt",
  unclear: "Nicht sicher zu entscheiden",
};

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
const percent = (n: number) => `${n.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;

/** One model's fact of a deviation: value, quote in its context, source and confidence; or that it has none. */
function FactColumn({ title, model, fact, attribute }: { title: string; model: string; fact: FactView | null; attribute: string }) {
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-line p-3">
      <h3 className="flex flex-wrap items-baseline gap-2 font-semibold">
        Modell {title} <Mono>{model}</Mono>
      </h3>
      {!fact ? (
        <p className="text-muted">Kein Fact zu diesem Attribut.</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="text-base">{formatFactValue(attribute, fact.value)}</strong>
            <span className="text-xs text-muted" title="Konfidenz des Modells für diesen Wert (0–1)">
              Konfidenz {share(fact.confidence)}
            </span>
          </p>
          {fact.context ? (
            <p className="rounded-md bg-sunken/60 p-2.5 text-xs leading-relaxed">
              <QuoteContext before={fact.context.before} quote={fact.context.quote} after={fact.context.after} />
            </p>
          ) : (
            fact.quote && <p className="rounded-md bg-sunken/60 p-2.5 text-xs leading-relaxed">„{fact.quote}“</p>
          )}
          {fact.source && (
            <p className="text-xs text-muted">
              Quelle:{" "}
              {fact.documentId ? <TextLink href={documentHref(fact)}>{fact.source.domain}</TextLink> : fact.source.domain}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function VerdictButtons({ comparisonId, unitKey, attribute, item, current }: { comparisonId: string; unitKey: string; attribute: string; item: number; current: ComparisonVerdict | null }) {
  return (
    <form action={rateDeviationAction} className="flex flex-wrap gap-2" aria-label="Urteil">
      <input type="hidden" name="comparisonId" value={comparisonId} />
      <input type="hidden" name="unitKey" value={unitKey} />
      <input type="hidden" name="attribute" value={attribute} />
      <input type="hidden" name="item" value={item} />
      {COMPARISON_VERDICTS.map((v, i) => (
        <Button
          key={v}
          type="submit"
          name="verdict"
          value={v}
          accessKey={String(i + 1)}
          title={`${VERDICT_HINTS[v]} (Taste ${i + 1})`}
          variant={current === v ? "primary" : "secondary"}
          aria-pressed={current === v}
        >
          {i + 1} {COMPARISON_VERDICT_LABELS[v]}
        </Button>
      ))}
    </form>
  );
}

export default async function Page({ searchParams }: PageProps<"/compare/models">) {
  await requireAdmin();
  const sp = await searchParams;
  const error = modelComparePageError(sp.error);
  const db = getDb();
  const cfg = getConfig();
  const comparisons = await listModelComparisons(db);
  const selectedParam = param(sp.comparison);
  const selected = selectedParam && UUID.test(selectedParam) ? selectedParam : comparisons[0]?.id;
  const detail = selected ? await modelComparisonDetail(db, selected, cfg) : null;
  const decision = extractionModelDecision(cfg);
  const target = cfg.extraction.comparison;
  const itemParam = Number(param(sp.item) ?? "1");
  const sampleSize = detail?.sample.length ?? 0;
  const item = Number.isInteger(itemParam) && itemParam >= 1 && itemParam <= sampleSize ? itemParam : 1;
  const current = detail?.sample[item - 1];
  const [modelA, modelB] = detail?.models ?? cfg.models.comparison.models;
  const decided = decision.status === "decided";
  const itemHref = (id: string, n: number) => `/compare/models?comparison=${id}&item=${n}`;

  return (
    <>
      <PageHeader
        title="Modellvergleich Extraktion"
        description={
          <>
            Welches Modell soll Facts aus Texten extrahieren? Beide Vergleichsmodelle werten dieselbe Stichprobe von bis zu{" "}
            {target.units} Erwähnungen aus mindestens {target.minSources} Quellen und allen Dokumenttypen aus. Verglichen werden
            Facts, verworfene Zitate, Übereinstimmung und Kosten; eine Stichprobe von {target.ratingSample} Abweichungen wird von
            Hand beurteilt. Die Entscheidung steht in <code>config/models.json</code>.
          </>
        }
        meta={
          <>
            <Badge tone={decided ? "ok" : "warn"}>{decided ? "Entschieden" : "Vorläufig"}</Badge>
            <span>
              Extraktion mit <Mono>{decision.model}</Mono>
            </span>
          </>
        }
        actions={
          <Dialog
            trigger="Vergleich anlegen …"
            triggerVariant={comparisons.length === 0 ? "primary" : "secondary"}
            title="Vergleich anlegen"
            description="Zieht eine neue Stichprobe aus den vorhandenen Erwähnungen und speichert sie mit den beiden Vergleichsmodellen. Extrahiert wird erst mit „Lauf starten“."
          >
            <form action={createComparisonAction} className="space-y-4">
              <Field label="Bezeichnung" hint="Frei wählbar, höchstens 80 Zeichen; unterscheidet die Vergleiche in der Liste.">
                <input name="label" required maxLength={80} defaultValue="pilot" className={inputClass} />
              </Field>
              <DescriptionList
                columns={1}
                items={[
                  {
                    label: "Stichprobe",
                    value: `${target.units} Einheiten aus mindestens ${target.minSources} Quellen und allen Dokumenttypen`,
                  },
                  { label: "Modelle", value: cfg.models.comparison.models.join(" und ") },
                ]}
              />
              <div className="flex justify-end">
                <Button type="submit" variant="primary">
                  Vergleich anlegen
                </Button>
              </div>
            </form>
          </Dialog>
        }
      />

      <div className="space-y-6">
        {error && <Notice tone="danger">Nicht ausgeführt: {error}</Notice>}
        {decision.note && <Notice tone="neutral">{decision.note}</Notice>}

        {comparisons.length > 0 && (
          <nav aria-label="Vergleiche">
            <ul className="flex flex-wrap gap-2">
              {comparisons.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/compare/models?comparison=${c.id}`}
                    aria-current={c.id === selected ? "page" : undefined}
                    className={cx(
                      "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm transition-colors",
                      c.id === selected
                        ? "border-accent bg-accent-soft font-medium text-accent"
                        : "border-line bg-surface text-ink hover:border-line-strong",
                    )}
                  >
                    {c.label}
                    <span className="text-xs text-muted">
                      {fmt.date(c.createdAt)}
                      {c.runStatus ? `, ${RUN_STATUS_LABELS[c.runStatus]}` : ", nicht gestartet"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {!detail ? (
          <Panel>
            <EmptyState title="Noch kein Vergleich">
              „Vergleich anlegen“ wählt die Stichprobe aus den vorhandenen Erwähnungen; danach extrahiert „Lauf starten“ sie mit
              beiden Modellen.
            </EmptyState>
          </Panel>
        ) : (
          <>
            <section aria-label="Stichprobe">
              <Panel
                title={detail.label}
                description="Die Erwähnungen, die beide Modelle auswerten."
                actions={
                  (!detail.runId || detail.runStatus === "failed") && (
                    <Dialog
                      trigger="Lauf starten …"
                      triggerVariant="primary"
                      triggerSize="sm"
                      title="Lauf starten"
                      description="Extrahiert die Stichprobe mit beiden Modellen über die Batch-API. Die Ergebnisse erscheinen hier, sobald der Lauf fertig ist."
                    >
                      <div className="space-y-4">
                        <DescriptionList
                          columns={1}
                          items={[
                            { label: "Modelle", value: `A ${modelA}, B ${modelB}` },
                            { label: "Einheiten", value: fmt.int(detail.units) },
                            {
                              label: "Kostenschätzung",
                              value: fmt.eur(detail.estimateEur),
                              hint: "Beide Modelle, Batch; eher zu hoch, abgerechnet werden die tatsächlichen Tokens.",
                            },
                          ]}
                        />
                        <form action={startComparisonRunAction} className="flex justify-end">
                          <input type="hidden" name="comparisonId" value={detail.id} />
                          <Button type="submit" variant="primary">
                            Lauf starten
                          </Button>
                        </form>
                      </div>
                    </Dialog>
                  )
                }
              >
                <div className="space-y-4">
                  <DescriptionList
                    columns={3}
                    items={[
                      { label: "Einheiten", value: fmt.int(detail.units) },
                      { label: "Quellen", value: fmt.int(detail.sources) },
                      { label: "Dokumenttypen", value: detail.docTypes.map((t) => DOC_TYPE_LABELS[t]).join(", ") || "–" },
                      {
                        label: "Kostenschätzung",
                        value: fmt.eur(detail.estimateEur),
                        hint: "Beide Modelle, Batch-API; eher zu hoch geschätzt",
                      },
                      { label: "Modelle", value: <>A <Mono>{modelA}</Mono>, B <Mono>{modelB}</Mono></> },
                      {
                        label: "Lauf",
                        value: detail.runId ? (
                          <span className="inline-flex items-center gap-2">
                            <Link href={`/runs/${detail.runId}`} className="font-mono text-accent underline-offset-2 hover:underline">
                              {detail.runId.slice(0, 8)}
                            </Link>
                            {detail.runStatus ? <RunStatusBadge status={detail.runStatus} /> : "–"}
                          </span>
                        ) : (
                          <span className="text-muted">nicht gestartet</span>
                        ),
                      },
                    ]}
                  />
                  {detail.shortfall.length > 0 && (
                    <Notice tone="warn" title="Stichprobe erfüllt die Vorgaben nicht ganz">
                      <ul role="note" className="list-disc pl-5">
                        {detail.shortfall.map((s) => (
                          <li key={s}>{comparisonShortfallLabel(s)}</li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                </div>
              </Panel>
            </section>

            <Panel
              title="Ergebnis je Modell"
              description="Verworfene Zitate: vorgeschlagene Facts, deren Zitat sich im Text nicht wiederfinden ließ. Ungültige Werte und unbekannte Attribute passen nicht zum Fact-Schema. Solche Vorschläge werden nicht gespeichert."
              flush
            >
              {detail.summary.runs.length === 0 ? (
                <EmptyState title="Noch kein Ergebnis">
                  Der Lauf ist nicht gestartet oder hat noch keine Extraktionsläufe.
                </EmptyState>
              ) : (
                <>
                  <Table>
                    <thead>
                      <tr>
                        <th className={thClass}>Modell</th>
                        <th className={cx(thClass, "text-right")}>Einheiten</th>
                        <th className={cx(thClass, "text-right")}>Facts</th>
                        <th className={cx(thClass, "text-right")}>Verworfene Zitate</th>
                        <th className={cx(thClass, "text-right")}>Ungültige Werte</th>
                        <th className={cx(thClass, "text-right")}>Unbekannte Attribute</th>
                        <th className={cx(thClass, "text-right")}>Kosten</th>
                        <th className={cx(thClass, "text-right")}>Kosten je Einheit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.summary.runs.map((r) => (
                        <tr key={r.extractionRunId} className={trClass}>
                          <td className={cx(tdClass, "font-mono text-[0.8125rem]")}>{r.model}</td>
                          <td className={cx(tdClass, numClass)}>{fmt.int(r.units)}</td>
                          <td className={cx(tdClass, numClass, "font-medium")}>{fmt.int(r.facts)}</td>
                          <td className={cx(tdClass, numClass, r.rejectedQuote > 0 && "text-warn")}>{fmt.int(r.rejectedQuote)}</td>
                          <td className={cx(tdClass, numClass)}>{fmt.int(r.invalidValue)}</td>
                          <td className={cx(tdClass, numClass)}>{fmt.int(r.unknownAttribute)}</td>
                          <td className={cx(tdClass, numClass)}>{fmt.eur(r.costEur, 4)}</td>
                          <td className={cx(tdClass, numClass)}>{fmt.eur(r.costPerUnitEur, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </>
              )}
              <div className="space-y-2 border-t border-line px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Übereinstimmung (je Einheit und Attribut):{" "}
                    <strong className="tabular-nums">{percent(detail.summary.agreement.pct)} gleich</strong>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone="ok">{detail.summary.agreement.same} gleich</Badge>
                    <Badge tone="warn">{detail.summary.agreement.deviation} abweichend</Badge>
                    <Badge>{detail.summary.agreement.onlyA} nur A</Badge>
                    <Badge>{detail.summary.agreement.onlyB} nur B</Badge>
                  </span>
                </div>
                <Meter ratio={detail.summary.agreement.pct / 100} label="Übereinstimmung" />
                <p className="text-xs text-muted">
                  Gleich heißt: beide Modelle liefern für dieselbe Einheit und dasselbe Attribut denselben Wert (Zahlen mit einer
                  Toleranz von {share(target.numericTolerance)}). „Nur A“ und „nur B“: nur ein Modell hat dazu einen Fact.
                </p>
              </div>
            </Panel>

            <section aria-label="Bewertung">
              <Panel
                title={
                  <>
                    Abweichungen bewerten:{" "}
                    <span className="tabular-nums">
                      {detail.ratedInSample} von {target.ratingSample} bewertet
                    </span>
                  </>
                }
                description="Je Abweichung anhand der Zitate entscheiden, welcher Wert stimmt. Die Ziffern 1–5 wählen ein Urteil über die Zugriffstaste des Browsers; danach folgt die nächste Abweichung."
                actions={
                  sampleSize > 0 && (
                    <Dialog trigger="Alle Abweichungen" triggerSize="sm" title="Abweichungen der Stichprobe" wide>
                      <Table>
                        <thead>
                          <tr>
                            <th className={cx(thClass, "text-right")}>Nr.</th>
                            <th className={thClass}>Attribut</th>
                            <th className={thClass}>A</th>
                            <th className={thClass}>B</th>
                            <th className={thClass}>Urteil</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.sample.map((d, i) => (
                            <tr key={`${d.unitKey}:${d.attribute}`} className={cx(trClass, i + 1 === item && "bg-accent-soft")}>
                              <td className={cx(tdClass, numClass)}>
                                <TextLink href={itemHref(detail.id, i + 1)}>{i + 1}</TextLink>
                              </td>
                              <td className={tdClass}>{factAttributeLabel(d.attribute)}</td>
                              <td className={cx(tdClass, "max-w-48 break-words")}>
                                {d.a ? formatFactValue(d.attribute, d.a.value) : <span className="text-muted">–</span>}
                              </td>
                              <td className={cx(tdClass, "max-w-48 break-words")}>
                                {d.b ? formatFactValue(d.attribute, d.b.value) : <span className="text-muted">–</span>}
                              </td>
                              <td className={tdClass}>
                                {d.verdict ? (
                                  <Badge tone={VERDICT_TONES[d.verdict]}>{COMPARISON_VERDICT_LABELS[d.verdict]}</Badge>
                                ) : (
                                  <span className="text-muted">offen</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </Dialog>
                  )
                }
              >
                {!current ? (
                  <EmptyState title="Keine Abweichungen">Erst nach dem Lauf gibt es etwas zu bewerten.</EmptyState>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-muted tabular-nums">
                          Eintrag {item} von {sampleSize}:
                        </span>
                        <strong>{factAttributeLabel(current.attribute)}</strong> <Mono>{current.attribute}</Mono>
                        {current.verdict && (
                          <Badge tone={VERDICT_TONES[current.verdict]}>bisher: {COMPARISON_VERDICT_LABELS[current.verdict]}</Badge>
                        )}
                      </p>
                      <nav aria-label="Einträge" className="flex gap-2">
                        {item > 1 && (
                          <ButtonLink href={itemHref(detail.id, item - 1)} size="sm">
                            ← vorheriger
                          </ButtonLink>
                        )}
                        {item < sampleSize && (
                          <ButtonLink href={itemHref(detail.id, item + 1)} size="sm">
                            nächster →
                          </ButtonLink>
                        )}
                      </nav>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <FactColumn title="A" model={modelA!} fact={current.a} attribute={current.attribute} />
                      <FactColumn title="B" model={modelB!} fact={current.b} attribute={current.attribute} />
                    </div>
                    <VerdictButtons comparisonId={detail.id} unitKey={current.unitKey} attribute={current.attribute} item={item} current={current.verdict} />
                  </div>
                )}
                {detail.ratings.rated > 0 && (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
                    <span className="text-muted">Urteile:</span>
                    {COMPARISON_VERDICTS.map((v) => (
                      <Badge key={v} tone={VERDICT_TONES[v]} title={VERDICT_HINTS[v]}>
                        {COMPARISON_VERDICT_LABELS[v]} {detail.ratings.counts[v]} ({percent(detail.ratings.shares[v] * 100)})
                      </Badge>
                    ))}
                  </div>
                )}
              </Panel>
            </section>
          </>
        )}
      </div>
    </>
  );
}

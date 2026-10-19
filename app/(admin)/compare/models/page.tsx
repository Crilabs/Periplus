import Link from "next/link";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import type { ComparisonVerdict } from "@/lib/db/schema";
import { COMPARISON_VERDICTS } from "@/lib/domain/extraction/comparison";
import type { FactView } from "@/lib/domain/geo-facts";
import { extractionModelDecision, listModelComparisons, modelComparisonDetail } from "@/lib/domain/model-comparison-view";
import { requireAdmin } from "@/lib/security/require-admin";
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
import { documentHref } from "../../_components/document-href";
import { createComparisonAction, rateDeviationAction, startComparisonRunAction } from "./actions";

const BUTTON = "rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const eur = (n: number, digits = 4) => `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} €`;
const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
const percent = (n: number) => `${n.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;

/** One model's fact of a deviation: value, quote in its context, source and confidence; or that it has none. */
function FactColumn({ title, model, fact, attribute }: { title: string; model: string; fact: FactView | null; attribute: string }) {
  return (
    <div className="min-w-0 space-y-1 rounded border border-neutral-300 p-3">
      <h3 className="font-semibold">
        {title} <span className="font-mono text-xs font-normal">{model}</span>
      </h3>
      {!fact ? (
        <p className="text-neutral-500">Kein Fact zu diesem Attribut.</p>
      ) : (
        <>
          <p>
            <strong>{formatFactValue(attribute, fact.value)}</strong> · Konfidenz {share(fact.confidence)}
          </p>
          {fact.context ? (
            <p className="text-xs">
              <QuoteContext before={fact.context.before} quote={fact.context.quote} after={fact.context.after} />
            </p>
          ) : (
            fact.quote && <p className="text-xs">„{fact.quote}“</p>
          )}
          {fact.source && (
            <p className="text-xs">
              Quelle:{" "}
              {fact.documentId ? (
                <Link href={documentHref(fact)} className="underline">
                  {fact.source.domain}
                </Link>
              ) : (
                fact.source.domain
              )}
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
        <button key={v} type="submit" name="verdict" value={v} accessKey={String(i + 1)} className={`${BUTTON} ${current === v ? "bg-neutral-200 font-semibold" : ""}`}>
          {i + 1} {COMPARISON_VERDICT_LABELS[v]}
        </button>
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

  return (
    <div className="space-y-6 text-sm">
      <h1 className="text-lg font-semibold">Modellvergleich Extraktion</h1>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Nicht ausgeführt: {error}
        </p>
      )}
      <p className="rounded bg-neutral-100 px-3 py-2">
        Aktuelle Entscheidung (<code>config/models.json</code>, <code>extract-facts</code>):{" "}
        <strong>{decision.status === "decided" ? "Entschieden" : "Vorläufig"}</strong> – Modell <code>{decision.model}</code>. {decision.note}
      </p>

      <section className="flex flex-wrap items-end gap-4">
        <form action={createComparisonAction} className="flex items-end gap-2">
          <label className="flex flex-col">
            Bezeichnung
            <input name="label" required maxLength={80} defaultValue="pilot" className="rounded border border-neutral-400 px-2 py-1" />
          </label>
          <button type="submit" className={BUTTON}>
            Vergleich anlegen
          </button>
        </form>
        <p className="text-xs text-neutral-600">
          Stichprobe: {target.units} Einheiten aus mindestens {target.minSources} Quellen und allen Dokumenttypen; Modelle{" "}
          {cfg.models.comparison.models.join(" und ")}.
        </p>
      </section>

      {comparisons.length > 0 && (
        <nav aria-label="Vergleiche" className="flex flex-wrap gap-3 text-xs">
          {comparisons.map((c) => (
            <Link key={c.id} href={`/compare/models?comparison=${c.id}`} aria-current={c.id === selected ? "page" : undefined} className={c.id === selected ? "font-semibold" : "underline"}>
              {c.label} ({c.createdAt.toISOString().slice(0, 10)}
              {c.runStatus ? `, ${RUN_STATUS_LABELS[c.runStatus]}` : ", nicht gestartet"})
            </Link>
          ))}
        </nav>
      )}

      {!detail ? (
        <p>Noch kein Vergleich – „Vergleich anlegen“ wählt die Stichprobe aus den vorhandenen Erwähnungen.</p>
      ) : (
        <>
          <section className="space-y-2" aria-label="Stichprobe">
            <h2 className="font-semibold">{detail.label}</h2>
            <p className="tabular-nums">
              {detail.units} Einheiten · {detail.sources} Quellen · Dokumenttypen: {detail.docTypes.map((t) => DOC_TYPE_LABELS[t]).join(", ") || "–"} · Kostenschätzung{" "}
              {eur(detail.estimateEur, 2)} (beide Modelle, Batch)
            </p>
            {detail.shortfall.length > 0 && (
              <ul role="note" className="list-disc rounded bg-amber-100 px-6 py-2">
                {detail.shortfall.map((s) => (
                  <li key={s}>{comparisonShortfallLabel(s)}</li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-3">
              {detail.runId ? (
                <p>
                  Lauf{" "}
                  <Link href={`/runs/${detail.runId}`} className="font-mono underline">
                    {detail.runId.slice(0, 8)}
                  </Link>{" "}
                  ({detail.runStatus ? RUN_STATUS_LABELS[detail.runStatus] : "–"})
                </p>
              ) : null}
              {(!detail.runId || detail.runStatus === "failed") && (
                <form action={startComparisonRunAction}>
                  <input type="hidden" name="comparisonId" value={detail.id} />
                  <button type="submit" className={BUTTON}>
                    Lauf starten
                  </button>
                </form>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-1 font-semibold">Ergebnis je Modell</h2>
            {detail.summary.runs.length === 0 ? (
              <p>Noch kein Ergebnis – der Lauf ist nicht gestartet oder hat noch keine Extraktionsläufe.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-neutral-300">
                      <th className="py-1 pr-4">Modell</th>
                      <th className="pr-4">Einheiten</th>
                      <th className="pr-4">Facts</th>
                      <th className="pr-4">Verworfene Zitate</th>
                      <th className="pr-4">Ungültige Werte</th>
                      <th className="pr-4">Unbekannte Attribute</th>
                      <th className="pr-4">Kosten</th>
                      <th>Kosten je Einheit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.summary.runs.map((r) => (
                      <tr key={r.extractionRunId} className="border-b border-neutral-200 tabular-nums">
                        <td className="py-1 pr-4 font-mono">{r.model}</td>
                        <td className="pr-4">{r.units}</td>
                        <td className="pr-4">{r.facts}</td>
                        <td className="pr-4">{r.rejectedQuote}</td>
                        <td className="pr-4">{r.invalidValue}</td>
                        <td className="pr-4">{r.unknownAttribute}</td>
                        <td className="pr-4">{eur(r.costEur)}</td>
                        <td>{eur(r.costPerUnitEur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 tabular-nums">
              Übereinstimmung (je Einheit und Attribut): {detail.summary.agreement.same} gleich, {detail.summary.agreement.deviation} abweichend,{" "}
              {detail.summary.agreement.onlyA} nur A, {detail.summary.agreement.onlyB} nur B – {percent(detail.summary.agreement.pct)} gleich
            </p>
          </section>

          <section className="space-y-3" aria-label="Bewertung">
            <h2 className="font-semibold">
              Abweichungen bewerten:{" "}
              <span className="tabular-nums">
                {detail.ratedInSample} von {target.ratingSample} bewertet
              </span>
            </h2>
            {!current ? (
              <p>Keine Abweichungen – erst nach dem Lauf gibt es etwas zu bewerten.</p>
            ) : (
              <>
                <p>
                  Eintrag {item} von {sampleSize}: <strong>{factAttributeLabel(current.attribute)}</strong>{" "}
                  <span className="font-mono text-xs">{current.attribute}</span>
                  {current.verdict && <> · bisher: {COMPARISON_VERDICT_LABELS[current.verdict]}</>}
                </p>
                <div className="grid gap-4 lg:grid-cols-2">
                  <FactColumn title="A" model={modelA!} fact={current.a} attribute={current.attribute} />
                  <FactColumn title="B" model={modelB!} fact={current.b} attribute={current.attribute} />
                </div>
                <VerdictButtons comparisonId={detail.id} unitKey={current.unitKey} attribute={current.attribute} item={item} current={current.verdict} />
                <nav aria-label="Einträge" className="flex gap-3 text-xs">
                  {item > 1 && (
                    <Link href={`/compare/models?comparison=${detail.id}&item=${item - 1}`} className="underline">
                      ← vorheriger
                    </Link>
                  )}
                  {item < sampleSize && (
                    <Link href={`/compare/models?comparison=${detail.id}&item=${item + 1}`} className="underline">
                      nächster →
                    </Link>
                  )}
                </nav>
              </>
            )}
            {detail.ratings.rated > 0 && (
              <p className="tabular-nums">
                Urteile:{" "}
                {COMPARISON_VERDICTS.map((v) => `${COMPARISON_VERDICT_LABELS[v]} ${detail.ratings.counts[v]} (${percent(detail.ratings.shares[v] * 100)})`).join(" · ")}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

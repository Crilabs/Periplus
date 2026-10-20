import Link from "next/link";
import type { AttributeFacts, FactView } from "@/lib/domain/geo-facts";
import { factAttributeLabel, FACT_ORIGIN_LABELS, formatFactValue } from "../../_components/labels";
import { documentHref } from "../../_components/document-href";
import { QuoteContext } from "../../_components/quote-context";
import { Badge, cx, EmptyState, FilterChips, Mono, Panel, TextLink } from "../../_components/ui";

const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

/**
 * The facts of a geo object by attribute (tab "Facts" of the place page, section "Facts" of the geo page): value,
 * quote highlighted in its context, source with a link to the document, date, confidence, model and run. Facts of an
 * extraction run that is not the active one are greyed (ruling M4-H-R2); `runsHref` builds the links of the switch
 * "nur aktiver Lauf" / "alle Läufe".
 */
export function FactsTab({
  groups,
  runs,
  runsHref,
}: {
  groups: AttributeFacts[];
  runs: "active" | "all";
  runsHref: (runs: "active" | "all") => string;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted text-pretty">
          Einzelbefunde je Attribut: aus Texten mit wörtlichem Zitat, aus Berechnungen, Prüfungen und Beobachtungen.
          Text-Facts anderer Extraktionsläufe (älteres Modell, Vergleich) erscheinen nur unter „alle Läufe“, ausgegraut.
        </p>
        <nav aria-label="Läufe">
          <FilterChips
            label="Facts nach Lauf"
            items={(["active", "all"] as const).map((r) => ({
              href: runsHref(r),
              label: r === "active" ? "nur aktiver Lauf" : "alle Läufe",
              current: r === runs,
            }))}
          />
        </nav>
      </div>
      {groups.length === 0 ? (
        <Panel>
          <EmptyState title="Keine Facts.">
            Facts entstehen, wenn ein Extraktionslauf Dokumente liest, die diesen Ort erwähnen, oder eine Berechnung für ihn läuft.
          </EmptyState>
        </Panel>
      ) : (
        groups.map((g) => (
          <Panel
            key={g.attribute}
            title={
              <span className="flex flex-wrap items-baseline gap-2">
                {factAttributeLabel(g.attribute)} <Mono>{g.attribute}</Mono>
              </span>
            }
          >
            <ul className="space-y-3">
              {g.facts.map((f) => (
                <FactCard key={f.id} fact={f} />
              ))}
            </ul>
          </Panel>
        ))
      )}
    </div>
  );
}

/** One fact: value, origin, date, confidence, model and run, the quote highlighted in its context, the source. */
export function FactCard({ fact: f }: { fact: FactView }) {
  return (
    <li className={cx("max-w-3xl rounded-md border border-line bg-surface p-3 text-sm", !f.active && "opacity-60")}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{formatFactValue(f.attribute, f.value)}</span>
        <Badge>{FACT_ORIGIN_LABELS[f.origin]}</Badge>
        <span className="text-xs text-muted">
          beobachtet {f.observedAt} · Konfidenz {share(f.confidence)}
          {f.model ? ` · ${f.model}` : ""}
          {f.runId && (
            <>
              {" "}
              · Lauf{" "}
              <Link href={`/runs/${f.runId}`} className="font-mono text-accent hover:underline">
                {f.runId.slice(0, 8)}
              </Link>
            </>
          )}
        </span>
        {!f.active && <Badge tone="neutral">nicht aktiver Lauf</Badge>}
      </p>
      {f.context ? (
        <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-xs leading-relaxed text-muted">
          <QuoteContext before={f.context.before} quote={f.context.quote} after={f.context.after} />
        </blockquote>
      ) : (
        f.quote && (
          <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-xs leading-relaxed">„{f.quote}“</blockquote>
        )
      )}
      {f.source && (
        <p className="mt-2 text-xs text-muted">
          Quelle: {f.documentId ? <TextLink href={documentHref(f)}>{f.source.domain}</TextLink> : f.source.domain} (Gewicht{" "}
          {share(f.source.weight)})
        </p>
      )}
    </li>
  );
}

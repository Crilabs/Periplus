import Link from "next/link";
import type { AttributeFacts } from "@/lib/domain/geo-facts";
import { factAttributeLabel, FACT_ORIGIN_LABELS, formatFactValue } from "../../_components/labels";
import { QuoteContext } from "../../_components/quote-context";

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
    <div className="space-y-3">
      <nav aria-label="Läufe" className="flex gap-3 text-xs">
        {(["active", "all"] as const).map((r) => (
          <Link key={r} href={runsHref(r)} aria-current={r === runs ? "page" : undefined} className={r === runs ? "font-semibold" : "underline"}>
            {r === "active" ? "nur aktiver Lauf" : "alle Läufe"}
          </Link>
        ))}
      </nav>
      {groups.length === 0 ? (
        <p>Keine Facts.</p>
      ) : (
        groups.map((g) => (
          <section key={g.attribute}>
            <h3 className="font-semibold">
              {factAttributeLabel(g.attribute)} <span className="font-mono text-xs font-normal text-neutral-500">{g.attribute}</span>
            </h3>
            <ul className="space-y-2">
              {g.facts.map((f) => (
                <li key={f.id} className={`max-w-3xl rounded border border-neutral-200 p-2 ${f.active ? "" : "text-neutral-400"}`}>
                  <p>
                    <span className="font-semibold">{formatFactValue(g.attribute, f.value)}</span> · {FACT_ORIGIN_LABELS[f.origin]} · beobachtet{" "}
                    {f.observedAt} · Konfidenz {share(f.confidence)}
                    {f.model ? ` · ${f.model}` : ""}
                    {f.runId && (
                      <>
                        {" "}
                        · Lauf{" "}
                        <Link href={`/runs/${f.runId}`} className="font-mono underline">
                          {f.runId.slice(0, 8)}
                        </Link>
                      </>
                    )}
                    {!f.active && " · nicht aktiver Lauf"}
                  </p>
                  {f.context ? (
                    <p className="mt-1 text-xs">
                      <QuoteContext before={f.context.before} quote={f.context.quote} after={f.context.after} />
                    </p>
                  ) : (
                    f.quote && <p className="mt-1 text-xs">„{f.quote}“</p>
                  )}
                  {f.source && (
                    <p className="mt-1 text-xs">
                      Quelle:{" "}
                      {f.documentId ? (
                        <Link href={`/documents/${f.documentId}`} className="underline">
                          {f.source.domain}
                        </Link>
                      ) : (
                        f.source.domain
                      )}{" "}
                      (Gewicht {share(f.source.weight)})
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

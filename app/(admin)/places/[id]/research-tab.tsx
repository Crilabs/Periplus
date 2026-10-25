import { Fragment } from "react";
import type { FactRow, ResearchRow, ResearchViewData, SignalRow } from "@/lib/domain/research/view";
import { PAGE_KIND_LABELS, PLACE_STATUS_LABELS, RESEARCH_FETCH_REASON_LABELS, SIGNAL_KIND_LABELS, TONE_LABELS } from "../../_components/labels";
import { Badge, EmptyState, Panel, Table, tdClass, TextLink, thClass, trClass } from "../../_components/ui";

const PURPOSE_LABELS = { positive: "Bestätigung", negative: "Negativsuche", landside: "Landsuche" } as const;

/** Column „Zweck“: the search purposes of a hit, else how the page is linked to the berth. */
function purposeText(r: ResearchRow): string {
  if (r.link === "neighbour") return "Treffer eines Nachbarn";
  if (r.link === "route") return "Routenhalt";
  if (r.ownWebsite) return "eigene Website";
  return r.purposes.map((p) => PURPOSE_LABELS[p]).join(", ");
}

/** „nicht geholt: <Grund>“ for a hit without assessment whose newest fetch did not store or confirm a page. */
function notFetched(r: ResearchRow): string | null {
  const f = r.fetch;
  if (!f || f.outcome === "stored" || f.outcome === "unchanged") return null;
  const reason = f.reason ? (RESEARCH_FETCH_REASON_LABELS[f.reason] ?? f.reason) : f.outcome;
  return `nicht geholt: ${reason}`;
}

function SignalLine({ s }: { s: SignalRow }) {
  return (
    <li>
      <span className="font-medium">{SIGNAL_KIND_LABELS[s.kind]}</span>
      {s.firstHand && <> · erste Hand</>} · Sicherheit {s.confidence.toFixed(2)} · {s.observedAt}
      {s.observedAtBasis === "fetched" && " (Abrufdatum)"}: „{s.quote}“
    </li>
  );
}

function FactLine({ f }: { f: FactRow }) {
  return (
    <li>
      <span className="font-medium">{f.statement}</span> · {f.subject ?? "Liegeplatz"} · {f.observedAt}
      {f.tone && <> · {TONE_LABELS[f.tone]}</>}: „{f.quote}“
    </li>
  );
}

/** What the rule says, in German: the sources of a confirmation, else the reason. */
function ruleText(verdict: ResearchViewData["verdict"]): string {
  return verdict.status === "confirmed"
    ? `bestätigt, ${verdict.independentSources.length} unabhängige Quellen (${verdict.independentSources.join(", ")})`
    : verdict.reason;
}

/**
 * The header: the place's actual status (confirmed only when it is; a rule-confirmed place shows its sources) with its
 * reason, and „Regel ergibt: …“ below when the rule's verdict differs from the status (admin-set, final, held by a
 * duplicate review or inside a restricted area).
 */
function VerdictLine({ view }: { view: ResearchViewData }) {
  const { status, statusReason, verdict } = view;
  let text: string;
  if (status === "confirmed") {
    text =
      verdict.status === "confirmed"
        ? `Bestätigt: ${verdict.independentSources.length} unabhängige Quellen (${verdict.independentSources.join(", ")})`
        : "Bestätigt (von Hand)";
  } else if (status === "candidate") {
    text = `Nicht bestätigt: ${statusReason ?? verdict.reason}`;
  } else {
    text = statusReason ? `${PLACE_STATUS_LABELS[status]}: ${statusReason}` : PLACE_STATUS_LABELS[status];
  }
  return (
    <div className="mb-3 text-sm" data-testid="research-verdict">
      <p className="font-medium">{text}</p>
      {verdict.status !== status && <p className="text-muted">Regel ergibt: {ruleText(verdict)}</p>}
    </div>
  );
}

/**
 * Tab „Recherche“ of the place page (plan N1, N2): the verdict of the confirmation rule on top, then the search hits
 * of the berth and the pages linked to it by a neighbour's hit or a route stop, with search term, page kind, first-hand and SEO/AI flags, observation date, the berths the page names
 * and the number of signals and facts, and below each page its signals and facts with their quotes.
 */
export function ResearchTab({ view }: { view: ResearchViewData }) {
  const { rows } = view;
  if (rows.length === 0) {
    return (
      <>
        <VerdictLine view={view} />
        <Panel>
          <EmptyState title="Noch keine Recherche für diesen Liegeplatz." />
        </Panel>
      </>
    );
  }
  return (
    <>
      <VerdictLine view={view} />
      <Panel flush>
        <Table>
          <thead>
            <tr>
              <th className={thClass}>Zweck</th>
              <th className={thClass}>Rang</th>
              <th className={thClass}>Suchbegriff</th>
              <th className={thClass}>Seite</th>
              <th className={thClass}>Art</th>
              <th className={thClass}>Merkmale</th>
              <th className={thClass}>Beobachtet</th>
              <th className={thClass}>Genannte Liegeplätze</th>
              <th className={thClass}>Signale / Fakten</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.url}>
                <tr className={trClass}>
                  <td className={tdClass}>{purposeText(r)}</td>
                  <td className={tdClass}>{r.rank ?? "–"}</td>
                  <td className={tdClass}>{r.keyword ?? "–"}</td>
                  <td className={tdClass}>
                    {r.documentId ? (
                      <TextLink href={`/documents/${r.documentId}`} title={r.url}>
                        {r.domain}
                      </TextLink>
                    ) : (
                      <a href={r.url} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">
                        {r.domain}
                      </a>
                    )}
                  </td>
                  <td className={tdClass}>{r.assessment ? PAGE_KIND_LABELS[r.assessment.pageKind] : (notFetched(r) ?? "–")}</td>
                  <td className={tdClass}>
                    {r.assessment && (
                      <span className="flex flex-wrap gap-1">
                        {r.assessment.firstHand && <Badge tone="ok">erste Hand</Badge>}
                        {r.assessment.generated && <Badge tone="warn">SEO/KI</Badge>}
                      </span>
                    )}
                  </td>
                  <td className={tdClass}>{r.assessment?.observedAt ?? "–"}</td>
                  <td className={tdClass}>{r.assessment && r.assessment.berths.length > 0 ? r.assessment.berths.join(", ") : "–"}</td>
                  <td className={tdClass}>
                    {r.signalCount} / {r.factCount}
                  </td>
                </tr>
                {(r.signals.length > 0 || r.facts.length > 0) && (
                  <tr className={trClass}>
                    <td className={tdClass} colSpan={9}>
                      {r.signals.length > 0 && (
                        <ul className="list-disc space-y-1 pl-5 text-sm">
                          {r.signals.map((s, i) => (
                            <SignalLine key={i} s={s} />
                          ))}
                        </ul>
                      )}
                      {r.facts.length > 0 && (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                          {r.facts.map((f, i) => (
                            <FactLine key={i} f={f} />
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </Table>
      </Panel>
    </>
  );
}

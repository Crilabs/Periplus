import Link from "next/link";
import type { FactView } from "@/lib/domain/geo-facts";
import type { ProfileAttributeSubject, ProfileSideView } from "@/lib/domain/review-view";
import {
  CONFIDENCE_CLASS_LABELS,
  CONFLICT_RESOLUTION_LABELS,
  FACT_ORIGIN_LABELS,
  formatFactValue,
  PROVENANCE_ORIGIN_LABELS,
} from "../../_components/labels";
import { QuoteContext } from "../../_components/quote-context";
import { documentHref } from "../../_components/document-href";
import { DecisionForm } from "./decision-form";

const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
const period = (from: string, to: string) => (from === to ? from : `${from} bis ${to}`);

/** The facts behind one value: value, origin, date, confidence, the quote in its context and the source with its weight. */
function FactList({ attribute, facts }: { attribute: string; facts: FactView[] }) {
  if (facts.length === 0) return <p className="text-xs text-neutral-500">Keine Facts gespeichert.</p>;
  return (
    <ul className="space-y-2">
      {facts.map((f) => (
        <li key={f.id} className={`rounded border border-neutral-200 p-2 ${f.active ? "" : "text-neutral-400"}`}>
          <p className="text-xs">
            <span className="font-semibold">{formatFactValue(attribute, f.value)}</span> · {FACT_ORIGIN_LABELS[f.origin]} · beobachtet{" "}
            {f.observedAt} · Konfidenz {share(f.confidence)}
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
                <Link href={documentHref(f)} className="underline">
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
  );
}

function SideCard({ title, attribute, side }: { title: string; attribute: string; side: ProfileSideView | undefined }) {
  return (
    <section className="space-y-2 rounded border border-neutral-300 p-3">
      <h2 className="font-semibold">{title}</h2>
      {side ? (
        <>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
            <dt>Wert</dt>
            <dd className="font-semibold">{side.display}</dd>
            <dt>Zeitraum</dt>
            <dd>{period(side.observedFrom, side.observedTo)}</dd>
            <dt>Gewicht</dt>
            <dd>{share(side.weight)}</dd>
          </dl>
          <FactList attribute={attribute} facts={side.facts} />
        </>
      ) : (
        <p>Diese Seite fehlt im Aufgabenkontext.</p>
      )}
    </section>
  );
}

/**
 * A `conflict` or `uncertain_change` task on one profile attribute (spec 07): the object, the attribute, the profile's
 * current value with its origin, and per side (conflict) or for the proposed value (uncertain change) the value, the
 * period, the weight and the facts with their quotes and sources. Decisions: "Wert A", "Wert B", "Beide (saisonal)",
 * "Offen lassen" (keys 1–4) or "Übernehmen", "Verwerfen" (keys 1–2); each names the task's context key, so a decision
 * on a value that changed meanwhile is refused.
 */
export function ProfileDecision({
  kind,
  subject,
  taskId,
  openedAt,
  open,
}: {
  kind: "conflict" | "uncertain_change";
  subject: ProfileAttributeSubject;
  taskId: string;
  openedAt: string;
  open: boolean;
}) {
  const props = { taskId, openedAt, taskKey: subject.key ?? "" };
  const p = subject.current.provenance;
  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
          <dt>Objekt</dt>
          <dd>
            <Link href={`/geo/${subject.geoObjectId}`} className="underline">
              {subject.name ?? subject.geoObjectId}
            </Link>
          </dd>
          <dt>Attribut</dt>
          <dd>
            {subject.label} <span className="font-mono text-xs text-neutral-500">{subject.attribute}</span>
          </dd>
          <dt>Im Profil</dt>
          <dd>
            <span className="font-semibold">{subject.current.display}</span>
            {p && ` · ${PROVENANCE_ORIGIN_LABELS[p.origin]} · Konfidenz ${CONFIDENCE_CLASS_LABELS[p.confidenceClass]} (${share(p.confidence)})`}
            {p?.expired && " · veraltet"}
          </dd>
          {subject.resolution && (
            <>
              <dt>Entscheidung</dt>
              <dd>{CONFLICT_RESOLUTION_LABELS[subject.resolution]}</dd>
            </>
          )}
        </dl>
      </section>

      {kind === "conflict" ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <SideCard title="Wert A" attribute={subject.attribute} side={subject.a} />
            <SideCard title="Wert B" attribute={subject.attribute} side={subject.b} />
          </div>
          {subject.others && subject.others.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-semibold">Weitere Werte</h2>
              <ul>
                {subject.others.map((o, i) => (
                  <li key={i}>
                    {o.display} – Gewicht {share(o.weight)}, {period(o.observedFrom, o.observedTo)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {open && (
            <div className="space-y-2">
              <DecisionForm {...props} n={1} label="Wert A" decision={{ action: "value_a" }} valueKey={subject.a?.fingerprint} disabled={!subject.a} />
              <DecisionForm {...props} n={2} label="Wert B" decision={{ action: "value_b" }} valueKey={subject.b?.fingerprint} disabled={!subject.b} />
              <DecisionForm {...props} n={3} label="Beide (saisonal)" decision={{ action: "seasonal" }} />
              <DecisionForm {...props} n={4} label="Offen lassen" decision={{ action: "leave_open" }} />
              <p className="text-xs text-neutral-600">
                „Wert A“ und „Wert B“ gehen als Prüfung in das Profil ein. „Beide (saisonal)“ und „Offen
                lassen“ gelten dauerhaft für dieses Wertepaar: derselbe Widerspruch wird nicht erneut vorgelegt.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <section className="space-y-2 rounded border border-neutral-300 p-3">
            <h2 className="font-semibold">Vorgeschlagene Änderung</h2>
            {subject.proposed ? (
              <>
                <p>
                  {subject.current.display} → <span className="font-semibold">{subject.proposed.display}</span>
                </p>
                <FactList attribute={subject.attribute} facts={subject.proposed.facts} />
              </>
            ) : (
              <p>Der Aufgabenkontext nennt keinen neuen Wert.</p>
            )}
          </section>
          {open && (
            <div className="space-y-2">
              <DecisionForm {...props} n={1} label="Übernehmen" decision={{ action: "accept_change" }} disabled={!subject.proposed || subject.proposed.value === null || subject.proposed.value === undefined} />
              <DecisionForm {...props} n={2} label="Verwerfen" decision={{ action: "discard_change" }} />
              <p className="text-xs text-neutral-600">
                „Übernehmen“ geht als Prüfung in das Profil ein; „Verwerfen“ behält den bisherigen Wert,
                diese Änderung wird nicht erneut vorgelegt.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

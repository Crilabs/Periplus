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
import { Badge, cx, DescriptionList, Mono, Panel, TextLink } from "../../_components/ui";
import { DecisionForm } from "./decision-form";
import { DecisionPanel, Disclosure } from "./parts";

const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
const period = (from: string, to: string) => (from === to ? from : `${from} bis ${to}`);
/** Facts shown per value before the rest folds away. */
const SHOWN_FACTS = 2;

function FactItem({ attribute, f }: { attribute: string; f: FactView }) {
  return (
    <li className={cx("rounded-md border border-line p-3", f.active ? "bg-surface" : "bg-sunken/60 text-muted")}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-semibold text-ink">{formatFactValue(attribute, f.value)}</span>
        <span className="text-muted">
          {FACT_ORIGIN_LABELS[f.origin]} · beobachtet {f.observedAt} · Konfidenz {share(f.confidence)}
        </span>
        {!f.active && <Badge title="Der Fact stammt aus einem Extraktionslauf, der nicht mehr aktiv ist">nicht aktiver Lauf</Badge>}
      </p>
      {f.context ? (
        <p className="mt-2 text-sm leading-relaxed">
          <QuoteContext before={f.context.before} quote={f.context.quote} after={f.context.after} />
        </p>
      ) : (
        f.quote && <p className="mt-2 text-sm leading-relaxed">„{f.quote}“</p>
      )}
      {f.source && (
        <p className="mt-2 text-xs text-muted">
          Quelle:{" "}
          {f.documentId ? (
            <TextLink href={documentHref(f)}>{f.source.domain}</TextLink>
          ) : (
            <span className="text-ink">{f.source.domain}</span>
          )}{" "}
          (Gewicht {share(f.source.weight)})
        </p>
      )}
    </li>
  );
}

/** The facts behind one value: value, origin, date, confidence, the quote in its context and the source with its weight. */
function FactList({ attribute, facts }: { attribute: string; facts: FactView[] }) {
  if (facts.length === 0) return <p className="text-xs text-muted">Keine Facts gespeichert.</p>;
  const rest = facts.slice(SHOWN_FACTS);
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {facts.slice(0, SHOWN_FACTS).map((f) => (
          <FactItem key={f.id} attribute={attribute} f={f} />
        ))}
      </ul>
      {rest.length > 0 && (
        <Disclosure summary={`${rest.length} weitere Beleg${rest.length === 1 ? "" : "e"}`}>
          <ul className="space-y-2">
            {rest.map((f) => (
              <FactItem key={f.id} attribute={attribute} f={f} />
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

function SideCard({ title, attribute, side }: { title: string; attribute: string; side: ProfileSideView | undefined }) {
  return (
    <Panel
      title={title}
      description={side ? `Gewicht ${share(side.weight)} · ${period(side.observedFrom, side.observedTo)}` : undefined}
    >
      {side ? (
        <div className="space-y-3">
          <p className="text-lg font-semibold tracking-tight">{side.display}</p>
          <FactList attribute={attribute} facts={side.facts} />
        </div>
      ) : (
        <p className="text-sm text-muted">Diese Seite fehlt im Aufgabenkontext.</p>
      )}
    </Panel>
  );
}

/**
 * A `conflict` or `uncertain_change` task on one profile attribute (spec 07): the object, the attribute, the profile's
 * current value with its origin, and per side (conflict) or for the proposed value (uncertain change) the value, the
 * period, the weight and the facts with their quotes and sources; an uncertain change of a held safety value also
 * shows the two sides of its conflict note (ruling M6-FIN-R3). Decisions: "Wert A", "Wert B", "Beide (saisonal)",
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

  const facts = (
    <Panel title="Attribut im Profil" className={open ? "lg:col-span-3" : "lg:col-span-5"}>
      <DescriptionList
        items={[
          {
            label: "Objekt",
            value: <TextLink href={`/geo/${subject.geoObjectId}`}>{subject.name ?? subject.geoObjectId}</TextLink>,
          },
          {
            label: "Attribut",
            value: (
              <>
                {subject.label} <Mono>{subject.attribute}</Mono>
              </>
            ),
          },
          {
            label: "Im Profil",
            value: (
              <>
                <span className="font-semibold">{subject.current.display}</span>
                {p && (
                  <span className="text-muted">
                    {` · ${PROVENANCE_ORIGIN_LABELS[p.origin]} · Konfidenz ${CONFIDENCE_CLASS_LABELS[p.confidenceClass]} (${share(p.confidence)})`}
                  </span>
                )}
                {p?.expired && (
                  <>
                    {" "}
                    <Badge tone="warn" title="Älter als zwei Zyklen der Kachel: der Wert bleibt, seine Konfidenz sinkt eine Stufe">
                      veraltet
                    </Badge>
                  </>
                )}
              </>
            ),
          },
          subject.resolution && { label: "Entscheidung", value: CONFLICT_RESOLUTION_LABELS[subject.resolution] },
        ]}
      />
    </Panel>
  );

  if (kind === "conflict") {
    return (
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-5">
          {open && (
            <DecisionPanel
              question="Welcher Wert gilt?"
              className="lg:col-span-2"
              note="„Wert A“ und „Wert B“ gehen als Prüfung in das Profil ein. „Beide (saisonal)“ und „Offen lassen“ gelten dauerhaft für dieses Wertepaar: derselbe Widerspruch wird nicht erneut vorgelegt."
            >
              <DecisionForm
                {...props}
                n={1}
                label="Wert A"
                decision={{ action: "value_a" }}
                valueKey={subject.a?.fingerprint}
                disabled={!subject.a}
                hint={subject.a && `„${subject.a.display}“`}
              />
              <DecisionForm
                {...props}
                n={2}
                label="Wert B"
                decision={{ action: "value_b" }}
                valueKey={subject.b?.fingerprint}
                disabled={!subject.b}
                hint={subject.b && `„${subject.b.display}“`}
              />
              <DecisionForm {...props} n={3} label="Beide (saisonal)" decision={{ action: "seasonal" }} hint="Beide Werte gelten, je nach Saison." />
              <DecisionForm {...props} n={4} label="Offen lassen" decision={{ action: "leave_open" }} hint="Der Widerspruch bleibt bestehen." />
            </DecisionPanel>
          )}
          {facts}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <SideCard title="Wert A" attribute={subject.attribute} side={subject.a} />
          <SideCard title="Wert B" attribute={subject.attribute} side={subject.b} />
        </div>
        {subject.others && subject.others.length > 0 && (
          <Panel title="Weitere Werte" description="Weitere Wertgruppen, schwerste zuerst; die Entscheidung betrifft nur A und B.">
            <ul className="divide-y divide-line text-sm">
              {subject.others.map((o, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 py-2 first:pt-0 last:pb-0">
                  <span className="font-medium">{o.display}</span>
                  <span className="text-muted">
                    Gewicht {share(o.weight)}, {period(o.observedFrom, o.observedTo)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-5">
        {open && (
          <DecisionPanel
            question="Den neuen Wert ins Profil übernehmen?"
            className="lg:col-span-2"
            note="„Übernehmen“ geht als Prüfung in das Profil ein; „Verwerfen“ behält den bisherigen Wert, diese Änderung wird nicht erneut vorgelegt."
          >
            <DecisionForm
              {...props}
              n={1}
              label="Übernehmen"
              decision={{ action: "accept_change" }}
              variant="primary"
              disabled={!subject.proposed || subject.proposed.value === null || subject.proposed.value === undefined}
            />
            <DecisionForm {...props} n={2} label="Verwerfen" decision={{ action: "discard_change" }} />
          </DecisionPanel>
        )}
        {facts}
      </div>
      <Panel title="Vorgeschlagene Änderung">
        {subject.proposed ? (
          <div className="space-y-3">
            <p className="flex flex-wrap items-baseline gap-2 text-lg tracking-tight">
              <span className="text-muted line-through decoration-1">{subject.current.display}</span>
              <span aria-hidden className="text-muted">→</span>
              <span className="sr-only">wird zu</span>
              <span className="font-semibold">{subject.proposed.display}</span>
            </p>
            <FactList attribute={subject.attribute} facts={subject.proposed.facts} />
          </div>
        ) : (
          <p className="text-sm text-muted">Der Aufgabenkontext nennt keinen neuen Wert.</p>
        )}
      </Panel>
      {(subject.a || subject.b) && (
        <>
          <p className="text-sm text-muted">
            Die schwachen Quellen widersprechen sich: vorgeschlagen ist Wert A, Wert B und weitere Werte stehen zum Vergleich.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <SideCard title="Wert A" attribute={subject.attribute} side={subject.a} />
            <SideCard title="Wert B" attribute={subject.attribute} side={subject.b} />
          </div>
          {subject.others && subject.others.length > 0 && (
            <Panel title="Weitere Werte" description="Weitere Wertgruppen, schwerste zuerst.">
              <ul className="divide-y divide-line text-sm">
                {subject.others.map((o, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2 py-2 first:pt-0 last:pb-0">
                    <span className="font-medium">{o.display}</span>
                    <span className="text-muted">
                      Gewicht {share(o.weight)}, {period(o.observedFrom, o.observedTo)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

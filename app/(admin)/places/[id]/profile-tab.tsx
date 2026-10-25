import Link from "next/link";
import type { ReactNode } from "react";
import { formatProfileValue } from "@/lib/domain/consolidation/format";
import type { ConfidenceClass, ConflictNote } from "@/lib/domain/rules/types";
import type { AttributeFactsView, ProfileRow, ProfileView } from "@/lib/domain/profile-view";
import { Dialog } from "../../_components/dialog";
import {
  COMPUTATION_KIND_LABELS,
  CONFIDENCE_CLASS_LABELS,
  CONFLICT_RESOLUTION_LABELS,
  PROFILE_NOTICE_LABELS,
  PROVENANCE_ORIGIN_LABELS,
  profileGapReasonLabel,
  SUMMARY_STATUS_LABELS,
} from "../../_components/labels";
import {
  Badge,
  Button,
  ButtonLink,
  buttonClass,
  cx,
  DescriptionList,
  EmptyState,
  Mono,
  Notice,
  Panel,
  Stat,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
  type Tone,
} from "../../_components/ui";
import { regenerateSummaryAction, removeProfileEntryAction } from "./actions";
import { FactCard } from "./facts-tab";

const share = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export const CONFIDENCE_CLASS_TONES: Record<ConfidenceClass, Tone> = { high: "ok", medium: "warn", low: "danger" };

const NOTICE_TONES: Record<string, Tone> = { entry_removed: "ok", entry_removed_no_run: "warn", changed: "warn", error: "danger" };

/** Where the profile table links to: the attribute's facts (`attr`), and where „Eintrag entfernen“ returns to. */
export type ProfileLinks = {
  geoObjectId: string;
  attrHref: (attribute: string | null) => string;
  placeId?: string;
  /** The entry key whose removal awaits confirmation (`?confirm=`): its button shows „Wirklich entfernen?“. */
  confirm?: string | null;
};

/**
 * The profile tab of the place page (`?tab=profile&attr=<key>`) and the profile section of the geo page: head
 * (version, profile confidence, popularity, sources and documents, summary; validity, rules version and identity in a
 * dialog), the table of attributes with their provenance, the facts of the clicked attribute beside it, derived
 * values and gaps.
 */
export function ProfileTab({
  view,
  selected,
  links,
  notice,
  noticeRunId,
}: {
  view: ProfileView | null;
  selected: AttributeFactsView | null;
  links: ProfileLinks;
  notice?: string | null;
  noticeRunId?: string | null;
}) {
  return (
    <div className="space-y-6">
      {notice && PROFILE_NOTICE_LABELS[notice] && (
        <Notice
          tone={NOTICE_TONES[notice] ?? "warn"}
          actions={
            noticeRunId && (
              <ButtonLink href={`/runs/${noticeRunId}`} size="sm">
                Lauf ansehen
              </ButtonLink>
            )
          }
        >
          {PROFILE_NOTICE_LABELS[notice]}
        </Notice>
      )}
      {view ? (
        <ProfileBody view={view} selected={selected} links={links} />
      ) : (
        <Panel>
          <EmptyState title="Noch kein Profil.">
            Ein Profil entsteht, wenn ein Konsolidierungslauf die Facts dieses Orts zusammenführt. „Profil neu berechnen“
            startet einen solchen Lauf.
          </EmptyState>
        </Panel>
      )}
    </div>
  );
}

function ProfileBody({ view, selected, links }: { view: ProfileView; selected: AttributeFactsView | null; links: ProfileLinks }) {
  const s = view.snapshot;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Version"
          value={
            <>
              {s.version} von {view.versions}
            </>
          }
          tone={view.latest ? "neutral" : "warn"}
          hint={view.latest ? `Gültig ab ${s.validFrom}` : `Gültig ab ${s.validFrom} (ältere Version)`}
        />
        <Stat
          label="Profil-Konfidenz"
          value={s.confidence === null ? "–" : share(s.confidence)}
          hint="Gewichtetes Mittel aus Schutz, Tiefe, Grund und Verboten (0–1)"
        />
        <Stat
          label="Beliebtheit"
          value={view.popularity === null ? "–" : share(view.popularity)}
          hint="Unabhängige Quellen mit Erwähnung, relativ zum Revier (0–1)"
        />
        <Stat label="Quellen / Dokumente" value={`${s.sourcesCount} / ${s.documentsCount}`} hint="Woraus die Facts stammen" />
      </div>

      <Panel
        title="Zusammenfassung"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {view.latest && (
              <form action={regenerateSummaryAction}>
                <input type="hidden" name="geoObjectId" value={links.geoObjectId} />
                {links.placeId && <input type="hidden" name="placeId" value={links.placeId} />}
                <Button size="sm" title="Startet einen Lauf, der die Zusammenfassung der neuesten Version neu schreibt (auch eine vorhandene).">
                  Zusammenfassung neu erzeugen
                </Button>
              </form>
            )}
            <Dialog trigger="Details zur Version" triggerSize="sm" title={`Profilversion ${s.version}`} description="Technische Angaben zu dieser Version des Profils.">
              <DescriptionList
                columns={1}
                items={[
                  { label: "Gültig ab", value: s.validFrom },
                  { label: "Regelversion", value: `${s.rulesVersion} · Fact-Schema ${s.factSchemaVersion}` },
                  {
                    label: "Erstellt",
                    value: (
                      <>
                        {time(view.createdAt)}
                        {view.runId && (
                          <>
                            {" "}
                            · Lauf{" "}
                            <TextLink href={`/runs/${view.runId}`} className="font-mono">
                              {view.runId.slice(0, 8)}
                            </TextLink>
                          </>
                        )}
                      </>
                    ),
                  },
                  ...view.identity.map((i) => ({ label: i.label, value: i.display })),
                ]}
              />
            </Dialog>
          </div>
        }
      >
        <p className={cx("max-w-3xl leading-relaxed text-pretty", (view.summary === null || view.summary.text === null) && "text-muted")}>
          {view.summary === null ? "–" : view.summary.text ?? `(${SUMMARY_STATUS_LABELS[view.summary.status]})`}
        </p>
      </Panel>

      <div className={cx("grid items-start gap-6", selected && "xl:grid-cols-[minmax(0,1fr)_28rem]")}>
        <Panel
          title="Attribute"
          description="Ein Klick auf ein Attribut zeigt die Facts, Zitate und Berechnungen, auf denen der Wert beruht."
          flush
        >
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Attribut</th>
                <th className={thClass}>Wert</th>
                <th className={thClass}>Konfidenz</th>
                <th className={thClass}>Herkunft</th>
                <th className={thClass} title="Zuerst beobachtet / zuletzt von einer Quelle bestätigt">
                  Beobachtet / bestätigt
                </th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <RowView key={r.attribute} row={r} links={links} selected={selected?.row.attribute === r.attribute} />
              ))}
            </tbody>
          </Table>
        </Panel>

        {selected && (
          <Panel
            title={selected.row.label}
            description={<Mono>{selected.row.attribute}</Mono>}
            actions={
              <ButtonLink href={links.attrHref(null)} size="sm" variant="ghost" scroll={false}>
                Schließen
              </ButtonLink>
            }
            className="xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto"
          >
            <AttributeDetail detail={selected} links={links} version={s.version} />
          </Panel>
        )}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {view.derived.length > 0 && (
          <Panel title="Abgeleitet" description="Werte, die aus anderen Attributen des Profils berechnet werden." flush>
            <ul className="divide-y divide-line text-sm">
              {view.derived.map((d) => (
                <li key={d.attribute} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                  <TextLink href={links.attrHref(d.attribute)} aria-current={selected?.row.attribute === d.attribute ? "true" : undefined}>
                    {d.label}
                  </TextLink>
                  <span className="text-right">{d.display}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="Lücken" description="Attribute ohne Wert im Profil und warum." flush>
          {view.gaps.length === 0 ? (
            <EmptyState title="Keine Lücken.">Alle Attribute des Profils haben einen Wert.</EmptyState>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {view.gaps.map((g) => (
                <li key={g.attribute} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5">
                  <span>
                    {g.label} <Mono>{g.attribute}</Mono>
                  </span>
                  <span className="text-muted">{profileGapReasonLabel(g.reason)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function RowView({ row: r, links, selected }: { row: ProfileRow; links: ProfileLinks; selected: boolean }) {
  return (
    <tr className={cx(trClass, selected && "bg-accent-soft/60 hover:bg-accent-soft/60")}>
      <td className={tdClass}>
        <Link
          href={links.attrHref(selected ? null : r.attribute)}
          aria-current={selected ? "true" : undefined}
          scroll={false}
          className={cx("text-accent underline-offset-2 hover:underline", selected && "font-medium")}
        >
          {r.label}
        </Link>
        <span className="block">
          <Mono>{r.attribute}</Mono>
        </span>
      </td>
      <td className={tdClass}>
        {r.display}
        <Markers row={r} />
      </td>
      <td className={tdClass}>
        <Badge tone={CONFIDENCE_CLASS_TONES[r.confidenceClass]}>
          {CONFIDENCE_CLASS_LABELS[r.confidenceClass]} <span className="tabular-nums">{share(r.confidence)}</span>
        </Badge>
      </td>
      <td className={tdClass}>
        {PROVENANCE_ORIGIN_LABELS[r.origin]}
        <span className="block text-xs text-muted" title="Regel, nach der der Wert gebildet wurde">
          {r.ruleLabel}
        </span>
      </td>
      <td className={cx(tdClass, "whitespace-nowrap text-xs tabular-nums text-muted")}>
        <span className="block" title="Zuerst beobachtet">
          {r.observedAt ?? "–"}
        </span>
        <span className="block" title="Zuletzt bestätigt">
          {r.lastConfirmedAt ?? "–"}
        </span>
      </td>
    </tr>
  );
}

/** A conflict decided seasonally or left open stays so for this value pair (ruling M5-F-R3 M-6). */
function ConflictMarker({ row: r, conflict: c }: { row: ProfileRow; conflict: ConflictNote }) {
  return (
    <span className="mt-1 block text-xs text-danger">
      Konflikt: {formatProfileValue(r.attribute, c.a.value)} ↔ {formatProfileValue(r.attribute, c.b.value)}
      {c.others.length > 0 && ` (+${c.others.length} weitere)`}
      {c.resolution && ` · ${CONFLICT_RESOLUTION_LABELS[c.resolution]}`}
      {(c.resolution === "seasonal" || c.resolution === "left_open") && " (dauerhaft für dieses Wertepaar)"}
      {r.conflictTaskId && (
        <>
          {" "}
          ·{" "}
          <Link href={`/review/${r.conflictTaskId}`} className="underline underline-offset-2">
            Aufgabe
          </Link>
        </>
      )}
    </span>
  );
}

function Markers({ row: r }: { row: ProfileRow }) {
  return (
    <>
      {r.conflict && <ConflictMarker row={r} conflict={r.conflict} />}
      {r.expired && <span className="mt-1 block text-xs text-warn">abgelaufen</span>}
      {r.onlyGoneSources && <span className="mt-1 block text-xs text-warn">nur verschwundene Quellen</span>}
      {r.pending && (
        <span className="mt-1 block text-xs text-warn">
          Änderung in Prüfung: {r.pending.display} ·{" "}
          <Link href={`/review/${r.pending.taskId}`} className="underline underline-offset-2">
            Aufgabe
          </Link>
        </span>
      )}
    </>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      {children}
    </section>
  );
}

function AttributeDetail({ detail: d, links, version }: { detail: AttributeFactsView; links: ProfileLinks; version: number }) {
  const r = d.row;
  return (
    <div className="space-y-5 text-sm">
      {r.conflict && (
        <Section title="Konflikt">
          <ul className="space-y-1 text-xs">
            {[r.conflict.a, r.conflict.b, ...r.conflict.others].map((side, i) => (
              <li key={i}>
                <span className="font-medium">{i === 0 ? "A" : i === 1 ? "B" : "weiterer Wert"}:</span>{" "}
                {formatProfileValue(r.attribute, side.value)} · Gewicht {share(side.weight)} ·{" "}
                {side.observedFrom === side.observedTo ? side.observedFrom : `${side.observedFrom} – ${side.observedTo}`}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {d.entries && (
        <Section title="Einträge">
          <ul className="space-y-3">
            {d.entries.map((e) => (
              <li key={e.key} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p>
                    <span className="font-medium">{e.display}</span>{" "}
                    <span className="text-xs text-muted">
                      · {e.inputIds.length} {e.inputIds.length === 1 ? "Beleg" : "Belege"}
                      {e.otherInputs.length > 0 && ` (davon ${e.otherInputs.length} aus Berechnung/Highlight)`}
                    </span>
                    {e.inReview && (
                      <span className="mt-1 block text-xs text-warn">ohne Beleg, bleibt bis zur Prüfung der Änderung</span>
                    )}
                  </p>
                  {e.removable &&
                    (links.confirm === e.key ? (
                      <form action={removeProfileEntryAction} className="flex items-center gap-2">
                        <input type="hidden" name="geoObjectId" value={links.geoObjectId} />
                        <input type="hidden" name="attribute" value={r.attribute} />
                        <input type="hidden" name="entryKey" value={e.key} />
                        <input type="hidden" name="version" value={version} />
                        {links.placeId && <input type="hidden" name="placeId" value={links.placeId} />}
                        <Button variant="danger" size="sm" className="bg-danger-soft">
                          Wirklich entfernen?
                        </Button>
                        <ButtonLink href={links.attrHref(r.attribute)} size="sm" variant="ghost" scroll={false}>
                          Abbrechen
                        </ButtonLink>
                      </form>
                    ) : (
                      <Link
                        href={`${links.attrHref(r.attribute)}&confirm=${encodeURIComponent(e.key)}`}
                        scroll={false}
                        title="Legt einen Prüf-Fact an, der den Eintrag aus dem Profil nimmt; danach wird das Profil neu berechnet."
                        className={buttonClass("danger", "sm")}
                      >
                        Eintrag entfernen
                      </Link>
                    ))}
                </div>
                {e.otherInputs.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
                    {e.otherInputs.map((i) => (
                      <li key={`${i.type}:${i.id}`}>
                        {i.type === "poi" ? (
                          <>
                            Highlight: <TextLink href={`/geo/${i.id}`}>{i.name ?? i.id.slice(0, 8)}</TextLink>
                          </>
                        ) : (
                          <>
                            Berechnung: {(i.kind && COMPUTATION_KIND_LABELS[i.kind as keyof typeof COMPUTATION_KIND_LABELS]) ?? i.kind ?? "unbekannt"}
                            {i.createdAt && ` vom ${time(i.createdAt)}`} <Mono>{i.id.slice(0, 8)}</Mono>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {e.facts.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {e.facts.map((f) => (
                      <FactCard key={f.id} fact={f} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Facts (${d.facts.length})`}>
        {d.facts.length === 0 ? (
          <p className="text-muted">Keine Facts.</p>
        ) : (
          <ul className="space-y-2">
            {d.facts.map((f) => (
              <FactCard key={f.id} fact={f} />
            ))}
          </ul>
        )}
      </Section>
      {d.computations.length > 0 && (
        <Section title="Berechnungen">
          <ul className="space-y-0.5">
            {d.computations.map((c) => (
              <li key={c.id}>
                {COMPUTATION_KIND_LABELS[c.kind as keyof typeof COMPUTATION_KIND_LABELS] ?? c.kind} vom {time(c.createdAt)}{" "}
                <Mono>{c.id.slice(0, 8)}</Mono>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {d.pois.length > 0 && (
        <Section title="Highlights">
          <ul className="space-y-0.5">
            {d.pois.map((p) => (
              <li key={p.id}>
                <TextLink href={`/geo/${p.id}`}>{p.name}</TextLink>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.derivedFrom && (
        <Section title="Herleitung">
          <Dialog trigger="Herleitung anzeigen" triggerSize="sm" title={`Herleitung: ${r.label}`} description="Die Eingangswerte, aus denen der Wert abgeleitet wurde." wide>
            <pre className="overflow-x-auto rounded-md bg-sunken p-3 font-mono text-xs">{JSON.stringify(r.derivedFrom, null, 2)}</pre>
          </Dialog>
        </Section>
      )}
    </div>
  );
}

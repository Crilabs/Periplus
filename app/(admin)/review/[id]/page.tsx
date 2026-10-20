import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import type { ProposalRobots } from "@/lib/domain/discovery/proposals";
import {
  detailFeatures,
  nextTaskHref,
  reviewTaskDetail,
  reviewTaskTitle,
  type GeoObjectView,
  type NearbyPlace,
  type SourceSuggestion,
} from "@/lib/domain/review-view";
import { QUEUES } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";
import { AnnotatedText } from "../../_components/annotated-text";
import { CrawlRulesFields } from "../../_components/crawl-rules-fields";
import { DecisionKeys } from "../../_components/decision-keys";
import { Dialog } from "../../_components/dialog";
import {
  CHANGE_RATE_LABELS,
  COMPARISON_ATTRIBUTE_LABELS,
  CRAWL_RULE_LABELS,
  DOC_TYPE_LABELS,
  FACT_ORIGIN_LABELS,
  factAttributeLabel,
  formatFactValue,
  GEO_OBJECT_TYPE_LABELS,
  GEO_ORIGIN_LABELS,
  NAME_CANDIDATE_STATUS_LABELS,
  NAME_HINT_LABELS,
  NAME_ORIGIN_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  POI_CATEGORY_LABELS,
  RESTRICTED_KIND_LABELS,
  REVIEW_KIND_LABELS,
  SOURCE_STATUS_LABELS,
  SUMMARY_FAILURE_LABELS,
  RUN_NOT_STARTED_NOTICE,
} from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import {
  Badge,
  ButtonLink,
  cx,
  DescriptionList,
  EmptyState,
  Field,
  fmt,
  inputClass,
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
import { REVIEW_KIND_HELP, REVIEW_STATUS_LABELS, REVIEW_STATUS_TONES } from "../kinds";
import { approveSourceAction } from "./actions";
import { ComparisonDecision } from "./comparison-decision";
import { DecisionForm } from "./decision-form";
import { NameCandidateCreate } from "./name-candidate";
import { DecisionPanel, Disclosure, Kbd, MapLegend } from "./parts";
import { PlaceConfirm } from "./place-confirm";
import { ProfileDecision } from "./profile-decision";

/** The tab title: the task's kind and subject (UI-15). */
export async function generateMetadata({ params }: PageProps<"/review/[id]">): Promise<Metadata> {
  await requireAdmin();
  const task = await reviewTaskTitle(getDb(), (await params).id);
  return { title: task ? `${REVIEW_KIND_LABELS[task.kind]}${task.name ? `: ${task.name}` : ""}` : "Prüfen" };
}

const distance = (m: number) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
const SELECT = cx(inputClass, "h-8 min-w-0 max-w-full");
/** Search hits and text occurrences shown on the page; the rest is in a dialog. */
const SHOWN_HITS = 5;
const SHOWN_OCCURRENCES = 3;

const PLACE_STATUS_TONES: Record<keyof typeof PLACE_STATUS_LABELS, Tone> = {
  candidate: "warn",
  confirmed: "ok",
  rejected: "neutral",
  abandoned: "neutral",
  no_anchoring: "neutral",
};
const SOURCE_STATUS_TONES: Record<keyof typeof SOURCE_STATUS_LABELS, Tone> = {
  proposed: "warn",
  approved: "ok",
  rejected: "neutral",
  paused: "neutral",
};

/** Labels of the fields `approveSourceAction` names in `?invalid=`. */
const APPROVAL_FIELD_LABELS: Record<string, string> = {
  type: "Typ",
  weight: "Gewicht",
  changeRate: "Änderungsrate",
  ...CRAWL_RULE_LABELS,
};

function robotsText(robots: ProposalRobots | null): string {
  if (!robots) return "–";
  if (robots.status === "unavailable") return "Nicht lesbar (wird beim Crawl erneut gelesen)";
  if (robots.status === "allow_all") return "Keine robots.txt – alles erlaubt";
  return [
    robots.disallowAll ? "Crawlen der Website verboten" : "Crawlen erlaubt",
    robots.blockedStartUrls.length > 0 && `gesperrte Start-URLs: ${robots.blockedStartUrls.join(", ")}`,
    robots.crawlDelaySec !== null && `Crawl-Delay ${robots.crawlDelaySec} s`,
    `${robots.sitemaps} Sitemap${robots.sitemaps === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function suggestionText(s: SourceSuggestion): string {
  return `${DOC_TYPE_LABELS[s.type]}, Gewicht ${s.weight.toLocaleString("de-DE", { maximumFractionDigits: 2 })}, ${CHANGE_RATE_LABELS[s.changeRate]}`;
}

/** "Bucht", "Highlight (Essen)", or the raw hint when it is unknown. */
function hintLabel(hint: string | null): string {
  if (!hint) return "–";
  if (hint.startsWith("poi:")) {
    const category = hint.slice(4);
    return `Highlight (${Object.hasOwn(POI_CATEGORY_LABELS, category) ? POI_CATEGORY_LABELS[category as keyof typeof POI_CATEGORY_LABELS] : category})`;
  }
  return Object.hasOwn(NAME_HINT_LABELS, hint) ? NAME_HINT_LABELS[hint as keyof typeof NAME_HINT_LABELS] : hint;
}

/** Names, type and origin of a geo object; external and internal IDs fold away. */
function ObjectFacts({ o }: { o: GeoObjectView }) {
  const external = [
    o.osmId && `OSM ${o.osmId}`,
    o.wikidataId && `Wikidata ${o.wikidataId}`,
    o.geonamesId && `GeoNames ${o.geonamesId}`,
  ].filter(Boolean);
  return (
    <div className="space-y-4">
      <DescriptionList
        items={[
          { label: "Typ", value: GEO_OBJECT_TYPE_LABELS[o.type] },
          { label: "Herkunft", value: GEO_ORIGIN_LABELS[o.origin] },
          {
            label: "Namen",
            value:
              o.names.length === 0 ? (
                "–"
              ) : (
                <ul className="space-y-0.5">
                  {o.names.map((n, i) => (
                    <li key={i}>
                      {n.name}{" "}
                      <span className="text-xs text-muted">
                        ({n.language}, {NAME_ORIGIN_LABELS[n.origin]})
                      </span>
                    </li>
                  ))}
                </ul>
              ),
          },
          { label: "Externe IDs", value: external.length > 0 ? <Mono>{external.join(" · ")}</Mono> : "–" },
        ]}
      />
      <p className="text-xs text-muted">
        Geo-Objekt <Mono>{o.id}</Mono>
      </p>
    </div>
  );
}

/** Places near the subject; the status stays inside the line's text (never a lone element). */
function NearbyList({ nearby }: { nearby: NearbyPlace[] }) {
  if (nearby.length === 0) return <p className="text-sm text-muted">Keine Orte in der Nähe.</p>;
  return (
    <ul className="divide-y divide-line text-sm">
      {nearby.map((n) => (
        <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 first:pt-0 last:pb-0">
          <span className="font-medium">{n.name ?? <Mono>{n.id}</Mono>}</span>
          <span className="text-xs text-muted">
            {PLACE_KIND_LABELS[n.kind]} · {PLACE_STATUS_LABELS[n.status]} · {distance(n.distanceM)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted">{children}</span>;
}

export default async function Page({ params, searchParams }: PageProps<"/review/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const query = await searchParams;
  const db = getDb();
  const [detail, nextHref] = await Promise.all([reviewTaskDetail(db, id.data), nextTaskHref(db, id.data)]);
  if (!detail) notFound();
  const { task, subject } = detail;
  const open = task.status === "open";
  const openedAt = new Date().toISOString();
  const features = detailFeatures(detail);
  const props = { taskId: task.id, openedAt };
  const invalid = typeof query.invalid === "string" ? query.invalid.split(",") : [];
  const crawlInvalid = invalid.some((f) => Object.hasOwn(CRAWL_RULE_LABELS, f));

  return (
    <>
      <DecisionKeys nextHref={nextHref} />
      <PageHeader
        back={{ href: `/review?kind=${task.kind}`, label: "Zurück zur Liste" }}
        title={
          <>
            {subject.type === "name_candidate" ? `Neuer Name: ${subject.candidate.name}` : REVIEW_KIND_LABELS[task.kind]}
            {subject.type === "place" && subject.geoObject.names[0] ? `: ${subject.geoObject.names[0].name}` : ""}
            {subject.type === "place" && !subject.geoObject.names[0] && subject.helperName ? `: ${subject.helperName}` : ""}
            {subject.type === "source" ? `: ${subject.source.domain}` : ""}
            {subject.type === "profile_attribute" ? `: ${subject.name ?? subject.geoObjectId} – ${subject.label}` : ""}
            {subject.type === "profile_summary" ? `: Zusammenfassung von ${subject.name ?? subject.geoObjectId}` : ""}
            {subject.type === "comparison"
              ? `: ${subject.place.name ?? subject.place.id} – ${COMPARISON_ATTRIBUTE_LABELS[subject.attribute]}`
              : ""}
          </>
        }
        meta={
          <>
            <Badge tone="accent">{REVIEW_KIND_LABELS[task.kind]}</Badge>
            <Badge tone={REVIEW_STATUS_TONES[task.status]}>{REVIEW_STATUS_LABELS[task.status]}</Badge>
            {subject.type === "comparison" && subject.evaluationRunId && <Badge tone="neutral">Bewertung</Badge>}
            <span title={fmt.dateTime(task.createdAt)}>erstellt {fmt.ago(task.createdAt)}</span>
            {task.priority !== 0 && <span title="Höhere Priorität kommt früher in der Warteschlange">· Priorität {task.priority}</span>}
          </>
        }
        description={REVIEW_KIND_HELP[task.kind]}
        actions={
          <span className="inline-flex items-center gap-2">
            <ButtonLink href={nextHref}>Nächste Aufgabe</ButtonLink>
            <Kbd title="Taste n">n</Kbd>
          </span>
        }
      />

      <div className="space-y-6">
        {(query.notice === "run_not_started" ||
          !open ||
          query.stale ||
          (query.changed && open) ||
          (query.error && open) ||
          (invalid.length > 0 && open)) && (
          <div className="space-y-3">
            {query.notice === "run_not_started" && <Notice tone="warn">{RUN_NOT_STARTED_NOTICE}</Notice>}
            {(!open || query.stale) && (
              <Notice tone={task.status === "dismissed" ? "neutral" : "ok"} title="Bereits entschieden">
                {task.status === "dismissed"
                  ? "Die Pipeline hat diese Aufgabe geschlossen, weil sie sich inzwischen erledigt hat. Eine Entscheidung ist hier nicht mehr möglich; die Belege bleiben zur Ansicht."
                  : "Für diese Aufgabe liegt schon eine Entscheidung vor; eine zweite ist nicht möglich. Die Belege bleiben zur Ansicht."}
              </Notice>
            )}
            {query.changed && open && (
              <Notice tone="danger" title="Der Wert hat sich geändert – bitte neu laden">
                Ein späterer Lauf hat die Frage dieser Aufgabe ersetzt. Es wurde nichts gespeichert.
              </Notice>
            )}
            {query.error && open && (
              <Notice tone="danger" title="Diese Entscheidung ist nicht möglich.">
                Sie passt nicht zur Aufgabe, oder ihr Gegenstand oder Ziel ist nicht mehr gültig (z. B. inzwischen
                zusammengeführt). Es wurde nichts gespeichert.
              </Notice>
            )}
            {invalid.length > 0 && open && (
              <Notice
                tone="danger"
                title={`Ungültige Eingaben: ${invalid.map((f) => (Object.hasOwn(APPROVAL_FIELD_LABELS, f) ? APPROVAL_FIELD_LABELS[f] : f)).join(", ")}`}
              >
                Es wurde nichts gespeichert. Die Werte korrigieren und erneut freigeben.
              </Notice>
            )}
          </div>
        )}

        {subject.type === "missing" && (
          <Panel>
            <EmptyState title="Der Gegenstand dieser Aufgabe wurde nicht gefunden.">
              Er wurde gelöscht oder zusammengeführt, oder diese Aufgabenart hat noch keine Ansicht. Gegenstand:{" "}
              <Mono>
                {task.subjectType} {task.subjectId}
              </Mono>
            </EmptyState>
          </Panel>
        )}

        {subject.type === "profile_attribute" && (task.kind === "conflict" || task.kind === "uncertain_change") && (
          <ProfileDecision kind={task.kind} subject={subject} {...props} open={open} />
        )}

        {subject.type === "comparison" && <ComparisonDecision subject={subject} features={features} {...props} open={open} />}

        {subject.type === "place" && (
          <>
            {subject.restrictions && (
              <Notice tone="danger" title="Dieser bestätigte Ort liegt in einem Sperrgebiet mit Ankerverbot">
                <ul className="space-y-0.5">
                  {subject.restrictions.map((r) => (
                    <li key={r.id}>
                      {RESTRICTED_KIND_LABELS[r.kind] ?? r.kind}
                      {r.share !== null && <> – {Math.round(r.share * 100)} % der Ankerfläche</>}
                      {r.sourceRef && (
                        <>
                          {" "}
                          · <Mono>{r.sourceRef}</Mono>
                        </>
                      )}
                      {r.sourceName && <> · Quelle {r.sourceName}</>}
                    </li>
                  ))}
                </ul>
                Ein Kandidat wäre automatisch ausgeschlossen worden. „Kein Ankerplatz“ schließt den Ort aus; „Trotz Sperrgebiet
                bestätigen“ behält ihn für diese Gebiete. Ein weiteres Gebiet, das der letzte Geometrie-Lauf gefunden hat, folgt
                sofort als nächste Aufgabe; ein danach geladenes fragt nach dem nächsten Geometrie-Lauf.
              </Notice>
            )}
            <PlaceConfirm
              {...props}
              defaultKind={subject.place.kind}
              features={features}
              open={open}
              confirmLabel={subject.restrictions ? "Trotz Sperrgebiet bestätigen" : undefined}
              question={
                subject.restrictions
                  ? "Darf hier trotz Sperrgebiet geankert werden? Sonst als „kein Ankerplatz“ markieren."
                  : "Ist das ein eigener Ort? Bestätigen, einem Ort in der Nähe zuordnen, verwerfen oder als „kein Ankerplatz“ markieren."
              }
            >
              <DecisionForm
                {...props}
                n={2}
                label="Einem Ort zuordnen"
                disabled={subject.nearby.length === 0}
                hint={
                  subject.nearby.length === 0
                    ? "Keine Orte in der Nähe, denen er zugeordnet werden könnte."
                    : "Derselbe Ort wie ein Ort in der Nähe: dieser wird verworfen und auf den gewählten verwiesen."
                }
              >
                {subject.nearby.length > 0 && (
                  <select name="decision" aria-label="Ort" className={cx(SELECT, "flex-1")}>
                    {subject.nearby.map((n) => (
                      <option
                        key={n.id}
                        value={JSON.stringify({
                          action: "merge",
                          intoPlaceId: n.id,
                        })}
                      >
                        {n.name ?? n.id} ({distance(n.distanceM)})
                      </option>
                    ))}
                  </select>
                )}
              </DecisionForm>
              <DecisionForm {...props} n={3} label="Verwerfen" decision={{ action: "reject" }} variant="danger" hint="Kein Ort: wird als verworfen markiert." />
              <DecisionForm
                {...props}
                n={4}
                label="Kein Ankerplatz"
                decision={{ action: "no_anchoring" }}
                hint="Der Ort existiert, taugt aber nicht zum Ankern."
              />
            </PlaceConfirm>
            <div className="grid gap-6 lg:grid-cols-3">
              <Panel title="Ort">
                <DescriptionList
                  columns={1}
                  items={[
                    { label: "Art", value: PLACE_KIND_LABELS[subject.place.kind] },
                    {
                      label: "Status",
                      value: <Badge tone={PLACE_STATUS_TONES[subject.place.status]}>{PLACE_STATUS_LABELS[subject.place.status]}</Badge>,
                    },
                    { label: "Position", value: <Mono>{coord(subject.place.position.lat, subject.place.position.lon)}</Mono> },
                    { label: "Kachel", value: subject.place.tileId ? <Mono>{subject.place.tileId}</Mono> : "–" },
                    !!subject.place.publicId && { label: "Öffentliche ID", value: <Mono>{subject.place.publicId}</Mono> },
                  ]}
                />
              </Panel>
              <Panel title="Geo-Objekt">
                {subject.helperName && (
                  <p className="mb-3 text-sm text-muted">
                    Unbenannte Bucht, aus der Geometrie erkannt. „{subject.helperName}“ ist nur ein Hilfsname und wird
                    nicht als Name gespeichert.
                  </p>
                )}
                <ObjectFacts o={subject.geoObject} />
              </Panel>
              <Panel title="Nächste Orte" description="Gültige Orte anderer Objekte, nächster zuerst.">
                <NearbyList nearby={subject.nearby} />
              </Panel>
            </div>
            <Panel
              title="Bisherige Facts"
              description="Je Attribut der neueste Fact: berechnet (Schutz, Tiefe) oder aus Texten mit Quelle und Gewicht."
              actions={
                subject.facts.length > 0 && (
                  <TextLink href={`/places/${subject.place.id}?tab=facts`} className="text-sm">
                    Alle Facts
                  </TextLink>
                )
              }
              flush
            >
              {subject.facts.length === 0 ? (
                <EmptyState title="Noch keine Facts">Facts entstehen mit dem Geometrie-Lauf und der Auswertung der Texte.</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th className={thClass}>Attribut</th>
                      <th className={thClass}>Wert</th>
                      <th className={thClass}>Herkunft</th>
                      <th className={thClass}>Quelle (Gewicht)</th>
                      <th className={cx(thClass, "text-right")}>Facts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subject.facts.map(({ attribute, newest, count }) => (
                      <tr key={attribute} className={trClass}>
                        <td className={tdClass}>{factAttributeLabel(attribute)}</td>
                        <td className={tdClass}>{formatFactValue(attribute, newest.value)}</td>
                        <td className={tdClass}>{FACT_ORIGIN_LABELS[newest.origin]}</td>
                        <td className={tdClass}>
                          {newest.source
                            ? `${newest.source.domain} (${newest.source.weight.toLocaleString("de-DE", { maximumFractionDigits: 2 })})`
                            : "–"}
                        </td>
                        <td className={cx(tdClass, numClass)}>{count}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </>
        )}

        {subject.type === "geo_object_pair" && (
          <>
            <div className="grid gap-6 lg:grid-cols-5">
              {open && (
                <DecisionPanel question="Beschreiben die beiden Geo-Objekte dasselbe?" className="lg:col-span-2">
                  <DecisionForm
                    {...props}
                    n={1}
                    label="Gleiches Objekt"
                    decision={{ action: "same" }}
                    variant="primary"
                    hint="Führt beide zusammen; es bleibt das Objekt mit OSM-ID, sonst das ältere."
                  />
                  <DecisionForm
                    {...props}
                    n={2}
                    label="Verschiedene Objekte"
                    decision={{ action: "distinct" }}
                    hint="Beide bleiben getrennt; das Paar wird nicht erneut vorgelegt."
                  />
                </DecisionPanel>
              )}
              <Panel title="Karte" className={open ? "lg:col-span-3" : "lg:col-span-5"}>
                <MiniMap features={features} />
                <MapLegend items={[["subject", "Beide Objekte"]]} />
              </Panel>
            </div>
            <Panel title="Vergleich">
              <DescriptionList
                columns={2}
                items={[
                  { label: "Abstand", value: subject.distanceM === null ? "–" : distance(subject.distanceM) },
                  {
                    label: "Ähnlichkeit",
                    hint: "Ähnlichkeit der Namen von 0 bis 1",
                    value:
                      subject.similarity === null
                        ? "–"
                        : subject.similarity.toLocaleString("de-DE", {
                            maximumFractionDigits: 2,
                          }),
                  },
                ]}
              />
            </Panel>
            <div className="grid gap-6 lg:grid-cols-2">
              {subject.objects.map((o, i) => (
                <Panel key={o.id} title={`Objekt ${i + 1}`}>
                  <ObjectFacts o={o} />
                </Panel>
              ))}
            </div>
          </>
        )}

        {subject.type === "tile" && (
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="space-y-6 lg:col-span-2">
              {open && (
                <DecisionPanel question="Zu welchem Revier gehört die Kachel?">
                  <DecisionForm
                    {...props}
                    n={1}
                    label="Revier zuordnen"
                    disabled={subject.areas.length === 0}
                    variant="primary"
                    hint={subject.areas.length === 0 ? "Es gibt kein Revier zur Auswahl." : "Reviere nach Abstand zur Kachel, nächstes zuerst."}
                  >
                    {subject.areas.length > 0 && (
                      <select name="decision" aria-label="Revier" className={cx(SELECT, "flex-1")}>
                        {subject.areas.map((a) => (
                          <option
                            key={a.id}
                            value={JSON.stringify({
                              action: "assign_area",
                              areaId: a.id,
                            })}
                          >
                            {a.name ?? a.id} ({distance(a.distanceM)})
                          </option>
                        ))}
                      </select>
                    )}
                  </DecisionForm>
                  <DecisionForm
                    {...props}
                    n={2}
                    label="Kein Revier nötig"
                    decision={{ action: "no_area" }}
                    hint="Die Kachel bleibt ohne Revier und wird nicht erneut vorgelegt."
                  />
                </DecisionPanel>
              )}
              <Panel title="Kachel">
                <DescriptionList
                  columns={1}
                  items={[
                    { label: "Kachel", value: <Mono>{subject.tile.id}</Mono> },
                    { label: "Küste", value: subject.tile.hasCoast ? "Ja" : "Nein" },
                    {
                      label: "Revier",
                      value: subject.areas.find((a) => a.id === subject.tile.areaId)?.name ?? subject.tile.areaId ?? "–",
                    },
                  ]}
                />
              </Panel>
            </div>
            <Panel title="Karte" className="lg:col-span-3">
              <MiniMap features={features} />
              <MapLegend items={[["subject", "Kachel"]]} />
            </Panel>
          </div>
        )}

        {subject.type === "name_candidate" && (
          <>
            <NameCandidateCreate
              {...props}
              name={subject.candidate.name}
              features={features}
              hits={subject.hits}
              objectTypes={subject.objectTypes}
              suggestedKind={subject.suggestedKind}
              open={open}
              question="Wofür steht der Name? Neu anlegen, einem bekannten Objekt zuordnen oder verwerfen."
            >
              <DecisionForm
                {...props}
                n={2}
                label="Einem Objekt zuordnen"
                disabled={subject.objects.length === 0}
                hint={
                  subject.objects.length === 0
                    ? "In der Kachel und ihren Nachbarn gibt es kein Objekt zur Auswahl."
                    : "Fügt den Namen einem Objekt der Kachel oder ihrer Nachbarn hinzu (nächstes zuerst)."
                }
              >
                {subject.objects.length > 0 && (
                  <select name="decision" aria-label="Objekt" className={cx(SELECT, "flex-1")}>
                    {subject.objects.map((o) => (
                      <option key={o.id} value={JSON.stringify({ action: "assign_name", geoObjectId: o.id })}>
                        {o.name ?? o.id} ({GEO_OBJECT_TYPE_LABELS[o.type]}, {distance(o.distanceM)})
                      </option>
                    ))}
                  </select>
                )}
              </DecisionForm>
              <DecisionForm
                {...props}
                n={3}
                label="Verwerfen"
                decision={{ action: "reject" }}
                variant="danger"
                hint="Kein Ortsname: es entsteht kein Objekt."
              />
            </NameCandidateCreate>

            <Panel
              title="Fundstellen"
              description={`${subject.candidate.documents} Dokumente aus ${subject.candidate.sources} Quellen nennen den Namen in dieser Kachel.`}
              actions={
                subject.occurrences.length > SHOWN_OCCURRENCES && (
                  <Dialog trigger={`Alle ${subject.occurrences.length} Fundstellen`} triggerSize="sm" title="Fundstellen" wide>
                    <Occurrences items={subject.occurrences} />
                  </Dialog>
                )
              }
            >
              {subject.occurrences.length === 0 ? (
                <p className="text-sm text-muted">Keine Fundstellen gespeichert.</p>
              ) : (
                <Occurrences items={subject.occurrences.slice(0, SHOWN_OCCURRENCES)} />
              )}
            </Panel>

            <div className="grid gap-6 lg:grid-cols-3">
              <Panel title="Name">
                <DescriptionList
                  columns={1}
                  items={[
                    { label: "Name", value: subject.candidate.name },
                    { label: "Hinweis", hint: "Art, auf die der Name hindeutet, z. B. Bucht oder Hafen", value: hintLabel(subject.candidate.hint) },
                    { label: "Kachel", value: <Mono>{subject.candidate.tileId}</Mono> },
                    { label: "Status", value: NAME_CANDIDATE_STATUS_LABELS[subject.candidate.status] },
                  ]}
                />
              </Panel>
              <Panel title="Nominatim-Treffer" description="Geokodierung des Namens im Umkreis der Kachel.">
                {subject.hits.length === 0 ? (
                  <p className="text-sm text-muted">Keine Treffer im Umkreis – Position per Klick in die Karte setzen.</p>
                ) : (
                  <ul className="divide-y divide-line text-sm">
                    {subject.hits.map((h) => (
                      <li key={h.osmId} className="py-2 first:pt-0 last:pb-0">
                        <p className="font-medium">{h.name}</p>
                        <p className="text-xs text-muted">
                          {h.category}/{h.type}, {distance(h.distanceM)} vom Kachelmittelpunkt · <Mono>{h.osmId}</Mono>
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Nächste Orte" description="Orte nahe dem Kachelmittelpunkt, nächster zuerst.">
                <NearbyList nearby={subject.nearby} />
              </Panel>
            </div>
          </>
        )}

        {subject.type === "profile_summary" && (
          <div className="grid gap-6 lg:grid-cols-5">
            {open && (
              <DecisionPanel question="Die Zusammenfassung dieser Profilversion ist leer geblieben. Erneut versuchen?" className="lg:col-span-2">
                <DecisionForm
                  {...props}
                  n={1}
                  label="Neu erzeugen"
                  decision={{ action: "regenerate_summary" }}
                  variant="primary"
                  hint="Startet die Zusammenfassung für dieses Objekt erneut."
                />
                <DecisionForm {...props} n={2} label="Ignorieren" decision={{ action: "ignore" }} hint="Schließt die Aufgabe, ohne etwas zu tun." />
              </DecisionPanel>
            )}
            <Panel title="Zusammenfassung" className={open ? "lg:col-span-3" : "lg:col-span-5"}>
              <DescriptionList
                columns={2}
                items={[
                  {
                    label: "Objekt",
                    value: <TextLink href={`/geo/${subject.geoObjectId}`}>{subject.name ?? subject.geoObjectId}</TextLink>,
                  },
                  { label: "Profilversion", value: subject.version },
                  { label: "Versuche", value: subject.attempts ?? "–" },
                  {
                    label: "Gründe",
                    value:
                      subject.reasons.length === 0 ? (
                        "–"
                      ) : (
                        <ul className="space-y-0.5">
                          {subject.reasons.map((r, i) => (
                            <li key={i}>{SUMMARY_FAILURE_LABELS[r] ?? r}</li>
                          ))}
                        </ul>
                      ),
                  },
                ]}
              />
              {!open && <p className="mt-4 text-sm text-muted">Die Zusammenfassung dieser Profilversion ist leer geblieben.</p>}
            </Panel>
          </div>
        )}

        {subject.type === "job" && (
          <div className="grid gap-6 lg:grid-cols-5">
            {open && (
              <DecisionPanel question="Wie geht es mit dem gescheiterten Job weiter?" className="lg:col-span-2">
                <DecisionForm
                  {...props}
                  n={1}
                  label="Erneut starten"
                  decision={{ action: "retry" }}
                  variant="primary"
                  disabled={!(QUEUES as readonly (string | null)[]).includes(subject.job.queue)}
                  hint={
                    (QUEUES as readonly (string | null)[]).includes(subject.job.queue)
                      ? "Stellt den Job erneut in seine Warteschlange."
                      : "Nicht möglich: die Warteschlange des Jobs ist unbekannt."
                  }
                />
                <DecisionForm {...props} n={2} label="Ignorieren" decision={{ action: "ignore" }} hint="Schließt die Aufgabe, ohne etwas zu tun." />
                {subject.job.sourceId && (
                  <DecisionForm
                    {...props}
                    n={3}
                    label="Quelle pausieren"
                    decision={{ action: "pause_source" }}
                    variant="danger"
                    hint="Setzt die Quelle, an der der Job arbeitete, auf „Pausiert“."
                  />
                )}
              </DecisionPanel>
            )}
            <Panel
              title="Job"
              className={open ? "lg:col-span-3" : "lg:col-span-5"}
              actions={
                subject.job.error && (
                  <Dialog trigger="Ganze Fehlermeldung" triggerSize="sm" title="Fehlermeldung" wide>
                    <pre className="overflow-x-auto rounded-md bg-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                      {subject.job.error}
                    </pre>
                  </Dialog>
                )
              }
            >
              <div className="space-y-4">
                {subject.job.error && (
                  <p className="line-clamp-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 font-mono text-xs leading-relaxed break-all text-danger">
                    {subject.job.error}
                  </p>
                )}
                <DescriptionList
                  columns={2}
                  items={[
                    { label: "Warteschlange", value: subject.job.queue ? <Mono>{subject.job.queue}</Mono> : "–" },
                    { label: "Stufe", value: subject.job.stage ?? "–" },
                    { label: "Schlüssel", value: subject.job.key ? <Mono>{subject.job.key}</Mono> : "–" },
                    {
                      label: "Lauf",
                      value: subject.job.runId ? (
                        <TextLink href={`/runs/${subject.job.runId}`} title={subject.job.runId}>
                          <span className="font-mono text-[0.8125rem]">{subject.job.runId.slice(0, 8)}</span>
                        </TextLink>
                      ) : (
                        "–"
                      ),
                    },
                    { label: "Job", value: <Mono>{subject.job.id}</Mono> },
                    !!subject.job.sourceId && { label: "Quelle", value: <Mono>{subject.job.sourceId}</Mono> },
                  ]}
                />
                {!subject.job.error && <Hint>Keine Fehlermeldung gespeichert.</Hint>}
              </div>
            </Panel>
          </div>
        )}

        {subject.type === "source" && (
          <>
            <div className="grid gap-6 lg:grid-cols-5">
              {open && (
                <DecisionPanel
                  question="Die Website als Quelle freigeben? Die Werte sind vorbelegt und lassen sich vor der Freigabe ändern."
                  className="lg:col-span-3"
                >
                  <DecisionForm
                    {...props}
                    n={1}
                    label="Freigeben"
                    action={approveSourceAction}
                    variant="primary"
                    hint="Übernimmt die Werte und setzt die Quelle auf „Freigegeben“."
                  >
                    <div className="grid w-full gap-3 sm:grid-cols-3">
                      <Field label="Typ">
                        <select name="type" defaultValue={subject.suggestion.type} className={SELECT}>
                          {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Gewicht" hint="0 bis 1; wie stark Facts dieser Quelle zählen">
                        <input
                          type="number"
                          name="weight"
                          required
                          min={0}
                          max={1}
                          step={0.05}
                          defaultValue={subject.suggestion.weight}
                          className={SELECT}
                        />
                      </Field>
                      <Field label="Änderungsrate">
                        <select name="changeRate" defaultValue={subject.suggestion.changeRate} className={SELECT}>
                          {Object.entries(CHANGE_RATE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div className="w-full">
                      <Disclosure summary="Crawl-Regeln anpassen" defaultOpen={crawlInvalid}>
                        <CrawlRulesFields defaults={subject.suggestion.crawlRules} invalid={invalid} />
                      </Disclosure>
                    </div>
                  </DecisionForm>
                  <DecisionForm
                    {...props}
                    n={2}
                    label="Ablehnen"
                    decision={{ action: "reject" }}
                    variant="danger"
                    hint="Setzt die Quelle auf „Abgelehnt“: die Domain wird dauerhaft ignoriert."
                    confirm={{
                      title: "Quelle ablehnen",
                      description: `${subject.source.domain} wird dauerhaft ignoriert: nie gecrawlt und nie wieder vorgeschlagen. Das lässt sich nicht zurücknehmen.`,
                      confirmLabel: "Endgültig ablehnen",
                    }}
                  />
                </DecisionPanel>
              )}
              <Panel title="Quellenvorschlag" className={open ? "lg:col-span-2" : "lg:col-span-5"}>
                <DescriptionList
                  columns={1}
                  items={[
                    { label: "Domain", value: subject.source.domain },
                    {
                      label: "Status",
                      value: (
                        <>
                          <Badge tone={SOURCE_STATUS_TONES[subject.source.status]}>{SOURCE_STATUS_LABELS[subject.source.status]}</Badge>
                          {subject.source.statusReason && <Hint> {subject.source.statusReason}</Hint>}
                        </>
                      ),
                    },
                    {
                      label: "Suchtreffer",
                      value: subject.hitCount,
                      hint: "Treffer der Quellensuche, die auf diese Domain zeigen",
                    },
                    {
                      label: "Verlinkt von",
                      value: `${subject.linkingSources} freigegebenen Quelle${subject.linkingSources === 1 ? "" : "n"}`,
                    },
                    { label: "Sprachen", value: subject.languages.join(", ") || "–" },
                    { label: "robots.txt", value: robotsText(subject.robots) },
                    !!subject.originalSuggestion && {
                      label: "Ursprünglicher Vorschlag",
                      value: (
                        <>
                          {suggestionText(subject.originalSuggestion)}
                          {subject.editedSinceProposal && (
                            <Hint>
                              {" "}
                              Auf der Quellenseite geändert; das Formular zeigt die aktuellen Werte (
                              {suggestionText(subject.suggestion)}).
                            </Hint>
                          )}
                        </>
                      ),
                    },
                  ]}
                />
              </Panel>
            </div>
            {subject.hits.length > 0 && (
              <Panel
                title="Suchtreffer"
                description={
                  subject.hitCount > Math.min(SHOWN_HITS, subject.hits.length)
                    ? `Die besten ${Math.min(SHOWN_HITS, subject.hits.length)} von ${subject.hitCount} Treffern nach Rang.`
                    : "Treffer nach Rang."
                }
                actions={
                  subject.hits.length > SHOWN_HITS && (
                    <Dialog
                      trigger={`Alle ${subject.hits.length} Treffer`}
                      triggerSize="sm"
                      title="Suchtreffer"
                      description={subject.hitCount > subject.hits.length ? `Die besten ${subject.hits.length} von ${subject.hitCount}.` : undefined}
                      wide
                    >
                      <SerpHits hits={subject.hits} snippets />
                    </Dialog>
                  )
                }
                flush
              >
                <SerpHits hits={subject.hits.slice(0, SHOWN_HITS)} />
              </Panel>
            )}
          </>
        )}
      </div>
    </>
  );
}

type Hit = { keyword: string; languageCode: string; url: string; rank: number; title: string; snippet: string };

function SerpHits({ hits, snippets = false }: { hits: Hit[]; snippets?: boolean }) {
  return (
    <Table>
      <thead>
        <tr>
          <th className={cx(thClass, "text-right")}>Rang</th>
          <th className={thClass}>Titel und URL</th>
          {snippets && <th className={thClass}>Ausschnitt</th>}
          <th className={thClass}>Suchanfrage</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((h) => (
          <tr key={`${h.keyword}|${h.languageCode}|${h.url}`} className={trClass}>
            <td className={cx(tdClass, numClass)}>{h.rank}</td>
            <td className={cx(tdClass, "min-w-64")}>
              <p className="font-medium">{h.title}</p>
              <p className="font-mono text-xs break-all text-muted">{h.url}</p>
            </td>
            {snippets && <td className={cx(tdClass, "min-w-64 text-xs text-muted")}>{h.snippet}</td>}
            <td className={cx(tdClass, "whitespace-nowrap")}>
              {h.keyword} <span className="text-xs text-muted">({h.languageCode})</span>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

type Occurrence = { chunkId: string; documentId: string; url: string | null; snippet: string; start: number; end: number };

function Occurrences({ items }: { items: Occurrence[] }) {
  return (
    <ul className="space-y-3">
      {items.map((o) => (
        <li key={o.chunkId} className="space-y-1.5">
          <TextLink href={`/documents/${o.documentId}`} className="block truncate text-xs">
            {o.url ?? o.documentId}
          </TextLink>
          <blockquote className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed">
            …<AnnotatedText text={o.snippet} spans={[{ start: o.start, end: o.end, kind: "mention", ref: o.chunkId }]} />…
          </blockquote>
        </li>
      ))}
    </ul>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { detailFeatures, nextTaskHref, reviewTaskDetail, reviewTaskTitle, type GeoObjectView, type NearbyPlace } from "@/lib/domain/review-view";
import { QUEUES } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";
import { DecisionKeys } from "../../_components/decision-keys";
import { Dialog } from "../../_components/dialog";
import {
  COMPARISON_ATTRIBUTE_LABELS,
  GEO_OBJECT_TYPE_LABELS,
  GEO_ORIGIN_LABELS,
  languageLabel,
  NAME_ORIGIN_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  RESTRICTED_KIND_LABELS,
  REVIEW_KIND_LABELS,
  RUN_NOT_STARTED_NOTICE,
} from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import {
  Badge,
  ButtonLink,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  inputClass,
  Mono,
  Notice,
  PageHeader,
  Panel,
  TextLink,
  type Tone,
} from "../../_components/ui";
import { REVIEW_KIND_HELP, REVIEW_STATUS_LABELS, REVIEW_STATUS_TONES } from "../kinds";
import { ComparisonDecision } from "./comparison-decision";
import { DecisionForm } from "./decision-form";
import { DecisionPanel, Kbd, MapLegend } from "./parts";
import { PlaceConfirm } from "./place-confirm";
import { PlaceImageDecision } from "./place-image-decision";
import { ResearchConflictDecision } from "./research-conflict-decision";

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

const PLACE_STATUS_TONES: Record<keyof typeof PLACE_STATUS_LABELS, Tone> = {
  candidate: "warn",
  confirmed: "ok",
  rejected: "neutral",
  abandoned: "neutral",
  no_anchoring: "neutral",
};
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
                        ({languageLabel(n.language)}, {NAME_ORIGIN_LABELS[n.origin]})
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

  return (
    <>
      <DecisionKeys nextHref={nextHref} />
      <PageHeader
        back={{ href: `/review?kind=${task.kind}`, label: "Zurück zur Liste" }}
        title={
          <>
            {REVIEW_KIND_LABELS[task.kind]}
            {subject.type === "place" && subject.geoObject.names[0] ? `: ${subject.geoObject.names[0].name}` : ""}
            {subject.type === "place" && !subject.geoObject.names[0] && subject.helperName ? `: ${subject.helperName}` : ""}
            {subject.type === "comparison"
              ? `: ${subject.place.name ?? subject.place.id} – ${COMPARISON_ATTRIBUTE_LABELS[subject.attribute]}`
              : ""}
            {subject.type === "place_image" ? `: ${subject.place.name ?? subject.place.placeId}` : ""}
            {subject.type === "research_conflict" ? `: ${subject.place.name ?? subject.place.id}` : ""}
          </>
        }
        meta={
          <>
            <Badge tone="accent">{REVIEW_KIND_LABELS[task.kind]}</Badge>
            <Badge tone={REVIEW_STATUS_TONES[task.status]}>{REVIEW_STATUS_LABELS[task.status]}</Badge>
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
          (query.error && open)) && (
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
                {subject.type === "place_image"
                  ? "Ein späterer Lauf hat das Bild dieser Aufgabe ersetzt. Es wurde nichts gespeichert."
                  : "Ein späterer Lauf hat die Frage dieser Aufgabe ersetzt. Es wurde nichts gespeichert."}
              </Notice>
            )}
            {query.error && open && (
              <Notice tone="danger" title="Diese Entscheidung ist nicht möglich.">
                Sie passt nicht zur Aufgabe, oder ihr Gegenstand oder Ziel ist nicht mehr gültig (z. B. inzwischen
                zusammengeführt). Es wurde nichts gespeichert.
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

        {subject.type === "comparison" && <ComparisonDecision subject={subject} features={features} {...props} open={open} />}

        {subject.type === "place_image" && <PlaceImageDecision subject={subject} {...props} open={open} />}

        {subject.type === "research_conflict" && <ResearchConflictDecision subject={subject} features={features} {...props} open={open} />}

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
                <Notice tone="warn">
                  Diese Art Aufgabe entfällt: Jede Küstenkachel gehört zu einem Landesteil, Reviere werden gefunden, nicht zugeordnet.
                </Notice>
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
      </div>
    </>
  );
}

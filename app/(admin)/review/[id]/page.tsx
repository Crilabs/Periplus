import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import type { ProposalRobots } from "@/lib/domain/discovery/proposals";
import { detailFeatures, nextTaskHref, reviewTaskDetail, type GeoObjectView } from "@/lib/domain/review-view";
import { QUEUES } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";
import { AnnotatedText } from "../../_components/annotated-text";
import { CrawlRulesFields } from "../../_components/crawl-rules-fields";
import { DecisionKeys } from "../../_components/decision-keys";
import {
  CHANGE_RATE_LABELS,
  CRAWL_RULE_LABELS,
  DOC_TYPE_LABELS,
  GEO_OBJECT_TYPE_LABELS,
  GEO_ORIGIN_LABELS,
  NAME_CANDIDATE_STATUS_LABELS,
  NAME_HINT_LABELS,
  NAME_ORIGIN_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  POI_CATEGORY_LABELS,
  REVIEW_KIND_LABELS,
  SOURCE_STATUS_LABELS,
} from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import { approveSourceAction } from "./actions";
import { DecisionForm } from "./decision-form";
import { NameCandidateCreate } from "./name-candidate";
import { PlaceConfirm } from "./place-confirm";

const distance = (m: number) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
const SELECT = "max-w-full rounded border border-neutral-300 px-1 py-0.5";

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

/** "Bucht", "Highlight (Essen)", or the raw hint when it is unknown. */
function hintLabel(hint: string | null): string {
  if (!hint) return "–";
  if (hint.startsWith("poi:")) {
    const category = hint.slice(4);
    return `Highlight (${Object.hasOwn(POI_CATEGORY_LABELS, category) ? POI_CATEGORY_LABELS[category as keyof typeof POI_CATEGORY_LABELS] : category})`;
  }
  return Object.hasOwn(NAME_HINT_LABELS, hint) ? NAME_HINT_LABELS[hint as keyof typeof NAME_HINT_LABELS] : hint;
}

function ObjectFacts({ o }: { o: GeoObjectView }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
      <dt>Namen</dt>
      <dd>
        {o.names.length === 0
          ? "–"
          : o.names.map((n) => `${n.name} (${n.language}, ${NAME_ORIGIN_LABELS[n.origin]})`).join(" · ")}
      </dd>
      <dt>Typ</dt>
      <dd>{GEO_OBJECT_TYPE_LABELS[o.type]}</dd>
      <dt>Herkunft</dt>
      <dd>{GEO_ORIGIN_LABELS[o.origin]}</dd>
      <dt>Externe IDs</dt>
      <dd>
        {[
          o.osmId && `OSM ${o.osmId}`,
          o.wikidataId && `Wikidata ${o.wikidataId}`,
          o.geonamesId && `GeoNames ${o.geonamesId}`,
        ]
          .filter(Boolean)
          .join(" · ") || "–"}
      </dd>
      <dt>Geo-Objekt</dt>
      <dd className="font-mono text-xs">{o.id}</dd>
    </dl>
  );
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

  return (
    <div className="space-y-4 text-sm">
      <DecisionKeys nextHref={nextHref} />
      <p className="flex gap-4">
        <Link href={`/review?kind=${task.kind}`} className="underline">
          Zurück zur Liste
        </Link>
        <Link href={nextHref} className="underline">
          Nächste Aufgabe
        </Link>
        <kbd className="rounded border border-neutral-300 px-1 text-xs text-neutral-500">n</kbd>
      </p>
      <h1 className="text-lg font-semibold">
        {subject.type === "name_candidate" ? `Neuer Name: ${subject.candidate.name}` : REVIEW_KIND_LABELS[task.kind]}
        {subject.type === "place" && subject.geoObject.names[0] ? `: ${subject.geoObject.names[0].name}` : ""}
        {subject.type === "source" ? `: ${subject.source.domain}` : ""}
      </h1>
      {(!open || query.stale) && (
        <p role="status" className="rounded bg-amber-100 px-3 py-2">
          Bereits entschieden
        </p>
      )}
      {query.error && open && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Diese Entscheidung ist nicht möglich.
        </p>
      )}

      {invalid.length > 0 && open && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Ungültige Eingaben: {invalid.map((f) => (Object.hasOwn(APPROVAL_FIELD_LABELS, f) ? APPROVAL_FIELD_LABELS[f] : f)).join(", ")}
        </p>
      )}

      {subject.type === "missing" && <p>Der Gegenstand dieser Aufgabe wurde nicht gefunden.</p>}

      {subject.type === "place" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <PlaceConfirm {...props} defaultKind={subject.place.kind} features={features} open={open} />
          <section className="space-y-4">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
              <dt>Art</dt>
              <dd>{PLACE_KIND_LABELS[subject.place.kind]}</dd>
              <dt>Status</dt>
              <dd>{PLACE_STATUS_LABELS[subject.place.status]}</dd>
              <dt>Position</dt>
              <dd>{coord(subject.place.position.lat, subject.place.position.lon)}</dd>
              <dt>Kachel</dt>
              <dd>{subject.place.tileId ?? "–"}</dd>
              {subject.place.publicId && (
                <>
                  <dt>Öffentliche ID</dt>
                  <dd className="font-mono text-xs">{subject.place.publicId}</dd>
                </>
              )}
            </dl>
            <ObjectFacts o={subject.geoObject} />
            <div>
              <h2 className="mb-1 font-semibold">Nächste Orte</h2>
              {subject.nearby.length === 0 ? (
                <p>Keine Orte in der Nähe.</p>
              ) : (
                <ul>
                  {subject.nearby.map((n) => (
                    <li key={n.id}>
                      {n.name ?? n.id} – {PLACE_KIND_LABELS[n.kind]}, {PLACE_STATUS_LABELS[n.status]},{" "}
                      {distance(n.distanceM)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {open && (
              <div className="space-y-2">
                <DecisionForm {...props} n={2} label="Einem Ort zuordnen" disabled={subject.nearby.length === 0}>
                  {subject.nearby.length > 0 && (
                    <select name="decision" aria-label="Ort" className={SELECT}>
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
                <DecisionForm {...props} n={3} label="Verwerfen" decision={{ action: "reject" }} />
                <DecisionForm {...props} n={4} label="Kein Ankerplatz" decision={{ action: "no_anchoring" }} />
              </div>
            )}
          </section>
        </div>
      )}

      {subject.type === "geo_object_pair" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <MiniMap features={features} />
          <section className="space-y-4">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
              <dt>Abstand</dt>
              <dd>{subject.distanceM === null ? "–" : distance(subject.distanceM)}</dd>
              <dt>Ähnlichkeit</dt>
              <dd>
                {subject.similarity === null
                  ? "–"
                  : subject.similarity.toLocaleString("de-DE", {
                      maximumFractionDigits: 2,
                    })}
              </dd>
            </dl>
            {subject.objects.map((o, i) => (
              <div key={o.id}>
                <h2 className="mb-1 font-semibold">Objekt {i + 1}</h2>
                <ObjectFacts o={o} />
              </div>
            ))}
            {open && (
              <div className="space-y-2">
                <DecisionForm {...props} n={1} label="Gleiches Objekt" decision={{ action: "same" }} />
                <DecisionForm {...props} n={2} label="Verschiedene Objekte" decision={{ action: "distinct" }} />
              </div>
            )}
          </section>
        </div>
      )}

      {subject.type === "tile" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <MiniMap features={features} />
          <section className="space-y-4">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
              <dt>Kachel</dt>
              <dd>{subject.tile.id}</dd>
              <dt>Küste</dt>
              <dd>{subject.tile.hasCoast ? "Ja" : "Nein"}</dd>
              <dt>Revier</dt>
              <dd>{subject.areas.find((a) => a.id === subject.tile.areaId)?.name ?? subject.tile.areaId ?? "–"}</dd>
            </dl>
            {open && (
              <div className="space-y-2">
                <DecisionForm {...props} n={1} label="Revier zuordnen" disabled={subject.areas.length === 0}>
                  {subject.areas.length > 0 && (
                    <select name="decision" aria-label="Revier" className={SELECT}>
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
                <DecisionForm {...props} n={2} label="Kein Revier nötig" decision={{ action: "no_area" }} />
              </div>
            )}
          </section>
        </div>
      )}

      {subject.type === "name_candidate" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <NameCandidateCreate
            {...props}
            name={subject.candidate.name}
            features={features}
            hits={subject.hits}
            objectTypes={subject.objectTypes}
            open={open}
          />
          <section className="space-y-4">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
              <dt>Name</dt>
              <dd>{subject.candidate.name}</dd>
              <dt>Hinweis</dt>
              <dd>{hintLabel(subject.candidate.hint)}</dd>
              <dt>Kachel</dt>
              <dd>{subject.candidate.tileId}</dd>
              <dt>Fundstellen</dt>
              <dd>
                {subject.candidate.documents} Dokumente aus {subject.candidate.sources} Quellen
              </dd>
              <dt>Status</dt>
              <dd>{NAME_CANDIDATE_STATUS_LABELS[subject.candidate.status]}</dd>
            </dl>
            <div>
              <h2 className="mb-1 font-semibold">Nominatim-Treffer</h2>
              {subject.hits.length === 0 ? (
                <p>Keine Treffer im Umkreis – Position per Klick in die Karte setzen.</p>
              ) : (
                <ul>
                  {subject.hits.map((h) => (
                    <li key={h.osmId}>
                      {h.name} – {h.category}/{h.type}, {distance(h.distanceM)} vom Kachelmittelpunkt{" "}
                      <span className="font-mono text-xs">{h.osmId}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h2 className="mb-1 font-semibold">Nächste Orte</h2>
              {subject.nearby.length === 0 ? (
                <p>Keine Orte in der Nähe.</p>
              ) : (
                <ul>
                  {subject.nearby.map((n) => (
                    <li key={n.id}>
                      {n.name ?? n.id} – {PLACE_KIND_LABELS[n.kind]}, {PLACE_STATUS_LABELS[n.status]}, {distance(n.distanceM)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {open && (
              <div className="space-y-2">
                <DecisionForm {...props} n={2} label="Einem Objekt zuordnen" disabled={subject.objects.length === 0}>
                  {subject.objects.length > 0 && (
                    <select name="decision" aria-label="Objekt" className={SELECT}>
                      {subject.objects.map((o) => (
                        <option key={o.id} value={JSON.stringify({ action: "assign_name", geoObjectId: o.id })}>
                          {o.name ?? o.id} ({GEO_OBJECT_TYPE_LABELS[o.type]}, {distance(o.distanceM)})
                        </option>
                      ))}
                    </select>
                  )}
                </DecisionForm>
                <DecisionForm {...props} n={3} label="Verwerfen" decision={{ action: "reject" }} />
              </div>
            )}
          </section>
          <section className="space-y-3 lg:col-span-2">
            <h2 className="font-semibold">Fundstellen</h2>
            {subject.occurrences.length === 0 ? (
              <p>Keine Fundstellen gespeichert.</p>
            ) : (
              <ul className="space-y-3">
                {subject.occurrences.map((o) => (
                  <li key={o.chunkId} className="space-y-1">
                    <p>
                      <Link href={`/documents/${o.documentId}`} className="underline">
                        {o.url ?? o.documentId}
                      </Link>
                    </p>
                    <blockquote className="border-l-2 border-neutral-300 pl-3 text-neutral-700">
                      …<AnnotatedText text={o.snippet} spans={[{ start: o.start, end: o.end, kind: "mention", ref: o.chunkId }]} />…
                    </blockquote>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {subject.type === "job" && (
        <section className="space-y-4">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
            <dt>Queue</dt>
            <dd>{subject.job.queue ?? "–"}</dd>
            <dt>Schlüssel</dt>
            <dd>{subject.job.key ?? "–"}</dd>
            <dt>Stufe</dt>
            <dd>{subject.job.stage ?? "–"}</dd>
            <dt>Fehler</dt>
            <dd className="break-all">{subject.job.error ?? "–"}</dd>
            <dt>Lauf</dt>
            <dd>
              {subject.job.runId ? (
                <Link href={`/runs/${subject.job.runId}`} className="underline">
                  {subject.job.runId}
                </Link>
              ) : (
                "–"
              )}
            </dd>
            <dt>Job</dt>
            <dd className="font-mono text-xs">{subject.job.id}</dd>
            {subject.job.sourceId && (
              <>
                <dt>Quelle</dt>
                <dd className="font-mono text-xs">{subject.job.sourceId}</dd>
              </>
            )}
          </dl>
          {open && (
            <div className="space-y-2">
              <DecisionForm
                {...props}
                n={1}
                label="Erneut starten"
                decision={{ action: "retry" }}
                disabled={!(QUEUES as readonly (string | null)[]).includes(subject.job.queue)}
              />
              <DecisionForm {...props} n={2} label="Ignorieren" decision={{ action: "ignore" }} />
              {subject.job.sourceId && (
                <DecisionForm {...props} n={3} label="Quelle pausieren" decision={{ action: "pause_source" }} />
              )}
            </div>
          )}
        </section>
      )}

      {subject.type === "source" && (
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="font-semibold">Quellenvorschlag</h2>
            <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
              <dt>Domain</dt>
              <dd>{subject.source.domain}</dd>
              <dt>Status</dt>
              <dd>
                {SOURCE_STATUS_LABELS[subject.source.status]}
                {subject.source.statusReason ? ` (${subject.source.statusReason})` : ""}
              </dd>
              <dt>Suchtreffer</dt>
              <dd>
                {subject.hitCount}
                {subject.hitCount > subject.hits.length ? ` (die besten ${subject.hits.length} unten)` : ""}
              </dd>
              <dt>Verlinkt von</dt>
              <dd>
                {subject.linkingSources} freigegebenen Quelle{subject.linkingSources === 1 ? "" : "n"}
              </dd>
              <dt>Sprachen</dt>
              <dd>{subject.languages.join(", ") || "–"}</dd>
              <dt>robots.txt</dt>
              <dd>{robotsText(subject.robots)}</dd>
              <dt>Vorschlag</dt>
              <dd>
                {DOC_TYPE_LABELS[subject.suggestion.type]}, Gewicht{" "}
                {subject.suggestion.weight.toLocaleString("de-DE", { maximumFractionDigits: 2 })},{" "}
                {CHANGE_RATE_LABELS[subject.suggestion.changeRate]}
              </dd>
            </dl>
          </section>
          {subject.hits.length > 0 && (
            <section>
              <h2 className="mb-1 font-semibold">Suchtreffer</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-neutral-300">
                      <th className="pr-3">Rang</th>
                      <th className="pr-3">Query</th>
                      <th className="pr-3">Titel</th>
                      <th className="pr-3">Snippet</th>
                      <th>URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subject.hits.map((h) => (
                      <tr
                        key={`${h.keyword}|${h.languageCode}|${h.url}`}
                        className="border-b border-neutral-100 align-top"
                      >
                        <td className="pr-3">{h.rank}</td>
                        <td className="pr-3">
                          {h.keyword} ({h.languageCode})
                        </td>
                        <td className="pr-3">{h.title}</td>
                        <td className="pr-3">{h.snippet}</td>
                        <td className="break-all font-mono text-xs">{h.url}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {open && (
            <section className="space-y-3">
              <DecisionForm {...props} n={1} label="Freigeben" action={approveSourceAction}>
                <div className="flex w-full flex-wrap gap-4">
                  <label className="flex items-center gap-1">
                    Typ
                    <select name="type" defaultValue={subject.suggestion.type} className={SELECT}>
                      {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    Gewicht
                    <input
                      type="number"
                      name="weight"
                      required
                      min={0}
                      max={1}
                      step={0.05}
                      defaultValue={subject.suggestion.weight}
                      className={`${SELECT} w-20`}
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    Änderungsrate
                    <select name="changeRate" defaultValue={subject.suggestion.changeRate} className={SELECT}>
                      {Object.entries(CHANGE_RATE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <CrawlRulesFields defaults={subject.suggestion.crawlRules} invalid={invalid} />
              </DecisionForm>
              <DecisionForm {...props} n={2} label="Ablehnen" decision={{ action: "reject" }} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

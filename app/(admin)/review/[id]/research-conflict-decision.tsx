import type { ResearchConflictSubjectView } from "@/lib/domain/review-view";
import { PLACE_KIND_LABELS, PLACE_STATUS_LABELS, SIGNAL_KIND_LABELS } from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import { DescriptionList, Notice, Panel, TextLink } from "../../_components/ui";
import { DecisionForm } from "./decision-form";
import { DecisionPanel, MapLegend } from "./parts";

const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/**
 * A `research_conflict` task (plan N3): the research confirms the place, but it is not in the reference. The admin
 * looks at the place on the map and in the aerial view and at the evidence (signals with quote and domain) and decides
 * „Liegeplatz“ (the status stays) or „Kein Liegeplatz“ (the place is rejected for good). Nothing of the reference is shown.
 */
export function ResearchConflictDecision({
  subject,
  features,
  taskId,
  openedAt,
  open,
}: {
  subject: ResearchConflictSubjectView;
  features: GeoJSON.FeatureCollection;
  taskId: string;
  openedAt: string;
  open: boolean;
}) {
  const props = { taskId, openedAt };
  const { place } = subject;
  const { lat, lon } = place.position;
  return (
    <>
      <Notice tone="warn">Dieser Ort ist nicht in der Referenz. Karte, Luftbild und Belege prüfen und entscheiden.</Notice>
      <div className="grid gap-6 lg:grid-cols-5">
        {open && (
          <DecisionPanel question="Ist das ein Liegeplatz?" className="lg:col-span-2">
            <DecisionForm
              {...props}
              n={1}
              label="Liegeplatz"
              decision={{ action: "berth" }}
              variant="primary"
              hint="Der Ort bleibt, wie er ist; die Entscheidung zählt im Tor als richtig."
            />
            <DecisionForm
              {...props}
              n={2}
              label="Kein Liegeplatz"
              decision={{ action: "not_berth" }}
              variant="danger"
              hint="Der Ort wird verworfen und von der Recherche nicht wieder bestätigt; die Entscheidung zählt im Tor als Fehler."
            />
          </DecisionPanel>
        )}
        <Panel title="Karte" className={open ? "lg:col-span-3" : "lg:col-span-5"}>
          <MiniMap features={features} />
          <MapLegend items={[["subject", "Ort"]]} />
          <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
            <a className="text-accent underline-offset-2 hover:underline" href={`https://www.google.com/maps/@${lat},${lon},18z/data=!3m1!1e3`} target="_blank" rel="noreferrer">
              Luftbild öffnen
            </a>
            <a className="text-accent underline-offset-2 hover:underline" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`} target="_blank" rel="noreferrer">
              Karte öffnen
            </a>
          </p>
        </Panel>
      </div>
      <Panel title="Ort">
        <DescriptionList
          columns={2}
          items={[
            { label: "Ort", value: <TextLink href={`/places/${place.id}`}>{place.name ?? place.id}</TextLink> },
            { label: "Art", value: PLACE_KIND_LABELS[place.kind] },
            { label: "Status", value: PLACE_STATUS_LABELS[place.status] },
            { label: "Position", value: coord(lat, lon) },
            { label: "Recherche-Urteil", value: `${subject.verdict.reason}${subject.verdict.independentSources.length > 0 ? ` (${subject.verdict.independentSources.join(", ")})` : ""}` },
            { label: "Schwelle", value: subject.threshold ?? "–" },
          ]}
        />
      </Panel>
      <Panel title="Belege" description="Signale der Recherche mit wörtlichem Zitat und Domain">
        {subject.evidence.length === 0 ? (
          <p className="text-sm text-muted">Keine Signale.</p>
        ) : (
          <ul className="divide-y divide-line">
            {subject.evidence.flatMap((page) =>
              page.signals.map((s, i) => (
                <li key={`${page.url}:${i}`} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <p className="text-sm">
                    <span className="font-medium">{page.domain}</span> · {SIGNAL_KIND_LABELS[s.kind]}
                    {s.firstHand ? " · aus erster Hand" : ""} · {s.observedAt}
                  </p>
                  <blockquote className="border-l-2 border-line pl-3 text-sm text-muted">{s.quote}</blockquote>
                  <a className="break-all text-xs text-accent underline-offset-2 hover:underline" href={page.url} target="_blank" rel="noreferrer">
                    {page.url}
                  </a>
                </li>
              )),
            )}
          </ul>
        )}
      </Panel>
    </>
  );
}

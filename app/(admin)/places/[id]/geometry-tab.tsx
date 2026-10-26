import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import type { LonLat } from "@/lib/domain/geo-view";
import type { PlaceGeometryView } from "@/lib/domain/geometry-view";
import {
  COMPUTATION_KIND_LABELS,
  GAP_REASON_LABELS,
  GEO_ORIGIN_LABELS,
  ORIGIN_SOURCE_LABELS,
  RESTRICTED_KIND_LABELS,
  SEABED_TYPE_LABELS,
  SECTOR_LABELS,
} from "../../_components/labels";
import { Dialog } from "../../_components/dialog";
import {
  Badge,
  Button,
  ButtonLink,
  DescriptionList,
  EmptyState,
  Field,
  inputClass,
  Mono,
  Notice,
  numClass,
  Panel,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../../_components/ui";
import { WindRose } from "../../_components/wind-rose";
import { shelterColor } from "../../_components/wind-rose-math";
import { setPlacePositionAction } from "./actions";
import { AnchorMap } from "./anchor-map";

const de = (n: number, digits = 0) => n.toLocaleString("de-DE", { maximumFractionDigits: digits });
const pct = (v: number | null) => (v === null ? "–" : `${de(v * 100)} %`);
const metres = (v: number | null, digits = 0) => (v === null ? "–" : `${de(v, digits)} m`);
const distance = (m: number) => (m < 1000 ? `${de(m)} m` : `${de(m / 1000, 1)} km`);
const time = (d: Date | null) => (d ? d.toISOString().slice(0, 19).replace("T", " ") : "–");
const coord = (p: LonLat) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
const originLabel = (origin: string | null) =>
  origin === null ? "–" : (GEO_ORIGIN_LABELS[origin as keyof typeof GEO_ORIGIN_LABELS] ?? origin);

const COLORS = { water: "#0ea5e9", area: "#16a34a", depth: "#7c3aed", position: "#2563eb", anchor: "#dc2626" };

/** Map features of the view: water, anchor area, rays coloured by shelter, depth samples, place and anchor position. */
function mapFeatures(view: PlaceGeometryView, position: LonLat): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (view.water) features.push({ type: "Feature", geometry: view.water, properties: { color: COLORS.water } });
  if (view.anchorArea?.geometry) {
    features.push({ type: "Feature", geometry: view.anchorArea.geometry, properties: { color: COLORS.area } });
  }
  if (view.origin) {
    const from = [view.origin.lon, view.origin.lat];
    for (const ray of view.rays) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [from, [ray.end.lon, ray.end.lat]] },
        properties: { color: shelterColor(ray.shelter) },
      });
    }
  }
  for (const s of view.depthSamples) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.position.lon, s.position.lat] },
      properties: { color: COLORS.depth },
    });
  }
  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [position.lon, position.lat] },
    properties: { role: "nearby" },
  });
  if (view.anchorPosition) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [view.anchorPosition.lon, view.anchorPosition.lat] },
      properties: { role: "subject" },
    });
  }
  return { type: "FeatureCollection", features };
}

function Legend() {
  const items: [string, string][] = [
    ["Wasserfläche", COLORS.water],
    ["Ankerfläche", COLORS.area],
    ["Tiefenpunkte", COLORS.depth],
    ["Ort", COLORS.position],
    ["Ankerposition", COLORS.anchor],
  ];
  return (
    <ul aria-label="Legende" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map(([label, color]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-full ring-1 ring-line" style={{ background: color }} />
          {label}
        </li>
      ))}
      <li>Strahlen: Farbe nach Schutz (rot offen, grün geschützt)</li>
    </ul>
  );
}

/**
 * Tab "Geometrie" of a place: map with anchor correction, wind rose, depths, seabed and anchor area, exclusions, gaps;
 * the sector table and the raw inputs of each computation open in dialogs.
 */
/** Result of „Position korrigieren“ (`?position=`), with the run it started. */
export type PositionNotice = { status: "moved" | "moved_no_run" | "too_far"; runId?: string };

const POSITION_NOTICES = {
  moved: { tone: "ok", text: "Position korrigiert. Die Geometrie wird neu berechnet." },
  moved_no_run: { tone: "warn", text: "Position korrigiert, aber der Geometrie-Lauf konnte nicht gestartet werden. Bitte im Reiter „Geometrie“ erneut starten." },
  too_far: { tone: "danger", text: "Nicht übernommen: Die neue Position liegt zu weit vom bisherigen Ort entfernt." },
} as const;

export function GeometryTab({
  placeId,
  position,
  view,
  editable,
  positionNotice,
}: {
  placeId: string;
  position: LonLat;
  view: PlaceGeometryView;
  editable: boolean;
  positionNotice?: PositionNotice;
}) {
  const shelter = view.sectors
    ? (Object.fromEntries(SECTORS.map((s) => [s, view.sectors![s].shelter])) as Record<Sector, number>)
    : null;
  const anchor = view.anchorPosition;
  const notice = positionNotice ? POSITION_NOTICES[positionNotice.status] : null;
  return (
    <div className="space-y-6">
      {notice && (
        <Notice
          tone={notice.tone}
          actions={
            positionNotice?.runId && (
              <ButtonLink href={`/runs/${positionNotice.runId}`} size="sm">
                Lauf ansehen
              </ButtonLink>
            )
          }
        >
          {notice.text}
        </Notice>
      )}
      {view.computations.length === 0 && (
        <Notice tone="neutral" title="Noch keine Geometrie berechnet.">
          Schutz, Tiefen und Ankerfläche erscheinen nach dem ersten Geometrie-Lauf für diesen Ort.
        </Notice>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Panel
          title="Karte"
          description={editable ? "Ein Klick in die Karte schlägt eine Ankerposition vor; übernommen wird sie erst per Button." : undefined}
        >
          <div className="space-y-3">
            <Legend />
            <AnchorMap placeId={placeId} features={mapFeatures(view, position)} editable={editable} />
          </div>
        </Panel>

        <div className="space-y-6">
          <Panel
            title="Ort"
            description="Der Punkt des Orts, im Paket die Spot-Position (Prüfung „spot_location“)."
            actions={
              editable && (
                <Dialog
                  trigger="Position korrigieren …"
                  triggerSize="sm"
                  title="Position korrigieren"
                  description="Setzt den Punkt des Orts, etwa wenn er an Land liegt. Danach wird die Geometrie neu berechnet."
                >
                  <form action={setPlacePositionAction} className="grid gap-4">
                    <input type="hidden" name="placeId" value={placeId} />
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Breite (lat)">
                        <input type="number" name="lat" required min={-90} max={90} step="any" defaultValue={position.lat} className={inputClass} />
                      </Field>
                      <Field label="Länge (lon)">
                        <input type="number" name="lon" required min={-180} max={180} step="any" defaultValue={position.lon} className={inputClass} />
                      </Field>
                    </div>
                    <div className="flex justify-end">
                      <Button variant="primary">Position korrigieren</Button>
                    </div>
                  </form>
                </Dialog>
              )
            }
          >
            <Mono>{coord(position)}</Mono>
          </Panel>

          <Panel title="Berechnung">
            <DescriptionList
              columns={1}
              items={[
                { label: "Berechnet am", value: time(view.computedAt) },
                { label: "Regelversion", value: view.rulesVersion ?? "–" },
                {
                  label: "Ausgangspunkt",
                  hint: "Punkt, von dem aus die Strahlen für Schutz und Fetch ausgehen",
                  value: (
                    <>
                      {view.origin ? <Mono>{coord(view.origin)}</Mono> : "–"}
                      {view.originSource && (
                        <span className="block text-xs text-muted">
                          {ORIGIN_SOURCE_LABELS[view.originSource as keyof typeof ORIGIN_SOURCE_LABELS] ?? view.originSource}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  label: "Ankerposition",
                  value: anchor ? (
                    <>
                      <Mono>{coord(anchor)}</Mono>
                      <span className="block text-xs text-muted">
                        {originLabel(anchor.origin)}, Konfidenz {anchor.confidence === null ? "–" : de(anchor.confidence, 2)}
                      </span>
                    </>
                  ) : (
                    "–"
                  ),
                },
              ]}
            />
          </Panel>

          <Panel
            title="Schutz und Fetch"
            description="Schutz je Windsektor (0 offen, 100 % geschützt), aus dem Fetch: der freien Wasserstrecke bis zum Land."
            actions={
              view.sectors && (
                <Dialog trigger="Tabelle" triggerSize="sm" title="Schutz und Fetch je Sektor">
                  <Table>
                    <thead>
                      <tr>
                        <th className={thClass}>Sektor</th>
                        <th className={`${thClass} text-right`}>Schutz</th>
                        <th className={`${thClass} text-right`}>Fetch</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SECTORS.map((s) => (
                        <tr key={s} className={trClass}>
                          <td className={tdClass}>{SECTOR_LABELS[s]}</td>
                          <td className={`${tdClass} ${numClass}`}>{pct(view.sectors![s].shelter)}</td>
                          <td className={`${tdClass} ${numClass}`}>{distance(view.sectors![s].fetchM)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Dialog>
              )
            }
          >
            <div className="space-y-4">
              {shelter ? (
                <div className="flex justify-center">
                  <WindRose sectors={shelter} size={260} />
                </div>
              ) : (
                <p className="text-sm text-muted">Keine Sektorwerte.</p>
              )}
              <DescriptionList
                items={[
                  { label: "Schwell", value: pct(view.swell), hint: "Schutz vor Schwell, 0–100 % (100 % = geschützt)" },
                  {
                    label: "Öffnung",
                    hint: "Richtung und Breite der offenen Seite",
                    value: view.opening
                      ? `${view.opening.bearingDeg === null ? "–" : `${de(view.opening.bearingDeg)}°`}, Breite ${de(view.opening.widthDeg)}°`
                      : "–",
                  },
                ]}
              />
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel title="Tiefen">
          <DescriptionList
            items={[
              {
                label: "Anfahrt 50/100/200 m",
                value: view.depth.approach
                  ? [view.depth.approach.at50m, view.depth.approach.at100m, view.depth.approach.at200m].map((v) => metres(v, 1)).join(" / ")
                  : "–",
              },
              { label: "Wasserfläche", value: `${metres(view.depth.min, 1)} bis ${metres(view.depth.max, 1)}` },
              { label: "Ankertiefe", value: `${metres(view.depth.anchoringMin, 1)} bis ${metres(view.depth.anchoringMax, 1)}` },
              { label: "Konfidenz", value: view.depth.confidence === null ? "–" : de(view.depth.confidence, 2) },
            ]}
          />
        </Panel>

        <Panel title="Grund und Ankerfläche">
          <DescriptionList
            items={[
              {
                label: "Grund",
                value:
                  view.seabed && view.seabed.length > 0
                    ? view.seabed.map((s) => `${SEABED_TYPE_LABELS[s.type]} ${pct(s.share)}`).join(" · ")
                    : "–",
              },
              { label: "Ankerfläche", value: view.anchorArea ? `${de(view.anchorArea.areaM2)} m²` : "–" },
            ]}
          />
        </Panel>

        <Panel title="Ausschlussflächen" description="Flächen wie Sperrgebiete, Kabel oder Schutzgebiete am Ort. Anteil: wie viel der Ankerfläche darin liegt." flush>
          {view.restriction.length === 0 ? (
            <EmptyState title="Keine Treffer.">Keine bekannte Ausschlussfläche betrifft diesen Ort.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Art</th>
                  <th className={thClass}>Kennung</th>
                  <th className={`${thClass} text-right`}>Anteil</th>
                  <th className={thClass}>Ankerverbot</th>
                </tr>
              </thead>
              <tbody>
                {view.restriction.map((h) => (
                  <tr key={h.restrictedAreaId} className={trClass}>
                    <td className={tdClass}>{RESTRICTED_KIND_LABELS[h.kind]}</td>
                    <td className={tdClass}>{h.sourceRef ? <Mono>{h.sourceRef}</Mono> : "–"}</td>
                    <td className={`${tdClass} ${numClass}`}>{pct(h.share)}</td>
                    <td className={tdClass}>{h.anchoringBan ? <Badge tone="danger">ja</Badge> : "nein"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Lücken" description="Geometriewerte, die nicht berechnet werden konnten." flush>
          {view.gaps.length === 0 ? (
            <EmptyState title="Keine Lücken." />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {view.gaps.map((g) => (
                <li key={`${g.attribute}:${g.reason}`} className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2.5">
                  <Mono>{g.attribute}</Mono>
                  <span className="text-muted">{GAP_REASON_LABELS[g.reason] ?? g.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Eingangsdaten" description="Die gespeicherten Eingaben jeder Berechnung, aus denen die Werte oben stammen." flush>
        {view.computations.length === 0 ? (
          <EmptyState title="Keine Berechnungen." />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {view.computations.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <span>
                  {COMPUTATION_KIND_LABELS[c.kind]}{" "}
                  <span className="text-xs text-muted">
                    · {c.rulesVersion} · {time(c.createdAt)}
                  </span>
                </span>
                <Dialog trigger="Eingaben anzeigen" triggerSize="sm" title={COMPUTATION_KIND_LABELS[c.kind]} description={`${c.rulesVersion}, ${time(c.createdAt)}`} wide>
                  <pre className="overflow-auto rounded-md bg-sunken p-3 font-mono text-xs">{JSON.stringify(c.inputs, null, 2)}</pre>
                </Dialog>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

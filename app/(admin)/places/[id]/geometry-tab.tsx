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
import { WindRose } from "../../_components/wind-rose";
import { shelterColor } from "../../_components/wind-rose-math";
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
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1">
          <span aria-hidden className="inline-block size-3 rounded-full" style={{ background: color }} />
          {label}
        </span>
      ))}
      <span>Strahlen: Farbe nach Schutz (rot offen, grün geschützt)</span>
    </p>
  );
}

/** Tab "Geometrie" of a place: wind rose, sector table, depths, seabed, anchor area, exclusions, gaps, inputs, map. */
export function GeometryTab({
  placeId,
  position,
  view,
  editable,
}: {
  placeId: string;
  position: LonLat;
  view: PlaceGeometryView;
  editable: boolean;
}) {
  const shelter = view.sectors
    ? (Object.fromEntries(SECTORS.map((s) => [s, view.sectors![s].shelter])) as Record<Sector, number>)
    : null;
  const anchor = view.anchorPosition;
  return (
    <div className="space-y-6">
      {view.computations.length === 0 && <p>Noch keine Geometrie berechnet.</p>}
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt>Berechnet am</dt>
        <dd>{time(view.computedAt)}</dd>
        <dt>Regelversion</dt>
        <dd>{view.rulesVersion ?? "–"}</dd>
        <dt>Ausgangspunkt</dt>
        <dd>
          {view.origin ? coord(view.origin) : "–"}
          {view.originSource && ` (${ORIGIN_SOURCE_LABELS[view.originSource as keyof typeof ORIGIN_SOURCE_LABELS] ?? view.originSource})`}
        </dd>
        <dt>Ankerposition</dt>
        <dd>
          {anchor
            ? `${coord(anchor)} – ${originLabel(anchor.origin)}, Konfidenz ${anchor.confidence === null ? "–" : de(anchor.confidence, 2)}`
            : "–"}
        </dd>
      </dl>

      <section className="space-y-2">
        <h2 className="font-semibold">Schutz und Fetch</h2>
        <div className="flex flex-wrap items-start gap-6">
          {shelter ? <WindRose sectors={shelter} size={260} /> : <p>Keine Sektorwerte.</p>}
          {view.sectors && (
            <table className="text-left">
              <thead>
                <tr className="border-b border-neutral-300">
                  <th className="py-1 pr-4">Sektor</th>
                  <th className="pr-4">Schutz</th>
                  <th>Fetch</th>
                </tr>
              </thead>
              <tbody>
                {SECTORS.map((s) => (
                  <tr key={s} className="border-b border-neutral-200">
                    <td className="py-1 pr-4">{SECTOR_LABELS[s]}</td>
                    <td className="pr-4">{pct(view.sectors![s].shelter)}</td>
                    <td>{distance(view.sectors![s].fetchM)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
            <dt>Schwell</dt>
            <dd>{pct(view.swell)}</dd>
            <dt>Öffnung</dt>
            <dd>
              {view.opening
                ? `${view.opening.bearingDeg === null ? "–" : `${de(view.opening.bearingDeg)}°`}, Breite ${de(view.opening.widthDeg)}°`
                : "–"}
            </dd>
          </dl>
        </div>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Tiefen</h2>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
          <dt>Anfahrt 50/100/200 m</dt>
          <dd>
            {view.depth.approach
              ? [view.depth.approach.at50m, view.depth.approach.at100m, view.depth.approach.at200m]
                  .map((v) => metres(v, 1))
                  .join(" / ")
              : "–"}
          </dd>
          <dt>Wasserfläche</dt>
          <dd>
            {metres(view.depth.min, 1)} bis {metres(view.depth.max, 1)}
          </dd>
          <dt>Ankertiefe</dt>
          <dd>
            {metres(view.depth.anchoringMin, 1)} bis {metres(view.depth.anchoringMax, 1)}
          </dd>
          <dt>Konfidenz</dt>
          <dd>{view.depth.confidence === null ? "–" : de(view.depth.confidence, 2)}</dd>
        </dl>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Grund und Ankerfläche</h2>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
          <dt>Grund</dt>
          <dd>
            {view.seabed && view.seabed.length > 0
              ? view.seabed.map((s) => `${SEABED_TYPE_LABELS[s.type]} ${pct(s.share)}`).join(" · ")
              : "–"}
          </dd>
          <dt>Ankerfläche</dt>
          <dd>{view.anchorArea ? `${de(view.anchorArea.areaM2)} m²` : "–"}</dd>
        </dl>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Ausschlussflächen</h2>
        {view.restriction.length === 0 ? (
          <p>Keine Treffer.</p>
        ) : (
          <table className="text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">Art</th>
                <th className="pr-4">Kennung</th>
                <th className="pr-4">Anteil</th>
                <th>Ankerverbot</th>
              </tr>
            </thead>
            <tbody>
              {view.restriction.map((h) => (
                <tr key={h.restrictedAreaId} className="border-b border-neutral-200">
                  <td className="py-1 pr-4">{RESTRICTED_KIND_LABELS[h.kind]}</td>
                  <td className="pr-4 font-mono text-xs">{h.sourceRef ?? "–"}</td>
                  <td className="pr-4">{pct(h.share)}</td>
                  <td>{h.anchoringBan ? "ja" : "nein"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Lücken</h2>
        {view.gaps.length === 0 ? (
          <p>Keine Lücken.</p>
        ) : (
          <ul>
            {view.gaps.map((g) => (
              <li key={`${g.attribute}:${g.reason}`}>
                <span className="font-mono text-xs">{g.attribute}</span> – {GAP_REASON_LABELS[g.reason] ?? g.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Karte</h2>
        <Legend />
        <AnchorMap placeId={placeId} features={mapFeatures(view, position)} editable={editable} />
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Eingangsdaten</h2>
        {view.computations.length === 0 ? (
          <p>Keine Berechnungen.</p>
        ) : (
          <div className="space-y-1">
            {view.computations.map((c) => (
              <details key={c.id} className="rounded border border-neutral-200 px-2 py-1">
                <summary className="cursor-pointer">
                  {COMPUTATION_KIND_LABELS[c.kind]} – {c.rulesVersion}, {time(c.createdAt)}
                </summary>
                <pre className="mt-1 max-h-96 overflow-auto bg-neutral-50 p-2 text-xs">{JSON.stringify(c.inputs, null, 2)}</pre>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

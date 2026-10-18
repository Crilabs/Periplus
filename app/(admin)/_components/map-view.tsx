"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import {
  type ExpressionSpecification,
  type GeoJSONSource,
  Map as MapLibreMap,
  type MapGeoJSONFeature,
  NavigationControl,
} from "maplibre-gl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GeoObjectType, PlaceStatus } from "@/lib/db/schema";
import type { MapLayer } from "@/lib/domain/map-data";
import { CLIENT_BBOX_DEGREES } from "@/lib/domain/map-limits";
import { GEO_OBJECT_TYPE_LABELS, PLACE_KIND_LABELS, PLACE_STATUS_LABELS } from "./labels";
import { DEFAULT_CENTER, MAP_STYLE_URL, OSM_ATTRIBUTION } from "./map-style";

const LAYERS: MapLayer[] = ["tiles", "areas", "geo-objects", "places"];
const DEBOUNCE_MS = 300;
/** The map-data route accepts at most 5° × 5°; larger views load the 5° box around the centre. */
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const GEO_TYPES = (Object.keys(GEO_OBJECT_TYPE_LABELS) as GeoObjectType[]).filter((t) => t !== "area");
const PLACE_STATUSES = Object.keys(PLACE_STATUS_LABELS) as PlaceStatus[];

const PLACE_STATUS_COLORS: Record<PlaceStatus, string> = {
  candidate: "#eab308",
  confirmed: "#16a34a",
  rejected: "#9ca3af",
  abandoned: "#525252",
  no_anchoring: "#dc2626",
};
const AREA_COLOR = "#7c3aed";
const TILE_COLOR = "#0284c7";
const GEO_OBJECT_COLOR = "#2563eb";

type Selection = { layer: MapLayer; properties: Record<string, unknown> };
type Visibility = { areas: boolean; tiles: boolean; geoTypes: GeoObjectType[]; placeStatuses: PlaceStatus[] };

const POLYGON: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const LINE: ExpressionSpecification = [
  "in",
  ["geometry-type"],
  ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]],
];
const POINT: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]];

const placeColor = [
  "match",
  ["get", "status"],
  ...PLACE_STATUSES.flatMap((s) => [s, PLACE_STATUS_COLORS[s]]),
  "#525252",
] as unknown as ExpressionSpecification;

/** Interactive MapLibre layer ids per data layer (for clicks). */
const CLICK_LAYERS: Record<MapLayer, string[]> = {
  tiles: ["tiles-fill"],
  areas: ["areas-line"],
  "geo-objects": ["geo-objects-fill", "geo-objects-line", "geo-objects-point"],
  places: ["places-point"],
};

function addLayers(m: MapLibreMap): void {
  for (const layer of LAYERS) m.addSource(layer, { type: "geojson", data: EMPTY });
  m.addLayer({
    id: "tiles-fill",
    type: "fill",
    source: "tiles",
    paint: { "fill-color": TILE_COLOR, "fill-opacity": ["case", ["get", "hasCoast"], 0.08, 0.01] },
  });
  m.addLayer({
    id: "tiles-line",
    type: "line",
    source: "tiles",
    paint: { "line-color": TILE_COLOR, "line-width": 1, "line-dasharray": [2, 2] },
  });
  m.addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": AREA_COLOR, "line-width": 3 } });
  m.addLayer({
    id: "geo-objects-fill",
    type: "fill",
    source: "geo-objects",
    filter: POLYGON,
    paint: { "fill-color": GEO_OBJECT_COLOR, "fill-opacity": 0.08 },
  });
  m.addLayer({
    id: "geo-objects-line",
    type: "line",
    source: "geo-objects",
    filter: LINE,
    paint: { "line-color": GEO_OBJECT_COLOR, "line-width": 1 },
  });
  m.addLayer({
    id: "geo-objects-point",
    type: "circle",
    source: "geo-objects",
    filter: POINT,
    paint: { "circle-color": GEO_OBJECT_COLOR, "circle-radius": 4, "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
  });
  m.addLayer({
    id: "places-point",
    type: "circle",
    source: "places",
    paint: { "circle-color": placeColor, "circle-radius": 6, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
  });
}

/** Shows or hides the layers and applies the type and status filters. */
function applyVisibility(m: MapLibreMap, v: Visibility): void {
  const show = (id: string, on: boolean) => m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("tiles-fill", v.tiles);
  show("tiles-line", v.tiles);
  show("areas-line", v.areas);
  const typeFilter: ExpressionSpecification = ["in", ["get", "type"], ["literal", v.geoTypes]];
  m.setFilter("geo-objects-fill", ["all", POLYGON, typeFilter]);
  m.setFilter("geo-objects-line", ["all", LINE, typeFilter]);
  m.setFilter("geo-objects-point", ["all", POINT, typeFilter]);
  for (const id of CLICK_LAYERS["geo-objects"]) show(id, v.geoTypes.length > 0);
  m.setFilter("places-point", ["in", ["get", "status"], ["literal", v.placeStatuses]]);
  show("places-point", v.placeStatuses.length > 0);
}

const isOn = (layer: MapLayer, v: Visibility): boolean =>
  layer === "areas" ? v.areas : layer === "tiles" ? v.tiles : layer === "geo-objects" ? v.geoTypes.length > 0 : v.placeStatuses.length > 0;

/** The visible bounds as `w,s,e,n`, clamped to 5° × 5° around the centre and to WGS84. */
function bboxParam(m: MapLibreMap): { bbox: string; clamped: boolean } {
  const b = m.getBounds();
  const center = m.getCenter();
  // After panning around the world the centre may lie beyond ±180: shift the bounds by the same offset.
  const c = center.wrap();
  const shift = c.lng - center.lng;
  const span = (lo: number, hi: number, mid: number) =>
    hi - lo > CLIENT_BBOX_DEGREES ? { lo: mid - CLIENT_BBOX_DEGREES / 2, hi: mid + CLIENT_BBOX_DEGREES / 2, clamped: true } : { lo, hi, clamped: false };
  const x = span(b.getWest() + shift, b.getEast() + shift, c.lng);
  const y = span(b.getSouth(), b.getNorth(), c.lat);
  const round = (n: number) => n.toFixed(5);
  const w = Math.max(-180, x.lo);
  const e = Math.min(180, x.hi);
  const s = Math.max(-90, y.lo);
  const n = Math.min(90, y.hi);
  return { bbox: [w, s, e, n].map(round).join(","), clamped: x.clamped || y.clamped };
}

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Admin map: toggleable layers (areas, tiles, geo objects by type, places by status), loaded per layer from
 * `/map-data/<layer>` for the visible bounds after each move (debounced). A click opens a sidebar with a link.
 */
export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [visibility, setVisibility] = useState<Visibility>({
    areas: true,
    tiles: true,
    geoTypes: GEO_TYPES,
    placeStatuses: PLACE_STATUSES,
  });
  const visibilityRef = useRef(visibility);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [failed, setFailed] = useState<MapLayer[]>([]);
  const [clamped, setClamped] = useState(false);
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: MAP_STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: 8,
      attributionControl: { compact: false, customAttribution: OSM_ATTRIBUTION },
    });
    m.addControl(new NavigationControl(), "top-right");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | undefined;

    const load = async () => {
      abort?.abort();
      const controller = new AbortController();
      abort = controller;
      const { bbox, clamped: wasClamped } = bboxParam(m);
      setClamped(wasClamped);
      const results = await Promise.all(
        LAYERS.filter((layer) => isOn(layer, visibilityRef.current)).map(async (layer) => {
          try {
            const res = await fetch(`/map-data/${layer}?bbox=${bbox}`, { signal: controller.signal, cache: "no-store" });
            if (!res.ok) return { layer, ok: false };
            const data = (await res.json()) as GeoJSON.FeatureCollection;
            m.getSource<GeoJSONSource>(layer)?.setData(data);
            return { layer, ok: true };
          } catch {
            return { layer, ok: controller.signal.aborted };
          }
        }),
      );
      if (!controller.signal.aborted) setFailed(results.filter((r) => !r.ok).map((r) => r.layer));
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), DEBOUNCE_MS);
    };
    reload.current = schedule;

    m.on("load", () => {
      addLayers(m);
      applyVisibility(m, visibilityRef.current);
      schedule();
    });
    m.on("moveend", schedule);
    m.on("click", (e) => {
      const ids = [...LAYERS].reverse().flatMap((layer) => CLICK_LAYERS[layer]).filter((id) => m.getLayer(id));
      const [hit]: MapGeoJSONFeature[] = m.queryRenderedFeatures(e.point, { layers: ids });
      setSelection(hit ? { layer: hit.source as MapLayer, properties: hit.properties } : null);
    });
    map.current = m;
    return () => {
      clearTimeout(timer);
      abort?.abort();
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const before = visibilityRef.current;
    visibilityRef.current = visibility;
    const m = map.current;
    if (!m?.getLayer("places-point")) return;
    applyVisibility(m, visibility);
    // Newly switched-on layers have no data for the current view yet.
    if (LAYERS.some((layer) => isOn(layer, visibility) && !isOn(layer, before))) reload.current();
  }, [visibility]);

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-3">
      <LayerPanel visibility={visibility} onChange={setVisibility} failed={failed} clamped={clamped} />
      <div ref={container} role="region" aria-label="Karte" className="h-full flex-1" />
      {selection && <Sidebar selection={selection} onClose={() => setSelection(null)} />}
    </div>
  );
}

function Checkbox({ label, checked, onChange, color }: { label: string; checked: boolean; onChange: () => void; color?: string }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {color && <span aria-hidden className="inline-block size-3 rounded-full" style={{ background: color }} />}
      {label}
    </label>
  );
}

const LAYER_LABELS: Record<MapLayer, string> = {
  areas: "Reviere",
  tiles: "Kacheln",
  "geo-objects": "Geo-Objekte",
  places: "Orte",
};

function LayerPanel({
  visibility: v,
  onChange,
  failed,
  clamped,
}: {
  visibility: Visibility;
  onChange: (v: Visibility) => void;
  failed: MapLayer[];
  clamped: boolean;
}) {
  return (
    <aside aria-label="Ebenen" className="w-52 shrink-0 space-y-4 overflow-y-auto text-sm">
      <fieldset className="space-y-1">
        <legend className="mb-1 font-semibold">Ebenen</legend>
        <Checkbox label="Reviere" color={AREA_COLOR} checked={v.areas} onChange={() => onChange({ ...v, areas: !v.areas })} />
        <Checkbox label="Kacheln" color={TILE_COLOR} checked={v.tiles} onChange={() => onChange({ ...v, tiles: !v.tiles })} />
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="mb-1 font-semibold">Geo-Objekte nach Typ</legend>
        {GEO_TYPES.map((t) => (
          <Checkbox
            key={t}
            label={GEO_OBJECT_TYPE_LABELS[t]}
            checked={v.geoTypes.includes(t)}
            onChange={() => onChange({ ...v, geoTypes: toggle(v.geoTypes, t) })}
          />
        ))}
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="mb-1 font-semibold">Orte nach Status</legend>
        {PLACE_STATUSES.map((s) => (
          <Checkbox
            key={s}
            label={PLACE_STATUS_LABELS[s]}
            color={PLACE_STATUS_COLORS[s]}
            checked={v.placeStatuses.includes(s)}
            onChange={() => onChange({ ...v, placeStatuses: toggle(v.placeStatuses, s) })}
          />
        ))}
      </fieldset>
      {clamped && <p className="text-neutral-600">Ausschnitt größer als 5° × 5°: Daten nur um die Kartenmitte.</p>}
      {failed.length > 0 && (
        <p role="alert" className="text-red-700">
          Nicht geladen: {failed.map((l) => LAYER_LABELS[l]).join(", ")}
        </p>
      )}
    </aside>
  );
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function Sidebar({ selection: { layer, properties: p }, onClose }: { selection: Selection; onClose: () => void }) {
  const id = str(p.id);
  let title = str(p.name) || "Ohne Namen";
  let rows: [string, string][] = [];
  let href: string;
  switch (layer) {
    case "places":
      rows = [
        ["Art", PLACE_KIND_LABELS[p.kind as keyof typeof PLACE_KIND_LABELS] ?? str(p.kind)],
        ["Status", PLACE_STATUS_LABELS[p.status as PlaceStatus] ?? str(p.status)],
        ["Öffentliche ID", str(p.publicId) || "–"],
      ];
      href = `/places/${id}`;
      break;
    case "tiles":
      title = id;
      rows = [
        ["Typ", "Kachel"],
        ["Küste", p.hasCoast ? "ja" : "nein"],
        ["Revier", str(p.areaKey) || "–"],
        ["Orte", String(p.placeCount ?? 0)],
        ["Kandidaten", String(p.candidateCount ?? 0)],
      ];
      href = `/tiles/${id}`;
      break;
    case "areas":
      rows = [
        ["Typ", GEO_OBJECT_TYPE_LABELS.area],
        ["Schlüssel", str(p.key) || "–"],
      ];
      href = `/geo/${id}`;
      break;
    case "geo-objects":
      rows = [
        ["Typ", GEO_OBJECT_TYPE_LABELS[p.type as GeoObjectType] ?? str(p.type)],
        ["Gehört zu", str(p.parentName) || "–"],
      ];
      href = `/geo/${id}`;
      break;
  }
  return (
    <aside aria-label="Auswahl" className="w-72 shrink-0 space-y-3 overflow-y-auto border-l border-neutral-300 pl-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Schließen" className="hover:underline">
          ×
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-600">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <Link href={href} className="inline-block text-blue-700 hover:underline">
        Details öffnen
      </Link>
    </aside>
  );
}

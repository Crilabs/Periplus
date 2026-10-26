"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibre-worker";
import {
  type ExpressionSpecification,
  type GeoJSONSource,
  Map as MapLibreMap,
  type MapGeoJSONFeature,
  NavigationControl,
} from "maplibre-gl";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { GeoObjectType, PlaceStatus, RestrictedKind } from "@/lib/db/schema";
import type { MapLayer } from "@/lib/domain/map-data";
import { CLIENT_BBOX_DEGREES, MAP_FEATURE_LIMIT, NOT_IN_GEO_OBJECT_LAYER } from "@/lib/domain/map-limits";
import type { ConfidenceClass } from "@/lib/domain/rules/types";
import {
  CONFIDENCE_CLASS_LABELS,
  GEO_OBJECT_TYPE_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  RESTRICTED_KIND_LABELS,
  profileConfidenceText,
} from "./labels";
import type { SubdivisionOption } from "@/lib/domain/areas/view";
import { AreaPanel } from "../map/area-panel";
import { DEFAULT_CENTER, MAP_SEA_COLOR, MAP_STYLE, OSM_ATTRIBUTION } from "./map-style";
import { buttonClass, cx } from "./ui";

const LAYERS: MapLayer[] = ["seas", "subdivisions", "tiles", "restricted-areas", "areas", "geo-objects", "places"];
const DEBOUNCE_MS = 300;
/** The map-data route accepts at most 5° × 5°; larger views load the 5° box around the centre. */
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const GEO_TYPES = (Object.keys(GEO_OBJECT_TYPE_LABELS) as GeoObjectType[]).filter((t) => !(NOT_IN_GEO_OBJECT_LAYER as readonly GeoObjectType[]).includes(t));
const PLACE_STATUSES = Object.keys(PLACE_STATUS_LABELS) as PlaceStatus[];

// Overlay colours are tuned for the dark base map: light enough to read on the sea, distinct from each other.
const PLACE_STATUS_COLORS: Record<PlaceStatus, string> = {
  candidate: "#facc15",
  confirmed: "#4ade80",
  rejected: "#94a3b8",
  abandoned: "#64748b",
  no_anchoring: "#f87171",
};
/** Fill of a place by the confidence class of its newest profile (grey without a profile); the outline shows the status. */
const PROFILE_CLASS_COLORS: Record<ConfidenceClass, string> = { high: "#22c55e", medium: "#fbbf24", low: "#f87171" };
const NO_PROFILE_COLOR = "#64748b";
const PROFILE_CLASSES = Object.keys(PROFILE_CLASS_COLORS) as ConfidenceClass[];
const AREA_COLOR = "#a78bfa";
const SUBDIVISION_COLOR = "#f59e0b";
const SEA_COLOR = "#2dd4bf";
const TILE_COLOR = "#38bdf8";
const GEO_OBJECT_COLOR = "#60a5fa";
const RESTRICTED_KIND_COLORS: Record<RestrictedKind, string> = {
  military: "#f87171",
  cable: "#fb923c",
  protected_area: "#4ade80",
  aquaculture: "#22d3ee",
  ferry_lane: "#818cf8",
  firing_area: "#f472b6",
};
const RESTRICTED_KINDS = Object.keys(RESTRICTED_KIND_COLORS) as RestrictedKind[];

type Selection = { layer: MapLayer; properties: Record<string, unknown> };
type Visibility = {
  subdivisions: boolean;
  seas: boolean;
  areas: boolean;
  /** Key of the Landesteil the Reviere are limited to; null = all. */
  areaSubdivision: string | null;
  tiles: boolean;
  restricted: boolean;
  geoTypes: GeoObjectType[];
  /** Show every highlight candidate, not only the highlights a place selected. */
  allPois: boolean;
  placeStatuses: PlaceStatus[];
};

const POLYGON: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const LINE: ExpressionSpecification = [
  "in",
  ["geometry-type"],
  ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]],
];
const POINT: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]];

const placeStatusColor = [
  "match",
  ["get", "status"],
  ...PLACE_STATUSES.flatMap((s) => [s, PLACE_STATUS_COLORS[s]]),
  "#525252",
] as unknown as ExpressionSpecification;

const placeProfileColor = [
  "match",
  ["coalesce", ["get", "profileClass"], "none"],
  ...PROFILE_CLASSES.flatMap((c) => [c, PROFILE_CLASS_COLORS[c]]),
  NO_PROFILE_COLOR,
] as unknown as ExpressionSpecification;

const restrictedColor = [
  "match",
  ["get", "kind"],
  ...RESTRICTED_KINDS.flatMap((k) => [k, RESTRICTED_KIND_COLORS[k]]),
  "#525252",
] as unknown as ExpressionSpecification;

/** Interactive MapLibre layer ids per data layer (for clicks). */
const CLICK_LAYERS: Record<MapLayer, string[]> = {
  seas: ["seas-line"],
  subdivisions: ["subdivisions-fill"],
  tiles: ["tiles-fill"],
  "restricted-areas": ["restricted-areas-fill"],
  areas: ["areas-line", "areas-fill"],
  "geo-objects": ["geo-objects-fill", "geo-objects-line", "geo-objects-point"],
  places: ["places-point"],
};

/** Which layer wins a click where several overlap (first = most specific / safety-relevant), independent of draw order. */
const CLICK_PRIORITY: MapLayer[] = ["places", "geo-objects", "restricted-areas", "areas", "tiles", "subdivisions", "seas"];

function addLayers(m: MapLibreMap): void {
  for (const layer of LAYERS) m.addSource(layer, { type: "geojson", data: EMPTY });
  m.addLayer({ id: "seas-line", type: "line", source: "seas", paint: { "line-color": SEA_COLOR, "line-width": 1, "line-opacity": 0.6, "line-dasharray": [4, 2] } });
  // a transparent fill makes the inside clickable; excluded subdivisions are greyed
  m.addLayer({
    id: "subdivisions-fill",
    type: "fill",
    source: "subdivisions",
    paint: { "fill-color": ["case", ["==", ["get", "status"], "excluded"], "#525252", SUBDIVISION_COLOR], "fill-opacity": ["case", ["==", ["get", "status"], "excluded"], 0.12, 0.02] },
  });
  m.addLayer({ id: "subdivisions-line", type: "line", source: "subdivisions", paint: { "line-color": SUBDIVISION_COLOR, "line-width": 1.25, "line-opacity": 0.8 } });
  m.addLayer({
    id: "tiles-fill",
    type: "fill",
    source: "tiles",
    paint: { "fill-color": TILE_COLOR, "fill-opacity": ["case", ["get", "hasCoast"], 0.06, 0] },
  });
  m.addLayer({
    id: "tiles-line",
    type: "line",
    source: "tiles",
    paint: { "line-color": TILE_COLOR, "line-width": 0.75, "line-opacity": 0.5, "line-dasharray": [2, 2] },
  });
  m.addLayer({
    id: "restricted-areas-fill",
    type: "fill",
    source: "restricted-areas",
    filter: POLYGON,
    paint: { "fill-color": restrictedColor, "fill-opacity": 0.14 },
  });
  // Areas that ban anchoring get a stronger outline.
  m.addLayer({
    id: "restricted-areas-line",
    type: "line",
    source: "restricted-areas",
    filter: LINE,
    paint: { "line-color": restrictedColor, "line-width": ["case", ["get", "anchoringBan"], 3, 1] },
  });
  // Overlapping Reviere stay visible: a light fill under a clear outline, no blending tricks.
  m.addLayer({ id: "areas-fill", type: "fill", source: "areas", paint: { "fill-color": AREA_COLOR, "fill-opacity": 0.12 } });
  m.addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": AREA_COLOR, "line-width": 2, "line-opacity": 0.9 } });
  m.addLayer({
    id: "geo-objects-fill",
    type: "fill",
    source: "geo-objects",
    filter: POLYGON,
    paint: { "fill-color": GEO_OBJECT_COLOR, "fill-opacity": 0.06 },
  });
  m.addLayer({
    id: "geo-objects-line",
    type: "line",
    source: "geo-objects",
    filter: LINE,
    paint: { "line-color": GEO_OBJECT_COLOR, "line-width": 1, "line-opacity": 0.7 },
  });
  m.addLayer({
    id: "geo-objects-point",
    type: "circle",
    source: "geo-objects",
    filter: POINT,
    paint: { "circle-color": GEO_OBJECT_COLOR, "circle-radius": 4, "circle-stroke-color": MAP_SEA_COLOR, "circle-stroke-width": 1.5 },
  });
  m.addLayer({
    id: "places-point",
    type: "circle",
    source: "places",
    paint: {
      "circle-color": placeProfileColor,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 4, 12, 7],
      "circle-stroke-color": placeStatusColor,
      "circle-stroke-width": 2.5,
    },
  });
}

/** Shows or hides the layers and applies the type and status filters. */
function applyVisibility(m: MapLibreMap, v: Visibility): void {
  const show = (id: string, on: boolean) => m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("tiles-fill", v.tiles);
  show("tiles-line", v.tiles);
  show("areas-fill", v.areas);
  show("areas-line", v.areas);
  show("seas-line", v.seas);
  show("subdivisions-fill", v.subdivisions);
  show("subdivisions-line", v.subdivisions);
  show("restricted-areas-fill", v.restricted);
  show("restricted-areas-line", v.restricted);
  const typeFilter: ExpressionSpecification = ["in", ["get", "type"], ["literal", v.geoTypes]];
  m.setFilter("geo-objects-fill", ["all", POLYGON, typeFilter]);
  m.setFilter("geo-objects-line", ["all", LINE, typeFilter]);
  m.setFilter("geo-objects-point", ["all", POINT, typeFilter]);
  for (const id of CLICK_LAYERS["geo-objects"]) show(id, v.geoTypes.length > 0);
  m.setFilter("places-point", ["in", ["get", "status"], ["literal", v.placeStatuses]]);
  show("places-point", v.placeStatuses.length > 0);
}

function isOn(layer: MapLayer, v: Visibility): boolean {
  switch (layer) {
    case "subdivisions":
      return v.subdivisions;
    case "seas":
      return v.seas;
    case "areas":
      return v.areas;
    case "tiles":
      return v.tiles;
    case "restricted-areas":
      return v.restricted;
    case "geo-objects":
      return v.geoTypes.length > 0;
    case "places":
      return v.placeStatuses.length > 0;
  }
}

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
 * Admin map: toggleable layers (subdivisions, seas, areas, tiles, restricted areas by kind, geo objects by type, places by status), loaded per layer from
 * `/map-data/<layer>` for the visible bounds after each move (debounced). A click opens a floating panel with a link.
 */
export function MapView({ subdivisions = [] }: { subdivisions?: SubdivisionOption[] }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [visibility, setVisibility] = useState<Visibility>({
    subdivisions: true,
    seas: false,
    areas: true,
    areaSubdivision: null,
    tiles: true,
    restricted: true,
    geoTypes: GEO_TYPES,
    allPois: false,
    placeStatuses: PLACE_STATUSES,
  });
  const visibilityRef = useRef(visibility);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [failed, setFailed] = useState<MapLayer[]>([]);
  const [truncated, setTruncated] = useState<MapLayer[]>([]);
  const [clamped, setClamped] = useState(false);
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: MAP_STYLE,
      center: DEFAULT_CENTER,
      zoom: 8,
      attributionControl: { compact: true, customAttribution: OSM_ATTRIBUTION },
    });
    m.addControl(new NavigationControl({ visualizePitch: false }), "bottom-right");
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
          // geo objects are filtered by type on the server, so the cap counts only the types shown (UI-12)
          const types = layer === "geo-objects" ? `&types=${visibilityRef.current.geoTypes.join(",")}` : "";
          const allPois = layer === "geo-objects" && visibilityRef.current.allPois ? "&allPois=1" : "";
          const subdivision = layer === "areas" && visibilityRef.current.areaSubdivision ? `&subdivision=${encodeURIComponent(visibilityRef.current.areaSubdivision)}` : "";
          try {
            const res = await fetch(`/map-data/${layer}?bbox=${bbox}${types}${allPois}${subdivision}`, { signal: controller.signal, cache: "no-store" });
            if (!res.ok) return { layer, ok: false, truncated: false };
            const data = (await res.json()) as GeoJSON.FeatureCollection & { truncated?: boolean };
            m.getSource<GeoJSONSource>(layer)?.setData(data);
            return { layer, ok: true, truncated: data.truncated === true };
          } catch {
            return { layer, ok: controller.signal.aborted, truncated: false };
          }
        }),
      );
      if (!controller.signal.aborted) {
        setFailed(results.filter((r) => !r.ok).map((r) => r.layer));
        setTruncated(results.filter((r) => r.truncated).map((r) => r.layer));
      }
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
      const ids = LAYERS.flatMap((layer) => CLICK_LAYERS[layer]).filter((id) => m.getLayer(id));
      // queryRenderedFeatures lists hits in render order; rank them explicitly so a Revier's fill never hides what lies under it
      const hits: MapGeoJSONFeature[] = m.queryRenderedFeatures(e.point, { layers: ids });
      const rank = (f: MapGeoJSONFeature) => CLICK_PRIORITY.indexOf(f.source as MapLayer);
      const hit = hits.reduce<MapGeoJSONFeature | undefined>((best, f) => (best === undefined || rank(f) < rank(best) ? f : best), undefined);
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
    // Newly switched-on layers have no data for the current view yet; other geo-object types need a new query.
    if (LAYERS.some((layer) => isOn(layer, visibility) && !isOn(layer, before)) || visibility.geoTypes !== before.geoTypes || visibility.allPois !== before.allPois || visibility.areaSubdivision !== before.areaSubdivision) reload.current();
  }, [visibility]);

  return (
    <div
      className="map-night relative h-[calc(100dvh-13rem)] min-h-[26rem] overflow-hidden rounded-xl border border-line"
      style={{ background: MAP_SEA_COLOR }}
    >
      {/* MapLibre forces position:relative on its container, so the absolute frame sits around it. */}
      <div className="absolute inset-0">
        <div ref={container} role="region" aria-label="Karte" className="h-full w-full" />
      </div>
      <LayerPanel
        visibility={visibility}
        onChange={(next) => {
          setVisibility(next);
          // choosing a Landesteil shows it: fit the view to its bounds
          const picked = next.areaSubdivision !== visibility.areaSubdivision && subdivisions.find((s) => s.key === next.areaSubdivision);
          if (picked) map.current?.fitBounds(picked.bbox, { padding: 40, maxZoom: 10, duration: 0 });
        }}
        subdivisions={subdivisions} failed={failed} truncated={truncated} clamped={clamped} />
      {selection && <Sidebar selection={selection} onClose={() => setSelection(null)} />}
    </div>
  );
}

/** Floating panels over the map, frosted so the chart shows through a little. */
const FLOAT = "absolute z-10 rounded-xl border border-line bg-surface/90 text-ink shadow-[0_8px_30px_rgb(0_0_0/0.35)] backdrop-blur-md";

/** A main layer: colour mark, name, switch. */
function LayerSwitch({
  label,
  checked,
  onChange,
  mark,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  mark: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/5">
      <span aria-hidden className={cx("flex w-4 justify-center transition-opacity", !checked && "opacity-35")}>
        {mark}
      </span>
      <span className={cx("flex-1", !checked && "text-muted")}>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={onChange} className="peer sr-only" />
      <span
        aria-hidden
        className="relative h-4 w-7 rounded-full bg-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50 after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-ink after:transition-transform peer-checked:after:translate-x-3 peer-checked:after:bg-accent-ink"
      />
    </label>
  );
}

/** A filter value inside a group (place status, geo-object type), toggled by click. */
function Chip({ label, pressed, onClick, color }: { label: string; pressed: boolean; onClick: () => void; color?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
        pressed ? "border-line-strong bg-white/8 text-ink" : "border-transparent text-muted/70 hover:text-muted",
      )}
    >
      {color && (
        <span
          aria-hidden
          className={cx("size-2 shrink-0 rounded-full", !pressed && "opacity-40")}
          style={{ background: color }}
        />
      )}
      {label}
    </button>
  );
}

function Group<T>({
  title,
  all,
  selected,
  onChange,
  children,
}: {
  title: string;
  all: T[];
  selected: T[];
  onChange: (next: T[]) => void;
  children: ReactNode;
}) {
  const allOn = selected.length === all.length;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-2">
        <h3 className="text-xs font-medium text-muted">
          {title} <span className="tabular-nums text-muted/60">{selected.length}/{all.length}</span>
        </h3>
        <button
          type="button"
          onClick={() => onChange(allOn ? [] : all)}
          className="text-xs text-accent hover:underline"
        >
          {allOn ? "Keine" : "Alle"}
        </button>
      </div>
      <div className="flex flex-wrap gap-1 px-1">{children}</div>
    </section>
  );
}

const LAYER_LABELS: Record<MapLayer, string> = {
  subdivisions: "Landesteile",
  seas: "Meere",
  areas: "Reviere",
  tiles: "Kacheln",
  "geo-objects": "Geo-Objekte",
  places: "Orte",
  "restricted-areas": "Ausschlussflächen",
};

function LayerPanel({
  visibility: v,
  onChange,
  subdivisions,
  failed,
  truncated,
  clamped,
}: {
  visibility: Visibility;
  onChange: (v: Visibility) => void;
  subdivisions: SubdivisionOption[];
  failed: MapLayer[];
  truncated: MapLayer[];
  clamped: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <aside
      aria-label="Ebenen"
      className={`${FLOAT} top-3 left-3 flex max-h-[calc(100%-1.5rem)] w-64 flex-col overflow-hidden text-sm`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3.5 py-2.5 font-medium hover:bg-white/5"
      >
        <svg viewBox="0 0 20 20" className="size-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="m10 3 7 3.5-7 3.5-7-3.5L10 3ZM3 10l7 3.5 7-3.5M3 13.5 10 17l7-3.5" strokeLinejoin="round" />
        </svg>
        <span className="flex-1 text-left">Ebenen</span>
        <svg
          viewBox="0 0 20 20"
          className={cx("size-4 text-muted transition-transform", open && "rotate-180")}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
        >
          <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {failed.length > 0 && (
        <p role="alert" className="mx-3 mb-2 rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
          Nicht geladen: {failed.map((l) => LAYER_LABELS[l]).join(", ")}
        </p>
      )}
      {truncated.length > 0 && (
        <p role="status" className="mx-3 mb-2 rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          Unvollständig (mehr als {MAP_FEATURE_LIMIT.toLocaleString("de-DE")} im Ausschnitt): {truncated.map((l) => LAYER_LABELS[l]).join(", ")}.
          Ausschnitt verkleinern oder Typen abwählen.
        </p>
      )}
      {clamped && (
        <p className="mx-3 mb-2 rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          Ausschnitt größer als 5° × 5°: Daten nur um die Kartenmitte. Hineinzoomen zeigt alles.
        </p>
      )}
      <div className={cx("space-y-4 overflow-y-auto border-t border-line px-2 pt-2 pb-3", !open && "hidden")}>
        <div className="space-y-0.5">
          <LayerSwitch
            label="Landesteile"
            checked={v.subdivisions}
            onChange={() => onChange({ ...v, subdivisions: !v.subdivisions })}
            mark={<span className="h-0.5 w-4 rounded-full" style={{ background: SUBDIVISION_COLOR }} />}
          />
          <LayerSwitch
            label="Meere"
            checked={v.seas}
            onChange={() => onChange({ ...v, seas: !v.seas })}
            mark={<span className="h-0.5 w-4 rounded-full border-t border-dashed" style={{ borderColor: SEA_COLOR }} />}
          />
          <LayerSwitch
            label="Reviere"
            checked={v.areas}
            onChange={() => onChange({ ...v, areas: !v.areas })}
            mark={<span className="h-0.5 w-4 rounded-full" style={{ background: AREA_COLOR }} />}
          />
          {v.areas && subdivisions.length > 0 && (
            <label className="flex items-center gap-2 px-2 pb-1 text-xs text-muted">
              <span className="shrink-0">Landesteil</span>
              <select
                aria-label="Landesteil der Reviere"
                value={v.areaSubdivision ?? ""}
                onChange={(e) => onChange({ ...v, areaSubdivision: e.target.value || null })}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-1 text-ink"
              >
                <option value="">Alle</option>
                {subdivisions.map((s) => (
                  <option key={s.key} value={s.key}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
          <LayerSwitch
            label="Kacheln"
            checked={v.tiles}
            onChange={() => onChange({ ...v, tiles: !v.tiles })}
            mark={<span className="size-3 rounded-[2px] border border-dashed" style={{ borderColor: TILE_COLOR }} />}
          />
          <LayerSwitch
            label="Ausschlussflächen"
            checked={v.restricted}
            onChange={() => onChange({ ...v, restricted: !v.restricted })}
            mark={
              <span
                className="size-3 rounded-[2px]"
                style={{ background: `linear-gradient(135deg, ${RESTRICTED_KIND_COLORS.military} 50%, ${RESTRICTED_KIND_COLORS.protected_area} 50%)` }}
              />
            }
          />
        </div>

        <Group
          title="Orte nach Status"
          all={PLACE_STATUSES}
          selected={v.placeStatuses}
          onChange={(placeStatuses) => onChange({ ...v, placeStatuses })}
        >
          {PLACE_STATUSES.map((s) => (
            <Chip
              key={s}
              label={PLACE_STATUS_LABELS[s]}
              color={PLACE_STATUS_COLORS[s]}
              pressed={v.placeStatuses.includes(s)}
              onClick={() => onChange({ ...v, placeStatuses: toggle(v.placeStatuses, s) })}
            />
          ))}
        </Group>

        <Group
          title="Geo-Objekte"
          all={GEO_TYPES}
          selected={v.geoTypes}
          onChange={(geoTypes) => onChange({ ...v, geoTypes })}
        >
          {GEO_TYPES.map((t) => (
            <Chip
              key={t}
              label={GEO_OBJECT_TYPE_LABELS[t]}
              pressed={v.geoTypes.includes(t)}
              onClick={() => onChange({ ...v, geoTypes: toggle(v.geoTypes, t) })}
            />
          ))}
          {v.geoTypes.includes("poi") && (
            <Chip label="alle Highlight-Kandidaten" pressed={v.allPois} onClick={() => onChange({ ...v, allPois: !v.allPois })} />
          )}
        </Group>

        <details className="group px-2 text-xs text-muted">
          <summary className="flex cursor-pointer list-none items-center justify-between font-medium hover:text-ink">
            Legende
            <svg viewBox="0 0 20 20" className="size-3.5 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="mt-2.5 space-y-3">
            <div>
              <p className="mb-1.5 text-ink">Orte: Füllung = Profil-Konfidenz, Rand = Status</p>
              <ul aria-label="Profil-Konfidenz" className="flex flex-wrap gap-x-3 gap-y-1">
                {PROFILE_CLASSES.map((c) => (
                  <li key={c} className="flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-full" style={{ background: PROFILE_CLASS_COLORS[c] }} />
                    {CONFIDENCE_CLASS_LABELS[c]}
                  </li>
                ))}
                <li className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: NO_PROFILE_COLOR }} />
                  ohne Profil
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-1.5 text-ink">Ausschlussflächen: kräftiger Umriss = Ankerverbot</p>
              <ul aria-label="Ausschlussflächen nach Art" className="grid grid-cols-2 gap-x-3 gap-y-1">
                {RESTRICTED_KINDS.map((k) => (
                  <li key={k} className="flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-[2px]" style={{ background: RESTRICTED_KIND_COLORS[k] }} />
                    {RESTRICTED_KIND_LABELS[k]}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </details>
      </div>
    </aside>
  );
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function Sidebar({ selection: { layer, properties: p }, onClose }: { selection: Selection; onClose: () => void }) {
  const id = str(p.id);
  let title = str(p.name) || "Ohne Namen";
  let rows: [string, string][] = [];
  let href: string | null = null;
  switch (layer) {
    case "places":
      rows = [
        ["Art", PLACE_KIND_LABELS[p.kind as keyof typeof PLACE_KIND_LABELS] ?? str(p.kind)],
        ["Status", PLACE_STATUS_LABELS[p.status as PlaceStatus] ?? str(p.status)],
        ["Öffentliche ID", str(p.publicId) || "–"],
        ["Profil-Konfidenz", profileConfidenceText(p)],
      ];
      href = `/places/${id}`;
      break;
    case "tiles":
      title = id;
      rows = [
        ["Typ", "Kachel"],
        ["Küste", p.hasCoast ? "ja" : "nein"],
        ["Landesteil", str(p.subdivisionKey) || "–"],
        ["Orte", String(p.placeCount ?? 0)],
        ["Kandidaten", String(p.candidateCount ?? 0)],
      ];
      href = `/tiles/${id}`;
      break;
    case "subdivisions":
      title = str(p.name) || str(p.key);
      rows = [
        ["Typ", "Landesteil"],
        ["Schlüssel", str(p.key)],
        ["Land", str(p.country)],
        ["Status", p.status === "excluded" ? "ausgeschlossen" : "aktiv"],
      ];
      href = `/subdivisions/${encodeURIComponent(str(p.key))}`;
      break;
    case "seas":
      rows = [["Typ", GEO_OBJECT_TYPE_LABELS.sea]];
      href = `/geo/${id}`;
      break;
    case "areas":
      rows = [];
      href = `/geo/${id}`;
      break;
    case "geo-objects":
      rows = [
        ["Typ", GEO_OBJECT_TYPE_LABELS[p.type as GeoObjectType] ?? str(p.type)],
        ["Gehört zu", str(p.parentName) || "–"],
      ];
      href = `/geo/${id}`;
      break;
    case "restricted-areas":
      title = "Ausschlussfläche";
      rows = [
        ["Art", RESTRICTED_KIND_LABELS[p.kind as RestrictedKind] ?? str(p.kind)],
        ["Kennung", str(p.sourceRef) || "–"],
        ["Ankerverbot", p.anchoringBan ? "ja" : "nein"],
      ];
      break;
  }
  return (
    <aside
      aria-label="Auswahl"
      className={`${FLOAT} right-3 bottom-3 left-3 max-h-[60%] space-y-3 overflow-y-auto p-4 text-sm sm:bottom-auto sm:left-auto sm:top-3 sm:right-3 sm:max-h-[calc(100%-6rem)] ${layer === "areas" ? "sm:w-96" : "sm:w-72"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          className="-mt-1 -mr-1 rounded-md p-1 text-muted hover:bg-white/5 hover:text-ink"
        >
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {layer === "areas" && <AreaPanel areaId={id} fallbackName={title} />}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {href && (
        <Link href={href} className={buttonClass("primary", "sm")}>
          Details öffnen
        </Link>
      )}
    </aside>
  );
}

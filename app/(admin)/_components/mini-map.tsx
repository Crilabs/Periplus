"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { type GeoJSONSource, LngLatBounds, Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { DEFAULT_CENTER, MAP_STYLE_URL } from "./map-style";

const SOURCE = "review";
/** Colour per feature property `role`. */
const ROLE_COLOR = [
  "match",
  ["get", "role"],
  "subject",
  "#dc2626",
  "nearby",
  "#2563eb",
  "picked",
  "#16a34a",
  "#525252",
];

function extend(bounds: LngLatBounds, coords: unknown): void {
  if (Array.isArray(coords) && typeof coords[0] === "number") bounds.extend([coords[0], coords[1] as number]);
  else if (Array.isArray(coords)) for (const c of coords) extend(bounds, c);
}

function boundsOf(features: GeoJSON.FeatureCollection): LngLatBounds | null {
  const bounds = new LngLatBounds();
  for (const f of features.features) {
    if (f.geometry.type === "GeometryCollection")
      for (const g of f.geometry.geometries) extend(bounds, "coordinates" in g ? g.coordinates : []);
    else extend(bounds, f.geometry.coordinates);
  }
  return bounds.isEmpty() ? null : bounds;
}

/**
 * Small MapLibre map of a review task's features (property `role`: subject red, nearby blue, picked green,
 * others grey). With `onPick`, a click reports its position.
 */
export function MiniMap({
  features,
  onPick,
}: {
  features: GeoJSON.FeatureCollection;
  onPick?: (lon: number, lat: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const onPickRef = useRef(onPick);
  const featuresRef = useRef(features);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!container.current) return;
    const initial = featuresRef.current;
    const bounds = boundsOf(initial);
    const m = new MapLibreMap({
      container: container.current,
      style: MAP_STYLE_URL,
      ...(bounds ? { bounds, fitBoundsOptions: { padding: 40, maxZoom: 15 } } : { center: DEFAULT_CENTER, zoom: 8 }),
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource(SOURCE, { type: "geojson", data: featuresRef.current });
      m.addLayer({
        id: "review-fill",
        type: "fill",
        source: SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: { "fill-color": ROLE_COLOR as never, "fill-opacity": 0.15 },
      });
      m.addLayer({
        id: "review-line",
        type: "line",
        source: SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]]],
        paint: { "line-color": ROLE_COLOR as never, "line-width": 2 },
      });
      m.addLayer({
        id: "review-point",
        type: "circle",
        source: SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        paint: {
          "circle-color": ROLE_COLOR as never,
          "circle-radius": 6,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
    });
    m.on("click", (e) => onPickRef.current?.(e.lngLat.lng, e.lngLat.lat));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    featuresRef.current = features;
    map.current?.getSource<GeoJSONSource>(SOURCE)?.setData(features);
  }, [features]);

  return (
    <div
      ref={container}
      role="region"
      aria-label="Kartenausschnitt"
      className={`h-80 w-full ${onPick ? "[&_canvas]:cursor-crosshair" : ""}`}
    />
  );
}

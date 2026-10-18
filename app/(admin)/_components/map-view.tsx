"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import { useEffect, useRef } from "react";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const CENTER: [number, number] = [23.4, 37.55];

export function MapView() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibreMap({
      container: container.current,
      style: STYLE_URL,
      center: CENTER,
      zoom: 8,
      attributionControl: { compact: false },
    });
    map.addControl(new NavigationControl(), "top-right");
    return () => map.remove();
  }, []);

  return <div ref={container} role="region" aria-label="Karte" className="h-[calc(100vh-8rem)] w-full" />;
}

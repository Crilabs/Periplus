import type { StyleSpecification } from "maplibre-gl";

/**
 * Base map: a reduced dark style on the OpenFreeMap vector tiles (free, no key; OpenMapTiles schema). Sea, land and a
 * fine coastline; roads and buildings only faintly at harbour zoom for orientation. No labels and no symbols, so the
 * style needs no glyphs or sprites and the overlays stay the only coloured, readable things on the map.
 */
const SEA = "#0a1620";
const LAND = "#16242f";
const COAST = "#2c4a5e";
const DETAIL = "#1e3140";

export const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
  },
  layers: [
    { id: "land", type: "background", paint: { "background-color": LAND } },
    {
      id: "landuse",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      minzoom: 10,
      filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "industrial", "commercial"]]],
      paint: { "fill-color": "#192a36" },
    },
    {
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      minzoom: 9,
      paint: { "line-color": SEA, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 14, 1.5] },
    },
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: { "fill-color": SEA, "fill-antialias": true },
    },
    {
      id: "coastline",
      type: "line",
      source: "openmaptiles",
      "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: {
        "line-color": COAST,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 10, 0.8, 15, 1.4],
      },
    },
    {
      id: "roads-major",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 9,
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": DETAIL, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 15, 2.5] },
    },
    {
      id: "roads-minor",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 13,
      filter: ["in", ["get", "class"], ["literal", ["tertiary", "minor", "service"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": DETAIL, "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.3, 16, 1.5] },
    },
    {
      id: "buildings",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": DETAIL, "fill-opacity": 0.8 },
    },
    {
      id: "borders",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": "#3a5568", "line-width": 0.8, "line-dasharray": [3, 2] },
    },
  ],
};

/** Background of the map frame while tiles load: the sea colour, so the first paint does not flash. */
export const MAP_SEA_COLOR = SEA;

/** Initial view without features: the pilot area. */
export const DEFAULT_CENTER: [number, number] = [23.4, 37.55];
/** Data licence of the overlays (OSM-derived geo objects), shown next to the base map's attribution. */
export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap-Mitwirkende, ODbL</a>';

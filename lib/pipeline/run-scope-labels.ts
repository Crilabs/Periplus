import type { RunScopeReason } from "./tile-scope";

/** German text of why a run did not start (`RunScopeNotReady.reason`), for the admin pages and the MCP tools. */
export const RUN_SCOPE_LABELS: Record<RunScopeReason, string> = {
  area_without_geo_object: "Revier hat noch kein Geo-Objekt – zuerst „Gazetteer aufbauen“",
  area_without_coast_tiles: "Revier hat noch keine Küstenkacheln – zuerst „Gazetteer aufbauen“",
  subdivision_without_coast_tiles: "Landesteil hat noch keine Küstenkacheln – zuerst „Gazetteer aufbauen“",
  tile_without_subdivision: "Kachel gehört zu keinem Landesteil – Suchsprachen unbekannt",
  bathymetry_missing: "Bathymetrie fehlt – zuerst „Datensätze laden“",
  land_missing: "Landpolygone fehlen – zuerst die Landpolygone importieren",
  place_not_computable: "Ort wird nicht berechnet (beendet, zusammengeführt, verworfen oder ohne Kachel)",
  unknown_tile: "Kachel ist unbekannt oder beendet",
  unknown_area: "Ein Revier-Schlüssel ist kein Laufumfang mehr – einen Landesteil angeben",
  comparison_set_empty: "Der Vergleichssatz des Reviers ist leer",
  geo_object_without_place: "Geo-Objekt hat keinen gültigen Ort",
  no_research_candidates: "Keine Kandidaten für die Recherche",
  research_run_active: "Für diesen Umfang wartet oder läuft schon eine Recherche – erst ihr Ende abwarten",
  research_gate_closed: "Recherche erst nach bestandenem Navily-Test für weitere Landesteile",
};

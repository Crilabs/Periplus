# Periplus 03 – Gazetteer, Kacheln und Seed (Stufen 1 und 2)

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilenstein: M1 · Quell-Spec: Grundprinzipien 2, 9, 11; Verarbeitungsstufen 1 und 2; „Pilot Saronischer Golf“, Woche 1

## Zweck

Das Verzeichnis aller benannten Geo-Objekte des Zielraums mit Hierarchie und Namensvarianten aufbauen, das Kachelraster anlegen und daraus die Ortskandidaten ableiten. Ergebnis von M1 ist eine Karte, auf der man Reviere, Inseln, Buchten, Häfen und Kandidaten sieht und prüfen kann.

## Zielraum als Konfiguration

`config/areas/<area-key>.json` je Revier: Schlüssel, Namen (de, en, el …), Polygon (GeoJSON) oder Liste von Kacheln, Sprachen der Quellen, Saisonfenster, Zyklus. Pilot: `saronic.json` und `argolic.json`, beide unter dem Label „Saronischer Golf“ für die zwölf Pilotkacheln (23,0–23,75° O, 37,0–38,0° N). Die beiden Polygone werden für den Pilot von Hand gezeichnet (geojson.io, Küste plus etwa 3 sm Wasser) und eingecheckt; die Quell-Spec lässt die Polygonquelle offen, die KI-Ableitung aus Revierführern kommt in M9.

Ein Admin legt ein Revier in der UI nicht an, sondern über eine Konfigurationsdatei und einen Deploy; die UI zeigt sie und startet Läufe. (Entscheidung Claude: Reviere ändern sich selten, und so sind sie versioniert.)

## Raster

- `lib/domain/tiles.ts`: Kachel-ID aus Koordinate, Bounding Box aus ID, Nachbarn (8), Kacheln einer Bounding Box.
- Kacheln werden nur für Reviere angelegt (nicht das ganze Mittelmeer vorab): Job `tiles.ensure` je Revier.
- `has_coast`: Kachel schneidet ein Landpolygon (Teil-Spec 04 lädt die OSM-Landpolygone) — deshalb lädt M1 bereits die Landpolygone für den Revier-Rahmen; die Geometrie-Rechnung bleibt in M2.
- Kacheln ohne Küste bekommen keinen Lauf.

## Stufe 1: Gazetteer (`gazetteer.build` je Revier)

Schritte, jeder als eigener Unter-Job, idempotent über externe IDs:

1. **OSM über Overpass** für die Revier-Bounding-Box plus 5 km. Abfragen nach Quell-Spec Stufe 1 (Meere und Golfe als Relationen; `place=island|islet|archipelago`; `place=town|village|hamlet` im Abstand ≤ 2 km zur Küste; `natural=bay|cape|strait|peninsula`; `seamark:type=harbour|anchorage|mooring|small_craft_facility`; `leisure=marina`; `harbour=*`; POIs für Highlights nach `config/categories.json`). Alle `name:*`-Tags werden zu `geo_names`. Overpass-Antworten werden roh in S3 archiviert (`datasets/overpass/<area>/<datum>.json`) — Rohmaterial ist das Asset.
2. **Wikidata** per SPARQL: Objekte mit Koordinate in der Box und einer der Klassen Insel, Bucht, Kap, Hafen, Siedlung, archäologische Stätte, Kloster, Leuchtturm, Museum, Strand; Labels und Aliase in de, en, el, it, hr. Verknüpfung mit OSM über das `wikidata`-Tag; ohne Tag über Name + Abstand ≤ 1 km.
3. **GeoNames** aus dem Länder-Dump (`GR.zip`, später `HR`, `IT`, …), Feature-Klassen `H` (Buchten, Kanäle), `T` (Kaps, Inseln), `P` (Orte), `L` (Häfen). Ergänzt Namen und Transliterationen; neue Objekte nur, wenn kein OSM-/Wikidata-Objekt desselben Typs im Umkreis von 500 m existiert.
4. **Wikivoyage**: Artikel zu Inseln und Orten des Reviers werden als Dokumente der Quelle `wikivoyage` (Typ `travel_guide`) angelegt; gelesen werden sie erst in Stufe 5.
5. **Zusammenführen**: Regeln in `lib/domain/gazetteer/merge.ts` — gleiche externe ID = gleiches Objekt; sonst gleicher Typ, normalisierter Namensvergleich (trgm ≥ 0,8 in irgendeiner Sprache) und Abstand unter typabhängiger Schwelle (Bucht 300 m, Insel: Punkt im Polygon, Siedlung 500 m). Unsichere Paare werden als Review-Aufgabe `place_candidate` („gleiches Objekt?“) angelegt. OSM ist maßgeblich, außer bei Ankerplätzen (Befund B21, Spec 12): ein OSM-Objekt und ein Objekt nur aus Wikidata oder GeoNames entscheidet das System sofort als „dasselbe“ (das OSM-Objekt bleibt und erhält Namen und IDs); zwei Objekte ohne OSM als „dasselbe“ ab trgm ≥ `trigramMin`, sonst „verschieden“. Ein Mensch entscheidet nur zwei OSM-Objekte, Paare, an denen ein Ort (Ankerplatz, Hafen) hängt, und Highlight-Dubletten (Spec 16). Automatische Entscheidungen stehen in `review_decisions` mit `decided_by = system`; Schalter `merge.autoDecidePairs` in `config/gazetteer.json`.
6. **Hierarchie**: Eltern per Raum: `poi`/`bay`/`harbour`/`settlement` → kleinste Insel oder Küstenabschnitt, die das Objekt enthält (Insel-Polygon mit 200 m Puffer) → Revier (Polygon) → Meer. Objekte auf dem Festland ohne Küstenabschnitt bekommen das Revier als Eltern; Küstenabschnitte für das Festland werden im Pilot von Hand als Polygone in der Revier-Konfiguration ergänzt, wo nötig (Methana, Ermioni, Porto Cheli, Epidavros).
7. **Kachel-Zuordnung**: `tile_geo_objects` neu schreiben. Jede Küstenkachel ohne Revier erzeugt eine Review-Aufgabe `coast_tile_without_area`.

Wiederholung jährlich (M8): neue Objekte anlegen, geänderte Namen als neue `geo_names`-Zeilen, verschwundene Objekte mit `valid_to`.

## Stufe 2: Seed (`seed.tile` je Kachel)

1. Kandidaten = Geo-Objekte vom Typ `bay`, `harbour` und alle mit `seamark`-Hafen-/Ankerplatz-/Marina-Tags in der Kachel. Je Objekt ein `places`-Eintrag mit `status = candidate`, `kind` aus Tags (Marina-Tag → `marina`, Hafen → `port`, Bojenfeld → `mooring_field`, sonst `anchorage`). Buchten ohne Namen aus der Geometrie-Erkennung kommen in M2 dazu.
2. Position = Schwerpunkt der Wasserfläche der Bucht (aus Buchtpolygon minus Land), bei Punkten der Punkt selbst; Häfen: Mitte des Hafenbeckens.
3. Ausschluss: Kandidaten innerhalb einer `restricted_areas`-Fläche mit Ankerverbot (ab M2 befüllt) bekommen `status = no_anchoring` mit Grund. In M1 bleibt dieser Schritt leer, läuft aber schon.
4. Kandidaten ohne Erwähnung bleiben Kandidaten (Quell-Spec). Bestätigt wird in M1 per Review: In der UI kann ein Admin Kandidaten in der Karte bestätigen, verwerfen oder zusammenlegen. Ab M4 entstehen Kandidaten auch aus Texten.
5. Öffentliche ID `sp_<ulid>` wird beim ersten Bestätigen vergeben und nie wieder geändert.

## Highlights (POIs)

OSM- und Wikidata-POIs werden nach `config/categories.json` (Zuordnung Tag → Kategorie, Quell-Spec-Tabelle der Highlight-Kategorien; `quiet` ist keine POI-Kategorie) als `geo_objects` vom Typ `poi` angelegt. Bedeutung (`importance`) und Zuordnung zu Spots rechnet Teil-Spec 07.

## Vergleichssatz anlegen (M1)

Ein Admin legt 50 Orte der Pilotkacheln als Vergleichssatz fest (Teil-Spec 10): Auswahl von bestätigten Orten in der UI, ohne Navily-Daten zu übernehmen.

## UI-Anteil (Teil-Spec 09)

Karte mit Revier-, Kachel- und Gazetteer-Ebenen; Geo-Objekt-Detail mit Namen, Eltern, Kindern, externen IDs; Review-Seiten `place_candidate` und `coast_tile_without_area`; Seite „Läufe“ mit „Gazetteer aufbauen“ und „Seed für Kachel“.

## Adapter und Regeln

- Overpass: eigener Endpunkt konfigurierbar, User-Agent mit Kontakt, höchstens 1 Anfrage gleichzeitig, Timeout 180 s, Fixture-Aufzeichnung für Tests.
- Nominatim (für Stufe 6): höchstens 1 Anfrage/s, nur Umkreissuche.
- GeoNames-Dump wird monatlich höchstens einmal heruntergeladen und in S3 abgelegt.

## Tests und Abnahme

- Unit: Kachel-Mathematik, Zusammenführungsregeln mit konstruierten Paaren, Hierarchie mit synthetischen Polygonen.
- Integration: Gazetteer-Lauf auf aufgezeichneten Overpass-/Wikidata-/GeoNames-Antworten für eine Kachel (Ägina-West) ergibt erwartete Objektzahl und Hierarchie; zweiter Lauf erzeugt keine Dubletten.
- Abnahme M1: jede Insel, jeder Küstenort, jede benannte Bucht der Pilotkacheln mit Namen in Deutsch, Englisch, Griechisch (fehlende deutsche Namen = englischer Name als deutsche Variante mit `origin = 'fallback'`; Abnahme prüft, dass jede Sprache einen Eintrag hat); Kachelzahl mit Küste dokumentiert; Review-Queue der Kandidaten abgearbeitet.

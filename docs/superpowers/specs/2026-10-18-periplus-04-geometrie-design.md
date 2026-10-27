# Periplus 04 – Geometrie, Bathymetrie und Ausschlussflächen (Stufe 3)

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilenstein: M2 · Quell-Spec: Grundprinzip 3; Verarbeitungsstufen 2 (Verbote) und 3; „Technologie“ (Geometrie, Amtliche Verbote); Geklärt am 18.10.2026

## Zweck

Für jeden Ort aus offenen Geodaten berechnen, was sich berechnen lässt: Schutz je Windsektor, Fetch, Schwell-Schutz, Tiefen, Grund, nutzbare Ankerfläche und erste Ankerposition. Dazu amtliche Ausschlussflächen laden und Orte darin ausschließen. Ergebnis sind Facts mit Herkunft `computed` und einer `computations`-Zeile mit allen Eingangsdaten.

## Eingangsdaten (Job `datasets.import` je Revier, Ergebnis in PostGIS)

| Datensatz | Quelle | Form in Periplus |
| --- | --- | --- |
| Landpolygone | OSM Land Polygons (osmdata.openstreetmap.de, `land-polygons-split-4326`), auf Revier-Box + 10 km geschnitten | Tabelle `land_polygons` (geom, dataset_version) |
| Bathymetrie | EMODnet Bathymetry DTM 2024, WCS-Abruf als GeoTIFF für die Revier-Box; HR-Küsten-DTMs, wo vorhanden; GEBCO als Fallback | PostGIS-Raster `bathymetry` (über `raster2pgsql` in einem Import-Job, Kacheln 256×256), Spalte `dataset` und `resolution_m` |
| Meeresboden | EMODnet Seabed Habitats (EUSeaMap, Substrat-Layer) per WFS | Tabelle `seabed_polygons` (substrate → `sand`, `mud`, `gravel`, `rock`, `mixed`; `weed` aus Habitat-Klassen Posidonia/Seegras) |
| Ausschlussflächen | EMODnet Human Activities per WFS: Telekommunikations-/Stromkabel (gepuffert 500 m), Militärgebiete, Natura 2000 / Schutzgebiete mit Ankerverbot, Aquakultur | `restricted_areas` |
| Schiffsdichte | EMODnet Human Activities Vessel Density (Passagier/Fähren) | M9 (Fährkorridore); in M2 nur Download und Ablage |
| NAVTEX-Historie | HNHS-Archiv | M9 (Dauer-Schießgebiete) |

Jeder Import archiviert die Rohdatei in S3 (`datasets/<name>/<version>/…`) und trägt die Datensatzversion in jede Ableitung. Neue Datensatzversion = Stufe 3 läuft für die betroffenen Orte neu (Quell-Spec).

## Algorithmen (`lib/domain/geometry/`, Parameter in `config/geometry.json`)

Alle Rechnungen in einer lokalen metrischen Projektion (UTM-Zone des Reviers, z. B. EPSG:32634 für den Pilot), Ergebnis zurück in WGS84.

1. **Wasserfläche der Bucht:** Buchtpolygon aus OSM (`natural=bay`), sonst Kreis 600 m um den Punkt; davon Land abgezogen.
2. **Fetch je Richtung:** Von der Ankerposition (anfangs Position des Orts) 72 Strahlen im 5°-Abstand, Länge bis 50 km; Fetch = Distanz bis zum ersten Schnitt mit Land (`ST_Intersection` des Strahls mit `land_polygons`, kürzeste Distanz). Strahlen, die nicht schneiden, haben Fetch 50 km.
3. **Schutz je Sektor:** Für jeden der 8 Sektoren (Mitte N=0°, NE=45° …, Breite ±22,5°) die 9 Strahlen des Sektors. Schutz je Strahl = `clamp(1 − log10(fetch_m / f_min) / log10(f_max / f_min), 0, 1)` mit `f_min = 300 m` (voll geschützt), `f_max = 20 km` (offen). Sektor-Schutz = 0,7 × Mittelwert + 0,3 × Minimum der Strahlen (das schwächste Loch zählt). Parameter in `config/geometry.json`, Version als `rules_version`.
4. **Schwell-Schutz:** Dünung kommt um Kaps herum; vereinfacht = Schutz des Sektors mit dem längsten Fetch über 30 km, gemindert, wenn die Öffnung zur See (Winkel der Strahlen mit Fetch > 10 km) breiter als 60° ist. Regel in Code, Parameter in Konfiguration; Konfidenz niedrig (0,4), weil Texte hier entscheiden.
5. **Öffnung zur See:** Peilung (Mittelrichtung) und Winkelbreite der Strahlen mit Fetch > 2 km.
6. **Tiefe:** Raster-Stichproben (`ST_Value`) in 50, 100 und 200 m vor der Ankerposition entlang der Öffnungsrichtung sowie Minimum/Maximum innerhalb der Wasserfläche. Tiefen auf LAT, positiv in Metern. Konfidenz nach Auflösung: HR-DTM 0,8; 115-m-Raster bei Buchtbreite ≥ 300 m 0,6, darunter 0,3 (Quell-Spec, Geklärt).
7. **Ankerfläche:** Teil der Wasserfläche mit Tiefe 3–12 m (Raster zu Polygon, geschnitten mit Wasserfläche), Mindestabstand 30 m zum Land; Fläche in m².
8. **Erste Ankerposition:** Punkt im ufernahen Band der Ankerfläche (Teil höchstens 120 m jenseits des Landabstands, also etwa 30–150 m vom Land, `nearshoreM`) mit maximalem Abstand zum Rand (`ST_MaximumInscribedCircle`); ist das Band leer, gilt derselbe Punkt der ganzen Ankerfläche. Die Ankerfläche selbst bleibt unverändert. Konfidenz 0,3, Herkunft `computed`. Bei leerer Ankerfläche: kein Wert, Lücke.
9. **Grund:** Anteile der Substratklassen innerhalb der Ankerfläche (bzw. Wasserfläche) aus `seabed_polygons`.
10. **Ruhe (`quietness`) Vorstufe:** Abstand zur nächsten Siedlung und Straße aus OSM, als Computation abgelegt; die endgültige Zahl rechnet die Konsolidierung (Teil-Spec 07) mit Belegung und Texten.
11. **Häfen und Marinas:** Wie oben, aber Wasserfläche = Hafenbecken (`harbour`-Polygon oder Mole-Umriss); Regel aus dem Vertrag: mindestens 0,8 je Sektor, solange kein Text eine offene Seite belegt — die Untergrenze setzt die Konsolidierung, die Berechnung liefert den Rohwert.

Jede Rechnung schreibt genau eine `computations`-Zeile je Art und Ort (Eingänge: Datensatzversionen, Parameter, Ankerposition) und je Attribut einen Fact. Identische Eingänge wie beim letzten Lauf = keine neuen Zeilen.

## Unbenannte Buchten (Kandidaten aus Geometrie)

Job `geometry.detect_bays` je Kachel: Küstenlinie in 50-m-Schritten abtasten; ein Punkt gilt als Buchtkandidat, wenn vom Wasser 400 m vor der Küste aus ≥ 180° der Strahlen in ≤ 1,5 km Land treffen und eine Ankerfläche ≥ 5.000 m² existiert. Benachbarte Treffer (< 300 m) werden zusammengefasst. Neue Kandidaten bekommen ein Geo-Objekt mit `origin = 'computed'` und den Namen der nächsten benannten Küstenstelle als Hilfsname („Bucht bei …“, nur Anzeige), Status `candidate`. Dieser Teil ist in M2 optional, wenn die Zeit knapp wird, und rückt sonst in M7 vor der Abdeckungsmessung.

## Ausschluss

`seed.tile` (Teil-Spec 03) setzt für Orte, deren Ankerfläche (oder Position) zu mehr als 50 % in einer Ausschlussfläche mit Ankerverbot liegt, `status = no_anchoring` mit `status_reason` aus `kind`. Orte bleiben erhalten (der Vertrag liefert ausgeschlossene Spots mit Grund). Schutzgebiete ohne Ankerverbot werden nur als Fact `prohibitions`/`hazards` mitgeführt; welche Natura-2000-Gebiete ein Ankerverbot tragen, steht in `config/restrictions.json` (pro Gebiets-ID), weil die WFS-Daten das nicht enthalten.

## UI-Anteil

Ort-Detail: Strahlen-Diagramm (Windrose mit 8 Sektorwerten und 72 Fetch-Strahlen auf der Karte), Tiefen-Stichproben, Ankerfläche und Ankerposition auf der Karte, Eingangsdaten der Computation. Karte: Ebene Ausschlussflächen. Admin kann die Ankerposition per Klick korrigieren (erzeugt einen Review-Fact, Konfidenz 0,9).

## Tests und Abnahme

- Synthetische Küsten (Halbkreis-Bucht nach Süden offen, Kanal, Insel im Meer) mit erwarteten Sektorwerten; Bathymetrie-Test-Raster 10×10.
- Golden-Test an drei realen Pilotorten mit eingecheckten Daten-Ausschnitten; Änderung der Ergebnisse > 0,1 lässt den Test fehlschlagen, bis die Golden-Datei bewusst aktualisiert wird.
- Abnahme M2: jeder Kandidat hat 8 Sektorwerte, Öffnung und eine Tiefenangabe oder eine begründete Lücke; Stichprobe gegen 20 Orte des Vergleichssatzes (Schutz je Sektor) in Teil-Spec 10 erfasst; Laufzeit und Kosten für alle Pilotorte dokumentiert.

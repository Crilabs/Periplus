# Periplus 14 – Raumgliederung: Landesteile, Reviere, Kacheln

Stand: 20.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Zeitpunkt: nach M7, Grundlage von M9 (Ausbau) · Ändert: Teil-Spec 03 (Reviere, Hierarchie, Kacheln), 05 (Quellenfindung), 06 (Erwähnungen), 07 (`popularity`), 08 (Paket-Umfang), 09 (Karte, Review), 10 (Kennzahlen je Revier) · Quell-Spec: Grundprinzipien 2 und 8, Verarbeitungsstufen 1, 4 und 6, offener Punkt „Revier-Polygone“

## Zweck

Periplus soll das ganze Mittelmeer abdecken, ohne dass jemand vorab eine Revierliste mit Grenzen festlegen muss. Bisher ist das Revier zugleich Name in der Welt, Arbeitsumfang, Hierarchie-Ebene und Liefereinheit. Das verträgt sich nicht: Namen wie „Saronischer Golf“ und „Saronische Inseln“ überlappen, ein Arbeitsumfang darf es nicht.

Diese Spec trennt die Rollen:

| Baustein | Rolle | Überlappung | Lückenlos | Herkunft |
| --- | --- | --- | --- | --- |
| **Kachel** | Arbeitseinheit: Stand, Zyklus, Priorität (wie bisher) | nein | ja (Raster) | Raster |
| **Landesteil** | Aufbau Landesteil für Landesteil, Gliederung, Elternkette, Kennzahlen, Lieferumfang (bis Teil-Spec 15) | nein | ja | Verwaltungsgrenzen (OSM, Wikidata) |
| **Revier** | Namen für Quellenfindung und Erwähnungen | ja | nein | per KI vorgeschlagen, Freigabe nach Bahnen, Korrektur in der Karte |
| **Meer** | oberste Ebene, Suchname | nein | ja | IHO-Meeresgebiete |

Ein Revier ist ab jetzt **ein Name, unter dem Segler über ein Gebiet schreiben**: ein fester Schlüssel, 1–n Namen und ein Polygon. Daten hängen nicht am Revier.

Der Endnutzer sieht weder Landesteil noch Revier; er wählt beim Abnehmer eine Heimatmarina (Entscheidung Christian). Die Lieferung nach Umkreis statt je Gebiet ist Gegenstand von Teil-Spec 15; bis dahin ist der Landesteil der Paketumfang.

## Entscheidungen

- Reviere sind intern, keine Planungseinheit für Nutzer (Christian).
- Landesteile: Land, darunter die erste Verwaltungsebene (Christian). Ist ein Landesteil zu groß, wird er über die nächste Verwaltungsebene geteilt, nie über eine eigene Definition (Claude, von Christian bestätigt).
- Begriff „Landesteil“, im Code `subdivision` (ISO 3166-2), öffentliches Präfix `sd_` (Christian). „Region“ scheidet aus, weil der Vertrag `region`/`rg_` schon für Inseln, Küsten, Golfe und Inselgruppen nutzt.
- Aufgebaut wird laufend Landesteil für Landesteil; es gibt keine eigenen Aufträge (Christian).
- Reviere sind Polygone mit 1–n Namen, dürfen sich überlappen; eine Kachel kann in mehreren Revieren liegen (Christian).
- Reviere werden per KI erarbeitet; freigegeben wird in der Karte, nach demselben Muster wie andere Freigaben, ohne dass ein Ablauf wartet (Christian).
- Revier-Quellen: Für jeden Landesteil werden die Berichte zu allen Revieren gesucht, die den Landesteil ganz oder teilweise berühren (Christian).

## Landesteile

### Herkunft

- Neue Geo-Objekt-Typen `country` und `admin_region`. `admin_region` trägt die OSM-Verwaltungsebene (`admin_level`) und ihren Rang unterhalb des Landes (1 = erste Ebene, 2 = darunter).
- Quelle: OSM-Grenzrelationen (`boundary=administrative`) der Anrainerstaaten, Namen aus OSM und Wikidata (wie Teil-Spec 03). Welche `admin_level` je Land die erste und zweite Ebene sind, steht in `config/subdivisions.json` (z. B. Griechenland: Region / Regionalbezirk; Kroatien: Gespanschaft; Italien: Region / Provinz).
- Polygone werden auf Land plus 12 sm Wasser zugeschnitten gespeichert, damit Inseln und Küstengewässer sicher drin liegen; wo sich zwei Landesteile im Wasser berühren, entscheidet für Orte die Landzuordnung (unten), nicht das Polygon.

### Welche Einheit ein Landesteil ist

- Ein **Landesteil** ist eine `admin_region` der ersten Ebene mit Mittelmeerküste (Abgrenzung gegen Atlantik, Schwarzes Meer, Marmarameer und Rotes Meer über das IHO-Polygon „Mediterranean Sea“ aus Marine Regions), oder ein ganzes Land, wenn es keine passende Unterteilung mit Küste hat (Monaco, Malta, Slowenien, Bosnien und Herzegowina, Montenegro, Gibraltar, Gaza).
- **Keine automatische Teilung nach Größe.** Abweichungen von der ersten Ebene stehen ausdrücklich in `config/subdivisions.json`, und ihre Bausteine sind immer Verwaltungseinheiten (Entscheidung Christian, 20.10.2026, nach dem OSM-Probeabzug: 139 Einheiten, Südliche Ägäis 98 Küstenkacheln, Sizilien 65, Libanon sechs Einheiten mit je 2–4):
  - `split`: ein Landesteil wird durch Gruppen von Einheiten der nächsten Ebene ersetzt. Start: Südliche Ägäis (`GR-L`) → Kykladen und Dodekanes, je als Vereinigung ihrer Regionalbezirke.
  - `wholeCountry`: ein Land wird ein einziger Landesteil. Start: Libanon, Israel, Republik Zypern.
  - `extra`: zusätzliche Einheiten aus einer eigenen OSM-Grenze. Start: Nordzypern (Relation 2514541, Ebene 3); seine Fläche wird aus dem Landesteil Zypern herausgenommen.
  - `merge` (ohne Startwerte): mehrere Einheiten derselben Ebene werden einer.
- Schlüssel: ISO 3166-2-Code, wo vorhanden (`GR-L`), sonst `<Land>-<Wikidata-ID>`. Er ist stabil und Teil der Paketpfade. Öffentliche ID mit Präfix `sd_` (Gesamtdesign, IDs).
- Eigene Tabelle `subdivisions` (stabil, kein DELETE, Historie wie `geo_objects`): `id`, `public_id`, `key`, `geo_object_id` (das `country` oder die `admin_region`), `status`, `status_reason`, `built_at` (erster abgeschlossener Landesteil-Lauf), `valid_from`/`valid_to`. Das Geo-Objekt bleibt unberührt, wenn ein Landesteil endet; die Elternkette hängt an den Geo-Objekten, nicht an `subdivisions`.
- Die Landesteilliste wird berechnet (Job `subdivisions.build`) und in der Admin-UI angezeigt. Ändert ein neuer `subdivisions.build` die Liste (andere Ebenen, Teilungen oder Zusammenlegungen), gilt: Landesteile **ohne** `built_at` werden ersetzt (alte enden über `valid_to`, neue entstehen); Landesteile **mit** `built_at` bleiben unverändert, und `subdivisions.build` meldet die Abweichung nur. Einen gebauten Landesteil zu teilen ist eine bewusste Migration außerhalb dieser Spec. (Entscheidung Claude: Paketpfade, `dataVersion` und Kennzahlen gebauter Landesteile bleiben stabil.)
- Die Kachelzahl je Landesteil braucht Landpolygone für das ganze Mittelmeer; `gazetteer.coarse` importiert sie deshalb vorab für alle Anrainer (bisher je Revier-Rahmen).

### Zuordnung eines Orts oder Geo-Objekts

Ein Geo-Objekt gehört zum Landesteil der Küste oder Insel, an der es liegt: zum Landesteil, dessen Landfläche (Landesteilpolygon ∩ Landpolygone) dem Objekt am nächsten ist. Seegrenzen spielen keine Rolle; umstrittene Seegebiete (Ägäis, Zypern) erzeugen so keine Sonderfälle.

Die Zuordnung wird gespeichert: `geo_objects.subdivision_id`, berechnet in der Hierarchie-Stufe. **Sie ist maßgeblich** für Paketinhalt, `popularity`, Kennzahlen und Vergleichssatz. Das Kachel-Label `tiles.subdivision_id` (unten) bestimmt nur den Laufumfang und die Anzeige. Beispiel: Kastellorizo liegt in einer Kachel mit Label Türkei, sein Hafen gehört aber zum Landesteil Südliche Ägäis/Dodekanes und erscheint in dessen Paket. (Entscheidung Claude, folgt aus „jede Insel gehört einem Land“.)

### Konfiguration je Landesteil

`config/subdivisions.json` hält Vorgaben je Land und Ausnahmen je Landesteil: `sourceLanguages` (Vorgabe: Amtssprache(n) + `de` + `en`), `season`, `cycleDays`, `coastSections` (bisher in `config/areas/*.json`), `status`.

`status`: `active` (wird aufgebaut) oder `excluded` mit Grund (Krieg, Sperrgebiet, kein Segelbetrieb; z. B. Libyen, Syrien, Gaza). Ausgeschlossene Landesteile bekommen keine Kacheln und keine Läufe. Nordzypern ist ein eigener Landesteil (eigene Einreise- und Hafenregeln), Gibraltar und die britischen Stützpunktgebiete auf Zypern sind eigene Länder.

### Kacheln

- `tiles.area_id` wird zu `tiles.subdivision_id`: der Landesteil mit dem größten Anteil an der Küstenlänge der Kachel. Es ist das Label für Anzeige und Kachel-Kennzahlen, nicht für Paketinhalt (siehe Zuordnung).
- Eine Kachel an einer Landesteilgrenze gehört zum Laufumfang **beider** Landesteile (alle Küstenkacheln, die das Landesteilpolygon schneiden). **Jeder Landesteil-Lauf bearbeitet sie vollständig**, mit seinen eigenen Eingaben (feiner Gazetteer, Sprachen, Reviere). Nichts wird übersprungen: Die Stufen sind idempotent (externe IDs, Erwähnungen je Dokumentversion, Konsolidierung je Ort), und SERP-Kosten werden über `serp.reuseDays` nicht doppelt fällig. Ein Stand je Kachel und Stufe ist nicht nötig; Zyklen kommen mit dem Scheduler aus M8. (Entscheidung Claude: Überspringen würde Orte des zweiten Landesteils in dieser Kachel verlieren.)
- `tiles.ensure` arbeitet je Landesteil statt je Revier. Die Review-Aufgabe `coast_tile_without_area` entfällt: jede Küstenkachel liegt in einem Landesteil. Der Enum-Wert bleibt (Postgres), neue Aufgaben entstehen nicht mehr.

## Gazetteer in zwei Stufen

| Stufe | Inhalt | Umfang | Job |
| --- | --- | --- | --- |
| Grob | Meere (IHO, Marine Regions, CC-BY), Länder, Verwaltungseinheiten, Golfe, Inselgruppen, Inseln, Küstenorte ab `town` | ganzes Mittelmeer, einmal und dann im Jahreszyklus | `gazetteer.coarse` (je Land als Unter-Job) |
| Fein | Buchten, Häfen, Kaps, Engen, Dörfer, POIs, Wikivoyage | je Landesteil, beim Start des Landesteils | `gazetteer.build` (bisherige Stufen, Umfang Landesteil statt Revier) |

Der grobe Gazetteer ist Voraussetzung für Landesteile (Polygone), die Revier-Polygone (Mitglieder auflösen) und die Karte.

### Elternkette

Die Hierarchie aus Teil-Spec 03, Schritt 6 läuft künftig über die Landesteile statt über das Revier:

Bucht / Hafen / Ort / POI → kleinste Insel oder Küstenabschnitt → `admin_region` (zweite, dann erste Ebene) → `country`.

Das Meer ist eine zweite Kette: jedes Objekt erhält zusätzlich `sea_id` (das IHO-Meer, in dem es liegt oder dem es am nächsten ist). Reviere sind nicht mehr Eltern; sie hängen n:m an Kacheln (über `tile_geo_objects`, wie bisher berechnet) und an Geo-Objekten (neue Tabelle `area_members`, siehe unten).

## Reviere

### Datenmodell

- Ein Revier ist ein Geo-Objekt vom Typ `area` (wie bisher) mit Namen in `geo_names` und Polygon. Es hat keine Eltern.
- Neue Spalten an `geo_objects` (nur für `area`): `area_status` (`candidate` | `approved` | `deferred` | `rejected`), `approval_kind` (`auto` | `manual`, Pflicht bei `approved`). Status- und Polygonwechsel laufen über die vorhandene Historie.
- Neue Tabelle `area_members` (Arbeitszustand, je Neuberechnung ersetzt): `area_id`, `geo_object_id`, `role` (`member` | `boundary`), `origin` (`extraction` | `review`). Mitglieder sind die Inseln, Orte, Golfe, Inselgruppen innerhalb; `boundary` sind Kaps oder Orte, die die Grenze markieren.
- Neue Tabelle `area_evidence` (nur anfügend): `area_id`, `document_version_id`, `chunk_id`, Zitat mit Zeichenbereich, genannte Namen je Sprache, Abgrenzung in Worten, aufgelöste und nicht aufgelöste Mitgliedsnamen, `extraction_run_id`. Kein Revier ohne Zitat.
- Die Pilotreviere `saronic` und `argolic` werden einmalig zu `approved`/`manual` mit ihren bisherigen Polygonen und Namen; `config/areas/` entfällt danach. Die Entscheidung aus Teil-Spec 03 („Reviere per Konfiguration und Deploy“) ist damit aufgehoben.

### Finden (je Landesteil)

1. **Suchen** (`areas.discover`): SERP mit Templates `subdivisionArea` aus `config/discovery.json`, je Sprache des Landesteils, mit den Namen des Landesteils und seines Landes, z. B. „Segelreviere {name}“, „sailing areas {name}“, „Revierführer {name}“, „{name} charter cruising areas“. Kosten gegen das SERP-Budget wie Teil-Spec 05.
2. **Holen**: nur die Treffer-URLs (kein Crawl), über `fetch.url` in einen Lauf der Art `area_probe`. Die Dokumente werden archiviert wie jeder Fetch; ihre Domains landen als normale Quellenvorschläge in der Quellenfreigabe. Zusätzlich gelesen werden alle archivierten Dokumente der Typen `pilot_guide` und `travel_guide`, die den Landesteil berühren.
3. **Extrahieren** (`areas.extract`, Prompt in `config/prompts/`, Modellklasse wie Klassifikation, Batch): je Dokument alle genannten Segelreviere mit Namen je Sprache, wörtlichem Zitat, Abgrenzung in Worten und Mitgliedsnamen. Belegprüfung wie Teil-Spec 06: Zitat muss wörtlich im Chunk stehen, sonst verworfen.
4. **Auflösen**: Mitgliedsnamen gegen den Gazetteer (grob und, wo vorhanden, fein) mit dem Namensabgleich aus Teil-Spec 06, beschränkt auf den Landesteil und seine Nachbarblöcke.
5. **Zusammenführen**: Ein Fund gehört zu einem bestehenden Revier, wenn ein Name übereinstimmt (normalisiert, trgm ≥ Schwelle) und die aufgelösten Mitglieder sich überwiegend decken (Schwelle in `config/areas.json`). Sonst entsteht ein neues Revier `candidate`. Namen und Belege werden angefügt.
6. **Polygon berechnen**: konkave Hülle um die Geometrien der Mitglieder, gepuffert um `polygonBufferNm` (Startwert 3 sm), auf Wasser und Küste begrenzt (Land landeinwärts von mehr als 1 km abgeschnitten). Liegt ein OSM-Golf mit Fläche als Mitglied vor und deckt er die übrigen Mitglieder, ist er das Polygon. Das Modell erzeugt keine Koordinaten.
7. **Bahn bestimmen** (unten), dann `tile_geo_objects` für das Revier neu schreiben.

### Bahnen

Nach dem Muster von Teil-Spec 11, aber ohne Schattenbetrieb: Ein falsches Revier erzeugt nur Suchbegriffe (Kosten im Cent-Bereich), die gefundenen Domains durchlaufen weiter die Quellenfreigabe, und bei Erwähnungen erweitern Reviere die Kandidaten nur (Teil-Spec 06). Schwellen in `config/areas.json`.

| Bahn | Bedingung | Wirkung |
| --- | --- | --- |
| Automatisch aktiv | ≥ `minSources` unabhängige Domains mit Beleg (Start 2), ≥ `minMembers` aufgelöste Mitglieder (Start 2), kein naher Doppelgänger | `approved`, `approval_kind = auto`, keine Aufgabe |
| Aktiv und prüfen | wie oben, aber ein bestehendes Revier überlappt zu mehr als `duplicateOverlap` (Start 0,7, Anteil der kleineren Fläche) und hat einen ähnlichen Namen | `approved`, `approval_kind = auto`, Review-Aufgabe `area_candidate` mit Vorschlag „Zusammenführen“ |
| Zurückgestellt | weniger Quellen oder Mitglieder | `deferred`, keine Suchen; bei jedem neuen Beleg oder neuen Gazetteer-Objekt im Landesteil neu bewertet |

Jede automatische Entscheidung schreibt `review_decisions` mit `decided_by = system`.

### Freigabe in der Karte

Kartenebene „Reviere“ auf `/map`: Polygone nach Bahn eingefärbt, überlappende transparent übereinander, Filter nach Landesteil und Status. Klick auf ein Revier zeigt Namen je Sprache, Mitglieder, Belege mit Zitat und Quelle. Aktionen, für jedes Revier und unabhängig von einer Aufgabe:

- **Entscheidung übernehmen** (`auto` → `manual`),
- **Zusammenführen** mit einem anderen Revier (Namen, Belege und Mitglieder wandern, das andere endet über `merged_into_id`),
- **Namen bearbeiten** (hinzufügen, entfernen, bevorzugten Namen je Sprache setzen; `origin = review`),
- **Abgrenzung ändern**: Mitglieder hinzufügen oder entfernen (Klick auf Geo-Objekte), Polygon neu rechnen,
- **Polygon von Hand** zeichnen als letzter Ausweg (`origin = manual`; wird bei Neuberechnung nicht überschrieben),
- **Verwerfen** (`rejected`): keine weiteren Suchen; vorhandene Dokumente und Facts bleiben.

Nichts im Ablauf wartet auf diese Aktionen.

### Änderung 21.10.2026: Reviere kommen aus dem Revier-Bot

Entscheidung Christian: Ein eigener KI-Bot außerhalb von Periplus findet die Reviere und liefert sie je Land als Datei (erste Lieferung Griechenland, 36 Reviere). Periplus sucht und extrahiert Reviere nicht selbst. Damit entfallen die Abschnitte „Finden (je Landesteil)“ Schritte 1–3, „Bahnen“, die Bearbeitungsaktionen unter „Freigabe in der Karte“, die Review-Art `area_candidate`, `area_status`/`approval_kind`, die Templates `subdivisionArea`, der Prompt `area-extract` und das Budget der Revier-Findung. Korrekturen an Revieren macht der Bot; Periplus übernimmt seinen Stand.

- **Lieferung:** `config/area-imports/<Land>.json` (eingecheckt, Format des Bots: `country`, `generatedAt`, `areas[]` mit `key`, `names[]` (`lang`, `name`, `preferred`), `subdivisions[]`, `members[]` und `boundaryPoints[]` (`name`, `type`), `boundary`, `related[]` (`key`, `relation`: `contains`|`within`|`overlaps`), `evidence[]` (`url`, `publisher`, `lang`, `quote`), `notes`). Die Datei hat keine Polygone.
- **Import** (`areas.import`): je Revier ein Geo-Objekt `area`, Schlüssel `config_key` = Bot-Schlüssel, Namen mit Herkunft `import`, Belege in `area_evidence` (Zitat, URL, Herausgeber, Sprache, Stand der Datei; nur anfügend), `boundary`, `related` und `notes` in `tags`. Ein Revier, das aus der Datei verschwindet, endet über `valid_to`.
- **Mitglieder auflösen:** Mitglieds- und Grenzpunktnamen gegen den Gazetteer (grob und fein) mit dem Namensabgleich aus Teil-Spec 06, beschränkt auf die genannten Landesteile (ein Schlüssel, den `split` ersetzt hat, steht für seine Gruppen, z. B. `GR-L` → Kykladen und Dodekanes) und ihre Nachbarkacheln; der Typ aus der Datei schränkt die Kandidaten ein. Nicht aufgelöste Namen bleiben am Revier vermerkt und werden bei jedem Import neu versucht.
- **Polygon:** wie Schritt 6 oben (konkave Hülle der aufgelösten Mitglieder und Grenzpunkte, gepuffert, Land landeinwärts abgeschnitten; ein Golf als Mitglied, der die übrigen deckt, ist das Polygon). Ein Revier entsteht erst, wenn mindestens `minMembers` Mitglieder aufgelöst sind; bis dahin meldet der Import es als „wartet auf Gazetteer“.
- **Wann:** von Hand per Skript aus der Entwicklungsumgebung, wenn eine neue Datei des Bots eingecheckt ist (`npm run areas:import`, auf dem Server `scripts/import-areas.ts`; keine Oberfläche, Entscheidung Christian), und im Landesteil-Lauf nach der Geometrie und vor der Quellenfindung (neue Gazetteer-Objekte lösen weitere Mitglieder auf). Weitere Länder kommen im selben Format.
- **Pilotreviere:** `saronic` wird zu `saronic-gulf`, `argolic` zu `argolic-gulf` (Zuordnung in `config/areas.json`); das Geo-Objekt mit `ar_`-ID und Revier-Facts bleibt, alte SERP-Suchen unter dem alten Schlüssel zählen weiter.
- **Karte:** Ebene „Reviere“ zur Ansicht mit Filter nach Landesteil; Klick zeigt Namen je Sprache, Mitglieder (aufgelöst und offen), Abgrenzung, Beziehungen, Belege mit Zitat und Quelle.
- Alles Übrige dieser Spec (Datenmodell `area_members`/`area_evidence`, Quellenfindung, Erwähnungen, Nachlesen, Lieferung) gilt unverändert für die importierten Reviere.

## Quellenfindung (ändert Teil-Spec 05)

- **Revier-Ebene:** je Landesteil für alle Reviere mit `approved`, deren Kacheln den Landesteil berühren (auch teilweise), alle Namen in den Sprachen des Landesteils × `templates.area`. Ein Revier wird höchstens einmal je `serp.reuseDays` gesucht, egal wie viele Landesteile es berührt; `serp_results.scope_id` ist die Revier-ID.
- **Landesteil-Ebene:** neu, nur für die Revier-Findung (oben).
- **Kachel-Ebene:** unverändert; Sprachen aus dem Landesteil statt aus dem Revier.

## Erwähnungen (ändert Teil-Spec 06)

- Der Vorlauf zählt Reviere, Landesteile (`country`, `admin_region`) und Meere zu den großen Objekten (`prepassTypes`).
- Rückfall „Revier der Quelle“ wird zu „Kacheln der Reviere, deren Suchen die Quelle fanden“.
- **Nachlesen beim Start eines Landesteils:** Nach dem feinen Gazetteer eines Landesteils läuft Stufe 6 erneut für alle archivierten Dokumentversionen, deren Vorlauf Kacheln des Landesteils berührt. Sonst bleiben Erwähnungen aus Berichten verloren, die vor dem Aufbau des Landesteils geholt wurden (ein Törnbericht „Saronischer Golf“ nennt Orte im Peloponnes, auch wenn nur Attika aufgebaut ist). Lauf-Art `reprocess`, Stufen 6–8, Umfang Landesteil.

## Landesteil-Lauf

Ein Admin startet einen Landesteil auf der neuen Seite `/subdivisions` (siehe Admin-UI). Ein Landesteil-Lauf ist eine Folge von Unterläufen wie bisher je Revier, Umfang `{ type: "subdivision", id }`:

1. `tiles.ensure` (Landesteil)
2. `gazetteer.build` (fein) und Hierarchie
3. Nachlesen der Erwähnungen (oben), parallel zu 4 ff.
4. Seed, Geometrie
5. Revier-Findung: `areas.discover` → `fetch.url` → `areas.extract` → Bahnen
6. Quellenfindung Revier- und Kachel-Ebene; die Revier-Ebene nimmt alle zu diesem Zeitpunkt aktiven Reviere
7. Fetch, Text, Konsolidierung, Paket

Die Schritte 4 bis 7 laufen, wie heute, je Kachel und Kachelblock und warten auf keine Review-Aufgabe. Die Reihenfolge der Landesteile bestimmt der Admin; ein automatischer nächster Landesteil ist nicht Teil dieser Spec.

## Folgen für Konsolidierung, Lieferung, Qualität

- `popularity` (Teil-Spec 07): normiert innerhalb des Landesteils statt des Reviers. Teil-Spec 15 ersetzt das durch eine feste Nachbarschaft je Ort.
- Paket (Teil-Spec 08): Umfang ist der Landesteil; Inhalt sind die Orte und Highlights mit `geo_objects.subdivision_id` = Landesteil. Pfad `deliveries/<subdivision-key>/<dataVersion>/`. **Vertragsversion 2.0** (Entscheidung Claude: die Umbenennung trifft jede Datei, also Major; es gibt noch keinen Abnehmer):
  - `area` wird überall `subdivision`: Hülle jeder Datei (`contract/v1/common.ts`), `manifest.subdivision` (Schlüssel, `sd_`-ID, Namen, Polygon, Bounding Box), Change-Feed je Landesteil.
  - `region.parentId` fällt auf Land oder Verwaltungseinheit zurück, nicht mehr auf das Revier.
  - Neu `manifest.areas`: die Reviere, die den Landesteil berühren (`ar_`-ID, Schlüssel, Namen), nur zur Information.
  - Wechselt ein Ort den Landesteil (nur durch Korrektur der Landzuordnung), erscheint er im alten Feed als entfernt und im neuen als neu; seine `sp_`-ID bleibt.
  - Teil-Spec 15 legt fest, ob die Lieferung nach Umkreis eine weitere Major-Version braucht.
- **Teilweise gebaute Landesteile:** Ein Paket enthält, was bisher bearbeitet ist; das Manifest führt die Kacheln mit Stand (wie v1). Gebaut wird auf Knopfdruck wie heute, unabhängig vom Fortschritt. (Entscheidung Claude.)
- Kennzahlen und Vergleichssatz (Teil-Spec 10): je Landesteil statt je Revier; `comparison_set.area_id` wird `subdivision_id`.
- Revier-Facts (`meltemi_exposure`, `ferry_traffic`, `charter_base`): bleiben am Revier-Objekt (Grundprinzip 8), Konsolidierung unverändert; überlappende Reviere tragen ihre Facts unabhängig.

## Admin-UI (ändert Teil-Spec 09)

- `/subdivisions` „Länder und Landesteile“ (eigener Menüpunkt, Wunsch Christian): Baum **Land → Landesteile**. Ein Land, das als Ganzes ein Landesteil ist (`wholeCountry`, Kleinstaaten), steht als eine Zeile ohne Unterebene. Je Zeile: Name (de), Schlüssel, Status, Küstenkacheln, davon bearbeitet, letzter Lauf, Kosten.
  - **Status je Landesteil:** `nicht begonnen` (kein Lauf), `läuft` (Landesteil-Lauf aktiv), `aufgebaut` (`built_at` gesetzt), `fehlgeschlagen` (letzter Lauf mit Fehler), `ausgeschlossen` (mit Grund aus der Konfiguration).
  - **Status je Land:** zusammengefasst aus seinen Landesteilen (z. B. „3 von 13 aufgebaut, 1 läuft“).
  - **Manuell starten:** Knopf „Aufbauen“ je Landesteil (auch erneut, wenn schon aufgebaut); je Land „Alle offenen aufbauen“, das die nicht begonnenen Landesteile nacheinander in die Warteschlange stellt (Entscheidung Claude). Ausgeschlossene Landesteile haben keinen Knopf.
  - Filter nach Status; Detailseite je Landesteil mit Kacheln, Revieren, Kennzahlen und Läufen.
- `/map`: Ebenen Landesteile, Reviere (mit Bahn), Meere; Reviere wie oben bearbeitbar.
- Review: neue Art `area_candidate` (Zusammenführen, Getrennt lassen, Verwerfen); `coast_tile_without_area` entfällt.
- `/settings`: zeigt `config/subdivisions.json` und `config/areas.json` statt der Revierdateien.

## Konfiguration

| Datei | Inhalt |
| --- | --- |
| `config/subdivisions.json` | Verwaltungsebenen je Land, `split`/`wholeCountry`/`extra`/`merge`, Vorgaben je Land, Ausnahmen und `status` je Landesteil, `coastSections` |
| `config/areas.json` | Schwellen der Bahnen, Zusammenführen, `polygonBufferNm`, Hüllen-Parameter |
| `config/discovery.json` | neue Templates `subdivisionArea` |
| `config/prompts/area-extract.*` | Prompt und Ausgabeschema der Revier-Extraktion |
| `config/budgets.json` | Budget je Landesteil-Lauf für Revier-Findung (SERP und Modell) |

## Umstellung

1. `gazetteer.coarse` und `subdivisions.build` für das Mittelmeer; Landesteilliste in der UI prüfen, `config/subdivisions.json` nachziehen.
2. Migration: `tiles.subdivision_id` aus vorhandenen Kacheln berechnen, Pilotreviere zu `approved`/`manual`, Elternkette neu rechnen, `comparison_set` umschlüsseln, `config/areas/` entfernen.
3. Prüfen, dass die Pilotkacheln dieselben Orte, Facts und Profile haben wie vorher (Abgleich vor/nach als Skript, nur über die bisherigen Pilotkacheln). Pakete für Attika und Peloponnes werden neu gebaut, `dataVersion` startet je Landesteil bei 1; sie enthalten zunächst nur die Pilotkacheln, der Rest kommt mit dem ersten Landesteil-Lauf.
4. Revier-Findung für die Landesteile der Pilotkacheln (Attika, Peloponnes) laufen lassen und Ergebnis in der Karte gegen Ortskenntnis prüfen.

## Tests

- Landesteilbildung: Fixture mit zwei Ländern, einer Region mit `split` in zwei Gruppen, einem Land mit `wholeCountry`, einer `extra`-Einheit, die aus ihrem Land herausgeschnitten wird, und einem Kleinstaat; Schlüssel stabil bei zweitem Lauf.
- Zuordnung nach Landfläche: Insel nahe fremder Küste (Fixture nach Art Kastellorizo) landet im Landesteil ihres Landes.
- Kachel an Landesteilgrenze: in beiden Laufumfängen; der zweite Landesteil-Lauf findet die Buchten seines Landesteils in dieser Kachel, ohne Dubletten aus dem ersten.
- Paketinhalt nach `geo_objects.subdivision_id`, nicht nach Kachel-Label (Fixture Kastellorizo).
- `subdivisions.build` mit geänderter Konfiguration: ungebauter Landesteil wird ersetzt, gebauter bleibt und wird gemeldet.
- Revier-Extraktion mit `MockModel`: Zitat-Prüfung, Auflösung, Zusammenführen zweier Funde, alle drei Bahnen, Doppelgänger-Erkennung.
- Polygonberechnung: Mitglieder → Hülle; OSM-Golf als Polygon; Handpolygon wird nicht überschrieben.
- Quellenfindung: Revier, das zwei Landesteile berührt, wird im Zyklus einmal gesucht.
- Nachlesen: Dokument aus Landesteil A mit Erwähnung eines Orts in Landesteil B erzeugt die Erwähnung nach dem Gazetteer von B.
- Migration: Pilot-Fixture vor und nach der Umstellung gleich.

## Aufwand (grob)

| Teil | Aufwand |
| --- | --- |
| Grob-Gazetteer, Landesteile, `config/subdivisions.json`, Zuordnung, Kacheln je Landesteil | 3–4 Tage |
| Elternkette, Meer-Kette, Erwähnungen (Vorlauf, Nachlesen) | 2 Tage |
| Revier-Findung: Suche, Holen, Extraktion, Auflösen, Zusammenführen, Polygon, Bahnen | 4–5 Tage |
| UI: `/subdivisions`, Kartenebene und Bearbeitung der Reviere, Review `area_candidate` | 3 Tage |
| Folgen: `popularity`, Paket 1.1, Kennzahlen, Migration und Abgleich | 2–3 Tage |

## Abweichungen

Für Abschnitt 4 des Gesamtdesigns:

| Quell-Spec | Periplus | Grund |
| --- | --- | --- |
| Revier als Ebene der Hierarchie (Meer → Revier → Insel → Ort) und als Liefereinheit | Reviere sind überlappende Namensgebiete außerhalb der Hierarchie; Hierarchie und Lieferumfang laufen über Landesteile (Land, Verwaltungseinheit) | Entscheidung Christian: Reviere überlappen in der Welt; Landesteile sind eindeutig und lückenlos |
| Kacheln ohne Revier → Review „Küstenkachel ohne Revier“ | Jede Küstenkachel liegt in einem Landesteil; ausgeschlossene Landesteile statt Einzelentscheidungen | Folge der Landesteile |

Im Gesamtdesign außerdem: Glossar „Revier“ (neue Bedeutung) und neuer Eintrag „Landesteil“ (`subdivision`, Geo-Objekte `country`/`admin_region`); Roadmap M9 „Weitere Reviere“ wird „Landesteil für Landesteil“, „Revier-Polygone per KI“ ist durch diese Spec erledigt; offener Punkt „Revier-Polygone“ geschlossen.

## Was dem Builder überlassen ist

Hüllen-Algorithmus im Detail (`ST_ConcaveHull`-Parameter oder Alpha-Shape), Overpass-Aufteilung des Grob-Gazetteers, Index- und Spaltendetails, ob `area_status` als eigene Tabelle mit Historie statt Spalten umgesetzt wird, Gestaltung von `/subdivisions` und der Kartenwerkzeuge innerhalb von Teil-Spec 09.

## Offene Punkte

- Ob OSM-Verwaltungsgrenzen der ersten Ebene in allen Anrainerstaaten Inseln vollständig einschließen (in manchen Ländern enden sie an der Küstenlinie); Rückfall ist die Landzuordnung, geprüft wird beim ersten `subdivisions.build`.
- Schlüssel ohne ISO-Code (z. B. Keserwan-Jbeil, britische Stützpunktgebiete auf Zypern) und abweichende OSM-Codes (Libyen) vergibt `config/subdivisions.json` von Hand.
- Ob nach Pilot und erstem Ausbau der nächste Landesteil automatisch startet (Nachfrage aus Teil-Spec 15 als Priorität).
- Teil-Spec 15 (Lieferung nach Umkreis um eine Heimatmarina) wartet auf die Frage, ob Abnehmer offline an Bord ein Paket brauchen oder online abfragen.

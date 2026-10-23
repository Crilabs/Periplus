# Periplus N7 – Raumgliederung stabil fürs Mittelmeer, Gazetteer vom Kandidaten aus

Stand 23.10.2026. Umsetzungsschritt (7) aus Abschnitt 9 der Neuausrichtung
(`2026-10-23-periplus-neuausrichtung-design.md`), erweitert um den Gazetteer-Umbau aus Abschnitt 5.1 und 8
(Entscheidung Christian). Läuft parallel zu N1 (Recherche je Kandidat) und ist von ihm unabhängig.

## 1. Warum

Griechenland soll Anfang November laufen, danach das ganze Mittelmeer. Betrieben wird das so: **ein Landesteil nach
dem anderen**, etwa einer pro Tag, nie alles auf einmal (Christian). Dafür muss zweierlei tragen:

- die **einmalige Einrichtung** (Meere, Landpolygone, Länder, Landesteile) auf einer leeren Datenbank, und
- **jeder einzelne Landesteil-Lauf**, auch die großen (Kykladen, Attika mit Athen, Dalmatien, Sizilien).

Heute scheitert beides an bekannten Stellen: zirkuläre Reihenfolge bei der Einrichtung (B3, B14), Overpass-Abbrüche
bei landesweiten Abfragen (B15), Speicherabstürze von Postgres beim Zusammensetzen riesiger Relationen (B4, B5, B16)
und Stunden-Laufzeiten in der Hierarchie (B7), die zum großen Teil von 20.000 landesweit geladenen POIs kommen (B8).
Die bisherigen Fixes (Puffer je Insel, Obergrenze `maxRelationPoints`, zerlegte Landflächen) sind in `main`, aber
Einzelkorrekturen; die Ursachen bleiben.

## 2. Was am Ende gilt (Erfolg)

1. **Einrichtung ohne Handgriffe:** Auf einer leeren Datenbank laufen nacheinander Landpolygon-Import und der Lauf
   „Landesteile neu bilden“ für alle konfigurierten Länder durch. Kein Schritt scheitert „erwartet“, keine Stufe muss
   von Hand einzeln nachgestartet werden. Ein Land, das bei Overpass endgültig scheitert, hält die anderen nicht auf
   und ist in der Oberfläche als fehlgeschlagen sichtbar; ein erneuter Lauf holt nur dieses Land nach.
2. **Jeder Landesteil einzeln:** Ein Landesteil-Lauf (Gerüst, Kandidaten, Dinge an Land, Hierarchie) kommt für die
   schweren Prüf-Landesteile (Abschnitt 6) durch, ohne dass Postgres an seine Speichergrenze kommt, und in Minuten statt
   Stunden.
3. **Dinge an Land nur um Kandidaten:** Nach einem Landesteil-Lauf gibt es Dinge an Land nur im Umkreis von Kandidaten,
   nicht landesweit. Die Athener Innenstadt liefert keine Tausenden POIs mehr.
4. **Gazetteer-Befunde behoben:** B2, B6, B9, B10, B11, B13 (Abschnitt 4.5).

## 3. Ziele, Nicht-Ziele, Anti-Ziele

**Ziele:** Ursachen der Speicher- und Overpass-Probleme beseitigen statt sie zu umgehen; Dinge an Land vom Kandidaten
aus laden; die Seite „Länder und Landesteile“ zeigt ehrlich, was gelaufen ist, weil sie bei täglicher Taktung die
Übersicht ist.

**Nicht-Ziele:**

- Kein Gesamtlauf über alle Länder als Belastungsprobe (Christian: nie alles auf einmal).
- Keine Berechnung der Erreichbarkeit (Fußweg, Bus, Taxi). Das ist Plan 4 („aktueller Stand und Erreichbares“). N7
  lädt nur die Dinge an Land, die Plan 4 braucht.
- Kein eigener Overpass-Spiegel (Entscheidung Claude; der Endpoint bleibt konfigurierbar, falls er später nötig wird).
- Kein Rückbau alter Stufen und keine neue Basis-Migration (Plan 6). Was N7 in Gazetteer-Stufen ändert, ändert es an
  Ort und Stelle; neue Stufen entstehen daneben.
- Keine Änderung an Seed/Geometrie, Sperrflächen (B19), EMODnet-Layer (B18), Ortsbildern (B17).

**Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft):**

- Das Gerüst wird lückenhaft: eine Bucht, ein Hafen, eine Marina oder ein Bojenfeld fehlt, weil eine Abfrage
  verkleinert oder eine Relation übersprungen wurde. Kandidaten entstehen aus dem Gerüst; was dort fehlt, wird nie
  recherchiert. Übersprungenes muss geloggt und gezählt sein.
- Eine Grenze wird nur weiter nach oben geschoben (mehr Speicher, längere Timeouts), statt die Arbeit zu zerlegen.
- N7 stört N1: gemeinsame Dev-DB oder Test-DB werden durch einen Absturz in N7 mitgerissen (Abschnitt 5).

## 4. Was gebaut wird

### 4.1 Einrichtung ohne Kreis (B3, B14)

Heute braucht der Landpolygon-Import die Meere (Box aus `mediterraneanBbox`), die erst `gazetteer.coarse` anlegt, und
`gazetteer.coarse` braucht die Landpolygone für den Küstenfilter der Grob-Orte. Künftig hängt der Landpolygon-Import
nicht mehr an Daten aus der Datenbank: Die Box des Mittelmeers steht in `config/subdivisions.json` (Entscheidung
Claude; Alternative für den Builder: Meere als eigene erste Stufe, solange der Import danach ohne Datenbank-Meere
auskommt). Reihenfolge der Einrichtung, im Runbook als „Erstinstallation“:

1. `npm run import:land-polygons -- --shp … --mediterranean` (Datei-Download bleibt Handarbeit, wie heute).
2. Lauf „Landesteile neu bilden“ in echter Reihenfolge: Meere → Grenzen und Grob-Merkmale je Land →
   `subdivisions.build` → Zuordnung der Grob-Objekte zu Meeren, Landesteilen und Eltern.

Fehlen die Landpolygone, lehnt der Lauf den Start ab (vor dem Anlegen des Laufs, wie `RunScopeNotReady`), statt
mittendrin zu scheitern.

Im Code ist die Reihenfolge heute nicht so (Befund des Prüfers): Meere und alle Länder sind parallele Jobs derselben
Stufe, und `importCoarseFeatures` ruft `assignSeas` und `assignSubdivisions` sofort auf. Auf leerer Datenbank ist das ein
Wettlauf mit dem Meer-Import und ein zweiter versteckter Kreis: Die Grob-Merkmale bekommen keinen Landesteil, weil
`subdivisions.build` noch nicht gelaufen ist. N7 trennt deshalb Import und Zuordnung: Die Meere sind fertig, bevor ein
Land zugeordnet wird, und die Zuordnung zu Landesteilen läuft erst nach `subdivisions.build`.

**Ein Land scheitert** (Entscheidung Claude): `subdivisions.build` baut nur, wenn für alle konfigurierten Länder die
Grob-Daten vorliegen. Sonst bricht die Stufe mit der Liste der fehlenden Länder ab, denn mit einer Lücke würde Land an
der Grenze dem falschen Landesteil zugeordnet (wie bei Gaza, B2). Nachgeholt wird mit demselben Lauf, beschränkt auf
die fehlenden Länder (Parameter `countries`); `gazetteer.coarse` plant dann nur diese, `subdivisions.build` prüft wieder
alle. Heute scheitert eine Stufe erst, wenn alle Jobs scheitern (`lib/domain/runs.ts`); die Prüfung in
`subdivisions.build` schließt diese Lücke.

### 4.2 Overpass je Land in tragbaren Stücken (B15)

`gazetteer.coarse` fragt heute je Land Verwaltungsgrenzen und Inseln, Golfe und Orte in je einer großen Abfrage.
Künftig:

- Die Grob-Abfrage eines Landes wird geteilt, mindestens nach Art (Grenzen; Inseln/Inselgruppen; Golfe/Buchten;
  Orte). Reicht das für große Länder nicht (Griechenland, Italien, Kroatien), zusätzlich nach Kachelblöcken. Wie
  fein, entscheidet der Builder nach Messung; Grenzen in `config/gazetteer.json`.
- Jede Teilabfrage ist einzeln wiederholbar mit längerem Abstand (Overpass-Überlast, 429, 502, 504, Laufzeitfehler im
  `remark`). Ein endgültig gescheitertes Teilstück lässt das Land scheitern, aber nicht den Lauf für die anderen Länder.
- Gleiches gilt für die Overpass-Abfrage des Landesteil-Gerüsts (`gazetteer.osm`), die durch den Wegfall der POIs
  (4.4) ohnehin deutlich kleiner wird.

### 4.3 Große Relationen nicht als Flächen (B5, B6, B16, Ursache von B4)

- Meere, Großregionen und Halbinseln (`natural=peninsula`, `boundary=land_area`, „Balkans“) werden im Gazetteer nicht
  als Flächen zusammengesetzt. Meere kommen ausschließlich aus Marine Regions (wie heute in `importSeas`).
- Halbinseln (B6): über einer Fläche aus Konfiguration verworfen; darunter bleiben sie, aber nicht als
  Küstenabschnitt, sondern als eigene Art oder gar nicht (Builder entscheidet, ob eine Halbinsel als Kontext für
  Namen gebraucht wird; im Zweifel verwerfen).
- `overpass.maxRelationPoints` bleibt als Sicherheitsnetz in allen Gazetteer-Stufen, ist aber nicht mehr der Mechanismus,
  der die bekannten Riesenrelationen ausschließt. Ein Überschreiten wird geloggt und in der Laufzusammenfassung gezählt.
- Jede schwere PostGIS-Operation über Landflächen oder Inselgruppen arbeitet stückweise (Lehre aus B1, B4, B7). Der
  Builder prüft dafür die übrigen Stellen in `lib/domain/gazetteer` und `lib/domain/subdivisions`, die noch ganze
  Flächen auf einmal puffern, vereinigen oder vermessen.

### 4.4 Dinge an Land vom Kandidaten aus (B7, B8)

**Heute:** `gazetteer.osm` und `gazetteer.wikidata` laden POIs für die ganze Box eines Landesteils plus 5 km, sofern
sie höchstens `poiCoastDistanceKm` (20 km) von einem Meer liegen, also auch die Athener Innenstadt.

**Welcher Lauf** (Entscheidung Claude, beim Planen korrigiert): Der Seed braucht die Sperrflächen aus der
Datensatz-Stufe (`no_anchoring`) und kann deshalb nicht in den Gazetteer-Lauf wandern. Die neue Stufe
`gazetteer.land` steht im Lauf „Aufbauen“ (`SUBDIVISION_BUILD_STAGES`) direkt nach `seed.tile`. Zusätzlich gibt es einen
eigenen Lauf „Dinge an Land“ für einen Landesteil oder einzelne Kandidaten. Die Zuordnung der neuen Objekte (Landesteil,
Meer, Eltern, Kacheln) übernimmt die Stufe selbst am Ende, ein zweiter Durchgang von `gazetteer.hierarchy` ist nicht
nötig. Eine Stufe darf je Lauf nur einmal vorkommen (`run_stages` eindeutig je Lauf und Stufe). „Minuten statt
Stunden“ (2.2) wird an den Gazetteer-Stufen und an `gazetteer.land` gemessen; Datensätze, Geometrie, Quellenfindung
usw. zählen nicht.

**Künftig:**

- Das **Gerüst** bleibt landesweit: Inseln, Eilande, Orte (bis `coastDistanceM`), Buchten, Kaps, Häfen, Marinas,
  Bojenfelder, Seezeichen. Es ist die Grundlage der Kandidaten und muss vollständig sein.
- **Dinge an Land** kommen aus einer neuen Stufe des Landesteil-Laufs, die nach dem Seed läuft (dann gibt es Kandidaten:
  `places` gültig, nicht zusammengeführt, Status `candidate` oder `confirmed`, wie N1). Sie lädt in zwei Ringen um jeden
  Kandidaten (Entscheidung Claude, abgeleitet aus Spec 5.7):
  - **Nahbereich** (Startwert 2,1 km Luftlinie = 1,5 km Fußweg × Umwegfaktor 1,4): Tavernen, Restaurants, Cafés,
    Bars, Supermärkte, Läden, Bäcker, Märkte, Strände, Bushaltestellen, Taxistände, Fähranleger und mögliche
    Anlandestellen (Steg, Pier, Slipanlage, Strandzugang).
  - **Fernbereich** (Startwert 15 km): nur Orte und Sehenswertes, und Sehenswertes nur mit Wikidata-Bezug und
    mindestens N Sitelinks (Startwert 5, Konfiguration; Entscheidung Claude). Ein OSM-Objekt ohne `wikidata`-Tag zählt
    im Fernbereich nicht. Die Sitelinks holt die neue Stufe selbst vor dem Filter; heute holt sie erst die
    Datensatz-Stufe nach dem Gazetteer. Teil-Spec 16 kennt keine reine Sitelink-Schwelle, ihre Wichtigkeit braucht
    Textquellen, die es beim Laden noch nicht gibt. Ohne diese Schwelle holt der 15-km-Ring um die Marinas von Piräus
    die Athener Innenstadt wieder herein.
  - **Ohne Namen** (Entscheidung Claude): Anlandestellen (Steg, Pier, Slipanlage, Strandzugang), Bushaltestellen und
    Taxistände werden auch ohne `name` gespeichert. Sie sind für Crews auch namenlos nützlich, und meistens haben sie
    keinen Namen. Heute verwirft `classifyOsm` alles ohne Namen; für diese Kategorien wird das geändert (Anzeige als
    Kategorie, kein erfundener Name). Für alle übrigen Kategorien bleibt der Name Pflicht.
  - **Nur Dinge an Land** (Entscheidung Claude): Die neue Stufe schreibt ausschließlich POIs und, im Fernbereich, Orte. Ein Fähranleger oder Steg
    mit `harbour=*` oder Hafen-Seezeichen, den der Klassifikator als `harbour` erkennen würde, wird von ihr nicht als
    Hafen angelegt. Häfen kommen nur aus dem Gerüst, sonst würde der nächste Seed daraus Kandidaten machen.
  - Radien, Kategorien je Ring und Schwellen in Konfiguration (`config/categories.json` um Bus, Taxi, Fähre, Bäcker und
    Anlandestellen ergänzt; Ringe in `config/gazetteer.json`).
- Die Stufe ist für einen einzelnen Kandidaten startbar, weil die Entdeckung (Spec 5.5) später neue Kandidaten
  nachliefert. Sie ist wiederholbar, ohne Dubletten zu erzeugen (Upsert über `osm_id` / `wikidata_id` wie heute).
- Die Overpass-Abfrage nutzt die Kandidaten als Mittelpunkte (`around` mit mehreren Koordinaten oder kleine Boxen),
  zerlegt in Stücke, nicht eine Box über den ganzen Landesteil.
- `gazetteer.hierarchy` läuft danach für die neuen Objekte; mit wenigen Tausend statt 25.000 Objekten.
- Was Plan 4 mit den Dingen an Land macht (Erreichbarkeit, Lieferung), ist nicht Teil von N7. Bestehende Nutzer der
  POIs (alte Highlights, Konsolidierung, Lieferung 3.0, Umkreis-Lieferung) laufen weiter, bekommen nur weniger POIs.
- Bestehende landesweite POIs in Datenbanken werden nicht gelöscht; die Dev-Daten werden ohnehin neu aufgesetzt (Spec 9).

### 4.5 Gazetteer-Befunde (Christian: „passt“)

| Befund | Lösung |
| --- | --- |
| B2 Palästina ohne `admin_level` | Länder-Relation je Land in `config/subdivisions.json` vorgebbar (z. B. `countryRelation: 1703814`) |
| B6 Halbinseln als Küstenabschnitt | siehe 4.3 |
| B9 Dubletten von Buchten 700–1.100 m auseinander; Wikidata-Häfen als Buchten | größerer Zusammenführungs-Abstand für Buchten bei hoher Namensähnlichkeit (Startwert 1.500 m, Konfiguration); Klassenabbildung prüfen, damit Wikidata-Häfen keine Buchten werden. Sonst recherchiert N1 dieselbe Bucht doppelt |
| B10 Buchten und Eilande vor einer Insel hängen am Landesteil | Elternregel: nächste Insel innerhalb eines Abstands (Startwert einige hundert Meter, Konfiguration) statt nur Inselfläche + 200 m |
| B11 Status „0 von 13 aufgebaut“ trotz gelaufener Stufen | Seite „Länder und Landesteile“ zeigt je Landesteil, welche Stufen zuletzt wann gelaufen sind (auch Einzelläufe), ein laufender Landesteil ist erkennbar; Länder mit begonnenem Landesteil sind aufgeklappt |
| B13 Sprachcode `und` | wird als „ohne Sprache“ angezeigt |

## 5. Entwicklungsumgebung

- **Eigene Datenbanken für N7** (Christian): ein eigenes Compose-Projekt (z. B. `periplus-n7`) mit Dev-Postgres auf
  Port 5435 und Test-Postgres auf 5436, aus demselben `docker/postgres`-Image. Die geteilten 5433 und 5434 bleiben
  unberührt; N1 macht dort seinen Probelauf.
- **Speichergrenze je Container:** Die Docker-VM (5,8 GB) ist allen Containern gemeinsam. Ein Speicherabsturz in N7 darf
  nicht den Kernel-OOM-Killer der VM auslösen, der den größten Prozess beendet, womöglich den Postgres von N1. Die
  N7-Container bekommen deshalb ein eigenes Speicherlimit (Startwert 2 GB Dev, 1 GB Test; Entscheidung Claude). Das
  Limit ist zugleich die Messlatte aus Abschnitt 2: Ein Landesteil-Lauf muss darunter bleiben.
- **S3:** der geteilte SeaweedFS mit eigenem Bucket (`periplus-n7`), damit sich Archivschlüssel nicht mischen.
- **Migrationen:** möglichst keine. Braucht N7 eine (etwa für Status je Landesteil-Stufe), bekommt sie die nächste
  freie Nummer auf diesem Branch; wer später nach `main` kommt, rebased und nummeriert neu (N1 hat `0069_research`, die
  Umkreis-Lieferung `0069_radius_packages`).
- Tests wie überall gegen echte Postgres (die N7-Test-DB), kein Netz; Overpass, Wikidata, Marine Regions über Fixtures.

## 6. Prüfung mit echten Daten

In der N7-Dev-DB, nicht in Produktion:

1. Einrichtung auf leerer Datenbank (2.1). Gemessen: Dauer, Overpass-Wiederholungen, gescheiterte Länder.
2. Landesteil-Läufe für drei schwere Landesteile: **GR-CYC** (Kykladen, 3.845 Inseln, B4), **GR-I** (Attika mit Athen,
   B7, B8) und einen großen außerhalb Griechenlands (Vorschlag: Dalmatien oder Sizilien; der Builder wählt den
   schwersten). Gemessen: Spitzenspeicher des Postgres-Containers, Dauer je Stufe, Zahl der Dinge an Land vorher (alte
   Zahlen aus den Befunden) und nachher, übersprungene Relationen.
3. Stichprobe Vollständigkeit des Gerüsts in GR-I gegen den Stand vor N7: keine Bucht, kein Hafen, keine Marina
   verloren.

Ergebnisse als Nachprüfung in `docs/pilot/pruefung/befunde.md` bei den jeweiligen Befunden.

## 7. Dem Builder überlassen

Feinheit der Overpass-Teilung je Land; ob Kandidaten-Ringe als `around`-Abfrage oder als Boxen gebaut werden;
Schwelle der Halbinsel-Fläche und ob kleine Halbinseln bleiben; genaue Startwerte für B9/B10 nach Prüfung an den
Beispielen der Befunde; wie der Status je Landesteil-Stufe gespeichert wird (aus `runs` abgeleitet oder eigene
Spalten); Aufteilung in Aufgaben und PRs; Wahl des dritten Prüf-Landesteils.

## 8. Entscheidungen

**Christian:** Gazetteer-Umbau gehört zu N7; Landesteile werden einzeln angestoßen, kein Gesamtlauf; B2, B9, B10, B11,
B13 wie in 4.5; eigene Dev-DB für N7; Plan vor Code.

**Claude** (änderbar): Mittelmeer-Box in Konfiguration statt aus den Meeren; `subdivisions.build` wartet auf alle
Länder, Nachholen per Lauf nur für die fehlenden Länder; Dinge an Land als Stufe nach dem Seed in „Aufbauen“ und als eigener Lauf; zwei Ringe
(2,1 km / 15 km) mit Sehenswertem im Fernring nur ab 5 Sitelinks; Anlandestellen, Bus und Taxi auch ohne Namen; die neue
Stufe schreibt nur POIs; Anlandestellen, Bus, Taxi, Fähre und Bäcker als Kategorien schon
in N7; kein eigener Overpass-Spiegel; Speicherlimit je N7-Container; Prüfung an drei schweren Landesteilen statt am
ganzen Mittelmeer.

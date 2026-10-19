# M2 Abnahme: Geometrie und Ausschlüsse

Abnahmekriterium aus der Roadmap (Gesamtdesign): Jeder Kandidat hat 8 Sektorwerte mit Beleg; Stichprobe gegen Vergleichssatz dokumentiert. Teil-Spec 04: jeder Kandidat hat 8 Sektorwerte, Öffnung und eine Tiefenangabe oder eine begründete Lücke; Stichprobe gegen 20 Orte des Vergleichssatzes (Schutz je Sektor); Laufzeit und Kosten für alle Pilotorte dokumentiert.
Ablauf der Läufe: `docs/runbook.md`, Abschnitt „Geometrie und Ausschlüsse“.

## Vom Code geprüft (Stand der Umsetzung)
- [x] Stufen `datasets.import` (Bathymetrie, Meeresboden, Ausschlussflächen, Straßen, Schiffsdichte) und `geometry.place` (Wasser- und Ankerfläche, Ankerposition, Fetch, Schutz, Schwell, Öffnung, Tiefe, Grund, Ausschluss, Ruhe-Vorstufe) sind umgesetzt; jede Rechnung schreibt eine `computations`-Zeile mit allen Eingängen, identische Eingänge schreiben nichts.
- [x] Golden-Test an drei realen Orten (Perdika, Aponisos, Hafen Aegina) mit eingecheckten Daten-Ausschnitten grün (`lib/pipeline/__tests__/geometry-golden.test.ts`); Meeresboden fehlt darin noch (siehe unten).
- [x] Admin-Oberfläche: Reiter „Geometrie“ am Ort (Windrose, 72 Strahlen, Tiefen, Ankerfläche, Ankerkorrektur), Kartenebene Ausschlussflächen, Läufe „Datensätze laden“ und „Geometrie für Revier“.
- [x] `npm run check:geometry -- --area <key>` prüft je Ort 8 Sektorwerte, Öffnung und Tiefe oder begründete Lücke.
- [x] `npm run compare:navily -- --area <key>` schreibt den Stichprobenbericht mit Laufzeit und Kosten nach `docs/pilot/`, ohne Navily-Werte.

## Offen für Christian (Übergabe, nicht automatisierbar)
1. [ ] **Natura-2000-Gebiete mit Ankerverbot** im Saronischen und Argolischen Golf prüfen und ihre Gebietscodes in `config/restrictions.json` (`protectedAreaAnchoringBan`) eintragen; die Liste startet leer.
2. [ ] **Ausschlussflächen bestätigen:**
   - Kabel kommen aus OSM statt EMODnet (EMODnet führt für das Mittelmeer keine Kabel mehr): Abdeckung im Pilot gegen Seekarte prüfen; Puffer steht auf 200 m (`config/datasets.json`), Teil-Spec 04 nennt 500 m – Wert bestätigen.
   - Aquakultur-Punkte werden mit 250 m gepuffert (Spec nennt keinen Radius) – bestätigen.
   - Militärgebiete einschließlich griechischer Schießgebiete werden als `military` gespeichert (beides Ankerverbot; `firing_area` bleibt bis NAVTEX in M9 ungenutzt) – bestätigen.
3. [ ] **Meeresboden im Golden-Test nachholen**, sobald der EMODnet-Seabed-WFS wieder antwortet (am 19.10.2026 lief jede GetFeature-Anfrage in den Timeout): in einer `_scratch`-Datenbank `npm run fixtures:record -- --area aegina-west --datasets` aufnehmen, `seabed` in `RECORDED_DATASETS` des Golden-Tests aufnehmen, `UPDATE_GOLDEN=1 npx vitest run lib/pipeline/__tests__/geometry-golden.test.ts`, Werte prüfen und einchecken.
4. [ ] **Auf dem Server**, je Revier (`saronic`, danach `argolic`):
   1. Landpolygone neu importieren (`landBufferKm` 55 km statt 10 km).
   2. „Datensätze laden“, danach „Geometrie für Revier“ starten; fehlgeschlagene Jobs unter „Review“ ansehen.
   3. `check:geometry` ausführen, bis es mit Exit 0 endet.
   4. Vergleichssatz mit mindestens 20 Orten (Seite „Qualität“), dann `compare:navily` mit `NAVILY_SPOTS_PATH` (Runbook); Bericht unter `docs/pilot/` einchecken und die Abweichungen ansehen.

## Abnahmekriterien
- [ ] **8 Sektorwerte mit Beleg je Kandidat:** `npm run check:geometry -- --area saronic` und `--area argolic` enden mit Exit 0; jeder Sektorwert ist ein Fact mit `computation_id` (Reiter „Geometrie“ zeigt die Computation mit Eingängen).
- [ ] **Öffnung** (`opening_bearing`) je Kandidat vorhanden (Teil der Prüfung).
- [ ] **Tiefe oder begründete Lücke** je Kandidat: `depth.approach` oder `depth.min`, sonst Lücke `no_bathymetry` oder `no_anchor_area` (Ausgabe „depth gaps“).
- [ ] **Stichprobe ≥ 20 Orte** des Vergleichssatzes gegen Navily dokumentiert: Bericht `docs/pilot/<datum>-m2-stichprobe.md` eingecheckt (Schutz je Sektor; Grund und Tiefendeckung als Zusatz).
- [ ] **Laufzeit und Kosten** für alle Pilotorte dokumentiert (Abschnitte im Stichprobenbericht).
- [x] **Golden-Test grün** (CI-Job `check`) – ohne Meeresboden, siehe offener Punkt zum Seabed-Fixture.

## Bewusst verschoben
- Unbenannte Buchten aus Geometrie (`geometry.detect_bays`) → M7; HR-Küsten-DTMs und GEBCO-Fallback, wenn der Pilot Lücken zeigt; Mole-Umriss für Häfen (Hafenbecken = Hafenpolygon oder 250-m-Kreis); Schiffsdichte nur abgelegt (Verbraucher M9).
- Lücken (`outputs.gaps`) bleiben bis zur Konsolidierung (M5) an den Computations; ohne Wasserfläche trägt die Ankerflächen-Rechnung die Lücken für Schutz, Fetch, Tiefe und Grund.

## Ergebnis
Datum der Abnahme: _offen_. Ausgabe von `check:geometry` (saronic / argolic): _offen_. Stichprobenbericht: _offen_.

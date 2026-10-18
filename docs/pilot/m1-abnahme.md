# M1 Abnahme: Gazetteer und Kacheln

Abnahmekriterium aus der Roadmap (Gesamtdesign) und Teil-Spec 03: Die Karte zeigt Kacheln, Hierarchie und Kandidaten; jede Insel, jeder Küstenort und jede benannte Bucht hat Namen in de, en und el.
Ablauf der Läufe: `docs/runbook.md`, Abschnitt „Gazetteer und Seed“.

## Vom Code geprüft (Stand der Umsetzung)
- [x] Gazetteer-Stufen (Kacheln, OSM, Wikidata, GeoNames, Hierarchie), Seed, Review-Oberfläche, Karte, Detailseiten, Vergleichssatz, Landpolygon-Import und Fixture-Aufnahme sind umgesetzt und getestet.
- [x] `npm run check:gazetteer -- --area <key>` prüft die Namen und zählt Küstenkacheln und offene Kandidatenaufgaben.

## Offen für Christian (Übergabe, nicht automatisierbar)
1. [ ] Revier-Polygone (`saronic`, `argolic`) und die Küstenabschnitte von `saronic` (Methana, Ermioni, Porto Cheli, Epidavros) in geojson.io nachzeichnen und in `config/areas/*.json` einchecken.
2. [ ] Server einrichten (Runbook, Abschnitte 1 bis 6) und die GitHub-Secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST` setzen; erst dann wird der CI-Job `deploy` grün.
3. [ ] Landpolygone auf dem Server importieren (`import:land-polygons`, je Revier).
4. [ ] Läufe starten: „Gazetteer aufbauen“, danach „Seed für Revier“, je Revier.

## Abnahmekriterien
- [ ] **Karte** zeigt Kacheln, Reviere, Hierarchie und Kandidaten (Seite „Karte“; Ebenen für Reviere, Kacheln, Gazetteer, Orte).
- [ ] **Namen** de/en/el vollständig: `npm run check:gazetteer -- --area saronic` und `--area argolic` enden mit Exit 0 (keine Objekte unter „objects without de/en/el names“).
- [ ] **Küstenkacheln** gezählt und hier dokumentiert: Pilot saronic: _offen_ von 12 Kacheln; argolic: _offen_ (Ausgabe `tiles with coast`).
- [ ] **Kandidaten-Queue** abgearbeitet: unter „Review“ keine offenen Aufgaben „Ortskandidat“ (Orte und Paare) und „Küstenkachel ohne Revier“; `open candidate tasks: 0`.
- [ ] **Vergleichssatz** mit 50 Orten der Pilotkacheln gewählt (Seite „Qualität“); er speichert nur Ort-IDs, keine Navily-Werte.

## Ergebnis
Datum der Abnahme: _offen_. Ausgabe von `check:gazetteer`: _offen_.

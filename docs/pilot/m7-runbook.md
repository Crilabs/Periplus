# M7 Pilot: Ablauf mit echten Daten (Runbook)

Stand 2026-10-20, nach M7 Teil (a) (Code). Er ersetzt den Entwurf aus dem M7-Preflight. Die Rulings M7-P1 … M7-P30 und die Rulings der Bündel stehen im Ledger (`.superpowers/sdd/2026-10-19-periplus-m7-pilot/`). Die Abnahme-Checkliste mit allen offenen Punkten steht in `docs/pilot/m7-abnahme.md`. Technik je Stufe: `docs/runbook.md`.

**Nichts davon ist gestartet.** Teil (b) braucht Christians Entscheidungen und eine Freigabe der Gesamtausgabe (≈ 125 €, Obergrenze P29 200 €).

## Voraussetzungen
- M6 und M7 (Code, Teil a) auf `main` gemergt.
- `npm run services:up`.
- **`npm run db:migrate`.** Die Entwicklungsdatenbank steht auf Migration **0038**. Nach dem Migrieren steht sie auf **0047**, dem Stand nach M7. Ohne 0044–0047 fehlen `quality_snapshots`, `comparison_results` und `config_activations`; „Messen“, `compare:navily` und `report:*` scheitern dann.
- Admin anlegen: `npm run user:create`.
- `npm run worker` und `npm run dev` starten.
- `.env.local` enthält alle Schlüssel (geprüft: Anthropic, Voyage, DataForSEO, Jina, Firecrawl, Kontakt-E-Mail).
- `NAVILY_SPOTS_PATH` zeigt auf die Navily-Datei außerhalb des Repos (`~/Code/dontsticktoaplan/data/navily-spots.json`). Sie wird nie eingecheckt, gespeichert oder geloggt.
- Kostengrundlagen:
  - `config/discovery.json`: 0,0035 € je Suche, ≤ 240 je Lauf.
  - `config/embeddings.json`: 0,055 €/MTok.
  - `config/fetch.json`: Jina 0,02 €/MTok, Firecrawl 0,0047 € je Credit.
  - `config/models.json`: Preise Sonnet/Haiku/Opus, Batch 50 %. Prompt `extract-facts` v4.
  - Abnahmedokumente M3–M5: Konverter-Vergleich 0,25 €, etwa 0,02 € je Sonnet-Einheit, Modellvergleich ≈ 13 €, Summary ≈ 0,02 €, gezielte Quellenfindung ≈ 1,90 € je 12 Kacheln.
- Annahmen:
  - etwa 150–250 bestätigte Orte und 200–600 POIs in `saronic` und `argolic` zusammen;
  - 30 Quellen × ≤ 500 Seiten, also etwa 3.000–6.000 Dokumente;
  - etwa 2.000–6.000 Extraktionseinheiten.

## Schritte
| # | Schritt | Dienst | Kosten € (erwartet / Spanne) | Braucht Christian |
| --- | --- | --- | --- | --- |
| 0 | Revierpolygone und Küstenabschnitte `saronic` neu zeichnen (M1-Übergabe 1) oder die Entwürfe übernehmen | – | 0 | **Entscheidung** |
| 1 | Landpolygone laden (osmdata, ~1 GB), dann `npm run import:land-polygons -- --shp <pfad>/land_polygons.shp --area saronic` (und `argolic`) | OSM | 0 | – |
| 2 | „Gazetteer aufbauen“ je Revier | Overpass, Wikidata, GeoNames | 0 | – |
| 3 | „Seed für Revier“; Ortskandidaten, Paare und Küstenkacheln prüfen; `npm run check:gazetteer -- --area saronic` und `-- --area argolic` mit Exit 0 | – | 0 | **Review (Stunden)** |
| 4 | Natura-2000-Codes, Kabelpuffer 200 oder 500 m, Aquakultur 250 m, Militär (M2-Übergaben 1–2) | – | 0 | **Entscheidung** |
| 5 | „Datensätze laden“ je Revier (EMODnet DTM, Seegrund, menschliche Nutzung, Straßen, Sitelinks) | EMODnet, Overpass, Wikidata | 0 | – |
| 6 | „Geometrie für Revier“: die erste Stufe `geometry.detect_bays` sucht je Küstenkachel unbenannte Buchten (Task 18, unten); dann `check:geometry -- --area <key>` mit Exit 0; die neuen Ortskandidaten prüfen; danach `check:gazetteer` erneut mit Exit 0 (er zählt offene Kandidatenaufgaben) | lokal | 0 | **Review** |
| 7 | Vergleichssatz mit 50 Orten auf „Qualität“ wählen; `npm run compare:navily -- --area saronic` (M2-Stichprobe, Bericht nach `docs/pilot/`) | lokal | 0 | **50 Orte wählen** |
| 8 | Quellenfindung `saronic` (`argolic` nach P25), Vorschläge prüfen, 20–40 freigeben | DataForSEO | 0,84 / ≤ 1,7 | **Quellen freigeben** |
| 9 | Wikivoyage je Revier; Testcrawl 10 Seiten je Quelle; Crawl-Regeln | lokaler Konverter | 0 | **Crawl-Regeln** |
| 10 | Konverter-Vergleich (50 Seiten), drei Spalten bewerten, `npm run report:converters`, Entscheidung in `config/fetch.json` | Firecrawl, Jina | 0,25 | **bewerten und entscheiden** |
| 11 | Zwei PDF-Revierführer hochladen; `npm run pdf:compare -- <a.pdf> <b.pdf>`; Entscheidung `pdf` | Anthropic (Fallback ≤ 40 Seiten je Dokument) | 1,0 / ≤ 1,3 | **PDFs bereitstellen, entscheiden** |
| 12 | Voller Crawl „Alle freigegebenen crawlen“; Vorschläge aus dem Linkgraphen prüfen; `check:sources` Exit 0 | Konverter (lokal 0 · Jina ~1 · Firecrawl 15–30), Voyage | 1 / 0,5–1,5 (+ Konverter) | Review |
| 13 | „Texte auswerten für Revier“: Klassifikation (Haiku), Disambiguierung, Geocoding, Extraktion (Sonnet, Prompt v4), Routen, Belegprüfung, Konsolidierung mit Summaries und Folgeaufträgen. Dauert bei 20 €/Tag mindestens 3–7 Tage. **Nach dem ersten Text-Lauf** die Prüfungen „max_facts“ und „run_id“ unten ausführen | Anthropic, Nominatim, DataForSEO | 95 / 55–175 (Extraktion 45–140, Routen 2–15, Summaries 7–17, Klassifikation 1–2, Folgeaufträge ≤ 1,6) | – |
| 14 | Namenskandidaten prüfen (Rematch-Läufe). Unbenannte Buchten aus Schritt 6 bekommen ihren Namen nur so („Name zuordnen“) | – | gering (in 13) | **Review** |
| 15 | Modellvergleich `npm run compare:models -- --label pilot --start` an einem Tag ohne andere Anthropic-Ausgaben | Anthropic | 13 / ≤ 15 | – |
| 16 | 50 Bewertungen, `npm run report:models -- <comparisonId>`, Modellentscheidung in `config/models.json`; bei Opus beide Reviere neu verarbeiten | Anthropic | 0 (Sonnet) / +90–280 (Opus) | **bewerten und entscheiden** |
| 17 | `fixtures:record --ai …` (optional); `check:texts` Exit 0; Entscheidung Kachelgrenzen (`neighbourRing`) | Anthropic | 0,3 | **Entscheidung** |
| 18 | `npm run consolidate -- --area <key>` für beide Reviere; Konflikte, Unsicherheiten und Summaries prüfen; `check:profiles` Exit 0 | Anthropic (Summaries geänderter Profile) | in 13 / ≤ 3 | **Review** |
| 19 | ODbL rechtlich prüfen (M6-Übergabe), bevor ein Paket hinausgeht | – | 0 | **rechtlich** |
| 20 | „Paket bauen“ je Revier; Befunde nach `docs/runbook.md` „Verstöße beheben“ beheben, neu bauen bis „Gültig“; `npm run apikey:create -- <abnehmer> --scope delivery:read`; `npm run delivery:consume -- --base-url http://localhost:<port des Entwicklungsservers> --area saronic` bis `OK` (Schlüssel über `PERIPLUS_API_KEY`, Runbook „Abnehmer-Prüfung“) | lokal; Anthropic nur für neu erzeugte Summaries (je ≈ 0,02 €) | 0 | Review |
| 21 | **Messung „Lauf 1“**: „Qualität“ → Revier → „Messen“, Bezeichnung `Lauf 1`, „von“ leer lassen (erste Messung: Beginn des ersten Laufs; wird verweigert, wenn es keinen Lauf gibt), „bis“ leer (jetzt) | lokal | 0 | – |
| 22 | **Navily-Abgleich** (unten): `compare:navily --accept-proposals`, dann `/quality/compare` und die Abweichungen im Review, dann `--coverage` | lokal (Navily-Datei zur Laufzeit) | 0 | **Abweichungen prüfen, P24** |
| 23 | **Simulierter Revisit, Vorbereitung** (unten): Tag D Paket bauen; Tag D+1 Klon, Szenario-Entwurf, Szenario prüfen | lokal | 0 | **Szenario prüfen** |
| 24 | **Simulierter Revisit, Ausführung** (unten): `sim:worker`, zweimal `sim:revisit`, Paket in der Simulation bauen, Simulations-Web aus eigenem Worktree auf :3001, `sim:verify` | Anthropic, Voyage | 1,5 / 1–3 | – |
| 25 | **Echter „Lauf 2“** (P28: mindestens 7 Tage nach Lauf 1): „Revisit für Revier“. Er blockiert für seine ganze Dauer (auch Extraktion und Konsolidierung, Stunden) jeden Crawl der freigegebenen Quellen (M7-G-R4): keinen Crawl daneben planen. Seine Aufgaben mit Zeitmessung prüfen (Seite der Aufgabe offen lassen, bis entschieden ist; eine Bearbeitung zählt höchstens 10 min). Dann Messung „Lauf 2“ | Konverter, Voyage, Anthropic | 10 / 5–20 (Firecrawl +15–30) | **Review (< 60 min)** |
| 26 | Optional: Regressionsbewertung (unten). Regeln allein kostenlos; ein Extraktionskandidat bewertet nur vorhandene Extraktionsläufe | Anthropic | 0 / ≤ 3 | Aktivierung entscheiden |
| 27 | Berichte (unten): `report:costs`, `report:pilot`; Ergebnisse der Abnahmen M3/M4/M5/M6/M7 und die Kachelgröße eintragen | lokal | 0 | **abzeichnen** |

### Schritt 6: Unbenannte Buchten (Task 18, Ruling M7-P13)
- Die Stufe läuft bei jeder „Geometrie für Revier“ und „Geometrie für Kachel“, nicht für einen einzelnen Ort.
- Parameter in `config/geometry.json` (`bays`), Anzeige unter „Einstellungen“ → Geometrie:
  - Küste alle 50 m abtasten;
  - Prüfpunkt 400 m vor der Küste;
  - ≥ 180° der 72 Strahlen treffen in 1,5 km Land;
  - Ankerfläche (3–12 m Tiefe, 30 m von Land, im 600-m-Kreis) ≥ 5.000 m²;
  - Treffer unter 300 m zusammengefasst.
- Eine Bucht gilt als bekannt, wenn ein Ort (jeder Status, auch abgelehnt) oder eine Bucht oder ein Hafen des Gazetteers näher als 500 m liegt. Ein neuer Lauf legt sie dann nicht wieder an. Verworfene Buchten kommen so nie wieder.
- Neue Buchten:
  - Geo-Objekt Typ Bucht, Herkunft „Berechnet“, ohne Namen;
  - Ort „Ankerplatz“ im Status Kandidat;
  - Prüfaufgabe „Ortskandidat“. Die Liste zeigt sie als „Bucht bei <nächster benannter Ort>“. Das ist nur ein Hilfsname, kein gespeicherter Name.
- **Nie automatisch bestätigt.** Im selben Lauf rechnet `geometry.place` ihre Geometrie: Schutz, Ankerfläche, Ausschluss in Sperrgebieten.
- Ein bestätigter unbenannter Ort zählt für die Abdeckung. Geliefert wird er erst mit einem Namen: ohne gültigen Namen lässt das Paket den Spot aus (Warnung „kein gültiger Name“). Einen Namen bekommt er über „Name zuordnen“ bei einem Namenskandidaten aus Texten (Schritt 14).
- Kosten 0 (nur Datenbank). Laufzeit auf echten Küsten ist ungemessen; im Lauf auf `/runs` beobachten, Stopp-Bedingung unten.

### Nach dem ersten Text-Lauf (Schritt 13)
1. **max_facts.** Prompt v4 verlangt einen Fact je Listeneintrag, also mehr Facts je Einheit (Ruling M7-G-R5, M7-H-R1). Prüfen, ob Einheiten an `maxFactsPerUnit` (40, `config/extraction.json`) stoßen:
   ```sql
   select count(*) filter (where (stats->>'overLimit')::int > 0) as at_limit, count(*) as units
   from extraction_units where extraction_run_id in (select id from extraction_runs where run_id = '<text-lauf>');
   ```
   Mehr als 1 % der Einheiten mit `at_limit` > 0: anhalten und berichten. Christian entscheidet über ein höheres `maxFactsPerUnit` (neue Konfiguration, Regressionsbewertung) oder kleinere Einheiten.
2. **run_id.** Nach dem ersten echten Text- oder Bewertungslauf prüfen, dass jeder bezahlte Aufruf einen Lauf trägt (Ruling M7-D-R3). Sonst verteilt die Kosten-Kennzahl ihn falsch:
   ```sql
   select service, stage, count(*) from external_calls
   where cost_eur > 0 and run_id is null and at > '<beginn des laufs>' group by 1, 2;
   ```
   Erwartet: keine Zeile, außer `smoke:ai` (Betriebskosten, M7-D-R1). Sonst berichten.

## Qualität messen (Schritte 21, 25)
- „Qualität“ → Revier → Panel „Messen“:
  - Bezeichnung (`Lauf 1`, `Lauf 2`), „von“ und „bis“ (beide optional, „bis“ einschließlich).
  - Ohne „von“ schließt die Messung an das Ende der letzten beendeten Messung des Reviers an. Die erste Messung beginnt beim ersten Lauf.
  - Eine Bezeichnung gibt es je Revier nur einmal. Eine fehlgeschlagene Messung gibt sie wieder frei.
  - Während einer laufenden Messung desselben Reviers wird eine zweite verweigert.
- Die Messung ist ein eigener Lauf (`quality.measure`). Ihre Kennzahlen stehen als Snapshots und erscheinen auf „Qualität“ mit Status je Zielwert:
  - Abnahme-Kennzahlen (P12): `coverage_navily`, `multi_document`, Fact-Präzision, Belegtreue, Schutz-Konfidenz, Routen-Rekonstruktion, Kosten je Ort, `review_minutes`.
  - Daneben `coverage`, `multi_source`, `places_per_tile` (Ziel 10–40) sowie Highlight- und Beobachtungsanteil.
- Kosten und Review-Aufwand gelten für das Zeitfenster:
  - Kosten ohne Kachel- oder Revierbezug werden nach Anteil bestätigter Orte verteilt. Kacheln ohne Revier zählen für niemanden.
  - Einmalkosten des Piloten (Konverter-, Modell-, PDF-Vergleich, Bewertungen) stehen getrennt (P15).
- Belegtreue unter 100 % sperrt die Konsolidierung des Laufs (Runbook „Gesperrter Extraktionslauf“).

## Navily-Abgleich (Schritt 22)
- **Die Datei** liegt lokal außerhalb des Repos bzw. auf dem Server nur für die Dauer des Laufs (`docs/runbook.md`, Geometrie Schritt 5). Sie wird über `NAVILY_SPOTS_PATH` oder `--navily <pfad>` zur Laufzeit gelesen.
- **Nie Navily-Werte eintragen**: nicht in die Datenbank, Reviews, Berichte, Commits oder Tickets. Gespeichert werden nur Ergebnisse (`match`, `deviation`, …) und Zählwerte.
- **Ablauf:**
  1. **Erstdurchgang:** `npm run compare:navily -- --area saronic --accept-proposals`. Er übernimmt alle Vorschläge des Assistenten als `proposal_auto` (`checked_by navily-assistant/1`) und überschreibt nie ein von Hand gesetztes Ergebnis. Vorher den Anteil `deviation` je Sektor-Attribut ansehen (Stopp-Bedingung).
  2. **`/quality/compare?area=saronic`:** Ort für Ort prüfen. Die Seite zeigt Navily-Namen zur Laufzeit (M7-P23) und speichert nur das bestätigte Ergebnis. Navily-Spots ohne Periplus-Ort erscheinen nur hier („wird nicht gespeichert“).
  3. **Review „Vergleichsabweichung“** (`comparison_deviation`): „Eigener Wert stimmt“, „Navily stimmt“ oder „Unklar“. Aufgaben eines Bewertungslaufs tragen in Liste und Detail das Kennzeichen „Bewertung“.
  4. **Abdeckung:** `npm run compare:navily -- --area saronic --coverage` schreibt `coverage_navily` als Zählwerte. Danach erneut „Messen“, sonst steht der Wert nicht in der Messung.

## Regression (Schritt 26)
**Neue Regelversion:**
1. `config/consolidation/v<n>.json` anlegen (nie die aktive ändern) und deployen.
2. „Qualität“ → „Regression“: Regelversion wählen → „Bewertung starten“. Das ist ein Bewertungslauf über den Vergleichssatz: nur Bewertungsprofile, keine Ereignisse, keine Lieferung.
3. Geänderte Werte prüfen: Vergleich alt/neu auf der Seite. Neue Abweichungen erscheinen als Aufgaben „Bewertung“ im Review.
4. „Aktivieren“ → „Jetzt aktivieren“. Der Knopf erscheint nur, wenn Übereinstimmung und Abdeckung nicht sinken und mindestens ein Wert verglichen wurde.
   - Die Aktivierung gilt sofort für alle Reviere: jede neue Konsolidierung, Lieferung und Summary.
   - Sie wird verweigert, wenn ein Ort des Vergleichssatzes nach der Bewertung ein neues Profil bekam. Dann neu bewerten.

**Prompt oder Modell:**
1. Modell und Prompt-Version wählen → „Bewertung starten“. Bewertet werden nur vorhandene Extraktionsläufe dieser Konfiguration; neu extrahiert wird nichts. Einen neuen Extraktionslauf liefert „Reprozessieren für Revier“ (kostet).
2. Freigeben mit „Jetzt aktivieren“.
3. Wirksam wird die Freigabe erst mit dem Deploy von `config/models.json`. „Einstellungen“ zeigt, ob die laufende Extraktionskonfiguration freigegeben ist.

## Simulierter Revisit (Schritte 23, 24)
Ruling M7-P27, Runbook-Abschnitt „Simulierter Revisit“ in `docs/runbook.md`.

**Zeitliche Bedingung:** der Revisit frühestens am Tag nach dem letzten Paketbau. Sonst trennt `asOf` die Stände nicht, und `sim:verify` verweigert mit Grund.

### Tag D
- `npm run consolidate -- --area saronic`.
- „Paket bauen“ für `saronic` bis „Gültig“.

### Tag D+1, Vorbereitung
1. **Entwicklungs-Worker stoppen.**
2. **Klonen:** `npm run sim:clone` (lokal: Compose-Dienst `db`; `-- --force` ersetzt einen vorhandenen Klon).
   - Der Klon `periplus_sim` behält die Queue-Definitionen. Alle Jobs werden gelöscht.
   - `sim_meta` hält `from_seq` fest, die Grenze „vor dem Revisit“.
   - Server: `bash scripts/sim/clone.sh --compose-file docker/compose.prod.yml --service postgres --db-user <POSTGRES_USER>`.
3. **`.env.sim`:**
   - `cp .env.sim.example .env.sim`.
   - Die übrigen Werte aus `.env.local` übernehmen.
   - `S3_WRITE_PREFIX=sim/<datum>/` setzen (Kleinbuchstaben, endet auf `/`).
   - `PERIPLUS_SIMULATION=data/sim/scenario.json`.
   - `sim:worker`, `sim:draft-scenario`, `sim:revisit` und `sim:verify` lesen nur diese Datei (`tsx --env-file=.env.sim`). Ohne sie scheitern sie laut.
4. **Szenario-Entwurf:** `npm run sim:draft-scenario -- --area saronic --out data/sim/scenario.json [--seed <n>]`.
   - Schreibt nur unter `data/sim/` und überschreibt nie.
   - Lücken (Kategorien, die das Archiv nicht hergibt) stehen als deutsche Zeilen in der Ausgabe.
5. **Szenario prüfen (Christian):** jede der 10 Änderungen, ihre Notiz und ihre Erwartung.
   - Ablegen nur unter `data/sim/` (git-ignoriert). **Nie einchecken:** das Szenario zitiert fremde Seiten wörtlich.
   - Änderungsarten: Textänderung, Löschen, Anhängen, 404, unverändert. **„Neue Seite“ gibt es nicht** (M7-F-R3).
   - Die Erwartungen folgen M5: ein gestrichener Satz ist keine Profiländerung, eine verneinte Taverne `changed`.

### Tag D+1, Ausführung
1. **Worker:** `npm run sim:worker` in einem eigenen Terminal.
   - Die Leitplanke verweigert den Start ohne `periplus_sim` und ohne Präfix.
   - Kein Text-Lauf der Entwicklung, solange er läuft (gleicher Anthropic-Schlüssel).
2. **Revisit:** `npm run sim:revisit -- --area saronic --scenario data/sim/scenario.json`.
   - Wartet höchstens 6 h, danach auf `/runs` der Simulation weiter beobachten.
   - **Zweimal ausführen**, nach dem Ende des ersten: der zweite Aufruf ist der zweite Abruf (eine 404-Seite wird erst beim zweiten Fehlen `gone`) und muss sonst ohne Ereignisse bleiben.
   - Verweigert ohne gültiges Paket des Reviers (Tag D), ohne Klon (`sim_meta`) und bei einem anderen Szenario als `PERIPLUS_SIMULATION`.
   - `foreignJobs > 0` oder ein Preflight-Fehler bedeutet Stopp.
3. **Simulations-Web aus einem eigenen Worktree** (Ruling M7-H-R1). Next 16 verweigert ein zweites `next dev` im selben Projektordner (Sperre `.next/dev/lock`). Deshalb **nie** `npx next dev -p 3001` neben dem normalen Entwicklungsserver im selben Ordner starten:
   ```bash
   git worktree add ../periplus-sim HEAD
   cd ../periplus-sim && npm ci
   cp ../periplus/.env.sim .env.local                       # Sim-Werte: periplus_sim, S3_WRITE_PREFIX, PERIPLUS_SIMULATION
   mkdir -p data/sim && cp ../periplus/data/sim/scenario.json data/sim/
   npm run build && npx next start -p 3001                  # oder: npx next dev -p 3001 (eigenes .next im Worktree)
   ```
   Danach den Worktree entfernen: `git worktree remove ../periplus-sim`.
4. **Paket in der Simulation bauen:** `http://localhost:3001` → „Lieferungen“ → „Paket bauen“ für `saronic`. Es muss am Tag nach dem Paket von Tag D liegen.
5. **API-Schlüssel in der Simulation:** `npm run apikey:create -- sim-check --scope delivery:read` mit `DATABASE_URL` von `.env.sim`, z. B. `npx tsx --env-file=.env.sim scripts/apikey.ts create sim-check --scope delivery:read`.
6. **Verifikation**, erst nach dem Ende beider Revisit-Läufe (sonst verweigert):
   ```bash
   npm run sim:verify -- --area saronic --scenario data/sim/scenario.json \
     --base-url http://localhost:3001 --key pk_… [--spot sp_…] --out docs/pilot/<datum>-revisit.json
   ```
   - Erwartet: 10 von 10, 0 unerwartete, „asOf ok“, Exit 0.
   - Die JSON-Datei enthält Ergebnis, asOf-Prüfung und die Kosten der Sim-Datenbank. Sie zitiert keine fremden Seiten und darf eingecheckt werden. Vorher prüfen.
   - Den Schlüssel nicht in die Shell-History schreiben (Runbook „Abnehmer-Prüfung“).
7. **Aufräumen:** Sim-Worker und Sim-Web stoppen.
   - `dropdb periplus_sim`, lokal: `docker compose -f docker/compose.dev.yml exec db dropdb -U periplus periplus_sim`.
   - Alle Objekte unter dem Präfix `sim/<datum>/` im Bucket löschen.
   - `.env.sim` behalten oder löschen (nie einchecken).
   - Danach den Entwicklungs-Worker wieder starten.

## Berichte (Schritt 27)
- **Kosten:**
  ```bash
  npm run report:costs -- --area saronic --first "Lauf 1" --second "Lauf 2" --revisit docs/pilot/<datum>-revisit.json
  ```
  → `docs/pilot/<datum>-kostenbericht.md`: Kosten je Stufe, je Dienst, je Ort und Lauf, Einmalkosten, Simulation, Annahmen, Hochrechnung Mittelmeer (60–100 Reviere, Ortszahl aus `config/quality.json`, sonst aus Lauf 2).
- **Pilotbericht:**
  ```bash
  npm run report:pilot -- --area saronic --first "Lauf 1" --second "Lauf 2" --revisit docs/pilot/<datum>-revisit.json --consumer-ok --data-version <n>
  ```
  → `docs/pilot/<datum>-pilotbericht.md`.
  - `--consumer-ok --data-version` nur, wenn `delivery:consume` für diese Version `OK` meldete.
  - Der Bericht enthält Checkliste, Kennzahlen, Revisit, Review-Aufwand und Kachelgröße.
  - Gazetteer und Kachelgröße entscheidet Christian; die Entscheidung im Bericht nachtragen.
- Erst danach M8.

## Kosten
**Erwartete echte Ausgabe gesamt: ≈ 125 € (Spanne ≈ 80–220 €)**, mit Sonnet und dem lokalen oder dem Jina-Konverter (Schritte 8, 10–13, 15, 17, 18, 24–26). Zuschläge:
- +15–30 € je vollem Crawl, falls Firecrawl gewählt wird;
- +90–280 €, falls die Modellentscheidung Opus ist.

Weitere Erwartungen:
- Kosten je Ort ≈ 0,5–0,9 € (Pilotziel < 2 €).
- Anthropic dominiert (~110 €). Bei der Tagesgrenze von 20 € verteilt sich die bezahlte Textarbeit auf mindestens 6 Kalendertage.
- DataForSEO ≤ 3,5 € (aber ~900 Aufrufe, P25). Voyage ≤ 2 €.
- Kostenlos: unbenannte Buchten, Messung, Navily-Abgleich und Berichte.
- Die Simulation kostet nur die Modellaufrufe der geänderten Chunks (≈ 1–3 €). Sie steht im Kostenbericht getrennt.

## Stopp-Bedingungen
Anhalten, berichten, auf Christian warten:
- **Budget**:
  - kumulierte `external_calls` über der Pilotgrenze (P29, Vorgabe 200 €);
  - die Schätzung eines Schritts über dem 1,5-Fachen seiner Zeile oben. Vor dem Absenden der Masse `Einheiten × 0,02 €` aus den geplanten Einheiten des Text-Laufs prüfen.
  - Eine tägliche Queue-Pause ist normal und kein Stopp. Der Modellvergleich bricht über `--max-eur 15` ab.
- **Belegtreue < 100 %** (gesperrter Extraktionslauf) oder gesperrtes `consolidation.geo`: Kette anhalten, prüfen (Runbook „Gesperrter Extraktionslauf“), nie blind „Belegtreue neu prüfen“.
- **Fehlerraten**:
  - fehlgeschlagene Jobs > 5 % der Jobs einer Stufe;
  - ein fehlgeschlagener Job `embed.chunks`/`fetch.*` bleibt offen;
  - je Quelle `failed` in der Frontier > 20 % → Quelle pausieren;
  - Anthropic-Wiederholungen wegen `max_tokens`/Ablehnung > 2 % der Einheiten;
  - mehr als 1 % der Einheiten am Fact-Limit (`overLimit`, oben);
  - bezahlte Aufrufe ohne `run_id` (oben);
  - wiederholte 429/5xx eines Anbieters länger als 1 h;
  - Overpass-/EMODnet-Timeouts, die eine Kachel ohne Bathymetrie lassen (die Geometrie verweigert dann).
- **Plausibilität**:
  - < 100 oder > 400 bestätigte Orte je Revier;
  - mehr als 30 unbenannte Buchten je Revier aus `geometry.detect_bays`, oder ein Job dieser Stufe länger als 15 min (Parameter verdächtig);
  - eine Quelle mit > 2.000 Dokumenten (Crawl-Regeln zu weit);
  - Anteil deterministischer Erwähnungen < 70 % (`check:texts`);
  - Lieferung `rejected`;
  - Navily-Vorschläge mit > 30 % `deviation` bei einem Sektor-Attribut (Matcher oder Schwelle verdächtig), bevor alle übernommen werden.
- **Simulation**:
  - Schutz verweigert (Datenbank nicht `periplus_sim`, kein Präfix);
  - `foreignJobs > 0`;
  - Preflight-Fehler;
  - `sim:verify` nicht 10/10 mit 0 unerwarteten.
  - Dann anhalten. Das Szenario erst korrigieren, wenn Christian entschieden hat, welche Seite falsch ist.

## Entscheidungen für Christian
**Blockieren einen Schritt:**

| Entscheidung | Schritt |
| --- | --- |
| Revierpolygone | 0 |
| M2-Sperrparameter und Natura-2000-Codes | 4 |
| Kandidaten aus unbenannten Buchten | 6 |
| Vergleichssatz mit 50 Orten | 7 |
| Quellenfreigaben, Typen, Gewichte, Crawl-Regeln | 8, 9, 12 |
| Konverter-Bewertung und -Wahl | 10 |
| die zwei PDF-Revierführer und die Wahl `pdf` | 11 |
| `maxFactsPerUnit`, falls Einheiten am Limit stehen | 13 |
| Modellbewertung und -wahl sowie die Ausgabe für eine Neuverarbeitung mit Opus | 16 |
| Kachelgrenzen | 17 |
| Kachelgröße | 18, 27 |
| ODbL-Prüfung | 19 |
| Navily-Abweichungen und P24 | 22 |
| Szenario prüfen | 23 |
| Aktivierung von Regeln oder Extraktion | 26 |
| Abzeichnen | 27 |

**Reviews, die Zeit brauchen:**
- Ortskandidaten (3, 6);
- Namenskandidaten (14);
- Konflikte, Unsicherheiten und Summaries (18);
- Review von Lauf 2 mit Zeitmessung unter 60 Minuten (25).

## Vorgaben, wo jeder Weg geraten ist
1. **P28: was „zweiter Lauf“ ist und wann er läuft.** Die Datendienst-Spec meint mit dem zweiten Durchgang den simulierten Revisit; Spec 10 und der Plan ergänzen einen echten Lauf 2. Vorgabe: echter Lauf 2 mindestens 7 Tage nach Lauf 1. Der Aufwand der Simulation wird daneben berichtet.
2. **P29: Obergrenze der Gesamtausgabe.** Freigegeben sind nur Tagesgrenzen. Vorgabe 200 € (Sonnet, lokaler oder Jina-Konverter); für Opus oder Firecrawl braucht es eine neue Freigabe.
3. **P13: `detect_bays` in M7.** Als Task 18 umgesetzt (Schritt 6). Alternative wäre gewesen, es nach M9 zu schieben und hinzunehmen, dass unbenannte Navily-Buchten `coverage_navily` senken.
4. **P25: SERP < 500 Aufrufe.** Quellenfindung und Folgeaufträge zusammen überschreiten das. Vorgabe: `saronic` zuerst, Quellenfindung für `argolic` nur nach Freigabe.
5. **P12: Mehrbefund.** Datendienst-Spec (≥ 2 Dokumente) gegen Spec 10 (≥ 2 Quellen). Vorgabe: Datendienst-Spec für die Abnahme.
6. **P24: maschinell übernommene Navily-Zuordnungen** zählen für die Präzision. Vorgabe: erlaubt, ihr Anteil wird berichtet.
7. **P10: Aktivierungsmechanismus.** Auflösung über die Datenbank (`config_activations`) statt über `active.json`. Vorgabe: Auflösung über die Datenbank nach Spec 10.

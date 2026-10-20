# M7 Pilot: Ablauf mit echten Daten (Entwurf)

Entwurf aus dem M7-Preflight (Teil b: echte Daten auf dem lokalen Entwicklungs-Stack), Stand 2026-10-20. Die Rulings M7-P1 … M7-P30 stehen im M7-Preflight (noch nicht eingecheckt); hier sind nur die Schritte, Kosten, Stopp-Bedingungen und Entscheidungen übernommen. **Nichts davon ist gestartet**: Teil (b) braucht Christians Entscheidungen und eine Freigabe der Gesamtausgabe.

## Voraussetzungen
- M6 und M7 (Code, Teil a) auf `main` gemergt.
- `npm run services:up`; `npm run db:migrate` (die Entwicklungsdatenbank steht auf Migration 0037); Admin anlegen (`npm run user:create`); `npm run worker` und `npm run dev`.
- `.env.local` enthält alle Schlüssel (geprüft: Anthropic, Voyage, DataForSEO, Jina, Firecrawl, Kontakt-E-Mail).
- Kostengrundlagen: `config/discovery.json` (0,0035 € je Suche, ≤ 240 je Lauf), `config/embeddings.json` (0,055 €/MTok), `config/fetch.json` (Jina 0,02 €/MTok, Firecrawl 0,0047 € je Credit), `config/models.json` (Preise Sonnet/Haiku/Opus, Batch 50 %), Abnahmedokumente M3–M5 (Konverter-Vergleich 0,25 €, etwa 0,02 € je Sonnet-Einheit, Modellvergleich ≈ 13 €, Summary ≈ 0,02 €, gezielte Quellenfindung ≈ 1,90 € je 12 Kacheln).
- Annahmen: etwa 150–250 bestätigte Orte und 200–600 POIs in `saronic` und `argolic` zusammen; 30 Quellen × ≤ 500 Seiten → etwa 3.000–6.000 Dokumente; etwa 2.000–6.000 Extraktionseinheiten.

## Schritte
| # | Schritt | Dienst | Kosten € (erwartet / Spanne) | Braucht Christian |
| --- | --- | --- | --- | --- |
| 0 | Revierpolygone und Küstenabschnitte `saronic` neu zeichnen (M1-Übergabe 1) oder die Entwürfe übernehmen | – | 0 | **Entscheidung** |
| 1 | Landpolygone laden (osmdata, ~1 GB) und `import:land-polygons` für `saronic`, `argolic` | OSM | 0 | – |
| 2 | „Gazetteer aufbauen“ je Revier | Overpass, Wikidata, GeoNames | 0 | – |
| 3 | „Seed für Revier“; Ortskandidaten, Paare und Küstenkacheln prüfen; `check:gazetteer` für beide Reviere Exit 0 | – | 0 | **Review (Stunden)** |
| 4 | Natura-2000-Codes, Kabelpuffer 200 oder 500 m, Aquakultur 250 m, Militär (M2-Übergaben 1–2) | – | 0 | **Entscheidung** |
| 5 | „Datensätze laden“ je Revier (EMODnet DTM, Seegrund, menschliche Nutzung, Straßen, Sitelinks) | EMODnet, Overpass, Wikidata | 0 | – |
| 6 | „Geometrie für Revier“; `check:geometry` Exit 0; ggf. unbenannte Buchten (Task 18) und Kandidaten-Review, falls P13 | lokal | 0 | Review |
| 7 | Vergleichssatz mit 50 Orten auf „Qualität“; Bericht `compare:navily` zur M2-Stichprobe | lokal | 0 | **50 Orte wählen** |
| 8 | Quellenfindung `saronic` (`argolic` nach P25) → Vorschläge prüfen → 20–40 freigegeben | DataForSEO | 0,84 / ≤ 1,7 | **Quellen freigeben** |
| 9 | Wikivoyage je Revier; Testcrawl 10 Seiten je Quelle; Crawl-Regeln | lokaler Konverter | 0 | **Crawl-Regeln** |
| 10 | Konverter-Vergleich (50 Seiten), drei Spalten bewerten, `report:converters`, Entscheidung in `config/fetch.json` | Firecrawl, Jina | 0,25 | **bewerten und entscheiden** |
| 11 | Zwei PDF-Revierführer hochladen; `pdf:compare`; Entscheidung `pdf` | Anthropic (Fallback ≤ 40 Seiten je Dokument) | 1,0 / ≤ 1,3 | **PDFs bereitstellen, entscheiden** |
| 12 | Voller Crawl „Alle freigegebenen crawlen“; Vorschläge aus dem Linkgraphen prüfen; `check:sources` Exit 0 | Konverter (lokal 0 · Jina ~1 · Firecrawl 15–30), Voyage | 1 / 0,5–1,5 (+ Konverter) | Review |
| 13 | „Neue Texte auswerten“ (Klassifikation Haiku, Disambiguierung, Geocoding, Extraktion Sonnet, Routen, Belegprüfung, Konsolidierung mit Summaries und Folgeaufträgen) – dauert bei 20 €/Tag mindestens 3–7 Tage | Anthropic, Nominatim, DataForSEO | 95 / 55–175 (Extraktion 45–140, Routen 2–15, Summaries 7–17, Klassifikation 1–2, Folgeaufträge ≤ 1,6) | – |
| 14 | Namenskandidaten prüfen (Rematch-Läufe) | – | gering (in 13) | **Review** |
| 15 | Modellvergleich `compare:models -- --label pilot --start` an einem Tag ohne andere Anthropic-Ausgaben | Anthropic | 13 / ≤ 15 | – |
| 16 | 50 Bewertungen, `report:models`, Modellentscheidung in `config/models.json`; bei Opus beide Reviere neu verarbeiten | Anthropic | 0 (Sonnet) / +90–280 (Opus) | **bewerten und entscheiden** |
| 17 | `fixtures:record --ai …` (optional); `check:texts` Exit 0; Entscheidung Kachelgrenzen (`neighbourRing`) | Anthropic | 0,3 | **Entscheidung** |
| 18 | `consolidate --area` für beide Reviere; Konflikte, Unsicherheiten und Summaries prüfen; `check:profiles` Exit 0; Entscheidung Kachelgröße | Anthropic (Summaries geänderter Profile) | in 13 / ≤ 3 | **Review und Entscheidung** |
| 19 | ODbL rechtlich prüfen (M6-Übergabe), bevor ein Paket hinausgeht | – | 0 | **rechtlich** |
| 20 | „Paket bauen“ je Revier; Befunde beheben (Zusammenlegen, Summaries); `apikey:create`; `delivery:consume` gegen localhost | lokal | 0 | Review |
| 21 | Messung „Lauf 1“ (`/quality`) | lokal | 0 | – |
| 22 | `compare:navily --accept-proposals` → `/quality/compare` → Abweichungen prüfen → `--coverage` | lokal (Navily-Datei zur Laufzeit) | 0 | **Abweichungen prüfen, P24** |
| 23 | Tag D: `consolidate --area saronic`, „Paket bauen“. Tag D+1: Entwicklungs-Worker stoppen, `clone.sh`, `sim:draft-scenario`, Szenario prüfen und einchecken | lokal | 0 | **Szenario prüfen** |
| 24 | `sim:worker`, zweimal `sim:revisit`, Paket in der Simulation bauen, Simulations-Web auf :3001, `sim:verify --base-url … --out docs/pilot/<datum>-revisit.json` | Anthropic, Voyage | 1,5 / 1–3 | – |
| 25 | Echter „Lauf 2“ (P28: mindestens 7 Tage nach Lauf 1): „Revisit für Revier“; seine Aufgaben mit Zeitmessung prüfen; Messung „Lauf 2“ | Konverter, Voyage, Anthropic | 10 / 5–20 (Firecrawl +15–30) | **Review (< 60 min)** |
| 26 | Optional: Regressionsbewertung (nur Regeln kostenlos; Extraktionskandidat) | Anthropic | 0 / ≤ 3 | Aktivierung entscheiden |
| 27 | `report:costs`, `report:pilot`, Ergebnisse der Abnahmen M3/M4/M5/M7 und die Kachelgröße eintragen | lokal | 0 | **abzeichnen** |

## Kosten
**Erwartete echte Ausgabe gesamt: ≈ 125 € (Spanne ≈ 80–220 €)** mit Sonnet und dem lokalen oder dem Jina-Konverter (Schritte 8, 10–13, 15, 17, 18, 24–26). Dazu +15–30 € je vollem Crawl, falls Firecrawl gewählt wird, und +90–280 €, falls die Modellentscheidung Opus ist.
- Erwartete Kosten je Ort ≈ 0,5–0,9 € (Pilotziel < 2 €).
- Anthropic dominiert (~110 €); bei der Tagesgrenze von 20 € verteilt sich die bezahlte Textarbeit auf mindestens 6 Kalendertage.
- DataForSEO ≤ 3,5 € (aber ~900 Aufrufe, P25); Voyage ≤ 2 €.

## Stopp-Bedingungen
Anhalten, berichten, auf Christian warten:
- **Budget**: kumulierte `external_calls` über der Pilotgrenze (P29, Vorgabe 200 €); die Schätzung eines Schritts über dem 1,5-Fachen seiner Zeile oben (vor dem Absenden der Masse `Einheiten × 0,02 €` aus den geplanten Einheiten des Text-Laufs prüfen). Eine tägliche Queue-Pause ist normal und kein Stopp. Der Modellvergleich bricht über `--max-eur 15` ab.
- **Belegtreue < 100 %** (gesperrter Extraktionslauf) oder gesperrtes `consolidation.geo`: Kette anhalten, prüfen (Runbook „Gesperrter Extraktionslauf“), nie blind „Belegtreue neu prüfen“.
- **Fehlerraten**: fehlgeschlagene Jobs > 5 % der Jobs einer Stufe, oder ein fehlgeschlagener Job `embed.chunks`/`fetch.*` bleibt offen; je Quelle `failed` in der Frontier > 20 % → Quelle pausieren; Anthropic-Wiederholungen wegen `max_tokens`/Ablehnung > 2 % der Einheiten; wiederholte 429/5xx eines Anbieters länger als 1 h; Overpass-/EMODnet-Timeouts, die eine Kachel ohne Bathymetrie lassen (die Geometrie verweigert dann).
- **Plausibilität**: < 100 oder > 400 bestätigte Orte je Revier; eine Quelle mit > 2.000 Dokumenten (Crawl-Regeln zu weit); Anteil deterministischer Erwähnungen < 70 % (`check:texts`); Lieferung `rejected`; Navily-Vorschläge mit > 30 % `deviation` bei einem Sektor-Attribut (Matcher oder Schwelle verdächtig), bevor alle übernommen werden.
- **Simulation**: Schutz verweigert (Datenbank nicht `periplus_sim`, kein Präfix), `foreignJobs > 0`, Preflight-Fehler oder `sim:verify` nicht 10/10 mit 0 unerwarteten → anhalten; das Szenario erst korrigieren, wenn Christian entschieden hat, welche Seite falsch ist.

## Entscheidungen für Christian
**Blockieren einen Schritt:** Revierpolygone (0); M2-Sperrparameter und Natura-2000-Codes (4); Vergleichssatz mit 50 Orten (7); Quellenfreigaben, Typen, Gewichte, Crawl-Regeln (8, 9, 12); Konverter-Bewertung und -Wahl (10); die zwei PDF-Revierführer und die Wahl `pdf` (11); Modellbewertung und -wahl sowie die Ausgabe für eine Neuverarbeitung mit Opus (16); Kachelgrenzen und Kachelgröße (17, 18); ODbL-Prüfung (19); Szenario prüfen und einchecken (23); Navily-Abweichungen und P24 (22); Aktivierung von Regeln oder Extraktion (26); Abzeichnen (27).

**Reviews, die Zeit brauchen:** Ortskandidaten (3), Namenskandidaten (14), Konflikte, Unsicherheiten und Summaries (18), Review von Lauf 2 mit Zeitmessung unter 60 Minuten (25).

## Vorgaben, wo jeder Weg geraten ist
1. **P28 – was „zweiter Lauf“ ist und wann er läuft**: die Datendienst-Spec meint mit dem zweiten Durchgang den simulierten Revisit; Spec 10 und der Plan ergänzen einen echten Lauf 2. Vorgabe: echter Lauf 2 mindestens 7 Tage nach Lauf 1, der Aufwand der Simulation wird daneben berichtet.
2. **P29 – Obergrenze der Gesamtausgabe**: freigegeben sind nur Tagesgrenzen; Vorgabe 200 € (Sonnet, lokaler oder Jina-Konverter), neue Freigabe für Opus oder Firecrawl.
3. **P13 – `detect_bays` in M7**: Spec 04 sagt ja, vor der Messung der Abdeckung; der Plan hat es fallen lassen. Vorgabe: als Task 18 ergänzen.
4. **P25 – SERP < 500 Aufrufe**: Quellenfindung und Folgeaufträge zusammen überschreiten das; Vorgabe `saronic` zuerst, Quellenfindung für `argolic` nur nach Freigabe.
5. **P12 – Mehrbefund**: Datendienst-Spec (≥ 2 Dokumente) gegen Spec 10 (≥ 2 Quellen); Vorgabe Datendienst-Spec für die Abnahme.
6. **P24 – maschinell übernommene Navily-Zuordnungen** zählen für die Präzision; Vorgabe: erlaubt, ihr Anteil wird berichtet.
7. **P10 – Aktivierungsmechanismus** (Auflösung über die Datenbank gegen `active.json`); Vorgabe: Auflösung über die Datenbank nach Spec 10.

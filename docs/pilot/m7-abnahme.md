# M7 Abnahme: Pilot

Abnahmekriterium aus der Roadmap (Gesamtdesign) und Teil-Spec 10, „Pilot-Abnahme (M7)“: alle Pilot-Zielwerte der Kennzahlen erreicht, Gazetteer der Pilotkacheln vollständig (de, en, el), simulierter Revisit 10 von 10 ohne falsche, Profil zum Stand vor dem Revisit per API, Review-Aufwand des zweiten Laufs unter 60 Minuten, Kosten je Ort und Lauf mit Hochrechnung, ein Abnehmer liest das Paket ohne Nachbearbeitung, Kachelgröße bewertet. Das Ergebnis hält der Pilotbericht in `docs/pilot/` fest; **erst danach beginnt M8**.

Ablauf mit Kosten, Stopp-Bedingungen und Entscheidungen: `docs/pilot/m7-runbook.md`. Technik je Stufe: `docs/runbook.md`, Abschnitt „Qualität und Pilot (M7)“.

**Stand:** M7 ist in zwei Teile geteilt (Preflight).

- **Teil (a), der Code**, ist gebaut und an Synthetik geprüft: Fixture-Revier, `withRollback`, Testdatenbank, Test-Bucket, `MockModel`, synthetische Navily-Datei. Für die Umsetzung wurde **kein Geld ausgegeben** und kein externer Dienst aufgerufen.
- **Teil (b), der Pilotbetrieb mit echten Daten**, ist **nicht gestartet**. Er braucht Christians Entscheidungen und eine Freigabe der Gesamtausgabe (≈ 125 €, Obergrenze 200 €, P29).

Die Entwicklungsdatenbank steht auf Migration **0038**. M7 bringt die Migrationen 0044–0047. Vor dem Pilot `npm run db:migrate`; danach steht sie auf **0047**. Server: jedes Deployment migriert.

Alle Messwerte auf echten Daten werden **im Pilot gemessen** (unten „Messwerte“).

## Vom Code geprüft (Stand der Umsetzung)

### Vergleich
- [x] **Schema** (Task 1, Migrationen 0044/0045):
  - `comparison_results`, `quality_snapshots` und `config_activations`, alle nur anfügend (`forbid_mutation`);
  - Konfiguration `config/quality.json` mit Zielwerten Pilot/Vollbetrieb, Schwellen, Vergleichssatz und Hochrechnung.
  - Keine Spalte nimmt einen Navily-Wert auf (Schema-Test).
- [x] **Vergleichswerte** mit stabilem Hash des eigenen Werts (`value_hash`; Task 2):
  - Ergebnisse `match`, `deviation`, `not_at_navily`, `deviation_confirmed_own`, `deviation_confirmed_navily`, `unclear`.
  - Jede Abweichung öffnet eine Aufgabe „Vergleichsabweichung“ mit „Eigener Wert stimmt“, „Navily stimmt“, „Unklar“.
  - Ein späteres `match` schließt offene Abweichungen.
- [x] **Navily-Assistent** (Task 3):
  - Zuordnung in zwei Durchgängen über alle bestätigten Orte des Reviers;
  - Artverträglichkeit vor Namensähnlichkeit vor Entfernung;
  - Vorschlag je Attribut.
- [x] **`/quality/compare`** mit Vorschlägen zur Laufzeit, Bestätigung per Klick und Prüfsumme gegen veraltete Vorschläge (Task 4).
- [x] **`compare:navily`** mit `--accept-proposals` (`proposal_auto`, `navily-assistant/1`) und `--coverage` (Task 5).

### Kennzahlen und Messung
- [x] **Kennzahlen nach Spec 10 und P12** (Tasks 6, 7):
  - `coverage` und `coverage_navily`;
  - `multi_document` und `multi_source`;
  - Fact-Präzision, Belegtreue (nur reguläre Läufe), Schutz-Konfidenz, Routen-Rekonstruktion;
  - Kosten je Ort, Review-Aufwand, Highlight- und Beobachtungsanteil, Orte je Kachel.
- [x] **Messlauf `quality.measure`** (Task 8): Snapshots je Kachel, Revier und Lauf, mit Bezeichnung und Fenster. Er verweigert mit deutscher Meldung:
  - eine belegte Bezeichnung;
  - ein leeres Fenster;
  - eine erste Messung ohne Läufe;
  - eine zweite Messung, während eine läuft.
- [x] **Dashboard `/quality`** (Task 9): Zielwerte, Verlauf, Kacheln, Messen, Regression.

### Regression
- [x] **Ablauf** (Task 10): Bewertungslauf, Vergleich alt/neu, Gate „Übereinstimmung und Abdeckung sinken nicht“, Aktivieren als bewusster Klick.
- [x] **Regelversion:** sie gilt über `config_activations`. Jeder konsolidierende Lauf friert sie beim Start ein (M7-E-R1).

### Simulierter Revisit
- [x] **Leitplanke** (Task 11):
  - ein Prozess mit `PERIPLUS_SIMULATION` nur gegen `periplus_sim` oder `*_test` und nur mit `S3_WRITE_PREFIX`;
  - die umgekehrte Prüfung gilt auch;
  - kein Dienst außer Anthropic und Voyage.
- [x] **Szenario und Fetch-Adapter `simulated`** (Task 12).
- [x] **Revisit-Lauf und Verifikation** gegen den Änderungs-Feed, mit `asOf`-Prüfung über die API (Task 13).
- [x] **Integrationstest am Fixture-Revier** (Task 14): 5 von 5 Änderungen, 0 unerwartete, 0 €.
- [x] **Sim-Klon, Sim-Worker, `.env.sim`, Szenario-Entwurf** (Task 15).

### Berichte
- [x] **Kostenbericht mit Mittelmeer-Hochrechnung, Pilotbericht** (Task 16).

### Weitere Änderungen
- [x] **Prompt `extract-facts` v4:** ein Fact je Listeneintrag mit eigenem Zitat (M7-G-R5).
- [x] **Listen-Attribute einer Einheit** werden zusammengeführt statt verworfen (M7-G-R2, Migration 0047).
- [x] **Unbenannte Buchten** `geometry.detect_bays` (Task 18, Ruling M7-P13):
  - erste Stufe jedes Geometrie-Laufs für Kachel oder Revier;
  - Parameter in `config/geometry.json` (`bays`).
  - Neue Buchten werden immer Ortskandidaten mit Prüfaufgabe und Hilfsname „Bucht bei …“, **nie automatisch bestätigt**.
  - Bekannte Treffer (Ort oder Bucht/Hafen in 500 m, auch früher erkannte Buchten) fallen vor dem Zusammenfassen weg; Gruppen über `maxClusterSpanM` (1 km) werden geteilt; nur Prüfpunkte in der eigenen Kachel (Ruling M7-I-R1).
  - Tests an synthetischer Halbkreis-Bucht, gerader Küste, Golf mit Seitenbucht und bestätigtem Ort am Kopf, Bucht an der Kachelgrenze, bekannten Orten und Objekten (400 m / 600 m), fehlender Ankerfläche, Wiederholung, Eltern-Objekt, Hilfsname mit Stufen und Planung durch `geometry.place` (`lib/domain/geometry/__tests__/bays.test.ts`).
- [x] **Review-Warteschlange:** Abweichungen eines Bewertungslaufs tragen in Liste und Detail das Kennzeichen „Bewertung“ (M7-E-R2-Notiz).
- [x] **Gesamtprüfung** am Ende von M7 Teil (a): `npm run lint`, `npm run typecheck`, `npm run test:ops`, `npx vitest run`, `npm run test:e2e`, `npm run build` grün; der Build ohne Umgebung (wie CI) grün.

## Messwerte
Alle Werte **werden im Pilot gemessen**, auf echten Daten von `saronic` (und `argolic`). Befehle:

| Messwert | Befehl / Ort | Wert |
| --- | --- | --- |
| Kennzahlen „Lauf 1“ | „Qualität“ → `saronic` → „Messen“, Bezeichnung `Lauf 1` | wird im Pilot gemessen |
| Kennzahlen „Lauf 2“ | „Revisit für Revier“, dann „Messen“, Bezeichnung `Lauf 2` | wird im Pilot gemessen |
| Navily-Abdeckung (`coverage_navily`) | `npm run compare:navily -- --area saronic --coverage` | wird im Pilot gemessen |
| Fact-Präzision | nach `/quality/compare` und dem Review „Vergleichsabweichung“, dann „Messen“ | wird im Pilot gemessen |
| Gazetteer vollständig | `npm run check:gazetteer -- --area saronic`, `-- --area argolic` | wird im Pilot gemessen |
| Unbenannte Buchten je Revier, Laufzeit der Stufe | Lauf „Geometrie für Revier“ → Stufe `geometry.detect_bays`, Log `unnamed bays detected` | wird im Pilot gemessen |
| Simulierter Revisit | `npm run sim:verify -- … --out docs/pilot/<datum>-revisit.json` | wird im Pilot gemessen |
| `asOf` vor dem Revisit | `sim:verify --base-url http://localhost:3001 --key pk_… [--spot sp_…]` | wird im Pilot gemessen |
| Review-Aufwand Lauf 2 | Messung „Lauf 2“, Kennzahl `review_minutes` | wird im Pilot gemessen |
| Kosten je Ort und Lauf, Hochrechnung | `npm run report:costs -- --area saronic --first "Lauf 1" --second "Lauf 2" --revisit <datei>` | wird im Pilot gemessen |
| Einheiten am Fact-Limit (`overLimit`) nach Prompt v4 | Abfrage im Runbook M7, „Nach dem ersten Text-Lauf“ | wird im Pilot gemessen |
| Bezahlte Aufrufe ohne `run_id` | Abfrage im Runbook M7, „Nach dem ersten Text-Lauf“ | wird im Pilot gemessen |
| Orte je Kachel | `places_per_tile` auf `/quality` | wird im Pilot gemessen |

## Offen für Christian (Übergabe, nicht automatisierbar)
1. [ ] **Voller Pilotlauf** (M1–M6) für `saronic` und `argolic` nach `docs/pilot/m7-runbook.md`, Schritte 0–20. Vorher `npm run db:migrate` (0038 → 0047).
2. [ ] **Unbenannte Buchten** (Schritt 6): Kandidaten prüfen, dann `check:gazetteer` erneut mit Exit 0. Nach Schritt 14 meldet `check:gazetteer` jede per „Name zuordnen“ benannte Bucht als fehlend (Sprache `und`); Abhilfe und Entscheidung unter „Vorgaben“ (M7-I M-5).
3. [ ] **Messung „Lauf 1“** (Schritt 21).
4. [ ] **Navily-Erstdurchgang und Abweichungs-Review** (Schritt 22).
5. [ ] **Simulierter Revisit** (Schritte 23–24):
   - Sim-Klon;
   - Szenario entwerfen, prüfen und unter `data/sim/` ablegen (nie einchecken);
   - simulierten Revisit ausführen und verifizieren;
   - Simulations-Web aus einem eigenen Worktree.
6. [ ] **Echter zweiter Lauf** (P28: frühestens 7 Tage nach Lauf 1), dann Messung „Lauf 2“ (Schritt 25).
7. [ ] **Berichte** (Schritt 27):
   - Kosten- und Pilotbericht erzeugen;
   - Kachelgröße entscheiden und im Pilotbericht dokumentieren;
   - diese Checkliste abhaken.
8. [ ] **Entscheidungen** unten unter „Vorgaben“ bestätigen oder ändern. Die Entscheidungen des Runbooks treffen (Abschnitt „Entscheidungen für Christian“).

## Abnahmekriterien
| Kriterium | Nachweis |
| --- | --- |
| Alle Pilot-Zielwerte der Kennzahlen erreicht | `/quality?area=saronic` Messung „Lauf 1“ und „Lauf 2“ alle „erreicht“; Navily-Abdeckung per `npm run compare:navily -- --area saronic --coverage`; Präzision nach Abarbeiten von `/quality/compare` und Review `comparison_deviation` |
| Gazetteer der Pilotkacheln vollständig (de, en, el) | `npm run check:gazetteer -- --area saronic` und `--area argolic` Exit 0 |
| Simulierter Revisit: 10 von 10, keine falschen | `scripts/sim/clone.sh` → `sim:draft-scenario` → Szenario prüfen und einchecken → `sim:worker` → `sim:revisit` (zweimal) → Paket bauen in der Sim-Umgebung → `sim:verify --out docs/pilot/<datum>-revisit.json` Exit 0 |
| Profil zum Stand vor dem Revisit per API | `sim:verify --base-url http://localhost:3001 --key pk_… --spot sp_…` meldet „asOf ok“ |
| Review-Aufwand zweiter Lauf < 60 min | echter zweiter Lauf („Revisit für Revier“) in Produktion, Messung „Lauf 2“, Kennzahl `review_minutes` < 60 |
| Kosten je Ort und Lauf dokumentiert, Hochrechnung | `npm run report:costs -- --area saronic --first "Lauf 1" --second "Lauf 2"` → `docs/pilot/<datum>-kostenbericht.md` |
| Abnehmer liest das Paket ohne Nachbearbeitung, validiert gegen das JSON-Schema | `npm run delivery:consume -- --base-url … --key … --area saronic` Exit 0 (M6) |
| Kachelgröße bewertet, Entscheidung dokumentiert | `places_per_tile` auf `/quality` → Entscheidung im Pilotbericht |
| Pilotbericht | `npm run report:pilot …` → `docs/pilot/<datum>-pilotbericht.md`; erst danach M8 |

Hinweise zur Tabelle (Stand der Umsetzung):
- **„Szenario prüfen und einchecken“** heißt beim echten Pilotszenario: prüfen und unter dem git-ignorierten `data/sim/` ablegen, **nicht** ins Repo (M7-F-R3). Eingecheckt wird nur die Ergebnisdatei `docs/pilot/<datum>-revisit.json`. Sie enthält keine fremden Texte; vorher ansehen.
- **`sim:verify` braucht** `.env.sim` und ein Simulations-Web auf :3001 aus einem eigenen Worktree (M7-H-R1).
- **Den Schlüssel** für `delivery:consume` lieber über `PERIPLUS_API_KEY` als `--key` übergeben (Shell-History, M6).

## Kosten der Umsetzung (echte Aufrufe)
Keine. M7 Teil (a) rief keinen externen Dienst auf; alle KI-Antworten kamen von `MockModel`, alle Abrufe aus Fixtures. Die unbenannten Buchten kosten auch im Pilot nichts (nur Datenbank).

## Offene Punkte aus den Reviews

### Vorgaben, die Christian bestätigen oder ändern kann
| Punkt | Vorgabe | Ort |
| --- | --- | --- |
| **P13** unbenannte Buchten in M7 | umgesetzt als Task 18; Alternative: nach M9, dann senken unbenannte Navily-Buchten `coverage_navily` | `lib/domain/geometry/bays.ts`, `config/geometry.json` |
| Task 18: Abstand „bekannt“ (500 m) und Radius des Hilfsnamens (5 km) | nicht in Spec 04 festgelegt, gewählt; in `config/geometry.json` (`bays.knownPlaceDistanceM`, `helperNameMaxDistanceM`) | `config/geometry.json` |
| Task 18: Teilung langer Treffergruppen (`maxClusterSpanM` 1 km, höchstens doppelter Bekannt-Abstand) | gewählt nach Ruling M7-I-R1, damit Seitenbuchten eines Golfs eigene Kandidaten bekommen; Folge: ein langer Golf oder Kanal bringt etwa einen Kandidaten je km Ufer (mehr Prüfaufwand, nie bestätigt) | `config/geometry.json` |
| **M7-I M-5** Name einer unbenannten Bucht und `check:gazetteer` | „Name zuordnen“ (Schritt 14) speichert den Namen mit Sprache `und`. `check:gazetteer` prüft jede benannte Bucht auf de, en und el, meldet die Bucht als fehlend und endet mit Exit 1; damit scheitert das Kriterium „Gazetteer vollständig“. Abhilfe heute: je gemeldeter Bucht die Namen in de, en und el anfügen (ein kleines Skript mit `addNames`, `lib/domain/gazetteer/names.ts`, Herkunft `review`; die `und`-Zeile bleibt, `geo_names` wird nie gelöscht), dann `check:gazetteer` erneut. Entscheidung für Christian: (a) so von Hand nachtragen, (b) `check:gazetteer` nimmt berechnete Buchten (Herkunft „Berechnet“) mit nur `und` aus, oder (c) „Name zuordnen“ fragt die Sprache ab | `lib/domain/review-decisions.ts` (`assign_name`), `scripts/check-gazetteer.ts` |
| Task 18: Prüfpunkt-Strecke von der Küste muss ganz im Wasser liegen | eine Bucht schmaler als etwa 400 m wird nur von ihrer Mündung aus geprüft; kleine Buchten können fehlen | `lib/domain/geometry/bays.ts` (`bayClusters`) |
| **P12** Mehrbefund und Abdeckung | Abnahme nach Datendienst-Spec (`multi_document`, `coverage_navily`); Spec 10 daneben | `lib/domain/quality/metrics.ts` |
| **P10** Aktivierung | über die Datenbank (`config_activations`), Rückfall `active.json` | `lib/domain/consolidation/active-rules.ts` |
| **P24** maschinell übernommene Navily-Ergebnisse | zählen für die Präzision, Anteil wird berichtet | `scripts/compare-navily.ts` |
| **P25** SERP-Grenze | `saronic` zuerst, `argolic` nur nach Freigabe | Runbook M7, Schritt 8 |
| **P28** zweiter Lauf | echter Lauf 2 frühestens 7 Tage nach Lauf 1, daneben der simulierte | Runbook M7, Schritt 25 |
| **P29** Gesamtausgabe | Obergrenze 200 € | Runbook M7, „Stopp-Bedingungen“ |
| **M7-E-R2 M-1** Gate der Abdeckung | das Gate „Abdeckung sinkt nicht“ kann heute nicht scheitern: eine Bewertung ändert keinen Ortsstatus. Alternative: Abdeckung über `coverage_navily` der Bewertungsprofile oder das Gate streichen | `lib/domain/quality/regression.ts` |
| **M7-B-R3** Zuordnung | ein namenloser, artverträglicher Navily-Spot geht einem gleichnamigen, nicht artverträglichen Hafen vor | `lib/domain/quality/navily-compare.ts` |
| **M7-P23** Navily-Namen | `/quality/compare` zeigt Navily-Namen zur Laufzeit an, gespeichert wird nichts | `app/(admin)/quality/compare/` |

### Übergaben (Handoff)
| Punkt | Ort |
| --- | --- |
| **Entwicklungsdatenbank migrieren** (steht auf 0038): `npm run db:migrate` bis 0047, sonst scheitern „Messen“, `compare:navily` und `report:*` | `drizzle/0044…0047` |
| **Unbenannte Buchten auf echten Küsten ungemessen**: Laufzeit und Trefferzahl der Stufe `geometry.detect_bays` (Landvereinigung je Kachel, 72 Strahlen je Prüfpunkt) nur an Synthetik geprüft; Stopp bei > 30 Buchten je Revier oder > 15 min je Kachel | `lib/domain/geometry/bays.ts`, Runbook M7 |
| **Bestätigte unbenannte Bucht ohne Namen** wird nicht geliefert (`no_name`), zählt aber für die Abdeckung; einen Namen bekommt sie nur über einen Namenskandidaten aus Texten („Name zuordnen“). Eine Namenseingabe von Hand gibt es nicht. Entscheidung, ob das reicht | `lib/domain/delivery/map-spot.ts`, `lib/domain/review-decisions.ts` |
| **run_id bei bezahlten Aufrufen** nach dem ersten echten Text- oder Bewertungslauf prüfen (M7-D-R3, Abfrage im Runbook M7) | `external_calls` |
| **Fact-Limit nach Prompt v4**: nach dem ersten Text-Lauf prüfen, dass Einheiten nicht an `maxFactsPerUnit` (40) stoßen (M7-H-R1, Abfrage im Runbook M7) | `config/extraction.json`, `config/prompts/extract-facts/v4.md` |
| **Simulations-Web nur aus eigenem Worktree** oder als `next start` eines eigenen Builds dort: Next 16 verweigert ein zweites `next dev` im selben Projekt (`.next/dev/lock`, M7-H-R1); `.env.sim.example` beschreibt denselben Weg | `.env.sim.example`, Runbook M7 Schritt 24 |
| **Ein Revisit blockiert jeden Crawl** der freigegebenen Quellen für seine ganze Dauer (M7-G-R4); keinen Crawl daneben planen | `lib/pipeline/revisit-run.ts` |
| **Echte Pilotszenarien** zitieren fremde Seiten: nur unter `data/sim/` (git-ignoriert), nie einchecken; „neue Seite“ ist keine Änderungsart (M7-F-R3) | `data/sim/`, `lib/domain/revisit/scenario.ts` |
| **Szenario-Entwurf** ist absichtlich streng (Taverne als einzige Quelle, Satz ohne fremdes Zitat, schwaches Raster bei Tiefe); auf echten Texten kann er weniger als 10 Einträge füllen, Lücken stehen in der Ausgabe; Christian ergänzt | `lib/domain/revisit/draft.ts` |
| **Review-Aufwand des simulierten Revisits** steht nicht in der `sim:verify`-Datei; ablesen auf `/quality` der Simulation (P28) | `scripts/sim/verify.ts`, Pilotbericht |
| **Kostenverteilung** (M7-D-R1): Kosten ohne Kachelbezug nach Anteil bestätigter Orte; Kacheln ohne Revier zählen für niemanden; `smoke:ai` als Betriebskosten; im Pilotbericht erklärt | `lib/domain/quality/metrics.ts`, `lib/domain/quality/reports.ts` |
| **Flaky 5-s-Timeouts** in der vollen Suite: Tests halten die globale Budget-Sperre (`BUDGET_LOCK`) für eine ganze `withRollback`-Transaktion; gemildert durch das sequentielle Vitest-Projekt `revisit-fixture`, Ursache offen (Bündel G/H) | `vitest.config.mts`, `lib/pipeline/batches.ts` (`BUDGET_LOCK`) |
| **Schriften brauchen beim Build Netz** (`next/font/google`, M6-Übergabe): selbst hosten oder Aussetzer hinnehmen | `app/layout.tsx` |
| **ODbL-Trennung rechtlich prüfen**, bevor ein Paket an Dritte geht (M6-Übergabe) | `config/delivery.json` |
| M6-Übergaben weiter offen: Server-Schritte (Paket bauen auf dem Server, API-Schlüssel, `delivery:consume` gegen den Server, `asOf` nach zweitem Bau) | `docs/pilot/m6-abnahme.md` |
| M5-Übergabe weiter offen: verwaister Lauf auf „Wartend“, wenn das Einreihen der ersten Stufe nach dem Commit scheitert; „Lauf beenden“ räumt auf | `lib/pipeline/runs.ts` |
| Die Spec 12 (Prüfung mit Echtdaten, nicht eingecheckt) verweist auf `docs/pilot/m7-runbook-entwurf.md`; die Datei ist jetzt ein Verweis auf `docs/pilot/m7-runbook.md` | `docs/pilot/m7-runbook-entwurf.md` |

### Bewusst angenommen (Verhalten im Pilot beobachten)
| Punkt | Ort |
| --- | --- |
| `quality_snapshots.details` und `config_activations.comparison` halten nur Zählwerte, nie Navily-Daten (P23) | `lib/domain/quality/` |
| Rundungskanten der Vergleichsklassen (Schutz ab 0,5, Tiefe 0,5 m, Position 4 Nachkommastellen) wie im Plan (M7-A-R1) | `lib/domain/comparison.ts` |
| Eine wiederholte Abweichung nutzt die offene Aufgabe und frischt ihren Kontext auf; ein späteres `match` oder `not_at_navily` schließt sie (M7-A-R1, M7-B-R2) | `lib/domain/quality/comparison-results.ts` |
| Bestätigen einer Abweichung schreibt nie über ein von Hand gesetztes Ergebnis; `proposal_confirmed` ist wie manuell geschützt (M7-B-R2, M7-C-R2) | `lib/domain/quality/comparison-results.ts` |
| Ein Schutzsektor mit Text-Fact, aber ohne berechneten Wert zählt als „nur Text“, nie als „korrigiert“ (M7-C-R1) | `lib/domain/quality/metrics.ts` |
| Beendete Kacheln stehen in `places_per_tile.details.endedTiles` und zählen für das Revier; Belegtreue zählt nur reguläre Läufe, Bewertungs- und Vergleichsläufe stehen getrennt (Bündel D) | `lib/domain/quality/metrics.ts` |
| Pseudo-Aufgaben (`profile_entry`, `place_merge`, `place_position`, `place_anchor`) und Vergleichsabweichungen zählen nicht zum Review-Aufwand, stehen aber in `byKind` (P14, M7-D-R3) | `lib/domain/quality/metrics.ts` |
| Der Anteil „Beobachtung < 18 Monate“ ist durch den Rückfall auf das Abrufdatum überhöht (M7-D-R3 M-1, im Pilotbericht erklärt) | `lib/domain/quality/metrics.ts` |
| Ein Extraktionskandidat bewertet nur vorhandene Extraktionsläufe; neu extrahieren ist Teil (b) („Reprozessieren“) (Bündel E) | `lib/domain/quality/regression.ts` |
| Die Prüfung „Profil nach der Bewertung neu“ ist vorsichtig (verweigert eher zu oft); ein schon aktiver Regel-Kandidat schreibt nichts (M7-E-R2) | `lib/domain/quality/regression.ts` |
| Abweichungen eines Bewertungslaufs öffnen eigene Aufgaben (Hash und Lauf), ein `match` darauf schließt die reguläre Aufgabe nicht (M7-E-R2) | `lib/domain/quality/comparison-results.ts` |
| Simulation: Anthropic und Voyage erlaubt (Budget gilt, gebucht), alle anderen Dienste gesperrt; DNS-Auflösung ohne HTTP angenommen; Uploads sind keine Revisit-Ziele (M7-F-R1, M7-F-R2) | `lib/domain/revisit/guard.ts` |
| `revisit.freeze` nimmt die Versionen, die der Crawl dieses Laufs schrieb, plus den Revierumfang (M7-G-R1); ein ungefrorener Revisit konsolidiert nur verschwundene Objekte (M7-G-R4) | `lib/pipeline/revisit-stages.ts` |
| Der Revier-Filter des Revisits überspringt eine neue Seite nur, wenn das Revier ihre Quelle nie fand und die Seite kein Objekt des Reviers nennt (Bündel G) | `lib/pipeline/revisit-stages.ts` |
| Der Kostenbericht liest die `cost_per_place`-Details der Messungen statt `spendBreakdown`; `clone.sh` hat `--db-user`; `sim:revisit`/`sim:verify` lesen `.env.sim` (Bündel H, D1–D7) | `lib/domain/quality/reports.ts`, `scripts/sim/` |
| Unbenannte Buchten: Kandidaten in einem Sperrgebiet werden nicht schon bei der Erkennung, sondern in der folgenden Stufe `geometry.place` desselben Laufs `no_anchoring` (ihre Aufgabe schließt sich dann) | `lib/domain/geometry/bays.ts`, `lib/domain/geometry/restrictions.ts` |
| Unbenannte Buchten an der Kachelgrenze: jede Kachel nimmt nur Prüfpunkte in ihrer Fläche, jeder Kandidat liegt in seiner Kachel. Die Kachel-Jobs laufen für Bekannt-Prüfung und Anlage nacheinander (Sperre `pg_advisory_xact_lock`), so sieht die zweite Kachel den Kandidaten der ersten als bekannt und legt die Bucht nicht noch einmal an. Liegen die Treffer einer Bucht auf beiden Seiten mehr als 500 m vom ersten Kandidaten entfernt, kann die zweite Kachel einen weiteren Kandidaten anlegen (nie bestätigt). Die Strahlen-Rechnung davor läuft ohne Sperre | `lib/domain/geometry/bays.ts` (`detectTileBays`) |
| Unbenannte Buchten: ein Golfabschnitt ohne Ankerfläche kann nach einem neuen Kandidaten nebenan bei einem neuen Lauf anders geschnitten werden und dann einen weiteren Kandidaten bringen (Richtung: mehr Prüfaufwand, nie bestätigt; M7-I-R1) | `lib/domain/geometry/bays.ts` (`clusterHits`) |

## Ergebnis
Datum der Abnahme: _offen_ (Pilot, Teil b). Messung „Lauf 1“: _offen_. Messung „Lauf 2“: _offen_. Navily-Abdeckung: _offen_. Simulierter Revisit: _offen_ von 10, _offen_ unerwartete, asOf _offen_. Review-Aufwand Lauf 2: _offen_ min. Kosten je Ort: _offen_. Kachelgröße: Entscheidung _offen_. Pilotbericht: _offen_.

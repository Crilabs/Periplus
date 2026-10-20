# M4 Abnahme: Erwähnungen und Facts

Abnahmekriterium aus der Roadmap (Gesamtdesign): Belegtreue 100 %; Modellwahl dokumentiert; Facts mit hervorgehobenem Zitat in der UI. Teil-Spec 06: Belegtreue 100 %; Modellwahl dokumentiert; Kosten je Erwähnung gemessen; Anteil Erwähnungen ohne Modellaufruf > 70 %. Offene Punkte des Gesamtdesigns für M4: „Modellklasse Extraktion (M4)“ und „Kachelgrenzen (M4)“.
Ablauf der Läufe: `docs/runbook.md`, Abschnitt „Erwähnungen und Facts“.

**Stand (Ruling M4-J-R0):** Die Entwicklungsdatenbank ist leer (kein Gazetteer, keine Dokumente). Alle Messwerte auf echten Daten werden deshalb **im Pilot (M7) gemessen**, nach Gazetteer, Quellenfindung, Crawl und Embeddings. M4 baut und testet die Werkzeuge dafür an Fixtures und `MockModel`; für die Umsetzung wurde kein Geld für echte Modellaufrufe ausgegeben.

## Vom Code geprüft (Stand der Umsetzung)
- [x] Stufe 6 Erwähnungen: Klassifikation (Haiku, Titel, URL, erste 1.500 Wörter, Beobachtungsdatum explizit → veröffentlicht → Abruf), Wort-N-Gramme 1–4 mit Normalisierung und Transliteration, exakter Treffer oder `similarity ≥ 0,75` ab 5 Zeichen, Mehrdeutiges an die Disambiguierung (Haiku, 2–6 Kandidaten), Kandidatenraum aus berührten Kacheln plus 8 Nachbarn (Ruling M4-E-R4), Stoppnamen und häufige Wörter in `config/mentions.json`, neue Namen ab 2 Dokumenten verschiedener Quellen mit Nominatim-Umkreissuche (20 km, 1 Anfrage/s) und Aufgabe „Ortskandidat“.
- [x] Stufe 7 Facts: Einheit je (Dokumentversion, Geo-Objekt) mit Nachbar-Chunks (höchstens 6), Extraktion mit wörtlichem Zitat (≤ 300 Zeichen, ≥ 12, normalisiert), Werte sprachneutral (Fact-Schema v2, Skalen „gut/mäßig/kein Schutz“ → 0,9/0,5/0,1), Eigennamen nur, wenn sie im Zitat stehen; Datenbank-Schranke `facts_text_quote_verified`; Routen aus Törnberichten mit belegten Stopps; alles über die Batch-API mit Budget-Reservierung.
- [x] Belegtreue: `extraction.check` prüft jedes Zitat jedes Laufs erneut gegen seinen Chunk und sperrt den Lauf bei einem einzigen Fehler (`quote_fidelity`); späte Ergebnisse (`late_results`), von Hand beendete Läufe (`run_ended`) und fehlgeschlagene Läufe (`run_failed`) sperren bis „Belegtreue neu prüfen“; ein gesperrter Lauf ist nie aktiv. Ein nicht geprüfter Lauf zählt seine Facts und Routen-Stopps nach dem gespeicherten Kennzeichen, wie die Prüfung sie zählt. Test: voller Text-Lauf über die drei Fixture-Dokumente endet mit Belegtreue 1 (`lib/pipeline/__tests__/text-run.test.ts`).
- [x] Ein Text-Lauf, dessen Stufe ganz scheitert (z. B. die Routen-Stufe bei einem Ausfall) oder dessen Stufenwechsel scheitert, lässt keinen Extraktionslauf auf „Läuft“: die bezahlten Facts stehen auf „Gesperrt“ (`run_failed`, Migration 0030), „Belegtreue neu prüfen“ schließt sie ab, und sie werden aktiv (Final-Review I1; Tests in `text-run.test.ts` und `lib/domain/extraction/__tests__/fidelity.test.ts`).
- [x] Aktiver Lauf je (Version, Objekt) (Ruling M4-H-R2) für M5; Vergleichsläufe erst mit entschiedener Modellwahl (NOTE T19, `lib/domain/extraction/active-run.ts`).
- [x] Text-Lauf, Reprozessieren (Stufen 6–7), Abgleich-Lauf nach „Ort anlegen“/„Namen zuordnen“; „Neue Texte auswerten“ auf der Quellen-Liste und -Seite. Erwähnungen, die die Abgleichs-Stufe eines Reprozess-Laufs hinzufügt, bezahlt der nächste reguläre Lauf nicht noch einmal (Test in `text-run.test.ts`). Der Abgleich-Lauf gleicht auch die aus einer älteren Version übernommenen Abschnitte der aktuellen Version ab und fügt dort nur hinzu, was der Ursprungs-Abschnitt nicht hat; so findet er den neuen Namen auch in einem Dokument, das sich nach dem Sammeln geändert hat (Final-Review I2; Test in `text-run.test.ts`).
- [x] Facts mit hervorgehobenem Zitat in der UI: Ort-Seite Reiter „Facts“, Geo-Seite, Dokumentseite Reiter „Erwähnungen und Zitate“ (Zitate aus nicht aktiven Läufen gestrichelt und grau); Link vom Fact auf die Version des Dokuments mit hervorgehobenem Zitat. End-to-End-Test `e2e/facts.spec.ts`: Login → Ort-Seite einer Fixture-Bucht → Reiter „Facts“ mit `<mark data-kind="quote">` → Link zum Dokument zeigt dasselbe Zitat hervorgehoben.
- [x] Modellvergleich (`/compare/models`, `npm run compare:models`, `npm run report:models`): 200 Einheiten reihum über Dokumenttypen und Quellen, Hinweise bei < 8 Quellen oder fehlenden Dokumenttypen, Kostenschätzung aus `config/extraction.json` `comparison`, zwei Extraktionsläufe (Sonnet 5.5, Opus 5.5) auf denselben Einheiten ohne Änderung des Erwähnungsstatus, Übereinstimmung je (Einheit, Attribut) mit Toleranz 0,1, Stichprobe von 50 Abweichungen mit Urteilen, Bericht `docs/pilot/m4-modellvergleich.md` mit Abschnitt „Entscheidung“. Tests: `lib/domain/extraction/__tests__/comparison.test.ts`, `scripts/__tests__/model-report.test.ts`.
- [x] `npm run check:texts` prüft die Abnahme (Exit 1 bei Belegtreue < 100 %, gesperrtem Lauf, vorläufiger Modellwahl oder Anteil ohne Modell ≤ `config/extraction.json` `acceptance.minDeterministicShare` 0,7; Test `scripts/__tests__/check-texts.test.ts`) und misst die Kachelgrenzen (`measureTileBorders`, Trockenlauf). Der Anteil ohne Modell zählt nur Erwähnungen des Abgleichs (deterministisch oder nach Disambiguierung), nicht die POI-Erwähnungen, die die Extraktion anlegt.
- [x] `npm run fixtures:record -- --ai <task> --limit <1-5> --max-eur <x>` zeichnet echte Antworten auf; `lib/ai/__tests__/recorded.test.ts` prüft jede aufgezeichnete `extract-facts`-Antwort gegen ihre Chunks.

## Messwerte
| Wert | Fixtures / MockModel (M4) | Echte Daten |
| --- | --- | --- |
| Belegtreue | 1 (voller Text-Lauf über die drei Fixture-Dokumente; ein gefälschtes Zitat wird verworfen und gezählt) | wird im Pilot (M7) gemessen: `check:texts` |
| Anteil Erwähnungen ohne Modellaufruf (Soll > 70 %) | etwa 83 % auf den Fixture-Texten (aus dem Bericht von Bündel E gemessen, kein Test prüft die Zahl) | wird im Pilot (M7) gemessen: `check:texts` |
| Kosten je Erwähnung | 0 € (MockModel) | wird im Pilot (M7) gemessen: `check:texts` (Anthropic der Text-Läufe ohne Vergleich / Erwähnungen) |
| Modellwahl Extraktion | vorläufig `claude-sonnet-5-5` (`config/models.json`, `decision.status "provisional"`): laut Spec Kandidat, halber Preis von Opus | wird im Pilot (M7) entschieden: Vergleich, 50 Urteile, `report:models` |
| Verworfene Zitate echter Antworten | – (keine Aufnahme, Ruling M4-J-R0) | wird im Pilot (M7) gemessen: `fixtures:record -- --ai extract-facts`, dann Annotation von `recorded.test.ts` |
| Kachelgrenzen: nicht zugeordnete Namen, davon mit Zweierring gefunden | Test: 2 Namen, 1 im Zweierring | wird im Pilot (M7) gemessen: `check:texts` (letzte 30 Tage) |

## Offen für Christian (Übergabe, nicht automatisierbar)
Voraussetzung: Gazetteer, Quellen und voller Crawl aus M1–M3 auf dem Server (Pilot M7). Kosten nach der Schätzung im Code, tatsächlich meist darunter; Budget `anthropic` 20 €/Tag.
1. [ ] **Text-Lauf**: Quellen → „Neue Texte auswerten“. Kosten: Klassifikation und Disambiguierung mit Haiku (Cent-Bereich), Extraktion mit Sonnet etwa 0,02 € je Einheit nach Schätzung der Abrechnung, Routen je Törnbericht. Der Lauf reicht nur ein, was ins Tagesbudget passt; der Rest folgt am nächsten Tag. Reserviert wird je Einheit die volle Ausgabe-Obergrenze (16.000 `maxTokens` × Ausgabepreis × 0,5, etwa 0,07 €), also bei 20 €/Tag nur etwa 270 Sonnet-Einheiten gleichzeitig; ein großer Lauf verteilt sich deshalb über Stunden, auch wenn die Abrechnung weit unter dem Budget bleibt.
2. [ ] **Neue Namen** unter Prüfen → Ortskandidat entscheiden.
3. [ ] **Modellvergleich**: `npm run compare:models -- --label pilot --start` (Server: `dc run --rm worker node --import tsx scripts/compare-models.ts --label pilot --start`). Erwartete Schätzung bei 200 Einheiten: etwa 4–5 € Sonnet und 8–9 € Opus, zusammen etwa 13 € (Standard `--max-eur` 15 €); an einem Tag ohne andere Anthropic-Ausgaben starten. Lehnt der Start ab (Tagesbudget), nennt das Skript die Vergleichs-ID; der Vergleich bleibt und startet später unter `/compare/models` mit „Lauf starten“. Ausgabe (Einheiten, Quellen, Dokumenttypen, Hinweise) hier unter „Ergebnis“ eintragen.
4. [ ] **50 Abweichungen bewerten** auf `/compare/models`.
5. [ ] **Bericht** `npm run report:models -- <comparisonId>` → `docs/pilot/m4-modellvergleich.md` einchecken.
6. [ ] **Modell entscheiden** in `config/models.json` (`tasks.extract-facts.model`, `decision.status "decided"`, `decision.note` mit Begründung aus dem Bericht), einchecken, deployen. Wechselt das Modell auf Opus: je Revier „Reprozessieren für Revier (Stufen 6–7)“ (Kosten etwa doppelt so hoch wie der Sonnet-Anteil des Text-Laufs).
7. [ ] **Echte Antworten aufzeichnen** (optional, ≤ 1 €): `npm run fixtures:record -- --ai extract-facts --limit 5 --max-eur 1` (etwa 0,15 €), ebenso `classify-document`, `disambiguate-mention`, `extract-route` (je unter 0,05 €); Fixtures ansehen, einchecken, `npx vitest run lib/ai/__tests__/recorded.test.ts`, Zahl verworfener Zitate hier eintragen.
8. [ ] **`npm run check:texts`** bis Exit 0 (Server: `dc run --rm worker node --import tsx scripts/check-texts.ts`); Ausgabe unter „Ergebnis“ eintragen.
9. [ ] **Kachelgrenzen entscheiden** aus der Messung von `check:texts`: findet der Zweierring nennenswert Namen (Faustregel: mehr als 5 % der nicht zugeordneten), `config/mentions.json` `neighbourRing` auf 2 setzen, deployen und reprozessieren; sonst bei 1 bleiben. Entscheidung und Zahlen unter „Ergebnis“.
10. [ ] Offene Punkte „Modellklasse Extraktion (M4)“ und „Kachelgrenzen (M4)“ im Gesamtdesign (Abschnitt Offene Punkte) abhaken.

## Abnahmekriterien
- [ ] **Belegtreue 100 %**: `check:texts` meldet 100 % und 0 gesperrte Extraktionsläufe.
- [ ] **Modellwahl dokumentiert**: `docs/pilot/m4-modellvergleich.md` eingecheckt, `config/models.json` `decision.status` = `decided` (`check:texts` meldet `decided`).
- [ ] **Kosten je Erwähnung gemessen**: Wert aus `check:texts` unter „Ergebnis“.
- [ ] **Anteil Erwähnungen ohne Modellaufruf > 70 %**: `check:texts`.
- [x] **Facts mit hervorgehobenem Zitat in der UI**: `e2e/facts.spec.ts` (an echten Daten im Pilot stichprobenartig ansehen).
- [ ] **Kachelgrenzen gemessen und entschieden**: Messung und Entscheidung unter „Ergebnis“.

## Kosten der Umsetzung (echte Aufrufe)
| Dienst | Bündel J | M4 gesamt |
| --- | ---: | ---: |
| Anthropic | 0 € (Ruling M4-J-R0, keine echten Aufrufe) | 0 € |
| Nominatim | 0 € | 0 € (1 kostenlose Anfrage für die Fixture in Bündel F) |

Je Modell im Vergleich: Sonnet 0 €, Opus 0 € (Vergleich läuft erst im Pilot).

## Offene Kleinpunkte aus den Reviews (bewusst verschoben)
| Punkt | Ort |
| --- | --- |
| Verwaister Anbieter-Batch nach Absturz zwischen Annahme und Buchung: begrenztes Risiko (ein Batch, budgetgedeckelt); Übernahme nur bei eindeutigem Treffer nach Zeitfenster und Anzahl, sonst neu senden und Fehler loggen; ein gleich großer fremder Batch im Fenster kann falsch übernommen werden (Rulings M4-C-R3, M4-C-R6) | `lib/pipeline/batches.ts` (Claim, Adoption) |
| Eine `sending`-Zeile mit unbekanntem Ausgang wird beim Dead Letter ohne Listenprüfung verworfen (N2, innerhalb R3/R6) | `lib/pipeline/batches.ts` (`failSubmitUnit`, `endRunBatches`) |
| Reservierungsfenster misst `created_at`: ein nach mehr als 48 h wiederholter Batch zählt nach dem Senden nicht mehr zur Reservierung (N5) | `lib/domain/costs.ts` (`reservedBatchEur`) |
| Wiederholung bei `max_tokens`/`refusal` zahlt die Antwort zweimal (Ruling M4-P7, m8); kein Schätzer für Ausgabe-Token (m12) | `lib/ai/anthropic.ts`, `lib/ai/cost.ts` |
| Zweite Zustellung eines Klassifikations-Jobs kann einen leeren Folge-Job `<key>+` anlegen (harmlos, D-Minor 2) | `lib/pipeline/text/classify.ts` |
| Markdown-Zeichen zählen als Wörter für die ersten 1.500 Wörter (D-Minor 4) | `lib/domain/mentions/classification.ts` (`firstWords`) |
| `reviveBatch` nur für Tests exportiert (D-Minor 8) | `lib/pipeline/batches.ts` |
| Zitatprüfung: `too_long` zählt UTF-16-Einheiten; ein nicht komponierbares Zeichen + Akzent gilt als eine Einheit (B-Minor 4, 5) | `lib/domain/extraction/quote.ts` |
| Griechische Flexion (Genitiv, Akkusativ) ohne Stammbildung; Stoppliste geschlossen; Trigram-Plan für den Pilot angenommen (Ruling M4-E-R5) – im Pilot über den Anteil ohne Modell messen | `lib/domain/mentions/match.ts`, `config/mentions.json` |
| Kleinbuchstaben-Regel senkt den Anteil ohne Modell bei kleingeschriebenem Griechisch (angenommen unter M4-E-R3, im Pilot messen) | `lib/domain/mentions/match.ts` |
| Nackte URL mit `)` am Ende lässt ein Zeichen übrig (harmlos) | `lib/domain/mentions/ngrams.ts` (`BARE_URL`) |
| Ein von einem hängenden Lauf beanspruchter Treffer wartet bis „Lauf beenden“ | `lib/pipeline/text/disambiguate.ts` (`planDisambiguate`) |
| Anzeigegrößen als Code-Konstanten (Ausschnitte, Listenlängen, Zitatkontext 200, Erwähnungen 50 je Seite) (F-Minor 3, I-Minor) | `lib/pipeline/text/geocode.ts`, `lib/domain/review-view.ts`, `lib/domain/text-annotations.ts`, `lib/domain/geo-facts.ts` |
| `assign_name` speichert Sprache `und`; braucht der Liefervertrag eine Sprache je Name, braucht die Entscheidung ein Sprachfeld (F-Minor 5) | `lib/domain/review-decisions.ts` |
| Ausschnitt-Hervorhebung kann bei Zeichen mit anderer Kleinschreib-Länge (`İ`) verrutschen (F-Minor 6, kosmetisch) | `lib/pipeline/text/geocode.ts` (`occurrenceSnippet`) |
| Tests mit Nominatim teilen die Ratenzeile `http:nominatim` (Serialisierung, kein Zyklus heute) (F-Minor 7) | `lib/adapters/__tests__/nominatim.test.ts` |
| Test „verschachtelte Planung“ (R-M5, nur Abdeckung) | `lib/pipeline/__tests__/extract.test.ts` |
| Ein Highlight kann `{present: true, names: []}` sein, wenn alle Namen fehlen; Verbraucher lesen „vorhanden, ohne Namen“ | `lib/domain/extraction/facts.ts` |
| `late_results` überschreibt einen früheren Sperrgrund (die Fehler stehen weiter in `quote_check`); Zeilensperre auf `extraction_runs` serialisiert Verteilungen je Lauf | `lib/domain/extraction/run-status.ts` |
| `versionsRoutedBefore` zählt auch gesperrte und laufende Routen-Läufe als „schon geroutet“ (I-Minor 4, angenommen unter M4-I-R1) | `lib/pipeline/text/routes.ts` |
| `geoFacts` und `versionAnnotations` fragen den aktiven Lauf je (Version, Objekt) einzeln ab (N Abfragen, I-Minor 5) | `lib/domain/text-annotations.ts` (`activeRunCache`) |
| Abgleich-Lauf nach einer Review-Entscheidung startet nach dem Commit; ein anderer Fehler als `RunScopeNotReady` ergibt einen 500er, die Entscheidung bleibt (I-Minor 6, Runbook) | `app/(admin)/review/[id]/actions.ts` |
| Prompt v3 macht frühere v2-Läufe inaktiv (es gibt noch keine echten); ein Prompt-Wechsel braucht Reprozessieren. Seit M7 gilt v4: Listen-Attribute (Verbote, Gefahren, Zonen, Namenslisten …) je Eintrag ein Fact mit eigenem wörtlichen Zitat, übrige Attribute höchstens einmal (Ruling M7-G-R5); vor dem ersten echten Text-Lauf, daher nichts zu reprozessieren. Ebenso v5: am Fact-Limit bleiben alle Einträge der Sicherheitslisten (Verbote, Gefahren, Zonen), andere Facts fallen zuerst weg (Ruling M7-FIN-R1); kein echter Lauf mit v4 | `config/models.json`, `lib/domain/extraction/active-run.ts` |
| Ein Abgleich-Lauf mit einer neuen Erwähnung eines schon extrahierten (Version, Objekt) wird für dieses Paar aktiver Lauf und verdeckt dessen ältere Facts aus anderen Chunks, bis reprozessiert wird (Folge der Auflösung je Paar, M4-H-R2) | `lib/domain/extraction/active-run.ts` |
| Vergleich: Routen sind nicht Teil des Modellvergleichs (Stufen nur `extraction.mention`, `extraction.check`); Routen laufen mit dem konfigurierten Routen-Modell | `lib/pipeline/text/run.ts` (`MODEL_COMPARISON_STAGES`) |
| Vergleich: Kosten je Erwähnung in `check:texts` lassen den Vergleichslauf weg; seine Kosten stehen im Bericht | `scripts/check-texts.ts` |
| Vergleich: die Kostenschätzung nimmt 4000 Ausgabe-Token je Einheit an (Thinking eingeschlossen, Ruling M4-P7) und liegt damit meist deutlich über der Abrechnung | `config/extraction.json` `comparison` |
| Vergleich: `pickComparisonUnits` lädt alle (Version, Objekt)-Gruppen und fragt `levelFor` je Objekt nacheinander; die Vergleichsseite rechnet Planung, Paare und Schätzung bei jedem Aufruf neu (J-Minor 4, für den Pilot ausreichend) | `lib/domain/extraction/comparison.ts`, `lib/domain/model-comparison-view.ts` |
| Monatsdatum im Abrufmonat wird auf das Abrufdatum begrenzt (`min(15., Abruf)`): ein Beobachtungsdatum kann bis zu zwei Wochen zu früh liegen (Ruling M4-D-R3) | `lib/domain/mentions/classification.ts` |
| Trigram-Plan für den Pilot angenommen; wächst er, Varianten je Version vorberechnen (Ruling M4-E-R5) | `lib/domain/mentions/match.ts` |
| Wertwörter: das allgemeine „keine“ (`none`) passt nur zu femininen Nomen; im Fact-Schema v2 hat nur `ferry_traffic` den Wert `none`, und es hat ein eigenes Wort („kein Fährverkehr“). Neue Attribute mit `none` brauchen ein eigenes Wort (J-Minor 9, geprüft) | `app/(admin)/_components/labels.ts` (`ATTRIBUTE_VALUE_WORDS`) |
| Ohne `fallbackScope` (nie gelesen, der Rückfall auf die Reviere der Quelle steckt in `candidateTiles`) ändert sich der Konfigurationsschlüssel des Abgleichs: jede Version gilt einmal als „neu“ für „Neue Texte auswerten“ (es gibt noch keine echten Daten) | `config/mentions.json`, `lib/domain/mentions/store.ts` (`mentionsConfigKey`) |
| Erledigt: zwei Testläufe mit „too many clients already“ (NOTE Final-Review aus Bündel G) – Ursache 17 Vitest-Worker × Pool 10 über `max_connections` 100, behoben mit Commit `cb4d40a` (8 Worker, `max_connections` 400) | `vitest.config.ts`, `docker/compose.dev.yml` |

Für M5 offen (NOTE): Namens- und Objektlisten von Revieren und Inseln brauchen eine Mengen-Regel statt `area_weighted`; Highlights zählen verschiedene (Version, Objekt) (Re-Review r1 von Bündel G zu F-M1: POI-Erwähnungen stehen auf `done`, M5 zählt je (Version, Objekt) nur einmal); M5 liest Facts nur über `activeExtractionRun(version, object)` und hängt `consolidation.geo` an die Text-Stufen.

## Bewusst verschoben
- Kein automatischer Text-Lauf nach dem Crawl: „Neue Texte auswerten“ von Hand; der Scheduler verknüpft beides in M8.
- Stufe 8 (Konsolidierung) im Reprozess-Lauf fehlt bis M5.
- Echte Messwerte, Modellvergleich und Aufnahme echter Antworten: im Pilot M7 (Ruling M4-J-R0).

## Ergebnis
Datum der Abnahme: _offen_ (Pilot M7). Ausgabe von `check:texts`: _offen_. Belegtreue: _offen_. Anteil ohne Modellaufruf: _offen_. Kosten je Erwähnung: _offen_. Modellvergleich (Einheiten, Quellen, Dokumenttypen, Übereinstimmung, Urteile, Kosten je Modell): _offen_. Modellwahl mit Begründung: _offen_ (vorläufig `claude-sonnet-5-5`). Verworfene Zitate echter Antworten: _offen_. Kachelgrenzen (Messung, Entscheidung): _offen_ (vorläufig `neighbourRing` 1).

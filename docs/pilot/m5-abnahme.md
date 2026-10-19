# M5 Abnahme: Konsolidierung und Änderungen

Abnahmekriterium aus der Roadmap (Gesamtdesign): Profil jedes Orts in der UI mit Herkunft je Attribut; Zeitregler zeigt alten Stand. Teil-Spec 07: jedes bestätigte Pilot-Geo-Objekt hat ein Profil; Lückenliste und Herkunft je Attribut in der UI; Profil zum Datum abrufbar; Szenario „Taverne 2019 ja, 2024 nein → `changed`, kein Konflikt“ und „zwei gleichzeitige widersprüchliche Tiefen-Facts mit Konfidenz 0,6 → Bathymetrie gilt, kein Ereignis“. Offener Punkt des Gesamtdesigns nach M5: „Kachelgröße (nach M5, aus Ortszahl je Kachel)“.
Ablauf der Läufe: `docs/runbook.md`, Abschnitt „Konsolidierung“.

**Stand (wie Ruling M4-J-R0):** Die Entwicklungsdatenbank ist leer (kein Gazetteer, keine Dokumente; `npm run check:profiles -- --area saronic` meldet „unknown area saronic“). Alle Messwerte auf echten Daten werden deshalb **im Pilot (M7) gemessen**, nach Gazetteer, Geometrie, Crawl und Text-Läufen. M5 baut und testet die Werkzeuge an Fixtures und `MockModel`; für die Umsetzung wurde kein Geld für echte Aufrufe ausgegeben.

## Vom Code geprüft (Stand der Umsetzung)
- [x] Regeln je Attribut als reine Funktionen in `lib/domain/consolidation/rules/` (Regelname aus dem Fact-Schema, Parameter aus `config/consolidation/v1.json`, `rules_version` je Profil); ein Test stellt sicher, dass jeder Regelname eine Implementierung hat (`rules/__tests__/rules-registry.test.ts`). Tabellentests je Regel mit Zeitverlauf, Quellengewicht, Unabhängigkeit und Konflikt (`rules/__tests__/*.test.ts`, `__tests__/weights.test.ts`).
- [x] Szenario-Tests: Taverne 2019 ja, 2024 nein aus einem Revierführer → `changed`, `notable`, kein Konflikt (`__tests__/changes.test.ts` „taverna yes → no …“, `__tests__/weights.test.ts` „a time course 2019 → 2024 …“); zwei widersprüchliche Tiefen-Texte mit 0,6 → Bathymetrie gilt, kein Ereignis (`__tests__/store.test.ts` „depth scenario …“). Determinismus: dieselben Eingänge erzeugen keine neue Version (`store.test.ts` „a second consolidation creates nothing“, „one day later without new facts …“).
- [x] Profil je Objekt (`consolidateGeo`, `lib/domain/consolidation/store.ts`): Werte, Konfidenz und Klasse, Herkunft je Attribut (Facts, Quellen, Berechnungen, POIs, Regel, `observedAt`, `lastConfirmedAt`, Ablauf), Konflikte mit Vermerk, Lückenliste mit Grund (`gaps jsonb`), abgeleitete Werte (Ruhe, Bedeutung, Radius, Spot-IDs, Saison); neue Version nur bei geänderten Werten, Konfidenzklassen, Konfliktauflösungen oder Ablauf-Markierungen (Inhalts-Hash); `profiles`, `change_events`, `profile_summaries` nur anfügend.
- [x] Änderungsereignisse (`changed`, `uncertain` mit Aufgabe `uncertain_change`, `expired`, `new_attribute`, `place_new`, `place_abandoned`, `geo_changed`) mit Severity aus der Konfiguration; Change-Feed mit Outbox-Schutz (`xact_id`, Ruling M5-A-R2).
- [x] Profil zum Datum: `profileAsOf` (`lib/domain/timeline.ts`, größtes `valid_from <= Datum`, am selben Tag die höchste Version); Reiter „Zeitachse“ mit Versionsregler, Feld „Stand zum“, Diff zur Vorversion und Ereignisliste.
- [x] UI: Ort-Seite Reiter „Profil“ mit Wert, Konfidenz, Herkunft je Attribut, Konfliktmarker, Lückenliste, Klick zeigt die Facts mit hervorgehobenem Zitat und die angewandte Regel; Geo-Seite für Objekte ohne Ort; Karte färbt Orte nach Profil-Konfidenz. End-to-End-Test `e2e/profile.spec.ts`: Login → Ort-Seite des Synthetik-Orts → Reiter „Profil“ zeigt `shelter.N` („Schutz aus N“) mit Herkunft „Text“ → Klick zeigt das Fact mit `<mark data-kind="quote">` → Reiter „Zeitachse“, Regler auf Version 1 → alter Wert 0,90 statt 0,50 sichtbar (Synthetik-Ort mit zwei Profilversionen aus `e2e/global-setup.ts`); dazu Halt mit Herkunft, Lücken und „Kein Profil zum 2020-01-01“. Zweistufiges „Eintrag entfernen“: erst „Wirklich entfernen?“ (Abbrechen lässt den Eintrag stehen), dann der Hinweis „Eintrag entfernt.“ (eigener Synthetik-Ort mit einer Gefahr).
- [x] Review `conflict` (Wert A, Wert B, „Beide (saisonal)“, „Offen lassen“) und `uncertain_change` („Übernehmen“, „Verwerfen“) mit Schutz gegen veraltete Seiten („Der Wert hat sich geändert – bitte neu laden“); Entscheidungen konsolidieren nie in ihrer Transaktion, der Folgelauf startet nach dem Commit. Ebenso nach jeder Entscheidung über einen Ortskandidaten („Bestätigen“, „Zusammenlegen“, „Ablehnen“, „Kein Ankerplatz“), und jeder Geometrie-Lauf hängt die Konsolidierungsstufen für seine Orte an: Ausschluss, Status, `place_new` und berechnete Werte stehen ohne Handgriff im Profil (Final-Review I-2; `review-decisions.test.ts`, `geometry.test.ts` „a geometry run's consolidation stage …“).
- [x] Summary (`consolidation.summary`, Sonnet, synchron, höchstens 3 Versuche, 15-Wörter-Prüfung gegen Zitate, leer und Aufgabe mit „Neu erzeugen“/„Ignorieren“), mit `MockModel` getestet (`__tests__/summary.test.ts`).
- [x] Folgeaufträge: gezielte Quellenfindung für Orte mit < 2 Dokumenten (`discovery.place`, Abklingzeit 90 Tage, höchstens 30 Orte je Lauf, Budget `dataforseo`), Konflikt ohne Zeitverlauf → Aufgabe `conflict` (`__tests__/followup.test.ts`).
- [x] Belegtreue < 100 % sperrt die Konsolidierung (keine aktiven Facts gesperrter Läufe, `consolidation.geo` plant nichts, Laufseite nennt den Grund); „Belegtreue neu prüfen“ konsolidiert nach der Freigabe, „Konsolidierung nachholen“ für übersprungene Läufe (Ruling M5-H-R2).
- [x] Bewertungslauf (`evaluation: true`, `rulesVersion`) schreibt nur `evaluation_profiles`, keine Profile, Ereignisse, Aufgaben, Summaries, Folgeaufträge.
- [x] Signale als Datensätze: Wikidata-Sitelinks (für die Bedeutung, neu in M5) über „Datensätze laden“; Straßen und die Ruhe-Rechnung gibt es unverändert seit M2 (Ruling M5-P1, `config/geometry.json` bleibt `geometry-1`). Die Konsolidierung braucht kein Netz.
- [x] `npm run check:profiles -- --area <key>` prüft die Abnahme (`scripts/check-profiles.ts`, Test `scripts/__tests__/check-profiles.test.ts`): Objekte = bestätigte Orte und gültige Objekte der Ebenen `area`, `island`, `cape_strait`, `poi` in den Küstenkacheln des Reviers (dieselben, die ein Revier-Lauf konsolidiert); Exit 1, wenn das Revier kein Objekt hat, bei einem Objekt ohne Profil, einem Attribut ohne Herkunft oder Regel (ein Text-, Rechen- oder Review-Wert muss einen Fact, eine Berechnung oder einen POI nennen) oder wenn `profileAsOf(valid_from(v2) − 1 Tag)` nicht Version 1 liefert (geprüft für jedes Objekt mit Versionen an zwei Tagen); offene Konflikte und Unsicherheiten (nur `subject_type = 'profile_attribute'`) und Summaries (ok, leer) werden gezählt. Beide Wege an eigenen Fixture-Objekten mit echtem `consolidateGeo` getestet: „a confirmed place without profile is missing“, „an area whose objects all have profiles with provenance passes“.
- [x] `npm run consolidate -- (--area <key> | --tile <id> | --comparison-set <key>) [--evaluation --rules <version>]` startet Revier-, Kachel-, Vergleichssatz- und Bewertungsläufe, die in M5 keinen Knopf haben (`scripts/consolidate.ts`, Test der Argumente).

## Messwerte
| Wert | Fixtures / MockModel (M5) | Echte Daten |
| --- | --- | --- |
| Objekte mit Profil / Objekte | Test: 2 von 2 (Ort mit zwei Versionen, Insel); fehlender Ort wird gemeldet | wird im Pilot (M7) gemessen: `check:profiles -- --area saronic` und `--area argolic` |
| Profile mit Attribut ohne Herkunft | Test: 0 | wird im Pilot (M7) gemessen: `check:profiles` |
| Profil zum Datum | Test: `profileAsOf(Tag vor Version 2)` = Version 1; e2e: Regler auf Version 1 zeigt den alten Wert | wird im Pilot (M7) gemessen: `check:profiles` (Zeile „profile as of a date“) |
| Offene Konflikte / unsichere Änderungen | Test: 1 / 0 (eine „Eintrag entfernen“-Aufgabe zählt nicht) | wird im Pilot (M7) gemessen: `check:profiles`, dann unter „Prüfen“ abarbeiten |
| Summaries ok / leer | Test: 1 / 1 | wird im Pilot (M7) gemessen: `check:profiles` |
| Kosten Summary je geändertem Profil | 0 € (MockModel) | wird im Pilot (M7) gemessen: `external_calls` `anthropic` der Konsolidierungsläufe (Seite „Kosten“); Schätzung etwa 0,02 € (Sonnet, ~2.000 Eingabe-, ~1.500 Ausgabe-Token mit Thinking) |
| Kosten gezielte Quellenfindung | 0 € (Fixtures) | wird im Pilot (M7) gemessen; Schätzung für 12 Kacheln etwa 540 Suchen ≈ 1,90 € (DataForSEO, Budget 10 €/Tag) |
| Orte je Kachel (für die Kachelgröße) | – | wird im Pilot (M7) gemessen: `select tile_id, count(*) from places where status = 'confirmed' and valid_to is null group by 1 order by 2 desc;` |

## Offen für Christian (Übergabe, nicht automatisierbar)
Voraussetzung: Gazetteer, Geometrie, Quellen, Crawl und Text-Läufe aus M1–M4 auf dem Server (Pilot M7). Kosten: Overpass und Wikidata kostenlos; Summaries Sonnet (Budget `anthropic` 20 €/Tag), gezielte Quellenfindung DataForSEO (Budget 10 €/Tag).
1. [ ] **Datensätze laden** je Revier (`saronic`, `argolic`): Läufe → „Datensätze laden“ (Sitelinks neu; unveränderte Datensätze bleiben).
2. Kein Geometrie-Lauf nötig (Ruling M5-P1: Straßen und Ruhe unverändert seit M2; Sitelinks wirken erst bei der Konsolidierung).
3. [ ] **Konsolidieren** je Revier: `dc run --rm worker node --import tsx scripts/consolidate.ts --area saronic`, ebenso `--area argolic` (nach jedem Text-Lauf geschieht es automatisch).
4. [ ] **Review**: `conflict`, `uncertain_change` und leere Summaries unter „Prüfen“ abarbeiten; Stichprobe von 10 Profilen in der UI ansehen (Herkunft, Lücken, Zeitachse).
5. [ ] **`check:profiles`** für `saronic` und `argolic` bis Exit 0 (`dc run --rm worker node --import tsx scripts/check-profiles.ts --area saronic`); Ausgabe unter „Ergebnis“ eintragen.
6. [ ] **Kachelgröße** aus der Zahl bestätigter Orte je Kachel entscheiden (Abfrage oben) und den offenen Punkt im Gesamtdesign abhaken.
7. [ ] Abnahme-Checkliste unten abhaken.

## Abnahmekriterien
- [ ] **Profil je bestätigtem Objekt**: `check:profiles` meldet für beide Reviere 0 Objekte ohne Profil.
- [ ] **Herkunft je Attribut und Lückenliste in der UI**: `check:profiles` meldet 0 Profile mit Attribut ohne Herkunft; Reiter „Profil“ an echten Daten stichprobenartig (Code: `e2e/profile.spec.ts` [x]).
- [ ] **Profil zum Datum**: `check:profiles` meldet „ok“ (nach einem zweiten Lauf mit Änderungen an einem späteren Tag; vorher ist die Prüfung leer wahr).
- [ ] **Zeitregler zeigt alten Stand**: an einem echten Ort mit zwei Versionen (Code: `e2e/profile.spec.ts` [x]).
- [x] **Szenario-Tests grün**: Taverne und Tiefe (siehe oben), in `npm test`.
- [ ] **Offene Konflikte und Unsicherheiten gezählt**: Zahlen aus `check:profiles` unter „Ergebnis“.

## Kosten der Umsetzung (echte Aufrufe)
| Dienst | Bündel J | M5 gesamt |
| --- | ---: | ---: |
| Anthropic | 0 € (keine echten Aufrufe) | 0 € |
| DataForSEO | 0 € | 0 € |
| Wikidata | 0 € | 0 € (3 kostenlose Abfragen für die Sitelink-Fixtures in Bündel D, gegen eine Wegwerf-Datenbank) |

## Offene Punkte aus den Reviews
### Für M6 (Liefervertrag, NOTE)
| Punkt | Ort |
| --- | --- |
| Der Change-Feed-Leser liefert nur Zeilen mit `xact_id < pg_snapshot_xmin(pg_current_snapshot())` (Outbox-Schutz; `seq` wird beim Einfügen vergeben, nicht beim Commit) (Ruling M5-A-R2) | `lib/domain/change-feed.ts` (`visibleChangeEventsFilter`) |
| `uncertain`- und `expired`-Ereignisse tragen eine unveränderte Profilversion: im Feed als Prüf-/Statusereignisse abbilden, nicht als „profileVersion gestiegen“ (Ruling M5-F-R3 M-4) | `lib/domain/consolidation/changes.ts` |
| Herkünfte `rule`, `gazetteer`, `derived` und die Konfliktauflösung `decided` im Vertrag abbilden (Rulings M5-E-R3, M5-F-R3) | `lib/domain/consolidation/types.ts` |
| `popularity` beim Lesen berechnen (`popularityForArea`, aus `sources_count`); die Ort-Seite rechnet das ganze Revier je Aufruf, in M6 je Lauf zwischenspeichern (Rulings M5-E-R2, M5-I-R2 M-8) | `lib/domain/consolidation/derived/` |
| Spot-Kandidaten im Bedeutungsradius nur bestätigte Orte; im Vertrag bestätigen. `highlightIds` als Umkehrung der `spotIds` der POI-Profile (Ruling M5-E-R2) | `lib/domain/consolidation/derived/` |
| Verbot bleibt im Profil; ein ganzjähriges Text-Ankerverbot schließt im Vertrag als `anchoringProhibited` aus, auch wenn `exclude` false ist (M6-Preflight P4, Vorgabe) | M6 |
| Das letzte Profil eines abgelehnten, zusammengelegten oder beendeten Objekts bleibt als Historie stehen und wird nie ausgeliefert; seine offenen Konflikt-/Unsicherheits-Aufgaben schließt der Folgelauf (`object_ended`) (Ruling M5-FIN-R1 M-6) | `lib/domain/consolidation/store.ts`, Liefervertrag |
| Tests committen nie Orte an der P20-Synthetik-Koordinate (21,0° O / 35,2° N); committende Tests nehmen −150,1/−50,1 mit Aufräumen in `finally`, e2e eigene Objekte bei 27,9x/34,9x (Bündel F, bindend für M6-Tests) | `test/`, `e2e/global-setup.ts` |

### Für M7 (Qualität)
| Punkt | Ort |
| --- | --- |
| Kennzahlen über entschiedene `uncertain_change`-Aufgaben zählen nur `subject_type = 'profile_attribute'`: „Eintrag entfernen“ schreibt sofort entschiedene `uncertain_change`-Aufgaben mit Subjekt `profile_entry` (ohne Dauer, ohne `context.key`) (Ruling M5-I-R2 M-3; `check:profiles` filtert so) | `lib/domain/profile-entry-removal.ts` (`ENTRY_REMOVAL_TASK`), M7-Kennzahlen |
| Vergleich alt/neu eines Bewertungslaufs und „Aktivieren“ auf „Qualität“; bis dahin Umstellen per Deploy (`active.json`) | `config/consolidation/`, `/quality` |
| Der Bewertungslauf variiert nur die Regelversion; neue Prompts, Modelle oder Fact-Schemas bewerten braucht `loadInputs({ cfg: Kandidat })` (Ruling M5-P22) | `lib/domain/consolidation/inputs.ts` |
| Simulierter Revisit (Spec 10) prüft die Änderungserkennung an echten Daten | M7 |

### Für M8 (Scheduler, Beobachtungen)
| Punkt | Ort |
| --- | --- |
| `observedAsOf`-Rekonstruktion (Spec 07) fehlt; `buildProfile` ist rein und kann mit gefilterten Eingängen aufgerufen werden | `lib/domain/consolidation/build.ts` |
| Beobachtungen ohne Tabelle: Lader und Regeln kennen Herkunft `observed` (Gewicht 0,8), Tests bauen solche Eingänge direkt | `lib/domain/consolidation/inputs.ts` |
| Kachelfärbung nach Profilalter folgt mit dem Scheduler | Karte |
| Neue Quellen aus der gezielten Quellenfindung gehen über `source_approval`; der Weg bis zur erneuten Konsolidierung bleibt manuell (Crawl → Text-Lauf) | `lib/pipeline/discovery-run.ts` |

### Übergaben (Handoff)
| Punkt | Ort |
| --- | --- |
| Verwaister Lauf auf „Wartend“, wenn nach einem Commit (Entscheidung, Start) das Einreihen der ersten Stufe scheitert; „Lauf beenden“ räumt auf (Runbook) (Bündel H) | `lib/pipeline/runs.ts` (`startRun`) |
| Erledigt: Voyage-Zahlungsmittel hinterlegt (M3-D-R1), Entwicklungsdatenbank auf Migration 0037 | – |
| Server-Schritte oben unter „Offen für Christian“ | Pilot M7 |

### Bewusst angenommen (Verhalten im Pilot beobachten)
`config/consolidation/v1.json` ist mit dem Final-Review eingefroren (ein Test pinnt seinen SHA-256): jede Parameteränderung ist eine neue Version `v2` (Final-Review M-4).

| Punkt | Ort |
| --- | --- |
| Ein Verbot wird nie durch Weglassen aufgehoben (ersetzt die Aufhebungsregel von P5): ein veraltetes Verbot bleibt, bis ein Admin es entfernt oder eine neuere Berechnung es nicht mehr hat (Ruling M5-C-R2 I-2) | `rules/prohibitions.ts` |
| Reine Text-Einträge in `prohibitions` altern nie (die Stütze enthält Basis und wirksame Entfernungen) (E-Minor M-4) | `rules/prohibitions.ts` |
| Entfernt ein Admin eine Text-Verbotsart (`{ remove: { kind } }`, genau eine Art), bringt sie der nächste jüngere Text, der sie nennt, zurück (wie bei Mengenlisten), dann mit allen Nennungen dieser Art. Eine Review-Entscheidung verdrängt nie einen Text: ein später gefundener, älter datierter Text fügt seine Arten hinzu (Ruling M5-FIN-R1 I-1). Entfernungen lesen einander nicht und brauchen keine Sperre (Final-Review M-5 dadurch erledigt) | `rules/prohibitions.ts`, `lib/domain/profile-entry-removal.ts` |
| „Übernehmen“ einer Listenänderung (`uncertain_change` auf einer Mengenliste) speichert die ganze vorgeschlagene Liste als einen Review-Fact (Einträge einzeln geprüft); sie fügt nur hinzu, Einträge verschwinden erst über „Eintrag entfernen“ (`{ remove }`) (Bündel G, Bedenken 1) | `lib/domain/review-decisions.ts` |
| Die Zeitachse zeigt `popularity` älterer Versionen mit dem heutigen Revierstand (beim Lesen berechnet, nicht je Version gespeichert) (Bündel I, Bedenken 5) | `lib/domain/profile-view.ts` |
| Auch ein Lauf für ein einzelnes Objekt („Profil neu berechnen“, Folgelauf einer Entscheidung) plant die gezielte Quellenfindung; begrenzt nur durch die Abklingzeit von 90 Tagen je Ort und `maxPlacesPerRun` (Bündel H, Bedenken 9). Geometrie-Läufe konsolidieren nur (Profil, Summary) und starten nie eine bezahlte Quellenfindung | `lib/pipeline/consolidation/followup.ts` |
| Geltung von Kacheln, Objekten und Orten in Lauf-Umfang und -Zielen am Laufdatum (UTC), nicht am Datenbankdatum (Final-Review M-7) | `lib/pipeline/consolidation/run.ts`, `lib/domain/consolidation/targets.ts` |
| Die flachere Tiefe gewinnt auch über die Zeit (Sicherheit), mit Konflikt für den Admin (Ruling M5-B-R3) | `rules/bathymetry.ts` |
| Ein einzelner schwacher Text (Gewicht ≤ 0,8), der Schutz oder Tiefe senkt, bleibt „unsicher“ mit Aufgabe Priorität 2, statt sofort zu gelten (Ruling M5-F-R3 I-3) | `lib/domain/consolidation/changes.ts` |
| Ein unsicherer Wert behält seine alte Herkunft; sein `lastConfirmedAt` steht, er kann ablaufen, während die Aufgabe offen ist (F-Bericht) | `lib/domain/consolidation/changes.ts` |
| Ablauf senkt die Konfidenz auf die Mitte der nächstniedrigeren Klasse; berechnete, Review- und POI-Werte laufen nie ab, undatierte Texte schon | `lib/domain/consolidation/build.ts` |
| Hafenuntergrenze 0,8 mit Konfidenz 0,3, wenn ein Text sie aufhebt (Ruling M5-B-R3) | `rules/shelter.ts` |
| Abgeleitete Werte haben Konfidenz 1 und zählen nicht zur Profil-Konfidenz; `derived.season` nur für Orte | `lib/domain/consolidation/derived/` |
| Sitelinks zählen alle Wikis, nicht nur Wikipedias | `lib/pipeline/datasets.ts` |
| Highlight-Namen werden exakt verglichen (keine Groß-/Leerzeichen-Faltung); verschachtelte Zahlen werden nicht gerundet (Koordinaten) | `rules/highlight.ts`, `weights.ts` |
| Abfragen je Objekt: 2 je Dokumentversion, Berechnungen doppelt geladen, Aufgaben-Präfix ohne Index (D-Minor M-2, für den Pilot ausreichend) | `lib/domain/consolidation/inputs.ts`, `store.ts` |
| Rechnungen zusammengelegter Objekte zählen für das überlebende nicht (Bündel D) | `lib/domain/consolidation/inputs.ts` |
| Revier-Lauf und `check:profiles` nehmen die Objekte der Küstenkacheln; ein Objekt nur in einer Kachel ohne Küste wird mit „Profil neu berechnen“ einzeln konsolidiert | `lib/domain/consolidation/targets.ts`, `scripts/check-profiles.ts` |
| Orte ohne Dokumente erreicht die gezielte Quellenfindung nur über Kachel-, Revier-, Orts- oder Review-Läufe; `thinPlaces` zählt Dokumente live (Bündel H) | `lib/domain/consolidation/followup.ts` |
| Der Hinweis auf der Laufseite heißt „Belegtreue unter 100 %“ auch bei einem gesperrten oder laufenden Extraktionslauf | `app/(admin)/runs/[id]/page.tsx` |
| `sentenceCount` der Summary ist eine Heuristik (Abkürzungen wie „z. B.“ berücksichtigt) | `lib/domain/consolidation/summary.ts` |
| Eine Job-Wiederholung nach einem bezahlten Summary-Aufruf kann einmal mehr zahlen (begrenzt durch `maxAttempts`, Ruling M5-P14) | `lib/domain/consolidation/summary.ts` |

## Ergebnis
Datum der Abnahme: _offen_ (Pilot M7). Ausgabe von `check:profiles` für `saronic`: _offen_; für `argolic`: _offen_. Offene Konflikte / unsichere Änderungen: _offen_. Summaries ok / leer: _offen_. Kosten Summaries und gezielte Quellenfindung: _offen_. Kachelgröße (Orte je Kachel, Entscheidung): _offen_.

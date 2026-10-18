# Periplus 10 – Qualität, Vergleichssatz und Pilot-Abnahme

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilensteine: Vergleichssatz in M1, Messung in M7, Regression ab M7 dauerhaft · Quell-Spec: „Qualitätsmetriken“, „Pilot Saronischer Golf“ (Simulierter Revisit, Erfolgskriterien)

## Zweck

Messen, ob Periplus gut genug ist, um vom Pilot in den Dauerbetrieb zu gehen, und danach verhindern, dass Änderungen an Prompt, Modell, Schema oder Regeln die Qualität senken.

## Kennzahlen

Die sieben Kennzahlen der Quell-Spec mit ihren Zielwerten (Pilot/Vollbetrieb) gelten unverändert, dazu die beiden Zusatzkennzahlen (Anteil Orte mit Highlight-Fact, Anteil Orte mit Beobachtung < 18 Monate) und der Review-Aufwand. Berechnung je Kachel, Revier und Lauf in `lib/domain/quality/metrics.ts`, gespeichert in `quality_snapshots` (run_id, scope, metric, value, details jsonb), angezeigt auf `/quality`.

| Kennzahl | Berechnung in Periplus |
| --- | --- |
| Abdeckung | Anteil der Orte im Vergleichssatz mit `status = confirmed` |
| Mehrbefund | Anteil bestätigter Orte mit Erwähnungen aus ≥ 2 Dokumenten verschiedener Quellen |
| Fact-Präzision | Über `comparison_results` der aktuellen Profile: (`match` + `deviation_confirmed_own`) / (alle verglichenen Attribute ohne `not_at_navily`) |
| Belegtreue | Anteil Facts mit `quote_verified = true` unter allen Text-Facts des Laufs; < 100 % sperrt die Konsolidierung des Laufs |
| Schutz-Konfidenz | Anteil Orte, bei denen jeder der 8 Sektoren mindestens einen Text-Fact hat, der bestätigt (Abweichung ≤ 0,2) oder korrigiert |
| Routen-Rekonstruktion | Anteil Routen, deren Stopps alle einem bestätigten Ort zugeordnet sind |
| Kosten je Ort | Summe `external_calls` des Laufs / bestätigte Orte im Umfang |
| Review-Aufwand | Summe der Bearbeitungszeiten der im Lauf entstandenen Review-Aufgaben, je 100 Orte |

## Vergleichssatz (Navily)

- `comparison_set`: (place_id, added_at, added_by, area_id); im Pilot 50 Orte, je weiterem Revier 20–30.
- `comparison_results` (nur anfügend): (place_id, attribute, profile_version, result: `match`, `deviation`, `not_at_navily`, `deviation_confirmed_own`, `deviation_confirmed_navily`, `unclear`; checked_by, checked_at). **Gespeichert wird nur das Ergebnis, nie ein Navily-Wert** (Quell-Spec, Grundprinzip 9) — es gibt keine Spalte, in die ein Navily-Wert passen würde.
- Ablauf: Auf `/quality/compare` arbeitet ein Admin die Orte des Satzes ab; je Ort zeigt Periplus die eigenen Werte für die Vergleichsattribute (Existenz, Position, Schutz je Sektor, Tiefe, Grund, Bojen, Versorgung, Taverne). Der Admin vergleicht in der Navily-App und klickt je Attribut stimmt / weicht ab / bei Navily nicht vorhanden. Jede Abweichung erzeugt eine Review-Aufgabe `comparison_deviation`.
- **Regression:** Nach jeder Reprozessierung mit neuem Prompt, Modell, Schema oder Regelstand werden die Profile des Vergleichssatzes neu berechnet (in einem Lauf `reprocess` mit Kennzeichen `evaluation`, ohne Änderungsereignisse in den Change-Feed). Für Attribute, deren Wert sich gegenüber dem zuletzt geprüften Profil nicht geändert hat, gilt das alte Ergebnis weiter; geänderte Werte gehen zur erneuten Prüfung. Übereinstimmung und Abdeckung dürfen nicht sinken; sonst wird die neue Konfiguration nicht aktiv geschaltet (`/quality` zeigt den Vergleich alt/neu, Aktivieren ist ein bewusster Klick).

## Simulierter Revisit (M7)

Ziel nach Quell-Spec: Nach dem ersten vollen Lauf werden 10 Dokumentversionen gezielt verändert und der Lauf wiederholt; der Change-Feed muss genau diese Änderungen mit richtigem Typ zeigen und nichts anderes.

Umsetzung (Entscheidung Claude), damit die echte Zeitachse sauber bleibt:

1. Kopie der Produktionsdatenbank in eine Datenbank `periplus_sim` (pg_dump/restore, Skript `scripts/sim/clone.sh`), eigener Worker-Prozess gegen diese Datenbank und ein eigener S3-Präfix.
2. Szenario-Datei `test/revisit/scenario.json`: 10 Änderungen mit erwarteten Ereignissen, z. B. Satz zur Taverne gestrichen → `changed` `services.taverna` mit Severity `notable`; Tiefe geändert (bei Text-Basis) → `changed` `depth.*` `safety`; Seite 404 zweimal → Dokument `gone`, Attribute mit nur dieser Quelle nach Regel; neuer Ankerverbot-Satz in einer `authority`-Quelle → `changed` `prohibitions` `safety`.
3. Ein Fetch-Adapter `simulated` liefert für die Szenario-URLs die veränderten Inhalte (Versionen mit `simulated = true`), alle anderen URLs wie aufgezeichnet.
4. Lauf `revisit` über die Pilotkacheln; danach vergleicht `scripts/sim/verify.ts` die entstandenen `change_events` mit dem Szenario: 10 von 10 erwartet, 0 zusätzliche.
5. „Ein Profil ist zum Stand vor dem Revisit über die API abrufbar“: `GET /spots/{id}?asOf=<Datum vor Revisit>` in der Sim-Umgebung liefert die alte Version.

Der Revisit wird zusätzlich als automatischer Integrationstest mit kleinem Fixture-Revier (eine Kachel, 3 Orte, 5 Dokumente) in der CI ausgeführt, damit die Änderungserkennung dauerhaft geprüft ist.

## Pilot-Abnahme (M7)

Die Erfolgskriterien der Quell-Spec gelten, angepasst an Periplus:

- [ ] Alle Pilot-Zielwerte der Kennzahlen erreicht; Gazetteer der Pilotkacheln vollständig (de, en, el)
- [ ] Simulierter Revisit: 10 von 10 Änderungen korrekt, keine falschen
- [ ] Profil zum Stand vor dem Revisit per API abrufbar
- [ ] Review-Aufwand für den zweiten Lauf unter 60 Minuten
- [ ] Kosten je Ort und Lauf dokumentiert, Hochrechnung für das Mittelmeer erstellt (`docs/pilot/2026-xx-kostenbericht.md`: Kosten je Stufe, je Ort, Annahmen für Ortszahl je Revier, Zahl der Reviere 60–100)
- [ ] Ein Abnehmer (Testskript oder neue Törn-App) liest das Paket des Pilotreviers über die API ohne eigene Nachbearbeitung und validiert es gegen das veröffentlichte JSON-Schema (ersetzt das DSTAP-Kriterium der Quell-Spec)
- [ ] Kachelgröße bewertet (Orte je Kachel, Ziel 10–40), Entscheidung dokumentiert

Ergebnis wird als Pilotbericht in `docs/pilot/` festgehalten; erst danach beginnt M8.

## Tests

- Kennzahlen mit konstruierten Daten (je Kennzahl ein Test mit erwartetem Wert).
- Revisit-Integrationstest (siehe oben) in der CI.
- Test, dass `comparison_results` keine freie Wertspalte hat (Schema-Test gegen Grundprinzip 9).

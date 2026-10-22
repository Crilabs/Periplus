# P3 – Geometrie und Ausschlüsse (M2), P3a – Ortsbilder, P3b – Reviere

Datum: 21.10.2026 (zweiter Durchgang nach Plan 16) · Umfang: Datensätze für `GR-I`, Geometrie für die Probekachel `q025:813:510`, Revier-Import `GR.json`

## Erwartung (vor dem Lauf)

- Geometrie für alle Ortskandidaten der Kachel (38 aus dem Seed) plus unbenannte Buchten aus `geometry.detect_bays` (Agistri, Methana, Poros haben viele kleine Buchten): 60–100 Orte.
- Schutzrichtung: die am schlechtesten geschützte Richtung entspricht bei den Navily-Plätzen mit Schutzangabe der offenen Richtung; Sektorübereinstimmung ≥ 75 %.
- Ausschlüsse: das Militärgebiet der Marine bei Poros (Navy Bay) und Aquakultur an der Festlandküste.
- Ortsbilder entstehen nur für Orte mit Status `confirmed` oder `no_anchoring` und einer Fetch-Rechnung; ohne Kandidaten-Review also fast keine.
- Reviere: `saronic-gulf`, `saronic-islands`, `argo-saronic`, `peloponnese-east-coast` berühren die Probekachel; Reviere anderer Landesteile warten auf deren Gazetteer.

## Lauf

| Lauf | Ergebnis |
| --- | --- |
| Datensätze `GR-I` (`01a15e49…`) | 30 min, 5 von 6: **Meeresboden (EMODnet Seabed) scheitert mit HTTP 400** (B18), Bathymetrie, Sperrgebiete, Straßen, Schiffsdichte, Wikipedia geladen |
| Geometrie Probekachel (`01a15e64…`) | 27 min: `detect_bays`, 91 Orte Geometrie, `consolidation.geo` 91, **`consolidation.highlights` 167 POIs**, `consolidation.summary` 258, `images.place` 5 |
| `areas:import --dry-run`, dann `areas:import` zweimal | 13 Reviere angelegt, 26 warten auf Gazetteer anderer Landesteile; zweiter Import: 13 unverändert |

## Automatische Prüfung

`check:geometry -- --subdivision GR-I` (Exit 1): 91 Orte, 90 vollständig, 1 mit fehlenden Werten („Aegina Harbour“: Position der Hafenfläche, kein Wasser in Reichweite – Ortsposition prüfen).

Status der Orte in der Kachel: 86 Kandidaten, 5 `no_anchoring` (Sperrgebiet). Offene Prüfaufgaben gesamt: 290 Ortskandidaten/Paare, 5 Titelbilder, 4 fehlgeschlagene Jobs.

## Sichtprüfung

| Prüfung | Ergebnis |
| --- | --- |
| Schutz gegen Navily (22 Ankerplätze mit Schutzangabe und Ort in 400 m, 176 Sektoren) | **83 % Sektoren übereinstimmend**; unsere am schlechtesten geschützte Richtung ist in **100 %** der Fälle bei Navily offen ✓. Abweichungen: 24 Sektoren bei uns geschützt (≥ 0,5), bei Navily offen; 6 umgekehrt – unsere Werte sind eher optimistisch |
| Ankerposition | 2 Marinas mit geschlossenem Becken (Öffnung 0°) – plausibel; keine Ankerposition an Land unter den Ankerplätzen |
| Ausschlüsse | 4 unbenannte Buchten im **Militärgebiet** westlich Agistri/Dorousa/Aponisos (37,68° N 23,31–23,32° O) und bei Kyra (37,71° N 23,26° O), 1 in **Aquakultur** südlich Poros. Navily kennt dort selbst eine „No anchor Zone“, aber auch genutzte Plätze (Aponisos, Dorousa, Agistri West, Epa South) – B19 |
| Unbenannte Buchten | 53 neue Kandidaten aus `detect_bays` (Ortskandidat-Aufgaben), Sichtprüfung offen für Christian |

## P3a – Ortsbilder

- 5 Bilder erzeugt, alle für **unbenannte Buchten mit Status `no_anchoring`** im Militär- bzw. Aquakulturgebiet (B17). Licht „Mittag“, Zoom z1, Wasser-IoU 0,87–0,98 (Schwelle 0,80) ✓.
- Für bestätigte Orte entstehen Bilder erst nach dem Kandidaten-Review.
- Kosten: 5 × 0,25 € = 1,25 € (OpenAI) plus Haiku-Prüfung.
- Freigabe der 5 Bilder: offen für Christian (sinnvoll eher „Kein Bild“, siehe B17).

## P3b – Reviere

| Revier | Fläche | Mitglieder | berührt Probekachel |
| --- | --- | --- | --- |
| argo-saronic | 4.742 km² | 15 | ja |
| peloponnese-east-coast | 6.314 km² | 15 | ja |
| saronic-gulf | 2.844 km² | 15 | ja |
| saronic-islands | 2.244 km² | 10 | ja |
| argolic-gulf, cyclades, northern-/western-/small-cyclades, gulf-of-corinth, gulf-of-evia, laconian-gulf, peloponnese-west-coast | 231–2.202 km² | 2–12 | nein |

Genau die vier erwarteten Reviere berühren die Probekachel ✓. Kykladen-Reviere entstehen schon aus wenigen Mitgliedern im Rahmen von `GR-I` (2–7) und sind damit vorläufig; sie werden nach dem Gazetteer von `GR-CYC` neu berechnet. Kartenansicht der Polygone: offen für Christian.

## Highlights (Plan 16) nach P3

Die Konsolidierung hat 167 POIs als Highlights der 91 Orte konsolidiert (statt aller 22.000 Kandidaten). Sichtprüfung der Auswahl je Ort folgt in P7; auf der Ortsseite steht dafür der neue Abschnitt „Highlights“.

## Kosten

2,08 € (OpenAI 1,25 €, Anthropic Zusammenfassungen 0,83 € für 260 Profile; Overpass, EMODnet, Kataster, Copernicus frei).

## Tor

**Bestanden mit Befunden:** Schutzwerte stimmen in der Hauptrichtung, keine Ankerposition an Land, Ausschlüsse nachvollziehbar, aber das Militärgebiet trifft genutzte Plätze (B19, Entscheidung Christian). Meeresboden fehlt (B18). Reviere plausibel.

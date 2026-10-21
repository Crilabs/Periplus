# P1 – Gazetteer (M1)

Datum: 21.10.2026 (Nacht, autonom durch Claude) · Umfang: Lauf für Landesteil `GR-I`, ausgewertet für die Probekachel 23,25–23,5° O × 37,5–37,75° N

## Erwartung (vor dem Lauf)

- Küstenkacheln von `GR-I`: Attika mit Saronischen Inseln, Troizinia/Methana, Kythira und Antikythera; Laufumfang inklusive Grenzkacheln zu `GR-H`, `GR-J`, `GR-CYC`: etwa 35–50 Küstenkacheln.
- Probekachel (Ägina-Süd, Agistri, Moni, Metopi, Dorousa, Methana, Poros, Galatas und Festland Troizinia):
  - Inseln/Eilande: 15–30 (Ägina, Agistri, Moni, Metopi, Dorousa, Poros/Sferia, Kalavria, Bisti, Petrokaravo, …).
  - Orte (`settlement`): Methana, Vathi, Agios Georgios, Galatas, Poros, Perdika, Skala, Megalochori, Limenaria, Kalloni, Agios Nikolaos; 10–25.
  - Häfen und Marinas: Poros (Stadt, Marina), Galatas, Methana, Vathi, Perdika, Skala, Megalochori, Ägina-Stadt (knapp außerhalb, 37,745° N); 8–15.
  - Benannte Buchten: 20–40 (Russian Bay, Navy Bay, Neorio, Askeli, Monastiri, Vagionia, Sarpa, Marathonas, Dragonera, Aponisos, …).
  - POIs: Tavernen, Strände, Kloster Zoodochos Pigi (Poros), Thermalquellen Methana, Vulkan Methana; einige Dutzend.
- Navily-Abgleich: mindestens 80 % der 17 Häfen/Marinas haben ein Geo-Objekt Hafen/Marina oder Ort in 300 m; bei den 88 Ankerplätzen deutlich weniger (viele Navily-Plätze sind unbenannte Strandabschnitte), erwartet 40–60 % mit einer benannten Bucht oder einem Strand in 500 m.
- Namen: Inseln und Orte durchgehend el/en, de lückenhaft (Wikidata hat für kleine Orte selten Deutsch).
- Landesteil-Zuordnung: alle Objekte der Probekachel in `GR-I`.

## Lauf

| Lauf | Ergebnis |
| --- | --- |
| `01a15c42…` | abgebrochen: Postgres-Absturz im OSM-Import (B5) |
| `01a15c56…` | `gazetteer.hierarchy` > 1:48 h (B7); Fix, dann vom Admin beendet (lief später doch zu Ende) |
| `01a15d09…` (nach Merge PR 12 und Fixes B5, B7) | **beendet in 16 min**: Kacheln 2 min, OSM 4 min (2 Relationen über 250.000 Punkte übersprungen: Ägäis, Balkan), Wikidata, GeoNames je < 1 min, Hierarchie 10 min |

## Automatische Prüfung

`npm run check:gazetteer -- --subdivision GR-I` (Exit 1):

- Kacheln mit Küste: **56** (Erwartung 35–50: etwas mehr, Laufumfang schließt Grenzkacheln ein).
- „open candidate tasks“: **1.542** – das sind keine Ortskandidaten, sondern unsichere **Paare** der Zusammenführung (`subject_type = geo_object_pair`, Bezeichnung im Skript irreführend). Davon 1.218 Paare Wikidata-POI ~ Wikidata-POI, fast alle denkmalgeschützte Gebäude im Zentrum Athens mit Adressen als Namen („Makri 1-3“ ~ „Makri 3“), siehe B8.
- Objekte ohne de/en/el-Namen: **443** (269 Orte, 126 Buchten, 48 Inseln) im ganzen Landesteil.

## Sichtprüfung (Probekachel `q025:813:510`)

Zählung über `tile_geo_objects`: 285 POIs, 51 Orte, 30 Buchten, 27 Kaps, 11 Inseln, 6 Eilande, 8 Häfen, 5 Engen, 3 Küstenabschnitte, 1 Golf.

| Prüfung | Ergebnis |
| --- | --- |
| Zählung gegen Erwartung | Inseln 17 (Erwartung 15–30) ✓, Orte 51 (10–25) ↑ mehr Weiler als erwartet, Häfen 8 (8–15) ✓ knapp, Buchten 30 (20–40) ✓ |
| Landesteil-Zuordnung | alle 424 Objekte mit Schwerpunkt in der Kachel in `GR-I` ✓ (auch Methana, Galatas, Festland Troizinia) |
| Namen (Inseln, Eilande, Orte) | de/en/el fast vollständig (Orte 50/50/51) ✓ |
| Namen (Buchten, Häfen) | Buchten de 27, en 27, el 19 von 30; Häfen de 4, en 4, el 5 von 8 – Häfen ohne Namen (OSM-Hafenflächen) |
| Navily-Häfen (17) | 7 mit Gazetteer-Hafen in 300 m, 9 mit Hafen oder Ort; es fehlt u. a. der Hafen von Ägina-Stadt als Hafen-Objekt (nur Marina-Fläche „Λιμένας Σκαφών Αναψυχής“ 1,3 km entfernt); Methana: GeoNames-Hafen 524 m vom Kai |
| Navily-Ankerplätze (89) | 23 mit benannter Bucht in 500 m, 35 mit Bucht, Hafen oder Ort in 500 m, 57 in 1 km – erwartet (viele Navily-Plätze sind unbenannte Strandabschnitte; die Geometrie-Stufe findet unbenannte Buchten) |
| Eltern (20 Stichproben) | Orte, Kaps, Häfen auf Inseln → Insel ✓; Methana-Objekte → Küstenabschnitt Methana ✓; **Buchten im Wasser vor Poros (Poros Bay, Ormos Monastiriou) → Attika statt Insel Kalaureia**, Eilande (Aponisos, Metopi) → Attika statt Inselgruppe – siehe B10 |
| Zusammenführung | Dubletten nicht zusammengeführt und ohne Paar-Aufgabe: Ligea Bay (OSM) / Liyea Bay (Wikidata) 1.057 m, Ormos Valariou (GeoNames) / Valariou Bay (Wikidata) 731 m, Ormos Taktikoupoleos / Taktikoupoleos Bay 1.045 m; Mouriotis / Mouriotou mit Aufgabe ✓ – siehe B9 |
| Klassifikation | Wikidata-Häfen als Bucht: „Methana Port“, „Agistri Port“, „Aegina Port“ (`bay`) neben dem gleichnamigen Hafen-Objekt – siehe B9 |

## Befunde

B5, B7 (behoben), B6, B8, B9, B10 (offen) – siehe `befunde.md`.

## Kosten

0 €.

## Tor

**Nicht bestanden, Entscheidung Christian nötig:** keine systematischen Fehler in Typ oder Landesteil-Zuordnung, aber (1) die Paar-Flut aus Athener POIs (B8) macht das Review des Landesteils unpraktikabel, (2) Wikidata-Häfen als Buchten und nicht erkannte Dubletten erzeugen doppelte Ortskandidaten (B9), (3) Buchten im Wasser hängen am Landesteil statt an der Insel (B10). Für die Probekachel ist P2/P3 trotzdem aussagekräftig; deshalb habe ich weitergemacht.

## Zweiter Durchgang (21.10.2026, nach Plan 16)

Lauf `01a15e2c…` (nach Fix B16), 31 min. `check:gazetteer`: 56 Küstenkacheln, **191** offene Paar-Aufgaben (vorher 1.542 – keine POI-Paare mehr, Plan 16), 442 Objekte ohne de/en/el-Namen. POI-Kandidaten bleiben 20.178 (OSM) und 2.062 (Wikidata): das Zentrum Athens liegt in 20 km zum Meer; die Begrenzung geschieht in der Auswahl je Ort, nicht im Gazetteer. Probekachel: Zählung, Landesteil-Zuordnung, Namensabdeckung und Navily-Abgleich identisch mit dem ersten Durchgang (Befunde B9, B10 bestehen weiter).

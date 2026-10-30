# T1 – Raumgliederung und Gerüst GR-I (Attika 2)

## Step 1: Erwartung (aus N7, Dev-Datenbank)

| Größe | Erwartung |
| --- | --- |
| „Landesteile neu bilden“ | 24 Länder, etwa 2,5 h (fast nur Overpass-Wartezeit), Spitzenspeicher 0,6 GB, ~110 aktive + 2 ausgeschlossene Landesteile |
| Gazetteer GR-I | ~2.300 Objekte (N7: 2.317), `gazetteer.hierarchy` ~1,4 min, Spitzenspeicher ~0,7 GB, `skippedLarge` 0 |
| Dinge an Land GR-I | ~5.600 OSM- + ~50 Wikidata-POIs, ~37 min (läuft in T2 nach `seed.tile`) |
| Kandidaten GR-I | ~186 (N7), davon 30 Marinas in Piräus/Flisvos/Glyfada |
| Gerüst gegen Referenz | Buchten, Häfen, Marinas: N7 verlor gegen die Dev-DB keinen OSM-/GeoNames-Hafen und keine OSM-Bucht |

## Step 2: Lauf

**Voraussetzung, nicht im Plan:** Produktion hatte nach N6 keine Landpolygone; „Landesteile neu bilden“ startete nicht
(„Landpolygone fehlen“). Christian hat sie per SSH importiert (Befund B26): 26.390 Polygone, Version 2026-10-26. Dabei
wurde Postgres kurz mit einem alten Image neu erstellt und auf `4a005d0` zurückgesetzt; Daten unberührt, Worker ohne
Unterbrechung.

Speicher (`docker stats`) gibt der MCP nicht her; belegt werden Dauer und Freiheit von OOM über `runs`/`worker`.

| Lauf | Start | Ende | Dauer | Ergebnis |
| --- | --- | --- | --- | --- |
| „Landesteile neu bilden“ `01a17866…` | 14:28 | 20:57 | **6:29 h** (Erwartung 2,5 h) | 24/24 Länder, 0 Fehler; 111 aktive + 3 ausgeschlossene Landesteile (LY, PS, SY); GR 13 Landesteile |
| „Aufbauen“ GR-I `01a179cc…` | 20:59 | 27.10. 10:51 | 13:52 h | alle 12 Stufen fertig; 2 Fehler (B18, B27) nach Deploy per `job_retry` nachgeholt; Einzelheiten T2 |

Dauer je Land in `gazetteer.coarse` (ab Speichern der Grenzen): ES 6 min, FR 19, MC 17, IT 65, MT 3, SI 7, HR 32,
BA 6, ME 5, AL 107, GR 42, TR 5, die übrigen 11 Länder je 2–7 min. Fast nur Overpass-Wartezeit: am Nachmittag war die
öffentliche Instanz überlastet (Monaco 17 min, Albanien 1:47 h), ab etwa 19:40 lief jedes Land in Minuten. Kein Job
gescheitert, kein Neustart des Workers (Heartbeat seit 10:41 durchgehend).

Ruling: Der Plan startet `datasets_start`, `seed_start`, `geometry_start` in T2 einzeln. `subdivision_build` enthält
diese Stufen bereits (`SUBDIVISION_BUILD_STAGES`: Gazetteer, Datensätze, Seed, Orts-Websites, Geometrie, Dinge an
Land, Revier-Import); getrennte Starts entfallen. Einzige Kosten: Website-Prüfung der Orte (Haiku, Cent-Bereich).

## Step 3: Polygon von GR-I

| Ort | im Landanteil GR-I | Abstand Land GR-I | Land gehört zu |
| --- | --- | --- | --- |
| Methana | ja | 0 m | GR-I |
| Poros | ja | 0 m | GR-I |
| Kythira (Kapsali) | Küstenpunkt | 68 m | GR-I |
| Lavrio | Küstenpunkt | 55 m | GR-I |
| Rafina | Küstenpunkt | 25 m | GR-I |
| Epidavros | nein | 5,9 km | GR-J |
| Korinth | nein | 16,5 km | GR-J |
| Ermioni | nein | 5,8 km | GR-J |

Das Gesamtpolygon (`geom`) enthält auch Epidavros, Korinth und Ermioni, weil die Landesteile auf See überlappen; an Land
(`land_geom`) gehören sie zu GR-J. Wie erwartet.

Navily (nur Zählung): 751 Spots im Polygon von GR-I, gleich der Vormessung gegen die Dev-DB. **Tor T0 (Referenz deckt
GR-I ab): ja.** Kacheln GR-I (nach `tiles.ensure`): 34, davon 25 Küstenkacheln, 22 mit mindestens einem Spot. 430 Spots in Kacheln
von GR-I (alle in Küstenkacheln): `mooring` 334, `port` 96; `anchor` 325, `aflot` 34, `jetty` 28, `public_quay` 24,
`dry-berthing` 10, `prohibited` 6, `buoy` 3. Alles gleich der Vormessung (430, 6/10, 22 von 25). Nenner der Abdeckung
ohne `prohibited` und `dry-berthing`: 414.

## Gerüst GR-I (Gazetteer, `01a179cc…` bis `gazetteer.hierarchy`, 21:01–21:11)

Gazetteer-Stufen zusammen 10 min (OSM 2 min, Wikidata + GeoNames 2 min, Hierarchie 4 min), kein Fehler.

| Art | Objekte |
| --- | ---: |
| Orte (`settlement`) | 843 |
| Kaps | 163 |
| Buchten | 137 |
| Eilande / Inseln | 97 / 91 |
| Häfen | 52 |
| Meerengen | 16 |
| Archipele | 11 |
| Golf, Küstenabschnitt | 1 / 1 |
| **gesamt** | **1.412** |

MCP `checks` (Teil `gazetteer`): 56 Küstenkacheln im Kachelrahmen (mit Nachbarn), 0 offene Kandidaten-Aufgaben; 339
Objekte ohne Namen in einer der Sprachen de/en/el (246 Orte, 56 Buchten, 37 Inseln; meist fehlt `de`). Kein Torbruch:
die Suche nutzt vorhandene Namen, ein fehlender deutscher Name verliert höchstens die deutschen Suchvorlagen.

## Step 4: Gerüst gegen Referenz (Navily, nur Zählungen)

Je Spot im Polygon von GR-I (751): Gazetteer-Objekt passender Art ≤ 300 m (Ankerplatz-Typen → Bucht, übrige → Hafen;
Abstand zur Geometrie, Punkt oder Fläche). Gemessen nach der Buchtsuche, daher getrennt nach Gerüst (OSM, Wikidata,
GeoNames) und berechneten Buchten.

| Spots | Bucht erwartet | Hafen erwartet |
| --- | ---: | ---: |
| Gerüst-Objekt passender Art ≤ 300 m | 89 | 28 |
| erst berechnete Bucht ≤ 300 m | 175 | – |
| nur Objekt anderer Art ≤ 300 m | 32 | 19 |
| kein Objekt ≤ 300 m | 358 | 50 |

Gründe (aus T2 Step 3, B28): Buchten sind fast alle Punkte (1.208 von 1.232), ein ufernaher Spot liegt am Rand oft
weiter als 300 m vom Buchtpunkt; vor allem aber liegen viele Spots an offener Küste, oft vor Stränden, wo das Gerüst
keine Bucht kennt. Kein Fehler im Gerüst gefunden (OSM-Buchten und -Häfen vollständig übernommen, kein Absturz einer
Stufe); die Lücke ist eine Frage der Kandidatenquellen.

## Step 5: Tor T1

- Kein OOM, kein Neustart des Workers: ja (Heartbeat durchgehend, kein Job mit Speicherfehler).
- Keine Stufe > 15 min: **nein, mit Begründung.** `gazetteer.coarse` je Land bis 1:47 h (Overpass-Überlast am
  Nachmittag, nicht Rechenzeit); `geometry.detect_bays` 56 Kacheln über ~12 h bei Concurrency 1, je Kachel bis ~15 min;
  `gazetteer.land` ~40 min in einem Job wie in N7. Keine einzelne Rechnung hing; alles Wartezeit oder Menge.
- Systematische Gerüst-Lücke geklärt: **als Befund B28 benannt**, Entscheidung über das Nachschärfen bei Christian.

Tor T1 bestanden mit B28 als offenem Befund für T2.

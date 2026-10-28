# Pilot: Revier-Suche und Verortung aus Berichten (Attika 2)

Stand: 28.10.2026. Anlass: Testlauf Attika 2, T3 (Hauptlauf 0,8 % Abdeckung, 14 bestätigt, 5 korrekt) und die
Einschätzung vom 28.10. abends. Entscheidung Christian (28.10.): Pilot entwerfen.

Ein **Messpilot, kein Umbau**. Er beantwortet in zwei Tagen und für höchstens ~40 € die Fragen, die drei Volläufe
(~90 €) nicht beantwortet haben, bevor an der Pipeline weitergebaut wird. Code entsteht nur als Lab-Skript
(Wegwerf-Charakter); nichts davon läuft auf Produktion, nichts ändert Daten.

## 1. Befund, der den Pilot begründet

| Größe | Wert | Quelle |
| --- | ---: | --- |
| Kandidaten gesucht → bestätigt → korrekt (Hauptlauf) | 764 → 14 → 5 | `tor.md`, T3 |
| Obergrenze der Abdeckung durch das Gerüst (Kandidat ≤ 150 m / ≤ 300 m) | 25 % / 46 % | T2 Step 3 |
| Fehlliste N=2: kein Kandidat / zu wenige Quellen | 486 / 98 von 637 | `tor.md` |
| bewertete Seiten, davon erste Hand | 6.009, 388 (6 %) | T3 |
| Liegeplatz-Nennungen auf Revierführer-/Berichts-/Forumsseiten (`page_assessments.berths`) | 2.407 Ankerplätze, 1.825 verschiedene Namen, 647 Seiten | DB 28.10. |
| Routen-Stopps aus Törnberichten / davon einem Platz zugeordnet | 1.013 / 74 (7 %) | `research_route_stops` 28.10. |
| neue Kandidaten aus `research.discover` (beide Rauchproben) | 0 | T3 |
| Koordinaten je Nennung | werden nicht extrahiert (`berths` hat nur `name`, `island`, `kind`) | Schema |

Lesart: Das Web nennt viele Ankerplätze; verloren geht es bei „Nennung → konkreter Platz“. Die Pipeline ist
kandidatenzentriert (Geometrie schlägt vor, Suche je Name, Seite wird dem Kandidaten zugeordnet). Die Referenz und
die Quellen sind ortszentriert (ein Spot, eine Buchtbeschreibung). Ob der umgekehrte Weg „Quelle → Ort → Kandidat“
trägt, ist bisher nie gemessen worden.

## 2. Fragen, die der Pilot beantwortet

1. **Obergrenze des Webs.** Wie viele Referenz-Spots in GR-I werden im Web überhaupt als Ankerplatz beschrieben:
   mindestens einmal, mindestens zweimal unabhängig? (Wenn diese Zahl niedrig ist, hilft keine Suchoptimierung mehr;
   dann fehlt eine Quellenklasse.)
2. **Verortbarkeit.** Wie genau lässt sich eine Beschreibung einem Ort zuordnen: über wörtliche Koordinaten, über
   Name + Insel gegen das Gazetteer, über Lagebeschreibung? Welcher Anteil bleibt unverortbar? Wie weit liegen
   wörtliche Koordinaten vom Referenz-Spot (Genauigkeit)?
3. **Suchweg.** Liefern Revier-Anfragen („Ankerplätze Poros“) die tragenden Seiten, und was bringt Claude mit
   Websuche (agentisch) gegenüber DataForSEO bei denselben Anfragen: mehr tragende Seiten, weniger Rauschen, zu
   welchen Kosten?
4. **Konfliktquote.** Wie viele verortete Web-Ankerplätze kennt die Referenz nicht (≤ 300 m kein Spot)? Das ist
   die Last für die Konfliktentscheidung nach Spec Neuausrichtung 6.

## 3. Ziele, Nicht-Ziele, Anti-Ziele

**Ziele:** Zahlen zu 1–4 für GR-I, reproduzierbar aus Scratchpad-Dateien, als Protokoll
`docs/pilot/neuausrichtung/attika-2/P1-revier-suche.md` (nur Zählungen und Quoten), mit einer Empfehlung für T8.

**Nicht-Ziele:** keine Änderung an Pipeline, Prompts in `config/prompts` oder Konfiguration; keine Fakten, keine
Bestätigungen, keine Lieferung; keine Bewertung der Kernwerte (Schutz, Grund); kein Produktionslauf.

**Anti-Ziele (würden den Pilot entwerten):**

- **Navily als Eingabe.** Kein Navily-Name, keine Navily-Koordinate in einer Suchanfrage, einem Prompt oder einer
  Verortung. Navily wird ausschließlich im letzten Schritt (Abgleich) gelesen, lokal, nur gezählt. Sonst misst der
  Pilot sich selbst.
- **Modellwissen als Beleg.** Eine Koordinate oder ein Ankerplatz zählt nur, wenn die Seite ihn wörtlich nennt
  (Zitat, per Regex gegen den Seitentext geprüft). Das Modell „weiß“, wo Poros liegt; das darf keine Nennung erzeugen.
- **Unfaire Engine-Messung.** Beide Suchwege liefern nur URL-Listen; Abruf, Bewertung, Extraktion und Verortung
  laufen für beide identisch.

## 4. Umfang

- **Gebiet:** Landesteil `GR-I`. Nenner: die Spots in den Kacheln von GR-I ohne `prohibited`/`dry-berthing`
  (T2: 414) und zum Vergleich die 637 Spots der bearbeiteten Tor-Kacheln aus `tor.md`; beide Zahlen werden berichtet
  (Abschnitt 6).
- **Gebiets-Liste für die Anfragen** (Annahme, aus dem Gazetteer GR-I, nicht aus Navily): Saronischer Golf, Ägina,
  Agistri, Salamis, Poros, Hydra, Dokos, Spetses, Methana, Epidavros-Küste (soweit GR-I), Attika-Westküste
  (Vouliagmeni–Sounion), Attika-Ostküste (Lavrio–Rafina–Marathon), Kythira. Die Liste wird aus
  `geo_objects` (Inseln, Golf, Archipel, Küstenabschnitt) gezogen und nur von Hand um Küstenabschnitte ergänzt.
- **Sprachen:** en, de, el (Annahme: it/fr tragen bei Revier-Anfragen wenig; ein Stichproben-Paar prüft das).
- **Kostenrahmen:** Erwartung ~25 €, Obergrenze 40 € (Abschnitt 9). Lokale Schlüssel (`.env.local`), lokale
  Dev-Datenbank für die Kostenbuchung des KI-Clients; Produktion wird nur lesend (MCP `sql`) für das Gazetteer benutzt.

## 5. Ablauf

Alle Zwischenstände als JSON/JSONL im Scratchpad (`<scratchpad>/pilot-revier/`), jeder Schritt einzeln startbar und
wiederholbar (Stufen-Cache: eine URL wird einmal geholt, einmal bewertet, einmal extrahiert).

### A. Revier-Anfragen, zwei Suchwege

Vorlagen (Annahme, je Gebiet; `{area}` englischer, deutscher bzw. griechischer Gazetteer-Name):

| Sprache | Vorlagen |
| --- | --- |
| en | `{area} anchorages`, `{area} best anchorages sailing`, `{area} cruising guide anchorages`, `{area} sailing trip report anchored` |
| de | `{area} Ankerplätze`, `{area} Ankerbuchten Törnbericht` |
| el | `{area} αγκυροβόλια`, `{area} αγκυροβόλια ιστιοπλοΐα` |

Etwa 13 Gebiete × 8 Vorlagen ≈ 100 Anfragen.

- **Weg D (DataForSEO):** vorhandener Adapter `searchOrganic` (`lib/adapters/dataforseo.ts`), 40 Treffer je Anfrage,
  Länder-/Sprachcodes aus `config/research.json` (`locationCodes`). Ergebnis: URL, Rang, Anfrage.
- **Weg C (Claude mit Websuche):** je Gebiet **eine** agentische Anfrage an `claude-sonnet-5-5` (Annahme: das
  Modell der Pipeline, Vergleichbarkeit; `claude-opus-5-5` als Variante für drei Gebiete, falls Sonnet dünn liefert)
  mit dem Server-Werkzeug `web_search_20260209`, `max_uses` 12, `blocked_domains` = `skipDomains` aus
  `config/research.json` (enthält `navily.com`). Auftrag: „Finde Seiten, die Ankerplätze in {area} beschreiben
  (Revierführer, Törnberichte, Foren); gib nur URLs mit einem Satz Begründung, keine Inhalte.“ Die Suchanfragen,
  die das Modell stellt, werden mitgeschrieben (sie sind Teil des Ergebnisses: *welche* Anfragen findet es?).
  Ergebnis: URL, Gebiet, Begründung, gestellte Suchanfragen, Tokens, Kosten.
- Ergebnis von A: eine URL-Tabelle mit Herkunft `D`, `C` oder beides; `skipDomains` auf beide angewandt.

### B. Abruf und Seitenbewertung (wie die Pipeline)

- Abruf mit den vorhandenen Konvertern (`lib/adapters/fetch`, `createConverters`; lokal ohne Browser-Rendering,
  Annahme: `local` und PDF reichen, Jina/Firecrawl nur bei Fehlschlag). Markdown ins Scratchpad.
- Bewertung mit dem vorhandenen Task `assess-page` (Prompt v1, gleiche Felder wie in T3: `page_kind`, `first_hand`,
  `berths`), damit die Quoten mit dem Hauptlauf vergleichbar sind. Über den KI-Client des Repos
  (`createAnthropicClient`), der Kosten in die lokale DB bucht.
- Zählende Seiten für C–E: `page_kind` in `countingPageKinds` (`trip_report`, `pilot_guide`, `forum`, `marina`,
  `authority`), wie `config/research.json`.

### C. Extraktion mit Verortung (neuer Pilot-Prompt)

Je zählender Seite eine Extraktion (Sonnet, Prompt im Scratchpad bzw. als Lab-Datei, nicht in `config/prompts`):
alle Ankerplätze/Bojenfelder/Häfen, die die Seite als Liegeplatz beschreibt, je Nennung

| Feld | Regel |
| --- | --- |
| `name`, `aliases` | wie auf der Seite; Transliterationen und Genitivformen als Alias |
| `area` | Insel, Golf oder Küstenabschnitt, wenn die Seite ihn nennt |
| `kind` | anchorage, mooring_field, port, marina, unknown |
| `coordinates` | nur wörtlich von der Seite, mit `quote`; jede Schreibweise (Grad/Minuten, Dezimal) |
| `position_description` | Zitat, das die Lage beschreibt („NW-Ecke der Bucht“, „vor dem Strand“, „östlich von Kap X“) |
| `berth_quote` | Zitat, das belegt, dass die Seite den Ort als Liegeplatz beschreibt (nicht als Badestrand) |

Jedes Zitat wird per Teilstring-Suche gegen das Markdown geprüft; Nennungen ohne gültiges `berth_quote` werden
verworfen, Koordinaten ohne gültiges Zitat gelöscht. Parallel läuft ein modellfreier Regex-Pass über alle
Markdown-Dateien (Koordinatenmuster), als Kontrolle, dass das Modell keine Koordinaten übersieht oder erfindet.

### D. Verortung (lokal, ohne Navily)

Reihenfolge je Nennung; der erste Weg, der trifft, entscheidet, der Weg wird mitgeführt:

1. **Koordinate** (wörtlich) → Punkt; Genauigkeit aus der Schreibweise abgeleitet (ganze Minute ≈ ±900 m).
2. **Name + Gebiet gegen das Gazetteer GR-I**: `geo_objects` (Buchten, Häfen, Strände, Kaps, Orte, Inseln, mit
   Namen in el/en/de), geholt über MCP `sql` (500 Zeilen je Aufruf, daher seitenweise), Abgleich mit dem vorhandenen
   Namensabgleich `berthNameForms`/`berthNameMatches` (`lib/domain/research/assign.ts`, Affixe aus
   `config/name-affixes.json`; nach dem Merge von `main` der Wortstamm-Abgleich aus PR #47), Gebiet als Filter
   (Insel/Umkreis). Treffer → Punkt des Objekts. Mehrdeutig (zwei Objekte gleichen Namens in GR-I) → unverortet,
   Grund „mehrdeutig“.
3. **Lagebeschreibung** wird im Pilot nicht in einen Punkt umgesetzt, nur gezählt (wie oft gäbe es eine, wenn 1 und 2
   fehlen); das zeigt, was ein späterer Verortungsschritt gewinnen könnte.
4. **Modellgestützte Verortung** (erlaubt, Abschnitt 10): Das Modell bekommt die Nennung und die Gazetteer-Objekte
   des Gebiets als Liste und wählt eines oder „unbekannt“. Sie läuft als getrennte Spalte, damit ihr Anteil und ihre
   Fehlerquote (Abstand zum Referenz-Spot in Schritt E) sichtbar bleiben; die bindende Kennzahl der
   Entscheidungsregel wird einmal ohne und einmal mit dieser Spalte berichtet.

Danach werden Nennungen zu **Web-Orten** geclustert (≤ 300 m, Annahme) und je Web-Ort die **unabhängigen Quellen**
gezählt: verschiedene registrierbare Domain und keine Kopie (Annahme: ≥ 12 gemeinsame Wörter in Folge wie
`copyMinSharedWords`, geprüft zwischen den Zitaten und den umgebenden 600 Wörtern).

**Was als Quelle zählt** (Festlegung nach dem Bauer-Check): bindend ist die pipelinenahe Regel aus
`lib/domain/research/confirmation.ts`: eine Seite zählt, wenn sie `first_hand` ist (eigene Erfahrung: Törnbericht,
Forum) oder ein `pilot_guide`, der den Ort als Liegeplatz führt. Als zweite, nicht bindende Spalte wird „jede
zählende Seite nach `page_kind`“ ausgewiesen, damit sichtbar bleibt, wie viel die Regel kostet.

### E. Abgleich gegen die Referenz (lokal, nur Zählungen)

Navily wird erst hier gelesen (`loadNavilySpots`, `NAVILY_SPOTS_PATH`). Ausgabe nur als Zählungen und Quoten:

| Kennzahl | Nenner |
| --- | --- |
| Spots mit ≥ 1 Web-Ort ≤ 150 m / ≤ 300 m / ≤ 600 m | Kacheln GR-I (414) und Tor-Kacheln (637) |
| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (die Bestätigungsregel) | dito |
| dasselbe auf **Buchtebene**: Spots ≤ 300 m zueinander als ein Liegeplatz gezählt | Zahl der Cluster |
| Beitrag je Suchweg: Spots nur über D, nur über C, über beide gedeckt | gedeckte Spots |
| Verortungsweg je gedecktem Spot (Koordinate / Gazetteer / Modell) | gedeckte Spots |
| Nennungen mit wörtlicher Koordinate: Anteil, Median-Abstand zum nächsten Spot, Anteil ≤ 150 m | Nennungen |
| Web-Orte ohne Spot ≤ 300 m (Konfliktlast) | Web-Orte |
| unverortete Nennungen nach Grund (kein Name, mehrdeutig, kein Gazetteer-Objekt) | Nennungen |
| Kosten je Suchweg, je Seite, je gedecktem Spot | – |

Einzellisten (welcher Spot, welche URL) bleiben im Scratchpad. Ins Repo geht `P1-revier-suche.md` mit den Tabellen
oben, dem Vorgehen und den Kosten; URLs und Domains der tragenden Seiten dürfen hinein (sie sind unsere Quellen, nicht
Navily), Navily-Werte nicht.

## 6. Entscheidungsregel (vorab)

Damit der Pilot nicht im Nachhinein gedeutet wird, steht fest, was aus welchem Ergebnis folgt (Schwellen: Annahme,
Entscheidung Christian in Abschnitt 10). Maßgeblich ist die Buchtebene mit ≥ 2 unabhängigen Quellen ≤ 300 m nach der
pipelinenahen Quellenregel (5D). **Bindender Nenner** (Festlegung nach dem Bauer-Check, korrigiert beim Planen): die
Bucht-Cluster aller Spots in den **Kacheln von GR-I** (`gate_input.tiles.all`, 34 Kacheln, wie T2: 414 Spots ohne
`prohibited`/`dry-berthing`), weil das der Suchumfang ist. Nicht das Polygon: es überlappt auf See mit GR-J und
zählt 751 Spots, darunter Epidavros und Ermioni, die zu GR-J gehören. Die 637 Spots der bearbeiteten Tor-Kacheln
(`tiles.worked` + Puffer) werden zum Vergleich mit T3 daneben berichtet (lokal reproduzierbar über `gate_input` und
`tileIdFor`, ohne dass Navily-Werte den Rechner verlassen).

| Ergebnis | Folge |
| --- | --- |
| ≥ 40 % der Bucht-Cluster | Quelle-zuerst als Pipeline-Stufe vor den Kandidaten bauen (Berichte legen Kandidaten an und verorten sie, Geometrie prüft Ankerwasser); Tor auf Buchtebene mit 300 m neu fassen (T8) |
| 20–40 % | bauen, aber das Abdeckungsziel gegen den neuen Nenner neu verhandeln; prüfen, welche Quellenklasse die Lücke schließt |
| < 20 % | Das Web als alleinige Quellenklasse reicht nicht für das Ziel; andere Klassen prüfen (lizenzierte Revierführer, Positionsdaten), bevor weiter an Suche und Gerüst gearbeitet wird |

Unabhängig davon: Zeigt der Vergleich D/C, dass ein Weg ≥ 80 % der tragenden Seiten des anderen enthält, bleibt es
bei einem Weg (dem billigeren). **Tragende Seite** (Festlegung nach dem Bauer-Check): eine zählende Seite mit
mindestens einer in GR-I verorteten Liegeplatz-Nennung; Navily geht in diese Definition nicht ein. Zeigt die Koordinaten-Messung einen Median-Abstand > 300 m, sind Koordinaten nur
zur Verortung auf Buchtebene brauchbar, nicht für die Ankerposition.

## 7. Was entsteht, und wo

| Artefakt | Ort | Bleibt? |
| --- | --- | --- |
| Lab-Skript `scripts/lab-region-search.ts` (Unterbefehle `search`, `fetch`, `assess`, `extract`, `locate`, `compare`) | Zweig `pruefung/attika-2` | ja, als Lab-Skript gekennzeichnet (Vorbild: das noch unversionierte `scripts/lab-image-framing.ts` im Haupt-Checkout); kein Produktionscode, keine Tests gegen das Netz |
| Pilot-Prompt Extraktion/Verortung | neben dem Skript (`scripts/lab/…`) | ja |
| Zwischenstände, Einzellisten, Markdown der Seiten | Scratchpad | nein |
| Protokoll `P1-revier-suche.md` | `docs/pilot/neuausrichtung/attika-2/` | ja |
| Zeile(n) in `befunde.md` | `docs/pilot/pruefung/` | ja (nächste Nummer nach B35) |

Grundsätze des Repos, die auch für das Lab-Skript gelten: Zitate wörtlich; Navily nie in Commits, Logs oder
MCP-Argumenten; `skipDomains` beachten (der Platzhalter `tripadvisor.*` muss für `blocked_domains` in konkrete
Domains aufgelöst werden); `robots.txt` über die vorhandene Crawl-Logik. Externe Dienste über die vorhandenen
Adapter, **soweit sie das Nötige können**: Der KI-Client des Repos (`createAnthropicClient`) kennt weder
Server-Werkzeuge (`web_search_…`) noch Prompts außerhalb `config/prompts`; damit laufen nur `assess-page` über ihn.
Für Weg C, die Pilot-Extraktion (5C) und die modellgestützte Verortung (D4) gibt es zwei Wege, Entscheidung in
Abschnitt 10:

- (a) direkter Aufruf des Anthropic-SDK im Lab-Skript mit eigener Kostensumme aus `usage` (kein Produktionscode,
  keine Buchung in `external_calls`);
- (b) kleine Erweiterung des Clients um ein zweites Prompt-Verzeichnis und Server-Werkzeuge, mit Tests, auf dem
  Prüfzweig (Produktionscode, bleibt nach dem Pilot).

## 8. Was dem Bauer überlassen bleibt

- Aufteilung des Skripts, Dateiformate im Scratchpad, Parallelität und Wiederholung bei HTTP 429.
- Die genaue Formulierung des Claude-Suchauftrags und des Extraktionsprompts (Regeln aus Abschnitt 5C sind bindend).
- Welche Gazetteer-Arten in die Verortung eingehen und wie der Gebietsfilter gezogen wird (Insel-Polygon oder Umkreis).
- Koordinaten-Regex (Grad/Minuten/Sekunden, Dezimal, griechische Schreibweisen).
- Ob die Gazetteer-Seite per MCP `sql` (seitenweise) oder aus der lokalen Dev-DB kommt, falls dort GR-I nach N7 noch
  steht (dann Stand prüfen).

## 9. Kosten (Annahmen)

| Posten | Menge | Kosten |
| --- | ---: | ---: |
| DataForSEO, ~100 Anfragen | 100 | ~0,3 € |
| Claude Websuche: 13 Gebiete × ≤ 12 Suchen, Sonnet 5.5, je Gebiet ~100k Eingabe-Tokens | ~150 Suchen | ~5 € (Suchpreis je Aufruf plus Tokens; Preis vor dem Start am Modellpreis-Blatt prüfen) |
| Abruf lokal | ~1.500 URLs | 0 € (Jina/Firecrawl nur bei Fehlschlag, < 1 €) |
| Bewertung `assess-page`, ~1.200 Seiten × ~0,007 € | 1.200 | ~8 € |
| Extraktion, ~400 zählende Seiten × ~0,02 € | 400 | ~8 € |
| modellgestützte Verortung (falls erlaubt) | ~300 Nennungen | ~1 € |
| **Summe** | | **~22 €**, Obergrenze **40 €** |

Die Kosten laufen über lokale Schlüssel, nicht über die Tagesbudgets der Produktion; das Skript führt eine eigene
Summe und bricht bei 40 € ab.

## 10. Entscheidungen Christian (28.10.2026)

1. **Kostenrahmen:** Obergrenze 40 € (Erwartung ~22 €); das Skript bricht bei 40 € ab.
2. **Modellgestützte Verortung** (Weg D4): erlaubt, als getrennt ausgewiesene Spalte mit eigener Fehlerquote.
3. **Schwellen der Entscheidungsregel:** 40 % / 20 % auf Buchtebene, ≥ 2 unabhängige Quellen ≤ 300 m nach der
   pipelinenahen Quellenregel (Abschnitt 6 gilt wie geschrieben).
4. **KI-Aufrufe außerhalb des Repo-Clients:** Weg (a), direkter SDK-Aufruf im Lab-Skript mit eigener Kostensumme;
   der Repo-Client bleibt unverändert, nur `assess-page` läuft über ihn.

## 12. Festlegungen nach dem Bauer-Check (meine Entscheidungen, zum Gegenlesen)

- Quellenregel für „≥ 2 unabhängige Quellen“: pipelinenah (`first_hand` oder `pilot_guide`), zweite Spalte „alle
  zählenden Seiten“ nur zur Information (5D).
- Bindender Nenner der Entscheidungsregel: Bucht-Cluster der Spots in den Kacheln von GR-I (414); Tor-Kacheln (637)
  zum Vergleich (6).
- „Tragende Seite“ für den Vergleich D/C: zählende Seite mit ≥ 1 in GR-I verorteter Nennung, ohne Navily (6).
- Namensabgleich im Pilot: `berthNameMatches` aus `assign.ts`, nicht ein eigener (5D).

## 11. Zeitplan

Tag 1: Skript, Schritte A und B (Suche beider Wege, Abruf, Bewertung; Bewertung läuft über Nacht, falls die
Batch-API wieder Stunden braucht). Tag 2: C–E, Protokoll, Empfehlung für T8.

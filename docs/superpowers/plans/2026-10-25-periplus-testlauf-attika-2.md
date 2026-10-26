# Periplus – Testlauf Attika 2 (Navily-Abgleich nach der Neuausrichtung) – Prüfplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Betriebsschritte, kein Feature-Code). Code-Befunde, die während des Laufs auftauchen, werden je Befund mit superpowers:systematic-debugging + superpowers:test-driven-development auf einem eigenen Fix-Branch behoben. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den vollständigen neuen Ablauf (Gerüst → Kandidaten → Recherche → Bestätigung → Stand → Landseite → Ortsbild → Paket 4.0) einmal über den ganzen Landesteil `GR-I` (Attika) laufen lassen und die bestätigten Liegeplätze gegen die aktualisierte Navily-Referenz prüfen. Ergebnis ist die Tor-Entscheidung aus Abschnitt 6 der Neuausrichtung: Erfassung für Griechenland freigeben (`gate.released = true`, Schwelle N gewählt) oder Befunde mit Nachschärf-Plan.

**Architecture:** Ein Betriebsplan, kein Feature-Plan. Er ersetzt für den neuen Ablauf den alten Prüfplan (Teil-Spec 12, P0–P9), übernimmt dessen Grundregeln (Erwartung vor dem Lauf, Stufe für Stufe, Befund → Ursache → Behebung → Wiederholung) und streicht die Stufen, die es nicht mehr gibt (Quellenfreigabe, Crawl, Erwähnungen, Profile, Zeitachse). Gemessen wird mit den vorhandenen Werkzeugen (`research:gate`, `check:gazetteer`, `check:geometry`, `delivery:consume`, Admin-Oberfläche) und mit SQL, das im Protokoll steht.

**Tech Stack:** Produktion (Hetzner, `dc` = docker compose auf `app-server`) bzw. lokal; PostgreSQL/PostGIS; pg-boss-Worker; DataForSEO, Anthropic, OpenAI (Ortsbilder).

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (Abschnitte 5, 6, 9). Hintergrund: Teil-Spec 12 (`…-12-pruefung-echtdaten-design.md`, alter Prüfplan), `docs/pilot/neuausrichtung/n3-tor.md`, `n3-befunde.md`, N3b-Plan Task 4, N7-Plan Task 9.

## Annahmen und Entscheidungen

Entscheidungen von Christian (25.10.2026) sind als **entschieden** markiert; die übrigen Punkte sind Annahmen von Claude:

- **A1 – Eingangsstand.** Der Lauf startet erst, wenn auf `main` liegen: N5 (Vertrag 4.0), N6 (Rückbau, Basis-Migration, Archiv-Übernahmeskript, Kernwerte-Vergleich im Tor gegen `berth_states`) und N7 (Raumgliederung robust: eigene Speichergrenzen, `gazetteer.land`, Overpass-Teilabfragen, Bucht-Dubletten B9/B10, Messlauf N7 Task 9) sowie der Periplus-MCP (`feat/mcp`, lesend) und seine Steuerung (`feat/mcp-steuern`), deployt. Kein Lauf auf einem Feature-Branch. Der Kernwerte-Vergleich kommt aus der Vereinfachen-Session (N5/N6), nicht aus diesem Plan (entschieden).
- **A2 – Ort des Laufs: Produktion (entschieden).** Design 9: „Der Probelauf läuft in Produktion“. Produktion wird nach N6 aus der Basis-Migration neu aufgesetzt, das Archiv (Dokumente, Versionen, S3, SERP, Recherche-Tabellen) per `scripts/migrate-archive.ts` übernommen. Seiten, die schon geholt sind, werden nicht neu geholt; Suchen innerhalb `reuseDays` nicht wiederholt. Das senkt die Kosten, verfälscht aber die Messung nicht, weil Bewertung, Extraktion und Bestätigung neu laufen.
- **A3 – Der laufende Recherche-Lauf GR-I (Stand vor N5–N7) ist nur Vergleichsbasis.** Seine Zahlen werden in T0 als „Vorher“ festgehalten; bewertet wird nur der neue Lauf.
- **A4 – „Korrekt“ im 100-%-Tor heißt Lage, Art und keine sicherheitsrelevante Abweichung (entschieden).** Lage und Art wie `research:gate` heute misst: Navily-Spot passender Art innerhalb `gate.maxPositionDeviationM` = 150 m, oder Konflikt mit Entscheidung „Liegeplatz“. Kernwerte werden gemessen (T5); eine **sicherheitsrelevante** Abweichung (Schutz in der Hauptwindrichtung grob falsch, Ankerverbot übersehen) zählt zusätzlich als Fehler. Übrige Kernwert-Abweichungen sind Befunde, kein Torbruch.
- **A5 – Mindestabdeckung 50 % (entschieden).** Zusätzlich zur Spec 6 gilt das Tor nur als bestanden, wenn bei der gewählten Schwelle mindestens 50 % der Navily-Liegeplätze in bearbeiteten Kacheln durch einen korrekt bestätigten Platz gedeckt sind (Abdeckung = korrekt zugeordnete Spots / Spots in bearbeiteten Kacheln). Darunter wird vor der Freigabe für Griechenland nachgeschärft. Der Wert steht als `gate.minCoverage: 0.5` in `config/research.json`.
- **A6 – Konflikte entscheidet Christian (entschieden).** Claude bereitet jeden Konflikt (bestätigt, Navily kennt den Platz nicht) mit Luftbild, Belegen und eigener Einschätzung vor; Christian entscheidet alle. Kein „KI entscheidet, wenn sicher“ an diesem Tor.
- **A7 – Navily-Datei.** Liegt seit 25.10.2026 im Periplus-Repo unter `data/navily/navily-spots.json` (gitignored, `.gitignore` Zeile `/data/navily/`), gelesen über `NAVILY_SPOTS_PATH`. Bleibt lokal: das Tor wird mit `research:gate --via-mcp` lokal gegen die Datenbank-Daten von Produktion gerechnet (MCP-Werkzeug `gate_input`); die Datei kommt nie auf den Server.
- **A9 – Navily-Arten.** Die Datei unterscheidet neben `kind` (`mooring`/`port`) eine Art `type`, darunter `prohibited` (Ankerverbot) und `dry-berthing` (Trockenliegeplatz). Ein bestätigter Platz auf einem `prohibited`-Spot ist ein **Fehler** (Anti-Ziel 1), nie „korrekt“; `prohibited`- und `dry-berthing`-Spots zählen nicht zum Nenner der Abdeckung, und ein Abgleich auf `dry-berthing` ist ein Konflikt, kein Treffer. Heute prüft das Tor nur `kind` (`kindCompatible` in `lib/domain/quality/navily-assistant.ts`); Behebung in T4 Step 0.
- **A8 – Budgets** in `config/budgets.json` bleiben Notbremse (Design 3, Ziel 3); vor dem Hauptlauf wird aus der Rauchprobe (T3) hochgerechnet und der Rahmen im Protokoll notiert. Überschreitung um > 50 % → anhalten und Ursache prüfen (Regel aus Spec 12).

## Global Constraints

- **Navily nie ins Repo:** keine Namen, IDs, URLs, Koordinaten oder Werte aus der Referenz in Commits, Protokollen, Review-Texten, Tickets oder Logs. Eingecheckt werden nur Zählungen und Quoten; Einzellisten nur unter `--out-dir` im Scratchpad bzw. `/tmp` auf dem Server.
- **Navily ist nie Datenquelle:** kein Wert der Referenz fließt in Plätze, Fakten oder Status. Nur die Entscheidung eines Menschen über einen Konflikt ändert einen Status.
- **Landesteile einzeln:** nur `GR-I`. Kein „Alle offenen aufbauen“, kein zweiter Landesteil parallel.
- **Erwartung vor dem Lauf:** vor jedem Schritt im Protokoll notieren, was herauskommen sollte (Größenordnung, Vorher-Wert aus T0).
- **Kein Handgriff an Daten:** Korrekturen nur über Konfiguration, Code (mit Regressionstest aus dem echten Fall, `fixtures:record -- --subdivision GR-I`) oder die vorgesehenen Review-Entscheidungen. Keine SQL-Updates von Hand.
- **Ein Befund = eine Zeile** in `docs/pilot/pruefung/befunde.md` (fortlaufende Nummer nach dem letzten B-Befund), Art Daten / Konfiguration / Code / Spec wie in Spec 12.
- **Steuerung über den Periplus-MCP** (`docs/mcp.md`): Claude startet und verfolgt die Läufe von lokal mit den MCP-Werkzeugen statt Knöpfen, SSH und `dc run`. Jeder Start erst ohne `confirm` (Umfang, Schätzung, Budgetstand ins Protokoll), dann mit `confirm: true`. Nach jedem Deploy einer Anpassung zuerst `version` (SHA und Config-Hash wie erwartet). Läufe: `runs`, `worker`, Fehler: `runs {id}`, `job_retry`; Zählungen: `sql`. Prüfentscheidungen trifft Christian in der Oberfläche; Claude bereitet sie mit `review_tasks` vor.
- Protokolle unter `docs/pilot/neuausrichtung/attika-2/T<n>-<stufe>.md`, deutsch; Tor-Bericht `docs/pilot/neuausrichtung/attika-2/tor.md` (von `research:gate` erzeugt).
- Commits auf Branch `pruefung/attika-2` (nur Doku und Konfiguration); Code-Fixes auf eigenen `fix/…`-Branches mit PR. Trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

Was der Lauf nicht übersehen darf, obwohl keine Stufe es von selbst meldet:

- **Ein bestätigter Platz, an dem man nicht liegen kann** (Anti-Ziel 1): jeder Konflikt und jede falsche Art wird einzeln mit Luftbild angesehen, nie nur gezählt (T4).
- **Kacheln ohne Seed oder Geometrie** verfälschen Fehlliste und Abdeckung (Befund 1 aus N3): T2 endet erst, wenn bearbeitete Kacheln = alle Küstenkacheln von `GR-I`.
- **Negativbelege, die zu Unrecht sperren** (N3-Befund 4) und solche, die fehlen (z. B. Ankerverbot der Küstenwache hinter HTTP 403): Stichprobe aus beiden Richtungen in T4.
- **Unbenannte Buchten:** wie viele Navily-Spots fallen auf Kandidaten ohne Namen, und holt die Entdeckung aus Routen (5.5) sie im zweiten Durchgang? (T3/T4)
- **Lieferung enthält fremde Formulierungen oder Quellen** (Anti-Ziel 3): `verbatim_text`/`foreign_content` greifen, plus Sichtprobe von 30 Fakten (T7).

---

### T0: Eingang und Ausgangsstand

- [ ] **Step 1: Eingangsbedingungen prüfen.** `git log origin/main` enthält die Merges von N5, N6 und N7; `research:gate` meldet Kernwerte (nicht mehr „noch nicht verglichen“); CI auf `main` grün; Produktion läuft auf diesem Stand (`/readyz` ok, MCP `version` zeigt den SHA von `main` und die letzte Migration), Basis-Migration angewendet, `migrate-archive` gelaufen (Zählung Dokumente/Versionen vorher = nachher). Ergebnis in `T0-eingang.md`.
- [ ] **Step 2: Vorher-Werte sichern.** Aus dem laufenden bzw. letzten Lauf vor N5–N7: Kandidaten, bestätigte Plätze, Tor-Tabelle, Fehlliste je Grund, Kosten je Kandidat (Quellen: `n3-tor.md`, Lauf-Seite). In `T0-eingang.md` als Spalte „Vorher“.
- [ ] **Step 3: Navily-Datei prüfen (nur Zählungen).** Lokales Skript im Scratchpad, nicht eingecheckt: Zahl der Spots gesamt, im Polygon von `GR-I`, in Kacheln von `GR-I`, je `kind` und `type`, Anteil der Küstenkacheln von `GR-I` mit mindestens einem Spot. Vormessung 25.10.2026 gegen die Dev-DB, nachdem die Datei für ganz Attika ergänzt wurde (Abfrageraster mit 10 km Radius über das Polygon von `GR-I`, 704 + 210 Spots): 914 Spots, 751 im Polygon von `GR-I` (Polygone der Landesteile überlappen auf See), 430 in den Kacheln von `GR-I` (davon 6 `prohibited`, 10 `dry-berthing`), 22 von 25 Küstenkacheln mit Spot. Auf Produktion nach dem Neuaufbau wiederholen. Erwartet: deutlich mehr als die bisher 558 Spots in `GR-I`, alle Küstenabschnitte (Saronischer Golf, Kythira, Athener Küste, Euböa-Golf mit Lavrio/Rafina, Methana) vertreten. Ergebnis: „Referenz deckt GR-I ab: ja/nein“, Dateidatum, Zählungen. **Tor T0:** ja.
- [ ] **Step 4: Konfiguration festhalten.** `config/research.json` (`gate`, `confirmation`), `config/budgets.json`, Modell- und Promptversionen aus `config/models.json` ins Protokoll; `gate.released` ist `false`, `gate.chosenThreshold` ist `null`.
- [ ] **Step 5: Commit** `docs(pruefung): Attika 2 – entry state and reference check`.

### T1: Raumgliederung und Gerüst GR-I

- [ ] **Step 1: Erwartung notieren.** Zahl Inseln, Orte, Buchten, Häfen, Marinas in `GR-I` aus dem N7-Messlauf (N7 Task 9) als Erwartung.
- [ ] **Step 2: Lauf.** Falls die frische Produktion noch keine Raumgliederung hat: `subdivisions_rebuild`, dann `subdivision_build {subdivision: GR-I}` (bzw. `gazetteer_start`), je erst ohne, dann mit `confirm`. Speicher mitschreiben (`docker stats --no-stream`, minütlich), Dauer je Stufe.
- [ ] **Step 3: Prüfung.** MCP `checks {subdivision: GR-I}` (Teil `gazetteer`); Polygon von `GR-I` schließt Methana, Kythira, Lavrio/Rafina ein und nicht Epidavros/Korinthia.
- [ ] **Step 4: Gerüst gegen Referenz (kostenlos, vor jeder bezahlten Stufe).** Je Navily-Spot in `GR-I`: liegt innerhalb 300 m ein Gazetteer-Objekt passender Art (Bucht, Hafen, Marina, Bojenfeld)? Quote und Liste der Spots ohne Objekt (Liste nur im Scratchpad). Jeder Spot ohne Objekt bekommt einen Grund: unbenannte Bucht (dann von `geometry.detect_bays` erwartet, T2), Lücke in OSM (Befund Art „Daten“), Fehler im Gerüst (Befund Art „Code“).
- [ ] **Step 5: Tor T1.** Kein OOM, keine Stufe > 15 min; keine systematische Gerüst-Lücke ungeklärt. Commit `docs(pruefung): Attika 2 – subdivision and gazetteer`.

### T2: Kandidaten, Geometrie, Dinge an Land

- [ ] **Step 1: Lauf.** `datasets_start`, `seed_start`, `geometry_start` je für `GR-I` (ohne, dann mit `confirm`), `gazetteer.land` (läuft nach `seed.tile`). Kein Ortsbild-Lauf hier (Ortsbilder nur für bestätigte Plätze, 5.8).
- [ ] **Step 2: Prüfung.** MCP `checks {subdivision: GR-I}` (Teil `geometry`); bearbeitete Kacheln (Definition aus N3b Task 1) = alle Küstenkacheln; Zahl Kandidaten je Art; Kandidaten in Sperrflächen (`no_anchoring`) mit Liste der Flächen.
- [ ] **Step 3: Kandidaten gegen Referenz (kostenlos).** Anteil Navily-Spots mit Kandidat innerhalb `gate.maxPositionDeviationM`; Anteil davon mit Namen. Das ist die **obere Grenze der Abdeckung**, bevor Geld ausgegeben wird. Liegt sie unter 50 % (A5), wird vor T3 das Gerüst nachgeschärft; sonst kann das Tor nicht bestanden werden. Spots ohne Kandidat nach Grund wie T1 Step 4; Spots auf `no_anchoring`-Kandidaten einzeln ansehen (Sperrfläche zu groß? B19).
- [ ] **Step 4: Sichtprobe.** 20 zufällige Kandidaten auf der Karte: im Wasser, Art richtig, Schutzrose plausibel. 10 `gazetteer.land`-Objekte: Kategorie richtig, innerhalb der Ringe.
- [ ] **Step 5: Tor T2.** Alle Küstenkacheln bearbeitet; Kandidaten-Obergrenze im Protokoll; jeder Spot in Sperrfläche erklärt. Commit `docs(pruefung): Attika 2 – candidates and geometry`.

### T3: Recherche (Rauchprobe, dann ganzer Landesteil)

- [ ] **Step 1: Rauchprobe Probekachel** `q025:813:510` (Ägina Süd, Agistri, Methana): `research_start {tileId: q025:813:510}`, erst ohne `confirm` (Schätzung: „keine Grundlage“ erwartet, erster Lauf mit `scopeSize`), dann mit. Messen: Suchen, Treffer, geholte Seiten (neu vs. aus dem Archiv), Bewertungen je Seitenart, Einheiten, Fakten und Signale je Einheit, Kosten je Kandidat. Mit N1/N3-Werten vergleichen.
- [ ] **Step 2: Hochrechnung.** Kosten je Kandidat × Kandidaten `GR-I` = Kostenrahmen Hauptlauf; ins Protokoll; Budgets bei Bedarf anheben (Konfigurations-Commit).
- [ ] **Step 3: Hauptlauf `GR-I`, erster Durchgang** (`research_start {subdivision: GR-I}`; die Schätzung kommt jetzt aus der Rauchprobe und muss zur Hochrechnung aus Step 2 passen) (Recherche, Bewertung, Extraktion, Routen, Entdeckung, Bestätigung, Folgekette). Täglich: Fortschritt, Fehlerserien (`failed_job`), Kosten gegen Rahmen.
- [ ] **Step 4: Zweiter Durchgang** für entdeckte Kandidaten und neu verknüpfte Seiten (wie N3 Task 5). Messen, wie viele unbenannte Buchten über Routen einen Namen und Treffer bekommen.
- [ ] **Step 5: Sichtprobe Recherche.** 30 Seitenbewertungen (Art, erste Hand, SEO/KI, Datum) von Hand; 30 Signale mit Zitat: stützt das Zitat „hier geankert“ bzw. den Negativbeleg? Quote falsch je Gruppe.
- [ ] **Step 6: Tor T3.** Lauf ohne offene Fehlerserie beendet; Kosten innerhalb Rahmen + 50 %; in der Sichtprobe ≤ 10 % falsche Bewertungen und ≤ 10 % Signale, deren Zitat das Signal nicht stützt (Werte aus Spec 12 P6 übernommen). Commit `docs(pruefung): Attika 2 – research run`.

### T4: Bestätigung und Navily-Tor

- [ ] **Step 0: Abdeckung und Navily-Arten im Tor (Code, eigener Branch `fix/gate-coverage` von `main`, TDD; kann an die Vereinfachen-Session gehen, berührt dieselben Dateien wie der Kernwerte-Vergleich).** (a) Arten nach A9: Listen `navily.excludedTypes: ["prohibited", "dry-berthing"]` und `navily.prohibitedTypes: ["prohibited"]` in `config/quality.json` (Schema `lib/config/schemas.ts`); `evaluateGate` in `lib/domain/research/gate-navily.ts` wertet einen bestätigten Platz, der einem `prohibitedTypes`-Spot zugeordnet ist, als neuen Fehler `GateErrorKind = "prohibited"`, einen Abgleich auf einen anderen ausgeschlossenen Typ als Konflikt; ausgeschlossene Spots erscheinen nicht in der Fehlliste. Tests in `lib/domain/research/__tests__/gate-navily.test.ts`: bestätigte Bucht 50 m neben synthetischem `prohibited`-Spot → Fehler `prohibited`, Korrektheit < 100 %; Marina neben `dry-berthing`-Spot → Konflikt; `prohibited`-Spot ohne Platz → nicht in Fehlliste. (b) Abdeckung: `gateOutcome` in `lib/domain/research/gate-report.ts` bekommt `gate.minCoverage` (Schema in `lib/config/schemas.ts`, Wert 0.5 in `config/research.json`); der Bericht nennt je Schwelle die Abdeckung, und „bestanden“ verlangt zusätzlich `coverage ≥ minCoverage`, sonst „nicht bestanden: Abdeckung n % (mindestens 50 %)“. Tests in `scripts/__tests__/research-gate.test.ts` mit synthetischen Spots: 100 % korrekt bei 40 % Abdeckung → nicht bestanden; 100 % korrekt bei 50 % Abdeckung und ≥ 25 bestätigt → bestanden; Spots außerhalb bearbeiteter Kacheln zählen nicht. PR, Merge, Deploy vor Step 1. Commit `feat(research): gate needs a minimum coverage of the reference`.
- [ ] **Step 1: Auswertung.** `PERIPLUS_MCP_URL`/`PERIPLUS_MCP_TOKEN` in `.env.local`, dann `npm run research:gate -- --via-mcp --subdivision GR-I --sync-conflicts --out-dir <scratchpad> --report docs/pilot/neuausrichtung/attika-2/tor.md`. Die Ausgabe nennt SHA und Tor-Config von Produktion; weicht die lokale Config ab, wird mit der von Produktion gerechnet. Konfliktaufgaben legt `gate_sync_conflicts` an (nur Platz-IDs).
- [ ] **Step 2: Fehler einzeln ansehen.** Jeder Platz mit falscher Art oder Positionsabweichung: Luftbild, Belege, Ursache, Befund.
- [ ] **Step 3: Konflikte vorbereiten und entscheiden (A6).** Je Konflikt-Aufgabe `research_conflict`: Luftbild, Signale mit Zitat und Domain, Geometrie, Einschätzung von Claude. Christian entscheidet „Liegeplatz“ / „Kein Liegeplatz“ in der Review-Oberfläche. Danach `research:gate` erneut.
- [ ] **Step 4: Fehlliste auswerten.** Je Grund (kein Kandidat, ohne Namen, ohne Treffer, zu wenige Quellen, Negativbeleg, Sperrfläche) die Zahl, je Grund 5 Beispiele im Scratchpad ansehen; je Grund eine Maßnahme oder „hinnehmen“ mit Begründung.
- [ ] **Step 5: Negativbelege in beide Richtungen.** 10 Plätze, die ein Negativbeleg sperrt: berechtigt? 10 bestätigte Plätze: gezielt nach jüngeren Verboten suchen lassen (5.6) und Ergebnis prüfen.
- [ ] **Step 6: Tor T4 (Spec 6).** Bei der kleinsten Schwelle N ∈ {2…5} mit **100 % Korrektheit, keinem offenen Konflikt, mindestens `gate.minConfirmed` = 25 bestätigten Plätzen und Abdeckung ≥ 50 %** gilt das Tor als bestanden, sofern T5 keinen sicherheitsrelevanten Fehler findet. Commit `docs(pruefung): Attika 2 – gate evaluation`.

### T5: Kernwerte gegen die Referenz

- [ ] **Step 1: Voraussetzung.** `research:gate` vergleicht Kernwerte aus `berth_states` (geliefert von der Vereinfachen-Session, N5/N6; in T0 Step 1 geprüft). Fehlt er doch, wird T5 angehalten und die Lücke dort gemeldet, nicht in diesem Plan gebaut.
- [ ] **Step 2: Messung je bestätigtem Platz.** Schutz (Hauptwindrichtungen N, NW, S), Grund, Tiefe, Bojen. Quote Übereinstimmung je Kernwert, Liste der Abweichungen nur im Scratchpad.
- [ ] **Step 3: Sicherheitsrelevante Abweichungen (A4).** Wir melden Schutz, wo die Referenz offen nennt (Hauptrichtung), oder liefern ohne bekanntes Verbot → Fehler, bricht T4. Jeder Fall einzeln mit Belegen ansehen.
- [ ] **Step 4: Tor T5.** Kein sicherheitsrelevanter Fehler; übrige Quoten als Befunde. Commit `docs(pruefung): Attika 2 – core values against the reference`.

### T6: Stand, Landseite, Ortsbilder (Folgekette)

- [ ] **Step 1: Vollständigkeit.** Jeder bestätigte Platz hat `berth_states`, Anlandestelle, `nearby` (oder begründet leer), Landrecherche gelaufen, Ortsbild erzeugt oder begründet keins. SQL-Zählung im Protokoll.
- [ ] **Step 2: Sichtprobe 10 Plätze** (gemischt: Ankerbucht ohne Ort, Ankerbucht bei Dorf, Bojenfeld, Marina, Hafen): Kernwerte, Fakten (Aussage in eigenen Worten, Zitat stützt sie, Datum, Tendenz, Sicherheit), Anlandestelle plausibel, Erreichbares (1,5 km zu Fuß, 15 km mit Bus/Taxi) plausibel, Lückenliste.
- [ ] **Step 3: Ortsbilder.** Review der Titelbild-Aufgaben aller bestätigten Plätze nach den Kriterien von Spec 12 P3a (Wasser-IoU, Bildregel je Ortsart, Wasserzeichen). Tor: Median IoU Mittag ≥ 0,85, verworfen < 20 %.
- [ ] **Step 4: Tor T6.** Folgekette für alle bestätigten Plätze durchgelaufen; Sichtprobe ohne systematischen Fehler. Commit `docs(pruefung): Attika 2 – berth state, landside and images`.

### T7: Lieferung 4.0

- [ ] **Step 1: Lauf.** `delivery_start {subdivision: GR-I}` (ohne, dann mit `confirm`); Umkreis-Paket für eine Marina in `GR-I` (Vorschlag: Alimos) mit 7 Tagen.
- [ ] **Step 2: Prüfung.** Validierung des Pakets ohne Verstöße; `delivery:consume -- --base-url https://<domain> --subdivision GR-I` gegen `/api/v4` (Schlüssel per `read -rs`, Runbook); Zahl Spots im Paket = bestätigte Plätze mit Stand.
- [ ] **Step 3: Sichtprobe.** 30 Fakten aus dem Paket: keine Quellennamen, Links, längeren Übernahmen; 3 Spots komplett lesen: „würde Marvoy damit arbeiten können?“
- [ ] **Step 4: Tor T7.** Paket gültig, Abruf ok, Sichtprobe ohne Verstoß. Commit `docs(pruefung): Attika 2 – delivery`.

### T8: Entscheidung und Hochrechnung

- [ ] **Step 1: Bericht** `docs/pilot/neuausrichtung/attika-2/ergebnis.md`: Tor-Tabelle je N, gewählte Schwelle, Abdeckung gegen das Ziel 50 % (mit Kandidaten-Obergrenze aus T2: liegt schon die Obergrenze unter 50 %, ist der Hebel Gerüst/Kandidaten, nicht Recherche), Fehlliste je Grund mit Maßnahme, Kernwert-Quoten, Kosten gesamt und je bestätigtem Platz, Hochrechnung Griechenland (Kandidaten je Landesteil × Kosten je Kandidat), Laufzeit je Stufe, Vergleich Vorher/Nachher (T0).
- [ ] **Step 2a: Bestanden.** `gate.chosenThreshold` und `confirmation.minIndependentSources` = gewählte Schwelle, `gate.released = true` in `config/research.json`; Commit `config(research): release capture after Attika gate (N=<n>)`; nächster Landesteil nach Freigabe durch Christian.
- [ ] **Step 2b: Nicht bestanden.** Befunde nach Hebel ordnen; Nachschärf-Plan (wie N3b) schreiben; nur betroffene Stufen auf `GR-I` wiederholen (Archiv und Suchen werden wiederverwendet); dann ab T4 erneut.
- [ ] **Step 3:** PR `pruefung/attika-2` → `main` mit Protokollen und Konfiguration.

## Zeit und Kosten (grob)

| Abschnitt | Dauer | Kosten |
| --- | --- | --- |
| T0–T2 | 1 Tag | 0 € (Overpass, EMODnet, Rechenzeit) |
| T3 Rauchprobe | 0,5 Tag | ~10 € (N1: 9,83 € für die Probekachel) |
| T3 Hauptlauf + 2. Durchgang | 2–4 Tage | Hochrechnung aus Rauchprobe; Archiv senkt Abrufkosten |
| T4–T5 | 1–2 Tage, überwiegend Konflikte und Sichtprüfung | < 5 € (Negativ-Nachsuche) |
| T6 | 1 Tag | Ortsbilder ≈ 0,30 € × bestätigte Plätze |
| T7–T8 | 0,5–1 Tag | 0 € |

Behebungsrunden kommen hinzu; sie sind der Zweck des Laufs.

## Gegenüber dem alten Prüfplan (Spec 12)

| Alt | Neu |
| --- | --- |
| P0 Umgebung | T0 (plus Prüfung der Referenz, Vorher-Werte) |
| P1–P3 Gazetteer, Seed, Geometrie | T1–T2 (plus kostenloser Abgleich Gerüst/Kandidaten gegen Referenz) |
| P3a Ortsbilder für alle Orte | T6, nur bestätigte Plätze |
| P3b Reviere | entfällt im Lauf (Import unverändert, geprüft in N7) |
| P4 Quellenfindung, P5 Crawl | T3 Recherche je Kandidat |
| P6 Erwähnungen und Facts | T3 Sichtprobe Signale, T6 Fakten |
| P7 Konsolidierung, Profile, Zeitregler | T6 Stand je Liegeplatz (ohne Zeitachse) |
| P8 Lieferung v2 | T7 Lieferung 4.0 inkl. Umkreis |
| P9 Ausweitung, Kennzahlen Spec 10 | T4/T5 Navily-Tor, T8 Entscheidung |
| Probekachel vor Landesteil | nur noch Rauchprobe der Recherche (T3); die übrigen Stufen sind auf der Probekachel bereits geprüft |

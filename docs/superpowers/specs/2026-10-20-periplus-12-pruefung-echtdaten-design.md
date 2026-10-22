# Periplus 12 – Schrittweise Prüfung mit echten Daten

Stand: 21.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Zeitpunkt: nach M7 Teil (a) (Code), nach Teil-Spec 14 Plan 14a (Landesteile) und Teil-Spec 13 Stufe 1 (Ortsbilder), vor dem vollen Pilotlauf aus `docs/pilot/m7-runbook-entwurf.md` · Ergänzt: Abnahmedokumente `docs/pilot/m1-abnahme.md` … `m6-abnahme.md`, Teil-Spec 10, 13, 14

## Zweck

M1 bis M7 sind gebaut und gegen Fixtures getestet, aber noch nie mit echten Daten gelaufen. Diese Spec legt fest, wie der Dienst **Stufe für Stufe** mit echten Daten geprüft und nachgeschärft wird, bevor der volle Pilotlauf (beide Pilot-Landesteile, alle Quellen, Modellvergleich, Revisit) startet.

Leitgedanke: jede Stufe zuerst auf einem kleinen, bekannten Ausschnitt laufen lassen, Ergebnis ansehen und gegen eine vorher notierte Erwartung halten, Fehler beheben, erst dann den Ausschnitt vergrößern oder zur nächsten Stufe gehen. Ein Fehler soll dort auffallen, wo er entsteht, nicht drei Stufen später im Profil.

Abgrenzung: Der volle Lauf aus dem Runbook-Entwurf (Schritte 8 ff. für beide Landesteile, Modellvergleich, Navily-Vergleich, Revisit, Lauf 2) ist die eigentliche M7-Abnahme und folgt **nach** dieser Prüfung. Die Kommandos je Schritt stehen dort und im `docs/runbook.md`; diese Spec bestimmt Reihenfolge, Umfang, Prüfungen und Tore. Nicht Teil der Prüfung: die Arbeit des Revier-Bots selbst (Reviere kommen nach Teil-Spec 14, Änderung 21.10.2026, als Datei `config/area-imports/GR.json`; geprüft wird nur der Import), Lieferung von Ortsbildern (Schalter `images.delivery.ktimatologio` bleibt `false`).

Stand der Umsetzung: P0–P3a brauchen nur Plan 14a und Teil-Spec 13. P3b (Reviere) und alles ab P4 setzen Plan 14b voraus (Revier-Import, Revier-Suchen nach ID, Erwähnungen mit Revieren, Nachlesen). Ist 14b noch nicht in `main`, endet die Prüfung vorerst nach P3a.

## Grundregeln

1. **Erwartung vor dem Lauf.** Vor jedem Prüfschritt wird im Protokoll notiert, was herauskommen sollte (Größenordnung, bekannte Objekte, bekannte Quellen). Ohne vorherige Erwartung ist eine Abweichung nicht erkennbar.
2. **Kleiner Ausschnitt zuerst.** Umfangsleiter: **Probekachel → Landesteil `GR-I` (Attika) → Landesteil `GR-J` (Peloponnes)**. Eine Stufe geht erst auf die nächste Sprosse, wenn ihr Tor auf der kleineren bestanden ist.
3. **Nur Einzelläufe.** Gestartet wird über die Kachelseite („Lauf für diese Kachel starten“) und, wo es nur je Landesteil geht (Gazetteer, Datensätze), unter „Läufe“. **„Aufbauen“ und „Alle offenen aufbauen“ auf „Länder und Landesteile“ werden in der Prüfung nicht benutzt**: sie starten für den ganzen Landesteil alle Stufen bis zur bezahlten Quellenfindung.
4. **Eine Stufe nach der anderen.** Keine Stufe startet, solange die vorige ein offenes Tor hat. Ausnahme: M2 (Geometrie) und M3 (Quellen) hängen beide nur an M1 und dürfen parallel geprüft werden.
5. **Automatische und Sichtprüfung.** Je Stufe das vorhandene Prüfskript (`check:*`) **und** eine Stichprobe mit eigenem Blick (Karte, Text, Ortskenntnis, Revierführer). Das Skript prüft Vollständigkeit, die Stichprobe Richtigkeit.
6. **Befund → Ursache → Behebung → Wiederholung.** Jeder Befund wird eingeordnet (siehe „Befunde“), behoben und die Stufe **nur auf der Probekachel** wiederholt, bis das Tor hält. Nachgelagerte Stufen werden danach neu gerechnet; das ist billig, weil alles nur anfügend gespeichert und reprozessierbar ist. Ausnahme Ortsbilder: sie werden nur bei neuem Luftbild, neuer Prompt- oder Modellversion oder geänderter Ortsart neu erzeugt.
7. **Kosten klein halten.** Während der Prüfung gelten abgesenkte Tagesbudgets (Vorschlag: `anthropic` 5 €, `firecrawl` 2 €, übrige unverändert, `openai` 10 € für Ortsbilder) in `config/budgets.json`; vor dem vollen Lauf zurück auf die Pilotwerte. Bezahlte Schritte nennen ihren Kostenrahmen; wird er um mehr als 50 % überschritten, wird angehalten und die Schätzung geprüft.
8. **Nichts geht nach außen.** Kein Paket wird an Dritte geliefert, solange die ODbL-Frage (Runbook-Entwurf, Schritt 19) offen ist; Ortsbilder bleiben bis zur Antwort des griechischen Katasters intern.

## Probekachel

Eine Kachel des Saronischen Golfs, die möglichst viel Vielfalt auf kleiner Fläche enthält und die Christian gut kennt:

- mindestens eine Insel mit Hauptort und Hafen, eine Marina, mehrere benannte Ankerbuchten, ein Stück Festlandküste (Küstenabschnitt), POIs aller Art;
- festgelegt: die Kachel mit **Ägina (Süden), Agistri und Methana** (etwa 23,25–23,5° O, 37,5–37,75° N). Sie liegt ganz in `GR-I` (Attika); Methana hängt am Festland des Peloponnes, gehört aber zu Attika und prüft damit die Zuordnung nach Landfläche. Die genaue Kachel-ID wird in P0 auf der Karte notiert.

Zu dieser Kachel legt Christian vorab eine **Referenzliste** an (aus Ortskenntnis und einem Revierführer, ohne Navily-Werte zu übernehmen): 10–15 Ankerplätze, Häfen und Marinas mit Namen und Ortsart (Ankerbucht, Bojenfeld, Marina, Hafen) und dem Vermerk, ob eine Stadt oder ein Dorf in Sichtweite liegt (≤ 1,5 km); je 3–5 davon mit erwarteter Schutzrichtung, Grund und Tiefe; 5–10 Highlights (Taverne, Strand, Kloster …); 3–5 Websites oder Revierführer, die bei der Quellenfindung auftauchen sollten. Die Liste ist der Maßstab der Sichtprüfungen und wird in `docs/pilot/pruefung/referenz-probekachel.md` eingecheckt.

## Prüfschritte

Jeder Schritt nennt: **Lauf**, **automatische Prüfung**, **Sichtprüfung**, **Tor** (Bedingung zum Weitergehen), **Kosten**.

### P0 – Umgebung

- **Lauf:** Dienste, Migrationen, Admin, Worker, Web nach Runbook-Entwurf „Voraussetzungen“; Landpolygone für das Mittelmeer importieren (`--mediterranean`); „Länder und Landesteile“ → „Landesteile neu bilden“ (`gazetteer.coarse`, `subdivisions.build`); liegen in der Datenbank Pilotdaten aus der Zeit vor den Landesteilen, die Umstellung nach Runbook „Umstellung auf Landesteile“ (Snapshot, `migrate:subdivisions`, `check:subdivision-migration`); `OPENAI_API_KEY` setzen; Budgets absenken (Grundregel 7); Probekachel festlegen; Referenzliste einchecken.
- **Prüfung:** `/settings` zeigt Konfiguration (darunter `subdivisions.json`, `images.json`) und Schlüssel als vorhanden; Testjob (M0) läuft durch.
- **Sichtprüfung:** Landesteilliste auf `/subdivisions`: Griechenland mit Attika (`GR-I`), Peloponnes (`GR-J`), Kykladen und Dodekanes; ausgeschlossene Länder mit Grund; Polygone von `GR-I` und `GR-J` auf der Karte (Ebene „Landesteile“) schließen die Inseln ein. Küstenabschnitte von `GR-I` (`overrides["GR-I"].coastSections` in `config/subdivisions.json`) prüfen oder nachziehen.
- **Tor:** Worker verarbeitet Jobs; Landesteile `GR-I` und `GR-J` vorhanden und plausibel; bei Umstellung `check:subdivision-migration` mit `OK`; Referenzliste liegt vor.
- **Kosten:** 0 €.

### P1 – Gazetteer (M1)

- **Lauf:** Läufe → „Gazetteer aufbauen“ für `GR-I` (läuft je Landesteil; geprüft wird zunächst nur die Probekachel).
- **Automatisch:** `check:gazetteer -- --subdivision GR-I`: Küstenkacheln, Objekte ohne de/en/el-Namen, offene Aufgaben.
- **Sichtprüfung (Probekachel):**
  - Zählung je Typ (Inseln, Orte, Buchten, Häfen, POIs je Kategorie) gegen die Erwartung.
  - Jedes Objekt der Referenzliste vorhanden? Mit welchen Namen in de/en/el? Fehlende Objekte und fehlende Sprachen notieren.
  - 20 zufällige Objekte: Typ richtig, Lage richtig, Eltern richtig (Bucht → Insel/Küstenabschnitt → Verwaltungseinheit → Land), Meer gesetzt?
  - Landesteil-Zuordnung: alle Objekte der Probekachel in `GR-I`, auch auf Methana und am Isthmus; kein Objekt in `GR-J`.
  - Zusammenführung: Dubletten auf der Karte (gleiche Bucht doppelt)? Falsch zusammengelegte Objekte? Offene Paar-Aufgaben ansehen.
- **Tor:** alle Referenzobjekte vorhanden oder als bekannte Lücke der offenen Daten dokumentiert; keine systematischen Fehler in Typ, Hierarchie, Landesteil-Zuordnung oder Zusammenführung; Namen de/en/el für Inseln, Orte und Buchten der Probekachel vollständig oder Lücke begründet.
- **Typische Stellschrauben:** `config/gazetteer.json` (Merge-Schwellen, `coastDistanceM`), `config/categories.json`, Küstenabschnitte in `config/subdivisions.json`.
- **Kosten:** 0 €.

### P2 – Seed (M1)

- **Lauf:** Kachelseite → „Seed“ (Probekachel).
- **Automatisch:** Zahl der Kandidaten, offene Kandidatenaufgaben.
- **Sichtprüfung:** Trefferquote gegen die Referenzliste (wie viele der 10–15 Plätze sind Kandidat?); 20 Kandidaten auf der Karte: echter Ankerplatz/Hafen oder Fehlgriff (z. B. Bucht ohne Ankermöglichkeit, Fischerhafen)? Lage der Position plausibel (im Wasser, nicht an Land)? Ortsart richtig (sie bestimmt später Bildregel und Licht)?
- **Tor:** mindestens 80 % der Referenzplätze sind Kandidat oder ihr Fehlen ist erklärt (dann Ergänzung über Review oder spätere Erkennung aus Texten); Kandidaten-Review der Probekachel ist abgearbeitet.
- **Kosten:** 0 €.

### P3 – Geometrie und Ausschlüsse (M2)

- **Lauf:** Entscheidungen zu Ausschlüssen (Runbook-Entwurf Schritt 4), Läufe → „Datensätze laden“ für `GR-I`, Kachelseite → „Geometrie“ für die Probekachel. Der Geometrie-Lauf endet mit der Stufe `images.place` und erzeugt die Titelbilder der Orte mit Geometrie (geprüft in P3a).
- **Automatisch:** `check:geometry -- --subdivision GR-I` (nur auf Probekachel bezogen auswerten).
- **Sichtprüfung:**
  - Die 3–5 Referenzplätze mit bekannter Schutzrichtung: Windrose im Reiter „Geometrie“ gegen Erwartung; Strahlen auf der Karte plausibel?
  - Tiefe und Grund gegen Revierführer; Ankerposition im Wasser und sinnvoll.
  - Ausschlussflächen: trifft ein Kabel, Schutzgebiet oder Militärgebiet einen Platz, der in der Praxis genutzt wird? Dann Puffer oder Auswahl prüfen.
  - Unbenannte Buchten (`geometry.detect_bays`): echte Buchten oder Küstenknicke?
- **Tor:** Schutzwerte der Referenzplätze stimmen in der Hauptrichtung; keine Ankerposition an Land; Ausschlüsse fachlich nachvollziehbar.
- **Kosten:** 0 € für die Geometrie; Ortsbilder siehe P3a.

### P3a – Ortsbilder (Teil-Spec 13)

- **Lauf:** entsteht mit P3 (je Ort mit Geometrie ein Titelbild, höchstens `images.pipeline.maxGenerationsPerRun` je Lauf); fehlende Orte über „Titelbilder erzeugen“ auf der Landesteilseite oder einzeln auf der Ortsseite. Luftbild: Kataster-WMS (mit Wasserzeichen), Sentinel-2, Copernicus DEM.
- **Automatisch:** je Bild Wasser-IoU gegen die Render-Maske (Mittag ≥ 0,80, Abend ≥ 0,60), Wasserzeichen-Prüfung, Zahl der Versuche; Abdeckung der Landesteilseite (Orte mit Luftbild, mit Entwurf, mit freigegebenem Bild); Kosten aus `external_calls` (`openai`, Haiku-Prüfung).
- **Sichtprüfung (alle Referenzplätze, je Bild Review-Aufgabe „Titelbild“ mit Rendering, Maske und KI-Bild):**
  - Geometrie: Küstenlinie, Molen, Stege, Bebauung wie im Rendering; nichts hinzugefügt, nichts weggelassen; Bildränder nicht herausgezoomt.
  - Bildregel je Ortsart: Ankerbucht mittags ohne Boote; Marina und Hafen abends mit Booten dort, wo das Rendering sie zeigt; Ankerplatz bei einer Stadt (≤ 1,5 km) mittags mit Booten, Kamera hinter dem Platz, Stadt im Hintergrund. Stimmt der Vermerk der Referenzliste?
  - Kamera: über Wasser, Blick vom offenen Sektor auf den Ort; Kameradaten (Position, Höhe, Blickrichtung, Neigung) plausibel.
  - Wasserzeichen und Logo vollständig entfernt; Wasserfarbe nicht unnatürlich (trübe Hafenbecken nicht karibisch); Alt-Text beginnt mit „KI-Illustration:“ und beschreibt den Ort richtig.
  - Freigeben, neu erzeugen (ggf. andere Zoomstufe) oder „Kein Bild“; Gründe im Protokoll.
- **Tor:** Median Wasser-IoU (Mittag) ≥ 0,85; in der Review verworfen < 20 %; für mindestens 80 % der Referenzplätze ein freigegebenes Titelbild oder begründet keins (z. B. kein Blick vom Wasser).
- **Typische Stellschrauben:** `config/images.json` (Kamera, Zoom, `light.townRadiusM`, Prüfschwellen), Prompt-Blöcke `config/prompts/generate-place-image/` (neue Version), Ortsart im Review.
- **Kosten:** etwa 0,25 € je Bild und Versuch zuzüglich Prüfung; für die Probekachel (15–30 Orte) etwa 5–15 €. Ändert sich in P6/P7 die Ortsart, entsteht ein neues Bild.

### P3b – Reviere (Teil-Spec 14, Plan 14b)

- **Lauf:** `npm run areas:import -- --dry-run`, dann `npm run areas:import` (Datei `config/area-imports/GR.json`, 36 Reviere). Erst nach P1, weil die Mitglieder gegen den Gazetteer aufgelöst werden; Reviere, die vor allem `GR-J` oder andere Landesteile betreffen, bleiben bis zu deren Gazetteer „wartet auf Gazetteer“ (erwartet).
- **Automatisch:** Bericht des Imports je Datei: angelegt, aktualisiert, unverändert, beendet, wartend mit nicht aufgelösten Namen, unbekannte Landesteile. Ein zweiter Import ändert nichts.
- **Sichtprüfung (Karte, Ebene „Reviere“, Filter `GR-I`):**
  - Welche Reviere berühren die Probekachel? Erwartung laut `GR.json`: `saronic-gulf`, `saronic-islands`, `argo-saronic`, `peloponnese-east-coast` (alle `GR-I` und `GR-J`; ihre Mitglieder in `GR-J` bleiben bis P9 offen). Pilotrevier `saronic` lebt als `saronic-gulf` mit derselben `ar_`-ID weiter, `argolic` als `argolic-gulf`.
  - Je berührendes Revier: Polygon deckt das Gebiet, das der Name meint; kein Land weiter als `inlandCutM` landeinwärts; Golf als Polygon, wo er die Mitglieder deckt.
  - Mitglieder: richtig aufgelöst (keine gleichnamige Bucht anderswo)? Nicht aufgelöste Namen: Lücke im Gazetteer (Befund an P1) oder Schreibweise des Bots?
  - Namen je Sprache und Belege mit Zitat und Quelle vorhanden.
- **Tor:** alle Reviere, die die Probekachel berühren, angelegt und plausibel abgegrenzt; nicht aufgelöste Mitglieder der Probekachel erklärt; zweiter Import ohne Änderung.
- **Typische Stellschrauben:** `config/areas.json` (`minMembers`, Puffer, Hülle, `inlandCutM`), Gazetteer-Befunde; Korrekturen an Namen und Abgrenzung macht der Bot, nicht Periplus.
- **Kosten:** 0 €.

### P4 – Quellenfindung (M3, Teil 1)

- **Lauf:** Kachelseite → „Quellenfindung“ nur für die **Probekachel**: Kachelsuchen und die Suchen der importierten Reviere, deren Kacheln die Probekachel berühren (alle Namen in den Sprachen von `GR-I`; jedes Revier höchstens einmal je `serp.reuseDays`).
- **Automatisch:** Zahl der Suchen, Treffer je Suche, Vorschläge.
- **Sichtprüfung:**
  - Liste der Suchbegriffe: sinnvoll, Namen richtig geschrieben, keine Suchen nach Unsinn (z. B. Objekten ohne Bezug zum Segeln)? Sprachen aus `GR-I` (el, de, en)?
  - Top-Domains je Sprache; tauchen die 3–5 erwarteten Quellen der Referenzliste auf?
  - Je Vorschlag: würde ich freigeben? Anteil „ja“ = Präzision der Vorschläge. Was fehlt, das bei Google von Hand sofort käme?
- **Freigabe:** 5–8 Quellen für die Probe, gemischt nach Typ (Revierführer/Verlag, Törnbericht-Blog, Marina, Forum, Wikivoyage) und Sprache.
- **Tor:** mindestens die Hälfte der erwarteten Quellen gefunden; Vorschläge mehrheitlich brauchbar oder Ursache (Vorlagen, Ignorierliste, Schwellen in `config/discovery.json`) behoben.
- **Kosten:** etwa 0,10–0,30 € (DataForSEO).

### P5 – Crawl, Konvertierung, Archiv (M3, Teil 2)

- **Lauf:** Testcrawl 10 Seiten je Probequelle; Crawl-Regeln nachschärfen; dann Crawl der Probequellen mit **gedeckeltem Umfang** (`maxPages` ≤ 50 je Quelle in den Crawl-Regeln); Wikivoyage für `GR-I`.
- **Automatisch:** `check:sources` (die Zahl 20–40 gilt hier nicht; ausgewertet werden Dokumente, Fehler, Kosten je Quelle).
- **Sichtprüfung:**
  - 10 Dokumente im Dokument-Viewer: Hauptinhalt vollständig, Navigation/Kommentare entfernt, Tabellen erhalten, Sprache und Datum richtig erkannt?
  - Chunks: sinnvoll an Überschriften getrennt, nicht mitten im Satz?
  - Crawl-Grenzen: nur relevante Pfade gecrawlt (keine Tag-Seiten, Archive, Shop)?
  - Konverter: an 10–15 dieser Seiten die drei Konverter auf `/compare/converters` vergleichen (Vorstufe des 50-Seiten-Vergleichs; die Entscheidung fällt erst im vollen Lauf).
  - Ein PDF-Revierführer hochladen und das Markdown an zwei Seiten mit Tabellen prüfen.
- **Tor:** Markdown der Probequellen für Menschen lesbar und vollständig; keine ungeklärten Fehlerserien; Embeddings vorhanden.
- **Kosten:** unter 1 € (Konverter-Vorvergleich, Voyage, PDF-Fallback).

### P6 – Erwähnungen und Facts (M4)

- **Lauf:** Kachelseite → „Texte auswerten“ für die **Probekachel**, Modell Sonnet (Startwert); kein Modellvergleich. Der Lauf endet mit Konsolidierung und `images.place` (neue Bilder nur bei geänderter Ortsart).
- **Automatisch:** `check:texts`: Belegtreue, Anteil Erwähnungen ohne Modellaufruf (Soll > 70 %), Kosten je Erwähnung.
- **Sichtprüfung:**
  - Klassifikation: 10 Dokumente – Typ, Sprache, Beobachtungsdatum mit Begründung richtig?
  - Erwähnungen: 30 Stichproben im Dokument-Viewer – richtiger Ort? Fehlende Erwähnungen der Referenzplätze in Texten, die sie offensichtlich nennen?
  - Neue Namen (`unmatched_names`): echte Orte, die dem Gazetteer fehlen, oder Rauschen?
  - Große Objekte im Vorlauf: Reviere, Landesteile und Meere als Erwähnung erkannt (z. B. „Saronischer Golf“), und erweitern sie die Kandidaten nur auf die richtigen Kacheln?
  - Facts: 30 Stichproben – Zitat stützt den Wert (nicht nur: Zitat steht im Text), Wert auf die richtige Skala abgebildet (Schutz, Grund, Tiefe), Highlight-Namen richtig?
  - Routen: ein bis zwei Törnberichte – Stopps in der richtigen Reihenfolge und zugeordnet?
- **Tor:** Belegtreue 100 %; in der Stichprobe höchstens 10 % falsche Erwähnungen und höchstens 10 % Facts, deren Zitat den Wert nicht stützt; Kosten je Erwähnung in der Größenordnung der Schätzung aus dem Runbook-Entwurf.
- **Typische Stellschrauben:** Prompts (`config/prompts/…`, neue Version), Fact-Schema, `config/name-affixes.json`, Ähnlichkeitsschwellen; danach Kachelseite → „Reprozessieren“ für die Probekachel.
- **Kosten:** etwa 2–5 € (Haiku, Sonnet-Batch).

### P7 – Konsolidierung (M5)

- **Lauf:** Kachelseite → „Konsolidieren“ für die Probekachel (die Folgeaufträge der Konsolidierung lösen gezielte Quellenfindung aus; im Prüfbetrieb beobachten, Kosten gering).
- **Automatisch:** `check:profiles -- --subdivision GR-I` (auf Probekachel bezogen auswerten).
- **Sichtprüfung:**
  - Profile der Referenzplätze: Werte, Herkunft je Attribut, Lückenliste – würde ich so einem Crewmitglied antworten?
  - Konflikte und unsichere Änderungen: echte Widersprüche oder Artefakte der Extraktion?
  - Summaries: richtig, nur aus Profilwerten, keine Übertreibungen?
  - Zeitregler: älterer Stand abrufbar?
  - Highlights: POIs aus OSM und Text richtig zusammengeführt, Bedeutung plausibel?
  - `popularity`: innerhalb von `GR-I` normiert, Rangfolge der Referenzplätze plausibel?
  - Ortsbilder: hat sich eine Ortsart geändert, liegt ein neuer Entwurf vor (Prüfung wie P3a)?
- **Tor:** Profile der Referenzplätze fachlich vertretbar; keine Konfliktflut aus einer einzelnen Fehlerquelle; offene Titelbild-Aufgaben der Probekachel entschieden.
- **Kosten:** unter 1 €, zuzüglich neu erzeugter Bilder (P3a).

### P8 – Lieferung (M6)

- **Lauf:** „Lieferungen“ → „Paket bauen“ für `GR-I` (das Paket umfasst den Landesteil, Inhalt nach Landesteil-Zuordnung der Objekte; inhaltlich bewertet wird die Probekachel; Lücken außerhalb sind hier erwartet).
- **Automatisch:** Validierungsregeln des Pakets; `delivery:consume -- --base-url http://localhost:3000 --key <pk_…> --subdivision GR-I` gegen `/api/v2`.
- **Sichtprüfung:** ein Spot und seine Highlights im JSON lesen: würde eine Törn-App damit arbeiten können? Felder ohne Wert, Einheiten, IDs (`sp_`, `sd_`)? `manifest.subdivision` und `manifest.areas` richtig? Ortsbilder: wegen `images.delivery.ktimatologio = false` **kein** `images` im Paket, keine Bilddateien, `profileVersion` durch freigegebene Bilder nicht erhöht.
- **Tor:** Paket gültig; Befunde nach Runbook „Verstöße beheben“ erledigt.
- **Kosten:** 0 €.

### P9 – Ausweitung auf den Landesteil

Erst wenn P1–P8 auf der Probekachel bestanden sind:

1. P2, P3, P3b für alle Küstenkacheln von `GR-I` (unter „Läufe“ für den Landesteil; kostenlos bis auf die Ortsbilder), Sichtprüfung nur noch als Stichprobe (5 Orte je Kachel) und Blick auf Ausreißer. Ortsbilder: Kosten aus Zahl der Orte × etwa 0,30 € vorab schätzen; `maxGenerationsPerRun` und das `openai`-Budget begrenzen je Lauf und Tag; Review als Stichprobe (10 Bilder je Ortsart) plus alle unter der IoU-Schwelle.
2. P4 für den ganzen Landesteil. `GR-I` ist größer als das frühere Revier `saronic` (Kythira, Küste von Athen, Nordküste): Zahl der Suchen und Kosten aus der Kachelzahl auf `/subdivisions` vorab schätzen und im Protokoll notieren. Freigabe bis zur Zielzahl 20–40 Quellen, `maxPages` auf die Pilotwerte.
3. P5–P7 für den ganzen Landesteil **tageweise**: Crawl, dann Texte und Konsolidierung im Rahmen der wieder angehobenen Budgets; nach jedem Tag `check:*` und Kennzahlen auf `/quality` ansehen.
4. Bewertung der Kennzahlen (Teil-Spec 10, je Landesteil; Teil-Spec 13 für Ortsbilder) für `GR-I`; erst dann `GR-J` in derselben Reihenfolge (ab P1, ohne Probekachel, mit Stichproben). Nach dem Gazetteer von `GR-J` den Revier-Import wiederholen (wartende Reviere lösen sich auf) und das Nachlesen der Erwähnungen prüfen: ein Törnbericht aus `GR-I`, der Orte in `GR-J` nennt, bekommt deren Erwähnungen.

Danach folgt der volle Pilotlauf nach `docs/pilot/m7-runbook-entwurf.md` ab den Schritten, die noch offen sind (Konverter- und PDF-Entscheidung, Modellvergleich, Navily-Vergleich mit `--subdivision`, Revisit, Lauf 2).

## Befunde

Jeder Befund wird in `docs/pilot/pruefung/befunde.md` erfasst: Nummer, Prüfschritt, Beobachtung, Beispiel (Objekt-, Dokument-, Fact- oder Bild-ID), Ursache, Art, Behebung, Nachprüfung.

| Art | Bedeutung | Behebung |
| --- | --- | --- |
| Daten | Lücke oder Fehler in den offenen Daten (OSM, Wikidata, EMODnet, Luftbild) | Review-Entscheidung oder dokumentieren; kein Code |
| Konfiguration | Schwelle, Vorlage, Prompt, Liste passt nicht | Änderung in `config/`, neue Version, Probekachel neu rechnen |
| Code | Fehler oder fehlender Fall im Code | Fix mit Test (Fixture aus dem echten Fall), Probekachel neu rechnen |
| Spec | Annahme der Spec trägt nicht | Änderung der Teil-Spec, Entscheidung Christian, dann wie Konfiguration oder Code |

Ein Code-Befund bekommt immer einen Regressionstest aus dem echten Beispiel (`fixtures:record -- --subdivision GR-I`), damit die Prüfung mit echten Daten dauerhaft in die Tests einfließt.

## Protokoll

Je Prüfschritt eine Datei `docs/pilot/pruefung/P<n>-<stufe>.md` mit: Datum, Umfang (Kachel/Landesteil), notierte Erwartung, Ausgabe des Prüfskripts, Stichprobe mit Ergebnis je Element, Befunde (Verweis), Kosten aus `external_calls`, Tor bestanden ja/nein. Die Abnahmedokumente M1–M6 werden erst im vollen Lauf ausgefüllt; die Prüfprotokolle sind ihre Vorstufe. Ortsbilder werden im Protokoll nicht eingecheckt (Lizenz offen); es genügen Bild-IDs und Bewertung.

## Zeit und Kosten (grob)

| Abschnitt | Dauer | Kosten |
| --- | --- | --- |
| P0–P3 (Probekachel) | 1–2 Tage, überwiegend Sichtprüfung und Review | 0 € |
| P3a (Probekachel) | 0,5–1 Tag | etwa 5–15 € |
| P3b (Reviere) | 0,5 Tag | 0 € |
| P4–P5 (Probekachel) | 1 Tag | etwa 1 € |
| P6–P8 (Probekachel) | 1–2 Tage | etwa 3–6 € |
| P9 `GR-I` | 4–8 Tage (Budgets begrenzen Texte und Bilder) | nach Runbook-Entwurf, anteilig für einen Landesteil, plus Ortsbilder (Zahl der Orte × etwa 0,30 €) |

Behebungsrunden kommen hinzu; sie sind der eigentliche Zweck der Prüfung.

## Offene Punkte

- Ob eine Vorschau der Suchbegriffe ohne SERP-Aufruf (Planausgabe von `discovery.area`/`discovery.tile`) vor P4 gebaut werden soll; sie macht P4 ohne Kosten prüfbar und hilft bei jedem neuen Landesteil.
- Ob die Prüfung lokal oder auf dem Server läuft. Vorschlag: P0–P8 lokal, P9 auf dem Server, sobald M0 dort abgenommen ist.
- Voraussetzung: PR 10 (Landesteile) und der Ortsbilder-Branch sind in `main`; die Prüfung startet auf diesem Stand.

# Periplus 09 – Admin-Oberfläche

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilensteine: Shell in M0, je Meilenstein wachsend · Quell-Spec: „Review und Freigabe“, „Service-Betrieb“ (Monitoring), „Qualitätsmetriken“

## Zweck und Haltung

Ein Werkzeug für ein bis drei Admins: sehen, was der Dienst weiß und tut; an den vier Rändern der Quell-Spec entscheiden; Läufe anstoßen. Kein Endnutzerprodukt. Maßstab der Quell-Spec: Review unter 30 Minuten je 100 Orte und Lauf; „ein Klick entscheidet, nichts muss getippt werden außer bei einer Korrektur“.

Sprache der Oberfläche: Deutsch. Gestaltung: ruhig, dicht, kartenzentriert, hell und dunkel; Tailwind 4 ohne Komponentenbibliothek, bis sich Bedarf zeigt (Entscheidung Claude; einzelne Primitives wie Dialog/Popover über Radix, wenn nötig).

## Technik

- Next.js 16 App Router, Server Components lesen über `lib/domain`-Funktionen (nie direkt aus `app/` auf die DB), Schreiben nur über Server Actions in `app/(admin)/**/actions.ts`, jede mit `requireAdmin()` und zod-Eingabeprüfung.
- Karte: MapLibre GL JS als Client-Komponente; Daten als GeoJSON aus internen Route-Handlern unter `app/(admin)/map-data/…` (Sitzung, nicht API-Schlüssel), gefiltert nach Kartenausschnitt; ab ~5.000 Objekten Vektor-Kacheln aus PostGIS (`ST_AsMVT`).
- Lange Listen serverseitig paginiert; Filter als URL-Parameter (teilbar, zurück-Taste funktioniert).
- Fortschritt laufender Läufe: Polling alle 5 s auf der Lauf-Seite (kein WebSocket nötig).

## Seiten

| Pfad | Inhalt | ab |
| --- | --- | --- |
| `/login` | Anmeldung | M0 |
| `/` Übersicht | Kennzahlen: offene Review-Aufgaben je Art, Jobs je Queue (offen, laufend, fehlgeschlagen), Kosten heute/Monat je Dienst mit Budget, Worker-Herzschlag, letzte Läufe, letzte Lieferungen | M0 (Gerüst), wächst |
| `/map` Karte | Ebenen schaltbar: Reviere, Kacheln (eingefärbt nach Stand: Alter des ältesten Profils / Status / Kosten), Geo-Objekte nach Typ, Orte nach Status und Profil-Konfidenz, POIs nach Kategorie, Ausschlussflächen, Routen. Klick öffnet Seitenleiste mit Kurzprofil und Link | M0 leer, M1 |
| `/tiles/[id]` Kachel | Geo-Objekte, Orte, Läufe, Kosten, Kennzahlen; Aktionen „Seed“, „Geometrie“, „Quellenfindung“, „Voller Lauf“, „Reprozessieren“ | M1 |
| `/geo/[id]` Geo-Objekt | Namen (alle Sprachen, Herkunft), Eltern/Kinder, externe IDs, Erwähnungen, Facts, Profil | M1 |
| `/places/[id]` Ort | Kopf: Name, Art, Status, Position, Aktionen (bestätigen, verwerfen, zusammenlegen, Ankerposition setzen). Reiter: **Profil** (Attribut, Wert, Konfidenz, Herkunft, Regel; Klick → Facts), **Facts** (je Attribut mit Zitat, Quelle, Datum, Lauf), **Geometrie** (Windrose, Strahlen auf Karte, Tiefen), **Zeitachse** (Profilversionen mit Regler und Diff, Änderungsereignisse), **Quellen** (Dokumente mit Erwähnung), **Lieferung** (Vertragsobjekt als JSON wie ausgeliefert) | M1–M6 |
| `/review` | Warteschlange je Art mit Zählern; Bearbeitung nacheinander („nächste“), Tastenkürzel für die Entscheidungen | M1 |
| `/sources` | Quellenliste mit Filter (Status, Typ), Detail mit Crawl-Regeln, Testcrawl, Dokumentliste, Kosten | M3 |
| `/documents/[id]` | Versionen auf Zeitleiste, Markdown, Diff, Chunks mit Erwähnungen und Fact-Zitaten hervorgehoben, Original/Rohdatei | M3 |
| `/runs` | Läufe mit Umfang, Stufen, Fortschritt, Kosten, Ergebnis; Lauf-Detail mit Jobs je Stufe, fehlgeschlagene Jobs mit Fehlermeldung und „Erneut“ | M0 |
| `/jobs` | Queues: Zähler, Pausieren/Fortsetzen (z. B. nach Budget-Stopp) | M0 |
| `/costs` | Kosten je Dienst, Stufe, Kachel, Lauf; Budgets | M0 |
| `/compare/converters`, `/compare/models` | Vergleichsseiten für die Pilot-Entscheidungen | M3, M4 |
| `/quality` | Sieben Kennzahlen je Kachel und Revier (Teil-Spec 10), Verlauf über Läufe, Vergleichssatz-Pflege | M1 (Vergleichssatz), M7 |
| `/deliveries` | Pakete, Validierungsbericht, Diff, Download, „Paket bauen“ | M6 |
| `/settings` | Anzeige der aktiven Konfiguration (Fact-Schema-Version, Modelle, Prompts, Budgets, Reviere) — nur lesend, Änderung per Deploy; API-Clients sperren | M0 |

## Review-Aufgaben (Quell-Spec „Review und Freigabe“ plus Ergänzungen)

Jede Aufgabe zeigt ihren ganzen Kontext auf einer Seite: Karte mit dem Objekt, Textausschnitte mit Hervorhebung, bisherige Facts, Quelle mit Gewicht.

| Art | Entscheidungen (je ein Knopf) |
| --- | --- |
| `source_approval` | Freigeben (Typ, Gewicht, Regeln vorbelegt, änderbar), Ablehnen |
| `place_candidate` | Bestätigen (Position per Klick korrigierbar, Art wählen), Einem Ort zuordnen (Liste der nächsten Orte), Verwerfen, Kein Ankerplatz |
| `conflict` | Wert A, Wert B, Beide (saisonal), Offen lassen |
| `failed_job` | Erneut starten, Quelle pausieren, Ignorieren |
| `coast_tile_without_area` | Revier zuordnen (Liste), Kein Revier nötig |
| `uncertain_change` | Übernehmen, Verwerfen |
| `comparison_deviation` | Eigener Wert stimmt, Navily stimmt (eigener Wert falsch), Unklar |

Jede Entscheidung schreibt `review_decisions` (unveränderlich) und wirkt sofort (Status, Review-Fact, Folgejob). Gemessen wird die Bearbeitungszeit je Aufgabe (Öffnen bis Entscheiden) für die Kennzahl Review-Aufwand.

## Rückfluss (M8)

Bestätigte und verworfene Kandidaten sowie entschiedene Konflikte werden als Beispiele exportierbar (`/review/export`), um Prompts (Few-Shot) und Konsolidierungsparameter zu verbessern. Die Kennzahl „Review-Aufgaben je 100 Orte und Lauf“ steht auf `/quality`.

## Tests

- Komponenten-nahe Logik (Formatierer, Filter-Parameter) als Unit-Tests.
- Server Actions mit Test-DB: Wirkung jeder Review-Entscheidung.
- Playwright: Login, Review eines Ortskandidaten, Lauf starten und Fortschritt sehen, Paket bauen.
- Routen-Policy-Test (Teil-Spec 01) deckt jede Seite ab.

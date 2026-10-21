# P0 – Umgebung

Datum: 21.10.2026 (Nacht, autonom durch Claude) · Umfang: lokal, Dev-DB `periplus` (vorher leer) · Stand: `main` 67e6cb2 (PR 10 Landesteile, PR 11 Ortsbilder) + Branch `pruefung/echtdaten`

## Erwartung (vor dem Lauf)

- Migrationen bis 0060 laufen auf der leeren Datenbank durch.
- „Landesteile neu bilden“ legt Meere (IHO), Länder und Verwaltungseinheiten an und bildet daraus etwa 140 Landesteile (OSM-Probeabzug aus Teil-Spec 14: 139 Einheiten vor `split`/`wholeCountry`); Griechenland mit Attika (`GR-I`), Peloponnes (`GR-J`), Kykladen (`GR-CYC`), Dodekanes (`GR-DOD`), ohne Südliche Ägäis (`GR-L`) als eigenen Landesteil; Libyen, Syrien, Gaza ausgeschlossen.
- Landpolygone für die Mittelmeer-Box: einige 10.000 Polygone aus dem Split-Datensatz.
- Probekachel 23,25–23,5° O × 37,5–37,75° N ist Küstenkachel mit Label `GR-I`.

## Lauf

| Schritt | Ergebnis |
| --- | --- |
| Worktree `pruefung/echtdaten` von `origin/main`, `npm ci` | ok |
| Budgets abgesenkt (`anthropic` 5 €, `firecrawl` 2 €) | ok, Commit auf dem Prüf-Branch; vor dem vollen Lauf zurücksetzen |
| `npm run db:migrate` (leere DB) | ok |
| Worker, Web (`next dev -p 3100`) | laufen |
| „Landesteile neu bilden“ (Lauf `01a15c05…`) | **fehlgeschlagen**: `gazetteer.coarse` 24/25 Länder (Palästina, B2), `subdivisions.build` an fehlenden Landpolygonen (B3, erwartet) |
| Landpolygone `--mediterranean` (Version 2026-10-20) | 26.388 Polygone in 21 s |
| nur `subdivisions.build` (Lauf `01a15c27…`) | hing > 20 min (B1), nach Fix Absturz von Postgres durch Speichermangel bei den Kykladen (B4) |
| Durchgang je Landesteil (113 Einträge, zurückgerollt) nach B1 und B4 | alle 113 ohne Fehler, Spitze 490 MB, langsamster GR-CYC 2,7 s |
| nur `subdivisions.build` (Lauf `01a15c41…`) | **beendet in 45 s** |

Hinweis: Die Läufe `01a15c27…` und `01a15c3c…` stehen noch auf „läuft“; ihre Jobs starben mit dem Worker bzw. dem Datenbank-Absturz und werden von pg-boss nach `expireInSeconds` (1 h) neu versucht; sie ändern dann nichts mehr (gleiche Planung).

## Prüfung

- Grob-Gazetteer: 10 Meere, 23 Länder, 430 Verwaltungseinheiten (ohne Palästina).
- Landesteile: 113, davon 111 aktiv, 2 ausgeschlossen (LY „Bürgerkrieg, kein Segelbetrieb“, SY „Krieg“). Gaza fehlt (B2).
- Je Land: AL 6, BA 1, CY 2 (mit Nordzypern), DZ 15, EG 8, ES 8, FR 3, GB 1 (Stützpunktgebiete), GI 1, GR 13, HR 7, IL 1, IT 15, LB 1, LY 1, MA 2, MC 1, ME 1, MT 1, SI 1, SY 1, TN 13, TR 10.
- Griechenland: GR-A, GR-B, GR-D, GR-E, GR-F, GR-G, GR-H, GR-I (Attika, 26.827 km² mit Wasser), GR-J (Peloponnes), GR-K, GR-M, GR-CYC, GR-DOD; West-Makedonien (GR-C, keine Küste) fehlt richtig, Südliche Ägäis (GR-L) ist geteilt.
- `/settings` und Testjob: nicht gesondert geprüft (Worker verarbeitet Jobs, sichtbar an den Läufen).

## Sichtprüfung

Landzuordnung (nächstes Land) an Probepunkten: Methana Hafen, Poros Stadt, Galatas, Perdika (Ägina), Skala (Agistri), Kalloni (Festland Troizinia) → `GR-I`; Epidavros, Ermioni → `GR-J`. Entspricht der Verwaltungsgliederung (Troizinia-Methana gehört zum Regionalbezirk Inseln von Attika). Karte (Polygone auf `/map`) nicht angesehen – offen für Christian.

## Referenz

Statt einer Referenzliste aus Ortskenntnis dienen die Navily-Daten aus `dontsticktoaplan` (Entscheidung Christian, 21.10.2026): 110 Einträge in der Probekachel (88 Ankerplätze, 4 Ankerverbote, 1 Bojenfeld, 17 Häfen/Marinas). Die Liste liegt nur lokal (`docs/pilot/pruefung/lokal/`, gitignored); Protokolle nennen nur Quoten.

## Befunde

B1 (behoben), B2 (offen), B3 (offen), B4 (behoben) – siehe `befunde.md`.

## Kosten

0 € (Overpass, Marine Regions frei).

## Tor

**Bestanden** mit offenem B2 (betrifft nur Gaza) und B3 (Runbook). Landesteile `GR-I` und `GR-J` vorhanden und plausibel.

## Zweiter Durchgang (21.10.2026, nach Plan 16 „Highlights je Ort“)

Datenbank geleert bis auf Benutzer (Wunsch Christian: „bestehende Daten verwerfen“), Migrationen bis 0064.

| Schritt | Ergebnis |
| --- | --- |
| Nur `gazetteer.coarse` (Lauf `01a15df1…`) | 1 von 25 Ländern fertig, dann viele HTTP 502 von Overpass (B15) und „land polygons missing“ (B14: der Grob-Gazetteer braucht seit PR 12 Landpolygone); Lauf beendet. Länder mit Grenzen: 19 (u. a. GR vollständig: 90 Einheiten), Inseln/Golfe/Orte des Grob-Gazetteers fehlen noch |
| Landpolygone `--mediterranean` | 26.388 |
| Nur `subdivisions.build` | 45 s; 93 aktive + 2 ausgeschlossene Landesteile (statt 111: Länder mit fehlgeschlagenem Grob-Gazetteer fehlen); alle 13 griechischen vorhanden |

Tor für die Probekachel: **bestanden** (GR-I vollständig). Grob-Gazetteer der übrigen Länder wird nach P3 nachgeholt (nicht parallel, B16).

# T3 – Recherche GR-I (Attika 2)

## Step 1: Rauchprobe Probekachel `q025:813:510`

Freigabe Christian 27.10. („Ursache klären + Rauchprobe“), parallel zur Ursachensuche aus T2 Step 3.

Ohne `confirm` (27.10. 10:55): Umfang 81 Plätze; Schätzung „keine Grundlage (noch kein vergleichbarer Lauf)“; Budgets
je Tag: Anthropic 80 € (verbraucht 0,00 €), DataForSEO 10 €, Firecrawl 2 €, Jina 5 €, OpenAI 10 € (je 0 €).

Eigene Hochrechnung aus N1 (`n1-probelauf.md`: 9,83 € für 85 Kandidaten, ≈ 0,29 € je Kandidat mit Namen): 33 Plätze mit
Namen (25 Ankerbuchten, 7 Marinas, 1 Hafen) × 0,29 € ≈ **10 €**. Abbruchgrenze (+50 %): **15 €**.

Mit `confirm` gestartet 27.10. 10:54, Lauf `01a17cc8…`, beendet 11:58 (64 min). **Kosten 11,59 €** (Rahmen 10 €,
Grenze 15 €): Seitenbewertung 6,25 €, PDF-Umwandlung 2,40 €, DataForSEO 1,59 € (455 Aufrufe), Auszug 0,89 €,
Routen 0,45 €; Crawl, robots.txt und 269 Browser-Renderings kostenlos.

| Größe | Rauchprobe | N1 (Probekachel, Dev) |
| --- | ---: | ---: |
| Plätze im Umfang / mit Namen | 81 / 33 | 85 / 36 |
| Suchanfragen | 251 | 221 |
| Plätze mit Treffern | 30 | – |
| Treffer positiv / negativ | 1.109 / 1.010 (981 / 695 URLs) | 38 / 35 je Kandidat |
| Seiten geholt / gescheitert / übersprungen | 1.277 / 232 / 107 | – |
| Seitenbewertungen | 1.277, davon erste Hand 124 (Revierführer 62, Törnbericht 45, Forum 13) | – |
| Einheiten (Seite × Platz) | 148 für 24 Plätze aus 81 Seiten | – |
| Signale | 33 (positiv 30, negativ 3) für 14 Plätze; ≥ 2 unabhängige Quellen: 9 Plätze | – |
| Fakten | 329 für 17 Plätze, davon 55 sicherheitsrelevant | – |
| Routen-Stopps | 188, davon 11 per Name zugeordnet | – |
| neue Kandidaten aus der Entdeckung | **0** | – |
| bestätigt (Lauf) / `no_anchoring` in der Kachel | 1 / 5 | 2 bei N=2 |
| Kosten je Platz / je Platz mit Namen | 0,14 € / 0,35 € | – / 0,29 € |

22 Abruf-Jobs gescheitert: 11× HTTP 429 (meist expedia.*), 2× HTTP 500, 2× Zeitüberschreitung, 1× kein PDF, **6×
Konverter (B29, PR #41)**.

`research:gate` (nur Scratchpad, bearbeitete Kacheln 31 von 56, Abdeckung daher ohne Aussage) für die Probekachel:

| N | bestätigt | korrekt | Position abweichend | Schutz falsch |
| --- | ---: | ---: | ---: | ---: |
| 2–4 | 4 | 1 | 2 | 1 |
| 5 | 2 | 1 | 1 | 0 |

- Position 466 m: OSM-Marina-Punkt an der Stadtkai-Seite; die Referenz führt die Marina 466 m entfernt, einen Kai 5 m
  neben unserem Punkt. Zuordnung über den Namen.
- Position 554 m (Ankerposition) / 530 m (Buchtpunkt): große Bucht als OSM-Punkt, die Referenz hat zwei Spots darin
  (256 m und 530 m entfernt). Ursache wie B28 (1).
- Schutz falsch (64 m, Zuordnung richtig): wir liefern Schutz in SE, S, SW, W, die Referenz nennt diese Sektoren
  offen. Sicherheitsrelevant nach A4; Einzelprüfung in T5.

Fehlliste der Probekachel bestätigt B28: Plätze ohne Namen werden nicht gesucht, die Entdeckung fand keinen neuen
Kandidaten, und von 188 Routen-Stopps ließen sich 11 zuordnen.

## Rauchprobe 2 (nach #42–#45)

Christian (27.10.): Rauchprobe 2 in derselben Probekachel `q025:813:510`.

Schätzung ohne `confirm`: 99 Plätze (vorher 81), **14,16 €** (Anthropic 10,00, DataForSEO 1,59; Basis Lauf `01a17cc8…`
11,59 € für 81). Budgetstand vor dem Start: Anthropic 10,06/80 €, DataForSEO 1,61/10 €, OpenAI 0,25/10 €. Abbruch
(`run_end`) über 21,24 € (+50 %).

Mit `confirm` gestartet 27.10. 15:29, Lauf `01a17dc3…`, beendet ~19:24. **Kosten 4,01 €** (Schätzung 14,16 €; Seiten
werden je URL einmal bewertet, die meisten waren aus Rauchprobe 1 schon bewertet). Die Seitenbewertung wartete ~2 h auf
die Batch-API von Anthropic (Rauchprobe 1: 2–3 min); kein Fehler bei uns.

| Stufe | Jobs |
| --- | --- |
| `research.search` | 99/99 |
| `research.fetch` | 990/1.013, 23 gescheitert (17× HTTP 429 expedia/vrbo, 2× HTTP 500, 2× Zeitüberschreitung, 1× kein PDF; alles Seiten aus anderen Regionen) |
| `research.assess` / `extract` / `routes` | 12 / 4 / 2 |
| `research.discover` / `confirm` / `state` | 41 / 1 / 3 |

`research:gate` (Scratchpad, bearbeitete Kacheln 31 von 56): unverändert 4 bestätigt, 1 korrekt, 2 Position, 1 Schutz.

- **Schutz (Russian Bay, `01a179f0-fd3b…`):** mit v4 und Uferband jetzt SE 0,87, S 0,70, SW 0,68, W 0,82 (vorher überall
  0,9). Die Begrenzung wirkt; die gerechnete Basis liegt nach der ufernahen Ankerposition aber selbst bei 0,6–0,77, also
  SE, S, W weiter ≥ 0,7, wo die Referenz offen nennt. Bleibt für T5 (gerechnete Kurve).
- **Position:** Marina 466 m (unverändert, OSM-Punkt am Stadtkai); große Bucht jetzt 432 m (vorher 554 m).
- **Strand-Kandidaten:** 25 liegen bei einem Spot; 23 davon ohne Suchtreffer, 2 mit zu wenigen Quellen. Die Suche unter
  Strandnamen liefert Badestrand- und Hotelseiten, oft aus anderen Regionen (gleichnamige Strände), keine
  Ankerplatz-Seiten. Kein neuer bestätigter Platz.

## Step 3: Hauptlauf GR-I

Christian (27.10.): Hauptlauf mit DataForSEO 20 €/Tag (PR #46, Deploy `d54f6142`, `configHash` `01d905402a9040b9`).

Ohne `confirm` (27.10. 21:13): 764 Plätze; Server-Schätzung 30,95 € (Basis Rauchprobe 2 mit Cache, daher zu niedrig).
Eigene Hochrechnung aus Rauchprobe 1 (11,59 € für 81 Plätze ohne Cache, 0,143 €/Platz): **~110 €**, davon DataForSEO
~15 €. Budgetstand vor dem Start: Anthropic 13,44/80 €, DataForSEO 2,24/20 €, OpenAI 0,25/10 €. Abbruch (`run_end`) über
**165 €** (+50 %). Anthropic-Tagesbudget reicht nicht für einen Tag; der Lauf wartet am Budget und setzt am Folgetag fort.

Stand 28.10. 07:45: Suche 764/764, Abruf 8.190/8.286 (96 gescheitert, 1,2 %), Bewertung 80/102 Jobs; Kosten 30,30 €.
`research.assess` stand seit 01:09 an der Budgetpause (B33: Reservierung 79,97 €, gebucht 20,70 €). Christian:
Queue freigeben; `queue_resume` 07:50, die übrigen 22 Batches sind abgeschickt.
`research.extract` stand 07:54 ebenfalls an der Budgetpause (Reservierung der Bewertungs-Batches noch offen; Auszugs-
Batches je ~7,6 € geschätzt, gebucht ~0,46 €). Mit derselben Freigabe 09:33 und 09:44 per `queue_resume` fortgesetzt;
Auszug 38/38 um 09:51, Kosten 48,61 €.

### Ergebnis Hauptlauf

Lauf `01a17eff…` beendet 28.10. ~10:15, **Kosten 51,20 €** (Schätzung ~110 €, Grenze 165 €).

| Stufe | Jobs |
| --- | --- |
| `research.search` | 764/764 |
| `research.fetch` | 8.190/8.286, 96 gescheitert (1,2 %) |
| `research.assess` / `extract` / `routes` | 124 / 38 / 6 |
| `research.discover` / `confirm` / `state` | 213 / 1 / 16 |

Trichter (Lauf): 764 Plätze gesucht → 283 mit Suchtreffern (14.835 Treffer, 8.654 URLs) → 6.009 Seiten bewertet
(erste Hand 388; Seitenart: sonstige 2.951, Verzeichnis 1.137, Reiseführer 870, Behörde 389, Revierführer 294,
Törnbericht 219, Forum 86, Marina 63) → 1.698 Einheiten für 220 Plätze → 305 Signale für 77 Plätze, davon nur 15 aus
erster Hand. Zählende positive Belege (Regel aus `config/research.json`, alle Läufe, je Seite gezählt): 40 Plätze mit
mindestens einem, 18 mit mindestens zwei.

`research:gate` (`tor.md`, Produktion `d54f6142`, Tor-Config `7d3da3c5b8cf1d15`, Kacheln 31 von 56, 637 Spots):
**Tor nicht bestanden.** N=2: 14 bestätigt, 5 korrekt, 7 Position abweichend (189, 253, 254, 331, 432, 466, 812 m),
1 Schutz falsch (Russian Bay), 1 Konflikt offen (nicht in der Referenz; Aufgabe angelegt). Abdeckung 0,8 %. Fehlliste
N=2: kein Kandidat 486, zu wenige Quellen 98, ohne Namen 26, ohne Treffer 10.

### Ausbeute untersucht (Christian 28.10.: „Ausbeute untersuchen“)

Spotzahl: Das Tor zählt 637 Spots in den 31 bearbeiteten Kacheln (Kacheln mit Platz); T2 zählte 414 in einer anderen
Kachelliste (34 Kacheln, 23 gemeinsam). Die Obergrenze bei 150 m liegt im Nenner des Tors bei ~24 % (486 Spots ohne
Kandidat), passend zu T2 (25,1 %).

Die 0,8 % entstehen in der Recherche: Befund **B34** (Suche trifft gleichnamige Buchten anderer Reviere; von 473
zählenden Seiten-Paaren der 82 Plätze mit zu wenigen Quellen nennen 418 den Platz nicht, 28 wurden Einheiten).
Namensvarianten sind ein kleiner Anteil.

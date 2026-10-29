# P1 – Revier-Suche und Verortung aus Berichten (Attika 2)

Stand 29.10.2026, 10:00 (nach dem Review-Durchgang). Messpilot nach
`docs/superpowers/specs/2026-10-28-periplus-pilot-revier-suche-design.md`, Plan
`docs/superpowers/plans/2026-10-28-periplus-pilot-revier-suche.md`, Lab-Skript `scripts/lab/region-search` (nur auf
`pruefung/attika-2`, kein Produktionscode). Zahlen aus `compare` (Generat `<Pilotverzeichnis>/report.md`); nur
Zählungen und Quoten, die Referenz ist nie Datenquelle. Einzellisten liegen außerhalb des Repos.

## Vorgehen

1. **Revier-Anfragen statt Kandidaten-Anfragen.** 14 Gebiete aus dem Gazetteer von GR-I (Saronischer Golf, Spetses,
   Dokos, Hydra, Poros, Agistri, Ägina, Salamis, Kythira, Antikythera, Kalavria, Methana, zwei manuelle Küstenabschnitte
   Attika West/Ost; Felsgruppen-Archipele weggelassen) × 8 Vorlagen (en/de/el) = 112 Anfragen.
2. **Zwei Suchwege mit identischem Nachlauf.** D: DataForSEO, 40 Treffer je Anfrage. C: je Gebiet eine agentische
   Anfrage an `claude-sonnet-5-5` mit dem Server-Werkzeug `web_search_20260209` (≤ 12 Suchen, `skipDomains` als
   `blocked_domains`); das Modell liefert nur URLs und seine Suchanfragen. Beide Wege liefern URL-Listen; Abruf,
   Bewertung, Extraktion und Verortung laufen für beide gleich.
3. **Abruf lokal** (vorhandener Transport, `htmlToMarkdown`, `pdftotext`, robots.txt; Seiten unter 400 Zeichen einmal
   über Jina nachgeholt, weil lokal kein Browser rendert). **Bewertung** mit dem Pipeline-Task `assess-page` v1.
4. **Extraktion** je zählender Seite (Revierführer, Törnbericht, Forum, Marina, Behörde) mit einem Pilot-Prompt: alle
   Liegeplätze der Seite mit wörtlichem Liegeplatz-Zitat, Koordinate nur wörtlich mit Zitat (die Koordinate wird aus
   dem geprüften Zitat gelesen, nie aus der Modellantwort), Lagezitat; jedes Zitat mit `locateQuote` geprüft, ohne
   gültiges Liegeplatz-Zitat verworfen.
5. **Verortung** in fester Reihenfolge: wörtliche Koordinate → Name (+ Alias) gegen das Gazetteer GR-I + GR-J
   (`berthNameMatches`, Typ-Rang nach Art der Nennung, Inselfilter nur wenn das Seiten-Gebiet eine Insel nennt,
   mehrdeutig nur innerhalb des besten Rangs) → Modell wählt aus den Gazetteer-Objekten des Gebiets. Nennt die Seite
   ein Gebiet, das weder Insel, Suchgebiet, Gazetteer-Name noch Land/Region um GR-I ist (Paros, Kefalonia, Paxos …),
   wird die Nennung **nicht** verortet (`foreign_area`), damit gleichnamige Orte anderer Reviere nicht auf GR-I-Objekte
   fallen.
6. **Web-Orte**: verortete Nennungen ≤ 300 m zusammengefasst; unabhängige Quellen je Web-Ort wie in der Pipeline
   (registrierbare Domain, Kopien über `copiesSource` verschmolzen); bindend zählen erste Hand und Revierführer. Die
   bindenden Zahlen entstehen **ohne** modellverortete Nennungen; die Spalte „mit Modell“ enthält sie.
7. **Abgleich** lokal gegen die Referenz. Nenner „Kacheln GR-I“ = die 34 Kacheln des Landesteils (414 Spots ohne
   `prohibited`/`dry-berthing`, exakt wie T2), zum Vergleich die 637 Spots der 31 bearbeiteten Tor-Kacheln (Web-Orte
   dafür aus eigenen und bearbeiteten Kacheln). Spots ≤ 300 m zueinander bilden einen Bucht-Cluster. Nennungen, deren
   Punkt außerhalb der jeweiligen Kacheln liegt, zählen als „außerhalb“.

## Trichter

| Stufe | Zahl |
| --- | ---: |
| Anfragen DataForSEO (D) / Gebiete Claude-Websuche (C) | 112 / 14 (155 Suchen) |
| URLs aus D / aus C / aus beiden / gesamt | 2.074 / 891 / 109 / 2.856 |
| Seiten geholt / bewertet / zählend | 2.553 / 2.553 / 539 |
| Nennungen (gültig) / verworfen (Zitat nicht auf der Seite) | 2.627 / 66 |
| nicht verortet, weil die Seite ein fremdes Revier nennt (`foreign_area`) | 1.166 |
| verortet: Gazetteer-Name / Koordinate / Modell | 680 / 112 / 19 |
| davon außerhalb der Kacheln von GR-I (GR-J und weiter) | 285 |
| unverortet: mehrdeutig / kein Treffer | 201 / 449 |

## Nenner „Kacheln GR-I“: 414 Spots, 379 Bucht-Cluster (≤ 300 m)

| Kennzahl | Wert | Anteil |
| --- | ---: | ---: |
| Spots mit Web-Ort ≤ 150 m | 40 | 9,7 % |
| Spots mit Web-Ort ≤ 300 m | 63 | 15,2 % |
| Spots mit Web-Ort ≤ 600 m | 122 | 29,5 % |
| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (pipelinenah: erste Hand oder Revierführer) | 32 | 7,7 % |
| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (alle zählenden Seiten) | 32 | 7,7 % |
| **Bucht-Cluster mit ≥ 2 unabhängigen Quellen ≤ 300 m (bindend, ohne Modell-Verortung)** | **27** | **7,1 %** |
| dasselbe mit modellgestützter Verortung | 30 | 7,9 % |
| Web-Orte mit ≥ 2 Quellen ohne Spot ≤ 300 m (Konfliktlast) | 25 | |

Gedeckte Spots (≤ 300 m) nach Suchweg: nur D 14, nur C 14, beide 35. Nach Verortungsweg: Gazetteer 33, Koordinate 30.

Wörtliche Koordinaten: 53 Nennungen in GR-I, Median-Abstand zum nächsten Spot 125 m, davon ≤ 150 m: 35.

## Nenner „Tor-Kacheln“: 637 Spots, 579 Bucht-Cluster (≤ 300 m)

| Kennzahl | Wert | Anteil |
| --- | ---: | ---: |
| Spots mit Web-Ort ≤ 150 m / ≤ 300 m / ≤ 600 m | 49 / 86 / 158 | 7,7 % / 13,5 % / 24,8 % |
| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m | 41 | 6,4 % |
| Bucht-Cluster mit ≥ 2 unabhängigen Quellen ≤ 300 m (ohne / mit Modell) | 33 / 36 | 5,7 % / 6,2 % |
| Konfliktlast | 29 | |

Zum Vergleich der Hauptlauf (`tor.md`, N=2, dieser Nenner): 14 bestätigt, 5 korrekt, Abdeckung 0,8 %.

## Tragende Seiten je Suchweg (Spec 6)

Zählende Seiten mit mindestens einer in GR-I verorteten Nennung: **230**; nur D 89, nur C 102, beide 39. D enthält
56 % aller tragenden Seiten, C 61 %. Kein Weg enthält ≥ 80 % der tragenden Seiten des anderen: **beide Wege bleiben.**

## Entscheidungsregel (Spec 6)

Bindend: Bucht-Cluster „Kacheln GR-I“ mit ≥ 2 unabhängigen Quellen ≤ 300 m: **27 von 379 = 7,1 %** (mit Modell 30,
7,9 %).

Folge nach der vorab festgelegten Regel (40 % / 20 %): **< 20 %. Das Web als alleinige Quellenklasse reicht für das
Abdeckungsziel nicht; andere Klassen prüfen, bevor weiter an Suche und Gerüst gearbeitet wird.**

Einordnung, damit die Zahl nicht überinterpretiert wird:

- Die Obergrenze dessen, was die gefundenen Seiten überhaupt hergeben, liegt bei **29,5 %** (Spots mit irgendeinem
  Web-Ort ≤ 600 m). Selbst mit perfekter Verortung und doppelt so vielen Quellen je Ort bliebe der bindende Wert
  unter 40 %.
- Die Verortung verliert viel: von 2.627 Nennungen bleiben 1.166 wegen fremder Reviere draußen (richtig so), weitere
  **650 bleiben unverortet**, obwohl sie kein fremdes Revier nennen: 295 nennen ein Gebiet von GR-I und scheitern am
  Namen – englische Seglernamen, die das Gazetteer nur griechisch kennt (der meistgenannte Ankerplatz des Reviers:
  12 Nennungen, kein Treffer), Schreibvarianten (Vathi/Vathy; der Wortstamm-Abgleich aus PR #47 ist auf diesem Zweig
  noch nicht enthalten), Namen auf mehreren Inseln (Mandraki 25, Agia Marina 12) –, 216 nennen kein Gebiet, 139 ein
  Gebiet, das weder GR-I noch erkennbar fremd ist. Mit den 295 wären nach dem Muster der verorteten Nennungen etwa
  10–15 weitere Cluster erreichbar, also ~10–11 %. Die Regelstufe ändert das nicht.
- Die Modell-Verortung hat im Pilot wenig gebracht: 1.450 Aufrufe, 5,31 €, 31 Zuordnungen (19 nach dem Fix des
  Inselfilters noch nötig), +3 Cluster. Zwei Ursachen sind möglich und nicht trennbar, weil der `stop_reason` nicht
  mitgeschrieben wurde: die Kandidatenliste (für Nennungen mit Gebiet „Saronischer Golf“ bekam das Modell nur
  Festlandobjekte) und ein zu kleines `max_tokens` (400 bei eingeschaltetem Thinking, Antwort könnte abgeschnitten
  sein). Beides ist im Skript behoben (Kandidaten bleiben, `max_tokens` 4.000, `stop_reason` wird geloggt); ein
  Neulauf kostet ~5 € und steht nicht im Budget. Das ist ein Fehler des Pilots, nicht ein Urteil über den Ansatz.

## Beobachtungen

**Suchwege.** Die beiden Wege sind fast disjunkt (109 gemeinsame URLs von 2.856). Je Seite ist C präziser: zählend
sind 27 % der nur über C gefundenen Seiten, 17 % der nur über D gefundenen, 49 % der von beiden gefundenen; von den
191 URLs, die das Modell ausdrücklich „gewählt“ hat, zählen 58 %. Absolut liefert D mehr zählende Seiten (303 gegen
187); bei den tragenden Seiten liegt C vorn (102 gegen 89 nur-eigene). Kosten: D 0,39 €, C 2,65 €. Das Modell
formuliert seine Anfragen mit eigenem Ortswissen (Buchtnamen in der Anfrage); das ist zulässig, weil nur URLs
zurückkommen, aber im Blick zu behalten.

**Abruf.** 2.553 von 2.850 abgerufenen URLs geholt (6 URLs des zweiten Suchlaufs D kamen nach dem Abruf hinzu und
fehlen in allen Folgestufen); Fehler: 137× HTTP 403, 48 Transport, 32 robots.txt, 28× 405, 24× 429, 15× 404,
6× Konverter-Absturz (Muster B27/B29).

**Bewertung.** 325 Revierführer, 186 Törnberichte, 32 Foren, 52 Behörde, 17 Marina, 422 Verzeichnis, 533 Reiseführer,
986 Sonstiges; erste Hand 363 (14 %, Hauptlauf 6 %). Die „pipelinenahe“ und die „alle zählenden Seiten“-Spalte sind
gleich: die zählenden Seitenarten sind praktisch deckungsgleich mit erster Hand + Revierführer.

**Extraktion.** 539 Seiten, 2.627 gültige Nennungen (im Mittel 4,9 je Seite), 66 verworfen, weil das Zitat nicht auf
der Seite stand (2,5 %). Koordinaten sind selten: 112 Nennungen (4 %), auf 87 Seiten fand der Regex welche. Wo sie
stehen, liegen sie nah am nächsten Spot: Median 125 m, zwei Drittel ≤ 150 m – in dichten Buchten misst das auch die
Spot-Dichte, eine Kontrolle mit Zufallspunkten fehlt. Lagebeschreibungen hat fast jede zweite Nennung (1.120),
auch 296 der unverorteten GR-I-nahen; sie werden bisher nicht genutzt.

**Verortung.** 680 Nennungen landen auf Gazetteer-Objekten: Hafen 254, Bucht 173, Ort 160, Insel 67, Kap 21, Strand
17, Eiland 7. Die 67 Insel- und 160 Ort-Treffer sind grob (Mittelpunkt der Insel bzw. des Orts); sie erzeugen zum
Teil Web-Orte, die nichts treffen. Hafenobjekte sind Polygon-Mittelpunkte: der meistgenannte Stadtkai des Reviers
(35 unabhängige Quellen) steht als „Konflikt“, weil der Referenzpunkt am Kai > 300 m vom Mittelpunkt liegt.

**Qualität der Treffer.** Von 31 Spots, deren *nächster* Web-Ort ≤ 300 m liegt und ≥ 2 unabhängige Quellen hat,
stimmt bei 25 der Name einer Nennung mit dem Spot überein; die 6 übrigen sind nach Stichprobe plausible
Nachbarbenennungen (Strand statt Bucht, Marina statt Hafenbecken), keine Fehlzuordnungen. Art der getroffenen Spots:
15 Ankerplätze, 9 `aflot`, 5 Steg, 2 Kai.

**Konflikte.** 25 Web-Orte mit ≥ 2 Quellen ohne Spot ≤ 300 m, 8 davon mit ≥ 5 Quellen. Drei Gruppen: (a) echte,
vielgenannte Liegeplätze, deren Referenzpunkt > 300 m vom Gazetteer-Punkt liegt (Stadtkais, Marinas, Kap-Ankerplätze,
Inselmittelpunkte); (b) **Fehlverortungen gleichnamiger Orte anderer Reviere** ohne Gebietsangabe auf der Seite
(Namen aus dem Ionischen Meer, den Sporaden, Messenien bleiben auch nach dem `foreign_area`-Filter übrig, weil die
Seite kein Gebiet nennt); (c) wenige Buchten, die die Referenz nicht kennt. Gruppe (b) ist die Kehrseite der
Revier-Suche: Seiten über „Griechenland“ brauchen eine Revier-Zuordnung je Nennung aus dem Abschnittskontext, nicht
nur aus einer expliziten Gebietsangabe.

## Kosten

| Stufe | Kosten |
| --- | ---: |
| Suche D / C | 0,39 € / 2,65 € |
| Bewertung (2.553 Seiten, 0,012 €/Seite, ohne Batch-Rabatt) | 30,56 € |
| Extraktion (539 Seiten, 0,020 €/Seite) | 10,74 € |
| Modell-Verortung (1.450 Aufrufe) | 5,31 € |
| Jina-Nachholung dünner Seiten | nicht erfasst (Cent-Beträge, `external_calls` der Dev-DB) |
| **gesamt** | **49,65 €** (Obergrenze 40 €, am 29.10. auf 50 € erhöht) |

Die Schätzung von ~22 € lag um das Doppelte daneben (Befund B36): zwei Suchwege × 40 Treffer ergaben 2.553 statt
1.200 Seiten, und die Bewertung kostet je Seite 0,012 € statt 0,007 €. Der Lauf stand nachts einmal, weil das
Guthaben des lokalen Schlüssels aufgebraucht war. In der Pipeline liefe die Bewertung mit 50 % Batch-Rabatt.

## Review

Ein frischer Reviewer hat den Lab-Code gegen Spec und Plan geprüft (0 kritisch, 7 wichtig, 12 klein). Behoben vor
dieser Fassung: fremde Reviere wurden auf gleichnamige GR-I-Objekte verortet (bindende Zahl 36 → 27 Cluster);
Modell-Quellen sickerten in die „ohne Modell“-Zeile; der Vergleichsnenner „Tor-Kacheln“ war auf die eigenen Kacheln
geschnitten (jetzt eigene ∪ bearbeitete); Koordinate kam aus `coordinate_text` statt aus dem geprüften Zitat;
Obergrenze schaltete sich bei nicht-numerischer Umgebungsvariable still ab; die 80-%-Regel wurde auf gedeckte Spots
statt tragende Seiten angewandt; `max_tokens` der Modell-Verortung. Offen (klein, im Ledger): Kopieprüfung nur Zitat
gegen Zitat; Mehrdeutigkeit nur im besten Rang; Konflikte gegen Spots ohne Ankerverbot; Jina-Kosten; Schreib-Race der
Kostendatei; Koordinaten-Assertion des Berichtstests.

## Empfehlung für T8

1. **Das Abdeckungsziel 50 % gegen die Referenz ist mit Web-Quellen nicht erreichbar**, auch nicht mit Revier-Suche
   und besserer Verortung: die Obergrenze der gefundenen Seiten liegt bei ~30 % (≤ 600 m), realistisch bestätigbar
   sind ~10 % der Bucht-Cluster. Das Ziel braucht entweder einen anderen Nenner (die kanonischen Ankerplätze, nicht
   die nutzergenerierte Spot-Dichte) oder eine andere Quellenklasse (lizenzierte Revierführer, Positionsdaten).
2. **Revier-Suche lohnt sich trotzdem**: 27 bestätigte Cluster (32 Spots) für 50 € gegen 5 korrekte Plätze für 51 €
   im Hauptlauf bei kleinerem Nenner. Wenn weitergebaut wird, dann Quelle-zuerst mit beiden Suchwegen – aber erst nach
   Punkt 1.
3. **Verortung ist der Hebel, nicht die Suche**: englische Seglernamen ins Gazetteer (B37), Wortstamm-Abgleich
   (PR #47), Revier-Zuordnung je Nennung vor der Verortung (B38), Lagebeschreibungen nutzen, Hafen- und Kai-Positionen
   statt Polygon-Mittelpunkte (B39). Koordinaten aus Seiten sind selten, aber, wo vorhanden, nah an der Referenz.
4. **Vor dem nächsten Lauf eine Kostenprobe mit 10 % des Umfangs**, dann hochrechnen; die Schätzung aus diesem Pilot
   war um Faktor 2 zu niedrig.

Befunde: B36–B39 in `docs/pilot/pruefung/befunde.md`.

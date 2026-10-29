# P1 – Revier-Suche und Verortung aus Berichten (Attika 2)

Stand 29.10.2026, 09:00. Messpilot nach `docs/superpowers/specs/2026-10-28-periplus-pilot-revier-suche-design.md`,
Plan `docs/superpowers/plans/2026-10-28-periplus-pilot-revier-suche.md`, Lab-Skript `scripts/lab/region-search`
(nur auf `pruefung/attika-2`, kein Produktionscode). Zahlen aus `compare`; nur Zählungen und Quoten, die Referenz ist
nie Datenquelle. Einzellisten liegen außerhalb des Repos.

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
   Liegeplätze der Seite mit wörtlichem Liegeplatz-Zitat, Koordinate nur wörtlich mit Zitat, Lagezitat; jedes Zitat
   mit `locateQuote` geprüft, ohne gültiges Liegeplatz-Zitat verworfen.
5. **Verortung** in fester Reihenfolge: wörtliche Koordinate → Name (+ Alias) gegen das Gazetteer GR-I + GR-J
   (`berthNameMatches`, Typ-Rang nach Art der Nennung, Inselfilter nur wenn das Seiten-Gebiet eine Insel nennt,
   mehrdeutig nur innerhalb des besten Rangs) → Modell wählt aus den Gazetteer-Objekten des Gebiets.
6. **Web-Orte**: verortete Nennungen ≤ 300 m zusammengefasst; unabhängige Quellen je Web-Ort wie in der Pipeline
   (registrierbare Domain, Kopien über `copiesSource` verschmolzen); bindend zählen erste Hand und Revierführer.
7. **Abgleich** lokal gegen die Referenz. Nenner „Kacheln GR-I“ = die 34 Kacheln des Landesteils (414 Spots ohne
   `prohibited`/`dry-berthing`, exakt wie T2), zum Vergleich die 637 Spots der bearbeiteten Tor-Kacheln. Spots ≤ 300 m
   zueinander bilden einen Bucht-Cluster. Nennungen, deren Punkt außerhalb der GR-I-Kacheln liegt, zählen als
   „außerhalb“.

## Trichter

| Stufe | Zahl |
| --- | ---: |
| Anfragen DataForSEO (D) / Gebiete Claude-Websuche (C) | 112 / 14 (155 Suchen) |
| URLs aus D / aus C / aus beiden | 2.074 / 891 / 101 |
| Seiten geholt / bewertet / zählend | 2.553 / 2.553 / 539 |
| Nennungen (gültig) / verworfen (Zitat nicht auf der Seite) | 2.627 / 66 |
| davon verortet außerhalb der Kacheln von GR-I (GR-J und weiter) | 374 |
| verortet: Gazetteer-Name / Koordinate / Modell | 873 / 112 / 19 |
| unverortet: mehrdeutig / kein Treffer | 342 / 1.281 |

## Nenner „Kacheln GR-I“: 414 Spots, 379 Bucht-Cluster (≤ 300 m)

| Kennzahl | Wert | Anteil |
| --- | ---: | ---: |
| Spots mit Web-Ort ≤ 150 m | 45 | 10,9 % |
| Spots mit Web-Ort ≤ 300 m | 76 | 18,4 % |
| Spots mit Web-Ort ≤ 600 m | 135 | 32,6 % |
| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (pipelinenah: erste Hand oder Revierführer) | 42 | 10,1 % |
| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (alle zählenden Seiten) | 42 | 10,1 % |
| **Bucht-Cluster mit ≥ 2 unabhängigen Quellen ≤ 300 m (bindend)** | **36** | **9,5 %** |
| dasselbe mit modellgestützter Verortung | 36 | 9,5 % |
| Web-Orte mit ≥ 2 Quellen ohne Spot ≤ 300 m (Konfliktlast) | 37 | |

Gedeckte Spots (≤ 300 m) nach Suchweg: nur D 19, nur C 15, beide 42. Nach Verortungsweg: Gazetteer 47, Modell 4,
Koordinate 25.

Wörtliche Koordinaten: 53 Nennungen in GR-I, Median-Abstand zum nächsten Spot 125 m, davon ≤ 150 m: 35.

Unverortete Nennungen: mehrdeutig 342, kein Treffer 1.281; davon mit Lagebeschreibung 672.

## Nenner „Tor-Kacheln“: 637 Spots, 579 Bucht-Cluster (≤ 300 m)

| Kennzahl | Wert | Anteil |
| --- | ---: | ---: |
| Spots mit Web-Ort ≤ 150 m / ≤ 300 m / ≤ 600 m | 45 / 76 / 135 | 7,1 % / 11,9 % / 21,2 % |
| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m | 42 | 6,6 % |
| Bucht-Cluster mit ≥ 2 unabhängigen Quellen ≤ 300 m | 36 | 6,2 % |

Zum Vergleich der Hauptlauf (`tor.md`, N=2, derselbe Nenner): 14 bestätigt, 5 korrekt, Abdeckung 0,8 %.

## Entscheidungsregel (Spec 6)

Bindend: Bucht-Cluster „Kacheln GR-I“ mit ≥ 2 unabhängigen Quellen ≤ 300 m: **36 von 379 = 9,5 %**.

Folge nach der vorab festgelegten Regel (40 % / 20 %): **< 20 %. Das Web als alleinige Quellenklasse reicht für das
Abdeckungsziel nicht; andere Klassen prüfen, bevor weiter an Suche und Gerüst gearbeitet wird.**

Einordnung, damit die Zahl nicht überinterpretiert wird:

- Die Obergrenze dessen, was die gefundenen Seiten überhaupt hergeben, liegt bei **32,6 %** (Spots mit irgendeinem
  Web-Ort ≤ 600 m). Selbst mit perfekter Verortung und doppelt so vielen Quellen je Ort bliebe der bindende Wert unter
  40 %.
- Die Verortung verliert viel: 1.623 von 2.627 Nennungen bleiben unverortet. Davon nennen **1.095 andere Reviere**
  (Paros, Kefalonia, Paxos, Lefkada, Korfu, Kythnos …; die Revier-Seiten decken ganz Griechenland), 216 nennen kein
  Gebiet, **312 nennen ein Gebiet von GR-I** und scheitern trotzdem: englische Seglernamen, die das Gazetteer nur
  griechisch kennt (der meistgenannte Ankerplatz des Reviers: 12 Nennungen, kein Treffer), Schreibvarianten
  (Vathi/Vathy; der Wortstamm-Abgleich aus PR #47 ist auf diesem Zweig noch nicht enthalten), und Namen, die auf
  mehreren Inseln vorkommen (Mandraki 25, Agia Marina 12). Mit diesen 312 wären nach dem Muster der verorteten
  Nennungen etwa 10–15 weitere Cluster erreichbar, also ~13 %. Die Regelstufe ändert das nicht.
- Die Modell-Verortung hat im Pilot versagt: 1.450 Aufrufe, 5,31 €, 31 Zuordnungen (19 nach dem Fix des Inselfilters
  noch nötig). Ursache ist die Kandidatenliste: für Nennungen mit Gebiet „Saronischer Golf“ bekam das Modell nur
  Festlandobjekte, keine Inseln. Das ist ein Fehler des Pilots, nicht ein Urteil über den Ansatz; eine Kandidatenliste
  über Namensähnlichkeit statt Gebiet wäre der nächste Versuch.

## Beobachtungen

**Suchwege.** Die beiden Wege sind fast disjunkt (101 gemeinsame URLs von 2.583). Je Seite ist C präziser: zählend
sind 27 % der nur über C gefundenen Seiten, 17 % der nur über D gefundenen, 49 % der von beiden gefundenen; von den
191 URLs, die das Modell ausdrücklich „gewählt“ hat, zählen 58 %. Absolut liefert D mehr zählende Seiten (303 gegen
187). Bei den gedeckten Spots tragen beide ähnlich (nur D 19, nur C 15, beide 42); keiner enthält ≥ 80 % des anderen,
also bleibt es nach der Regel bei beiden Wegen. Kosten: D 0,39 €, C 2,65 €. Das Modell formuliert seine Anfragen mit
eigenem Ortswissen (Buchtnamen in der Anfrage); das ist zulässig, weil nur URLs zurückkommen, aber im Blick zu behalten.

**Abruf.** 2.553 von 2.850 URLs geholt; Fehler: 137× HTTP 403, 48 Transport, 32 robots.txt, 28× 405, 24× 429, 15× 404,
6× Konverter-Absturz (Muster B27/B29).

**Bewertung.** 325 Revierführer, 186 Törnberichte, 32 Foren, 52 Behörde, 17 Marina, 422 Verzeichnis, 533 Reiseführer,
986 Sonstiges; erste Hand 363 (14 %, Hauptlauf 6 %). Die „pipelinenahe“ und die „alle zählenden Seiten“-Spalte sind
gleich: die zählenden Seitenarten sind praktisch deckungsgleich mit erster Hand + Revierführer.

**Extraktion.** 539 Seiten, 2.627 gültige Nennungen (im Mittel 4,9 je Seite), 66 verworfen, weil das Zitat nicht auf
der Seite stand (2,5 %). Koordinaten sind selten: 112 Nennungen (4 %), auf 87 Seiten fand der Regex welche. Wo sie
stehen, sind sie gut: Median 125 m zum nächsten Spot, zwei Drittel ≤ 150 m. Lagebeschreibungen hat fast jede zweite
Nennung (1.120), auch 672 der unverorteten; sie werden bisher nicht genutzt.

**Verortung.** 873 Nennungen landen auf Gazetteer-Objekten: Bucht 263, Hafen 262, Ort 210, Insel 72, Kap 42, Strand
24, Eiland 19. Die 72 Insel- und 210 Ort-Treffer sind grob (Mittelpunkt der Insel bzw. des Orts); sie erzeugen zum
Teil Web-Orte, die nichts treffen. Hafenobjekte sind Polygon-Mittelpunkte: der meistgenannte Stadtkai des Reviers
(35 unabhängige Quellen) steht als „Konflikt“, weil der Referenzpunkt am Kai > 300 m vom Mittelpunkt liegt.

**Qualität der Treffer.** Von 41 Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (nächster Web-Ort) stimmt bei 29 der
Name einer Nennung mit dem Spot überein; die 12 übrigen sind nach Stichprobe plausible Nachbarbenennungen (Strand
statt Bucht, Marina statt Hafenbecken), keine Fehlzuordnungen. Art der getroffenen Spots: 24 Ankerplätze, 9 `aflot`,
5 Steg, 3 Kai.

**Konflikte.** 37 Web-Orte mit ≥ 2 Quellen ohne Spot ≤ 300 m, 10 davon mit ≥ 5 Quellen. Drei Gruppen: (a) echte,
vielgenannte Liegeplätze, deren Referenzpunkt > 300 m vom Gazetteer-Punkt liegt (Stadtkais, Marinas, Kap-Ankerplätze);
(b) **Fehlverortungen gleichnamiger Orte anderer Reviere** auf GR-I-Objekte (Namen aus dem Ionischen Meer, den
Sporaden, den Kykladen, Messenien finden sich unter den 37); (c) wenige Buchten, die die Referenz nicht kennt. Gruppe
(b) ist die Kehrseite der Revier-Suche: Seiten über „Griechenland“ brauchen eine Revier-Zuordnung je Nennung, bevor
verortet wird.

## Kosten

| Stufe | Kosten |
| --- | ---: |
| Suche D / C | 0,39 € / 2,65 € |
| Bewertung (2.553 Seiten, 0,012 €/Seite, ohne Batch-Rabatt) | 30,56 € |
| Extraktion (539 Seiten, 0,020 €/Seite) | 10,74 € |
| Modell-Verortung (1.450 Aufrufe) | 5,31 € |
| **gesamt** | **49,65 €** (Obergrenze 40 €, am 29.10. auf 50 € erhöht) |

Die Schätzung von ~22 € lag um das Doppelte daneben (Befund B36): zwei Suchwege × 40 Treffer ergaben 2.553 statt
1.200 Seiten, und die Bewertung kostet je Seite 0,012 € statt 0,007 €. Der Lauf stand nachts einmal, weil das
Guthaben des lokalen Schlüssels aufgebraucht war. In der Pipeline liefe die Bewertung mit 50 % Batch-Rabatt.

## Empfehlung für T8

1. **Das Abdeckungsziel 50 % gegen die Referenz ist mit Web-Quellen nicht erreichbar**, auch nicht mit Revier-Suche
   und besserer Verortung: die Obergrenze der gefundenen Seiten liegt bei ~33 % (≤ 600 m), realistisch bestätigbar
   sind 10–15 % der Bucht-Cluster. Das Ziel braucht entweder einen anderen Nenner (die kanonischen Ankerplätze, nicht
   die nutzergenerierte Spot-Dichte) oder eine andere Quellenklasse (lizenzierte Revierführer, Positionsdaten).
2. **Revier-Suche lohnt sich trotzdem**: 36 bestätigte Cluster für 50 € gegen 5 korrekte Plätze für 51 € im
   Hauptlauf, bei gleichem Nenner. Wenn weitergebaut wird, dann Quelle-zuerst mit beiden Suchwegen – aber erst nach
   Punkt 1.
3. **Verortung ist der Hebel, nicht die Suche**: englische Seglernamen ins Gazetteer (B37), Wortstamm-Abgleich
   (PR #47), Revier-Zuordnung je Nennung vor der Verortung (B38), Lagebeschreibungen nutzen, Hafen- und Kai-Positionen
   statt Polygon-Mittelpunkte (B39). Koordinaten aus Seiten sind, wo vorhanden, auf 150 m brauchbar.
4. **Vor dem nächsten Lauf eine Kostenprobe mit 10 % des Umfangs**, dann hochrechnen; die Schätzung aus diesem Pilot
   war um Faktor 2 zu niedrig.

Befunde: B36–B39 in `docs/pilot/pruefung/befunde.md`.

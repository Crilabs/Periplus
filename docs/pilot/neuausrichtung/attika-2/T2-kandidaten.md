# T2 – Kandidaten, Geometrie, Dinge an Land GR-I (Attika 2)

## Step 1: Lauf

Alle Stufen liefen im „Aufbauen“-Lauf `01a179cc…` (Ruling in T1). Zwei Fehler, beide behoben und nachgeholt:

| Job | Befund | Fix | nachgeholt |
| --- | --- | --- | --- |
| `datasets.import seabed:GR-I` (HTTP 400) | B18 | PR #38 | 27.10. 09:50 (`job_retry`), 6/6 |
| `places.website` (leere Seite) | B27 | PR #39 | 27.10. 09:47 (`job_retry`), 51/51 |

Beide Fixes kamen mit #40 (Bildausschnitt, Spec 19) am 27.10. 00:23 auf `main`; Produktion danach auf `0c92e5e`,
Migration 0083, `configHash` `9f0381c786f09f7b` (vorher `235619fe91b05187`), `gateConfigHash` unverändert
`7d3da3c5b8cf1d15`.

| Stufe | Jobs | Dauer |
| --- | ---: | --- |
| `seed.tile` | 56 | bis 21:2x |
| `places.website` | 51 | Cent-Bereich (0,28 € Haiku) |
| `geometry.detect_bays` | 56 | 26.10. ~21:30 bis 27.10. ~09:50, Concurrency 1; die ersten Kacheln ~15 min, später deutlich schneller |
| `geometry.place` | 1.668 | ~09:55–10:10, ~2 Jobs/s |
| `gazetteer.land` | 1 | ab ~10:10 |

## Step 2: Kandidaten

Gültige Plätze nach `geometry.place` (alle 56 Kacheln des Rahmens, mit Nachbarn):

| Art | Kandidat | Sperrfläche (`no_anchoring`) |
| --- | ---: | ---: |
| Ankerplatz | 1.574 (davon 1.290 aus berechneten Buchten) | 24 |
| Marina | 55 | 0 |
| Hafen | 14 | 2 |
| **gesamt** | **1.643** | **26** |

N7 hatte 186 Kandidaten ohne Buchtsuche; der Zuwachs kommt fast ganz aus `geometry.detect_bays`.

## Step 3: Kandidaten gegen Referenz (Navily, nur Zählungen)

Gemessen wie `research:gate`: verglichen wird die Ankerposition (Ankerplatz) bzw. die Position (Marina, Hafen),
Nenner = Spots in Kacheln von GR-I ohne `prohibited` und `dry-berthing` = 414.

| nächster Kandidat | Spots | Anteil |
| --- | ---: | ---: |
| ≤ 150 m, Kandidat mit Namen | 55 | 13,3 % |
| ≤ 150 m, nur berechnete Bucht | 20 | 4,8 % |
| 150–300 m | 59 | 14,3 % |
| 300–1.000 m | 232 | 56,0 % |
| > 1.000 m | 48 | 11,6 % |

**Obergrenze der Abdeckung: 18,1 %** (1:1 zugeordnet 72 Spots = 17,4 %), gefordert 50 % (A5). **Tor T2 nicht
erreichbar ohne Nachschärfen.** Kein Spot liegt innerhalb 150 m eines Sperrflächen-Platzes.

Christian (27.10.): Ursache klären und parallel die Rauchprobe T3 fahren.

### Ursache (Stand der Untersuchung)

Probekachel `q025:813:510` (108 Spots, 80 Kandidaten), Uferabstand gegen die Landpolygone:

| | Median Uferabstand |
| --- | ---: |
| Navily-Spots | 64 m |
| Ankerposition, benannte Bucht | 173 m |
| Ankerposition, berechnete Bucht | 237 m |
| Marina / Hafen | 46 m / 13 m |

Median-Abstand Spot → nächster Kandidat: 559 m.

1. **Ankerposition liegt in der Mitte der Ankerfläche** (`anchorArea`: Mittelpunkt des größten Inkreises von Wasser
   3–12 m tief, 30 m vom Land). Allein verschiebt das wenig: mit der Buchtposition statt der Ankerposition 74 statt 75
   Spots ≤ 150 m.
2. **Kandidaten fehlen an ganzen Küstenstücken** (Agistri NO, Ägina W, Methana W/O): dort reihen sich Spots ufernah an
   fast gerader Küste ohne benannte oder berechnete Bucht. Hypothese: Ankerplätze vor Stränden an offener Küste, die das
   Gerüst nicht als Kandidat kennt. Gemessen nach `gazetteer.land` (551 Strände aus OSM/Wikidata im Rahmen,
   Abstand zum nächsten Stützpunkt der Strandgeometrie):

   | Spots | Strand ≤ 300 m | 300–600 m | kein Strand ≤ 600 m |
   | --- | ---: | ---: | ---: |
   | ohne Kandidat ≤ 150 m (339) | 124 | 49 | 166 |
   | gedeckt (75) | 33 | 17 | 25 |

   Strände erklären gut ein Drittel der Lücke. Selbst ein perfekt gesetzter Kandidat je Strand ≤ 300 m hebt die
   Obergrenze nur auf ~48 % (199/414); 166 fehlende Spots liegen an Küste ohne Strand.

`gazetteer.land` 1/1 und `areas.import` 1/1 ohne Fehler; Lauf `01a179cc…` beendet 27.10. 10:51 (13:52 h ab 20:59).

Christian (27.10., nach der Rauchprobe): Nachschärfen nach `docs/superpowers/specs/2026-10-27-periplus-geruest-nachschaerfen-design.md`
(Ankerposition im Uferband bis 150 m, Strände als Kandidaten, Suchnamen aus Strand/Ort/Kap, Text hebt Schutz höchstens
um 0,1). Danach Gerüst, Seed und Geometrie GR-I neu und Step 3 neu messen; Tor T2 bleibt bis dahin offen.

## Step 3 neu gemessen (nach #42–#45, 27.10.)

Deploy `3b5885ca` (#42 Uferband `geometry-2`, #43 Konsolidierung v4, #44 Strände, #45 `skipBayDetection`). Neulauf GR-I
ohne Kosten, alle ohne Fehler:

| Lauf | Stufen | Ergebnis |
| --- | --- | --- |
| `01a17d33…` Gazetteer | osm, wikidata, geonames, hierarchy | 727 Küstenstrände aus OSM (insgesamt 1.278 Strände im Bestand, davon 487 benannt) |
| `01a17d6e…` Seed | `seed.tile` 56/56 | 247 neue Ankerplatz-Kandidaten vor benannten Stränden |
| `01a17db0…` Geometrie ohne Buchtsuche | `geometry.place` 1.916/1.916 | alle Berechnungen `geometry-2` |

Gültige Plätze: 1.916 (1.889 Kandidaten, 1 bestätigt, 26 Sperrfläche).

| nächster Kandidat | Spots | Anteil | vorher |
| --- | ---: | ---: | ---: |
| ≤ 150 m, Kandidat aus Quelle | 60 | 14,5 % | 13,3 % |
| ≤ 150 m, nur berechnet (Bucht oder Strand) | 44 | 10,6 % | 4,8 % |
| ≤ 150 m, nur Sperrfläche | 1 | 0,2 % | 0 |
| 150–300 m | 85 | 20,5 % | 14,3 % |
| 300–1.000 m | 185 | 44,7 % | 56,0 % |
| > 1.000 m | 39 | 9,4 % | 11,6 % |

**Obergrenze 25,1 %** (104/414, vorher 18,1 %), gefordert 50 %. **Tor T2 nicht erreicht.**

Probekachel `q025:813:510`: Median Uferabstand der Ankerpositionen 92 m (berechnet) / 91 m (benannt), vorher 237 / 173 m;
Spots 64 m. Spots mit Kandidat ≤ 150 m: 27 von 108; Median Spot → nächster Kandidat 471 m (vorher 559 m).

Wo die Lücke bleibt (310 Spots ohne Kandidat ≤ 150 m, Strand = Mittelpunkt ≤ 300 m):

| | Kandidat 150–300 m | Kandidat > 300 m |
| --- | ---: | ---: |
| benannter Strand ≤ 300 m | 19 | 31 |
| nur unbenannter Strand ≤ 300 m | 17 | 32 |
| kein Strand ≤ 300 m | 211 (zusammen) | |

Selbst jeder Spot an einem Strand gedeckt ergäbe ~49 %; zwei Drittel der Lücke liegen an Küste ohne Strand und ohne
Kandidat.

Christian (27.10., nach der Neumessung): Lücke an Küste ohne Strand kostenlos klären und parallel Rauchprobe 2; Tor T2
bleibt offen. Die Obergrenze +0,1 für Schutz aus Text gilt auch für Review-Entscheidungen (bleibt wie gebaut).

### Lücke nach dem Nachschärfen (kostenlos geklärt)

310 Spots ohne Kandidat ≤ 150 m:

| Ursache | Spots |
| --- | ---: |
| mehrere Spots in derselben Bucht: der nächste Kandidat deckt schon einen anderen Spot ≤ 150 m (ein Platz je Bucht) | 45 |
| Strand ≤ 300 m, aber kein Kandidat ≤ 150 m (davon 49 nur unbenannte Strände, nicht suchbar) | 99 |
| kein Strand; Gazetteer-Punkt (Bucht, Hafen) ≤ 500 m, Ankerposition aber > 150 m davon | 118 |
| kein Strand, kein Gazetteer-Punkt ≤ 500 m (gerade Küste) | 93 |

(Überschneidungen: die erste Zeile zählt quer zu den übrigen.)

- Strand-Kandidaten entstehen richtig 60 m vor dem Strand. `geometry.place` setzt ihre Ankerposition danach in das
  Uferband im Umkreis von 600 m und damit oft 150–600 m vom Strand weg (Probekachel: 18 von 24 benannten Stränden).
  Der Vorrang „Uferband vor dem Strand“ aus dem Design (Teil 1) ist nicht gebaut. Gewicht klein: mit der Platzposition
  statt der Ankerposition 107 statt 104 Spots.
- Die Lücke ist strukturell: Die Referenz kennt Spots an fast jeder Küste, auch mehrere je Bucht und an gerader Küste
  ohne Namen; das Gerüst kennt einen Platz je benanntem Merkmal. Weiteres Nachschärfen am Gerüst bringt nach dieser
  Zerlegung höchstens einige Prozentpunkte; 50 % bei 150 m sind so nicht erreichbar.

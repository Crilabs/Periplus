# Navily-Tor GR-I

Stand: 2026-10-28. Gemessen wird, welche Plätze bei jeder Schwelle unabhängiger Quellen bestätigt wären, gegen die Referenz (637 Spots in den bearbeiteten Kacheln des Landesteils). Die Referenz ist nie Datenquelle, sie misst nur.

Bearbeitete Kacheln: 31 von 56. Nur Spots in bearbeiteten Kacheln (mit mindestens einem Platz) zählen; Spots mit Ankerverbot oder Trockenliegeplatz zählen nicht zur Abdeckung und stehen nicht in der Fehlliste; ein Platz bei einem Ankerverbot ist ein Fehler, bei einem Trockenliegeplatz ein Konflikt. Das Tor gilt nur mit mindestens 25 bestätigten Plätzen und einer Abdeckung von mindestens 50 % (korrekt zugeordnete Spots je Schwelle).

## Ergebnis je Schwelle

| Schwelle N | bestätigt | korrekt | falsche Art | Position abweichend | Schutz falsch | Konflikte offen | mit Entscheidung | davon „kein Liegeplatz“ | Korrektheit | Ankerverbot | Abdeckung |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 14 | 5 | 0 | 7 | 1 | 1 | 0 | 0 | 35.7 % | 0 | 0.8 % |
| 3 | 11 | 4 | 0 | 6 | 1 | 0 | 0 | 0 | 36.4 % | 0 | 0.6 % |
| 4 | 11 | 4 | 0 | 6 | 1 | 0 | 0 | 0 | 36.4 % | 0 | 0.6 % |
| 5 | 10 | 4 | 0 | 5 | 1 | 0 | 0 | 0 | 40 % | 0 | 0.6 % |

Geliefert bestätigt, aber von der Regel (N=2) nicht gedeckt: 0. Solange es solche Plätze gibt, ist das Tor nicht bestanden.

Falsch geliefert gilt auch ein Sektor, den wir mit Schutzwert von mindestens 0,7 als geschützt liefern, während die Referenz ihn nicht als geschützt nennt („Schutz behauptet, bei der Referenz offen“); ein Platz mit so einem Sektor zählt nicht als korrekt.

## Kernwerte gegen die Referenz (N=2)

Verglichen werden die bestätigten Plätze mit Treffer in der Referenz. Übereinstimmung und Abweichung zählen, wo beide Seiten einen Wert haben; Lücke: die Referenz hat einen Wert, wir nicht; nicht bei Navily: die Referenz sagt nichts dazu; kein Stand: der Platz hat noch keinen Stand. Sonst wird nichts verglichen (Existenz und Position prüft das Tor selbst, Tiefe und Taverne hat die Referenz nicht). Nur der Schutzfehler bricht das Tor.

| Kernwert | Übereinstimmung | Abweichung | Lücke | nicht bei Navily | kein Stand |
| --- | --- | --- | --- | --- | --- |
| Schutz N | 12 | 1 | 0 | 0 | 0 |
| Schutz NE | 10 | 3 | 0 | 0 | 0 |
| Schutz E | 13 | 0 | 0 | 0 | 0 |
| Schutz SE | 12 | 1 | 0 | 0 | 0 |
| Schutz S | 11 | 2 | 0 | 0 | 0 |
| Schutz SW | 10 | 3 | 0 | 0 | 0 |
| Schutz W | 12 | 1 | 0 | 0 | 0 |
| Schutz NW | 13 | 0 | 0 | 0 | 0 |
| Grund | 3 | 3 | 0 | 7 | 0 |
| Bojen | 0 | 0 | 0 | 13 | 0 |
| Wasser | 0 | 1 | 5 | 7 | 0 |
| Versorgung | 5 | 1 | 0 | 7 | 0 |

## Fehlliste: Spots ohne bestätigten Platz, nach Grund

| Grund | N=2 | N=3 | N=4 | N=5 |
| --- | --- | --- | --- | --- |
| kein Kandidat in der Nähe | 486 | 486 | 486 | 486 |
| Kandidat gehört schon zu einem anderen Spot | 2 | 1 | 1 | 0 |
| Status vom Admin gesetzt, nicht bestätigt | 0 | 0 | 0 | 0 |
| Kandidat ohne Namen | 26 | 26 | 26 | 26 |
| Kandidat ohne Suchtreffer | 10 | 10 | 10 | 10 |
| zu wenige unabhängige Quellen | 98 | 101 | 101 | 103 |
| negative Belege | 1 | 1 | 1 | 1 |
| Schutzgebiet mit Ankerverbot | 1 | 1 | 1 | 1 |
| abgelehnt oder aufgegeben | 0 | 0 | 0 | 0 |

Die Einzellisten (Fehlliste, Fehler und Konflikte: Platz-ID, Grund, Abstand, Spot-Index) liegen nur außerhalb des Repos (`--out-dir`).

## Gewählte Schwelle

Tor nicht bestanden: bei keiner Schwelle sind alle bestätigten Plätze korrekt, es gibt offene Konflikte. Gewählt wird die kleinste Schwelle mit Korrektheit 100 % ohne offene Konflikte mit mindestens 25 bestätigten Plätzen und ausreichender Abdeckung; bisher gibt es keine.

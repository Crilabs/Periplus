# Navily-Tor GR-I

Stand: 2026-10-23. Gemessen wird, welche Plätze bei jeder Schwelle unabhängiger Quellen bestätigt wären, gegen die Referenz (558 Spots im Landesteil). Die Referenz ist nie Datenquelle, sie misst nur.

## Ergebnis je Schwelle

| Schwelle N | bestätigt | korrekt | falsche Art | Position abweichend | Konflikte offen | mit Entscheidung | davon „kein Liegeplatz“ | Korrektheit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 100 % |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |

Geliefert bestätigt, aber von der Regel (N=2) nicht gedeckt: 0. Solange es solche Plätze gibt, ist das Tor nicht bestanden.

Kernwerte gegen die Referenz: noch nicht verglichen (bekannte Lücke).

## Fehlliste: Spots ohne bestätigten Platz, nach Grund

| Grund | N=2 | N=3 | N=4 | N=5 |
| --- | --- | --- | --- | --- |
| kein Kandidat in der Nähe | 529 | 529 | 529 | 529 |
| Kandidat gehört schon zu einem anderen Spot | 0 | 0 | 0 | 0 |
| Status vom Admin gesetzt, nicht bestätigt | 0 | 0 | 0 | 0 |
| Kandidat ohne Namen | 7 | 7 | 7 | 7 |
| Kandidat ohne Suchtreffer | 1 | 2 | 2 | 2 |
| zu wenige unabhängige Quellen | 12 | 13 | 13 | 13 |
| negative Belege | 7 | 7 | 7 | 7 |
| Schutzgebiet mit Ankerverbot | 0 | 0 | 0 | 0 |
| abgelehnt oder aufgegeben | 0 | 0 | 0 | 0 |

Die Einzellisten (Fehlliste, Fehler und Konflikte: Platz-ID, Grund, Abstand, Spot-Index) liegen nur außerhalb des Repos (`--out-dir`).

## Gewählte Schwelle

Kleinste Schwelle mit Korrektheit 100 % ohne offene Konflikte: **N=2**. Tor bestanden bei N=2.

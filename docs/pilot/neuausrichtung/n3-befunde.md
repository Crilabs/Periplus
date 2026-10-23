# N3 – Erster Tor-Lauf GR-I: Befunde und Entscheidung

Lauf `01a16a03-3874-73b1-ae0e-6c5c2649f74b` (23.10.2026), Abgleich `docs/pilot/neuausrichtung/n3-tor.md`. Nur Zählungen, keine Werte der Referenz.

## Entscheidung

**Tor nicht freigegeben** (`gate.released` bleibt `false`), obwohl der Bericht formal „bestanden bei N=2“ meldet: 2 bestätigte Plätze sind keine belastbare Stichprobe.

## Befunde

1. **Gemessen wurde der ganze Landesteil, bearbeitet ist nur eine Kachel.** Kandidaten gibt es nur in der Probekachel `q025:813:510` (90 Plätze, 1 von 34 Kacheln des Landesteils). 529 der 558 Referenz-Spots liegen außerhalb und erscheinen als „kein Kandidat in der Nähe“. Das Tor muss sich auf Kacheln beschränken, in denen Seed und Geometrie gelaufen sind.
2. **In der Probekachel (29 Spots):** 2 korrekt bestätigt, 7 Kandidat ohne Namen, 1 ohne Suchtreffer, 12 zu wenige unabhängige Quellen, 7 durch Negativbeleg gesperrt.
3. **Wenige Belege aus erster Hand:** von 93 Signalen nur 11 positive aus erster Hand (5 geankert, 6 festgemacht); `listed_as_berth` 36-mal, aber nicht aus Revierführern.
4. **„Kein Platz“ als Negativbeleg sperrt Marinas und Häfen**, meist aus undatierten Seiten (Abrufdatum = aktuell) und im Sinne „oft voll“, nicht „dauerhaft kein Platz“.
5. **Marinas ohne offizielle Seite:** die vorhandene Website-Zuordnung der Marinas (`place_websites`) fließt nicht in die Recherche ein.
6. Alte Bestätigungen (6 Buchten, 4 Marinas nach alten Regeln) wurden von der neuen Regel zurückgenommen.

## Nächste Schritte (Plan N3b)

Tor nur über bearbeitete Kacheln und mit Mindestzahl bestätigter Plätze; „kein Platz“ nur dauerhaft; Marina-Websites als Treffer; Suchvorlagen und Prompt für Belege aus erster Hand; ganzen Landesteil GR-I aufbauen; Tor-Lauf wiederholen.

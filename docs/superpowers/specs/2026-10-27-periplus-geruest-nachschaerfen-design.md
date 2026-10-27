# Gerüst nachschärfen (Attika 2, B28) und Schutz aus Text (Rauchprobe)

Stand: 27.10.2026. Anlass: Testlauf Attika 2, T2 Step 3 und T3 Step 1. Entscheidung Christian (27.10.): Ankerposition
ufernah, Strände als Kandidaten, unbenannte Kandidaten benennen; den Schutzfehler sofort untersuchen.

## Befund

- Kandidaten-Obergrenze 18,1 % (75 von 414 Navily-Spots in Kacheln von GR-I mit Kandidat ≤ 150 m), gefordert 50 %.
- Probekachel: Navily-Spots im Median 64 m vor dem Ufer, unsere Ankerpositionen 173 m (benannte Buchten) bzw. 237 m
  (berechnete). Median Spot → nächster Kandidat 559 m.
- 124 der 339 Spots ohne Kandidat haben einen Strand ≤ 300 m.
- 1.290 berechnete Buchten (79 % der Kandidaten) werden nie gesucht, weil sie keinen Namen haben; die Entdeckung fand in
  der Rauchprobe 0 neue Kandidaten.
- Rauchprobe: 4 bestätigt, 1 korrekt. Zwei Positionsfehler (466 m Marina, 554 m große Bucht), ein Schutzfehler.

## 1. Ankerposition ufernah (Spec 04, Schritt 8)

Heute: Mittelpunkt des größten Inkreises der Ankerfläche (Wasser 3–12 m tief, ≥ 30 m vom Land, im Umkreis 600 m um
den Buchtpunkt). Das ist der Punkt, der am weitesten von allen Rändern entfernt ist, also systematisch in der Mitte.

Neu: Die Ankerposition liegt im **Uferband** der Ankerfläche: dem Teil, der höchstens `nearshoreM` von der
Land-Freihaltezone entfernt ist (Annahme: `nearshoreM` = 120 m, also 30–150 m vom Land; in `config/geometry.json`).
Position = Mittelpunkt des größten Inkreises dieses Bands; ist es leer, gilt die heutige Regel.

Zusätzlich gilt für eine Bucht mit Strand (Abschnitt 2): das Uferband vor dem Strand hat Vorrang, weil dort geankert wird
(Annahme).

Messung vor dem Bauen nicht möglich (Navily geht nicht an den Server); nach Deploy kostenlos: `geometry_start GR-I`, dann
dieselbe Obergrenzen-Rechnung wie T2 Step 3.

## 2. Strände als Kandidaten (Spec Neuausrichtung 5.2)

Heute: Kandidaten sind Buchten, Häfen, Marinas, Seezeichen-Ankerplätze, Bojenfelder.

Neu: Ein **Strand** (OSM `natural=beach`, Kategorie `beach`) an der Küste wird Ankerplatz-Kandidat, wenn vor ihm
Ankerwasser liegt (Ankerfläche nicht leer). Er trägt den Namen des Strands (suchbar: „{name} anchorage“). Liegt sein
Kandidat ≤ `mergeM` (Annahme 300 m) von einem Bucht-Kandidaten, wird kein zweiter Platz angelegt; der Strand gibt dem
Bucht-Kandidaten Namen (falls unbenannt) und die Uferrichtung für die Ankerposition.

Woher die Strände kommen: heute nur aus `gazetteer.land` („Dinge an Land“, läuft nach `seed.tile` und nur in Reichweite
der Kandidaten). Neu holt `gazetteer.osm` die **Küstenstrände** einer Kachel (Strand ≤ 50 m vom Land-Rand) als Gerüst,
vor `seed.tile` (Annahme: eine zusätzliche Overpass-Abfrage je Kachel-Block wie die Buchten). Unbenannte Strände nur
dann, wenn kein Bucht-Kandidat in `mergeM` liegt.

Erwartung: Obergrenze bis ~48 % (Strand-Spots), zusammen mit 1. mehr.

## 3. Unbenannte Kandidaten benennen

Heute: Ein Platz ohne Namen wird nicht gesucht (Fehlliste „Kandidat ohne Namen“).

Neu: Ein unbenannter Kandidat bekommt **Suchnamen aus der Nachbarschaft**, keine Namen für die Lieferung:

- Strand ≤ 300 m (aus 2.) → „{strand} anchorage“ usw. wie ein eigener Name;
- sonst Ort, Kap oder Insel ≤ 1,5 km → nur die Vorlagen „anchorage near {ort}“, „{ort} {insel} anchorage“ (eigene
  Vorlagengruppe `nearby` in `config/research.json`, Annahme 4 Vorlagen statt 16).

Die Zuordnung eines Treffers zum Platz bleibt die heutige (Umkreis, Bewertung je Seite). Der Name eines bestätigten
Platzes kommt weiter nur aus Quellen (Spec 5.5), nicht aus dem Suchnamen.

Kosten: GR-I hat 1.290 berechnete Buchten. Mit 4 Vorlagen und gemeinsamer Suche je Nachbarname (mehrere Buchten bei
demselben Ort teilen sich eine Suche) geschätzt 300–400 zusätzliche Suchanfragen und ~0,10 € je Platz für die
Seitenbewertung (Seiten werden je URL einmal bewertet) → grob 100–150 € für GR-I. Wird in der Rauchprobe gemessen.

## 4. Schutz aus Text (Rauchprobe, sicherheitsrelevant)

Befund: Ein Revierführer aus erster Hand schreibt zu der Bucht „Protection: Very good from any direction“. Die
Konsolidierung (`shelterRule`, `config/consolidation/v3.json`) korrigiert die gerechnete Basis um bis zu
`maxCorrection` = 0,3 **nach oben wie nach unten**. Aus S 0,60 / SW 0,63 / W 0,68 / SE 0,72 (gerechnet, Fetch 1,5–3,8
km über den Kanal) wurde überall 0,9. Die Referenz nennt SE, S, SW, W offen.

Vorschlag: Text darf Schutz **senken** wie heute, aber nur begrenzt **heben** (`maxRaise`, Annahme 0,1; neue
Konsolidierungs-Version v4). Begründung: Sicherheit zuerst; eine Pauschalaussage („any direction“) ersetzt keine
Rechnung je Sektor, eine Warnung („exposed to S“) schon. Mit 0,1 bleiben SW 0,73, W 0,78, SE 0,82 über der Schwelle
0,7 der Referenz-Prüfung; mit 0 bliebe SE 0,72. Die gerechnete Kurve selbst (Fetch 1,5–3 km → 0,6–0,72) ist großzügig;
ob sie nachgestellt wird, entscheidet T5 mit allen bestätigten Plätzen.

## Reihenfolge und Prüfung

Ein Branch je Teil (`fix/anchor-nearshore`, `feat/beach-candidates`, `feat/search-nearby-names`, `fix/shelter-raise`),
je mit Tests (TDD), PR zur Freigabe. Danach auf Produktion: Gazetteer/Seed/Geometrie GR-I neu (kostenlos), Obergrenze
neu messen (Tor ≥ 50 %), dann Rauchprobe 2 in derselben Probekachel (~15 €) und erst dann der Hauptlauf.

## Umsetzung (27.10.)

| Teil | PR | Abweichung |
| --- | --- | --- |
| 1. Ankerposition im Uferband (`nearshoreM` 120, `geometry-2`) | #42 | – |
| 2. Strände als Kandidaten (`beachCandidates` coastM 50, mergeM 300, offshoreM 60) | #44 | unbenannte Strände werden keine Kandidaten (nicht suchbar) |
| 3. Suchnamen | #44 | nur über Strände: eine unbenannte Bucht ≤ 300 m vor einem benannten Strand übernimmt dessen Namen. **Keine Suchnamen aus Ort/Kap:** eine Seite zählt nur, wenn sie den Liegeplatz nennt (N3, `assign.ts`); „anchorage near {ort}“ nennt eine unbenannte Bucht nie, die Suchen kosteten nur |
| 4. Text hebt Schutz höchstens um 0,1 (Konsolidierung v4) | #43 | gilt auch für Review-Entscheidungen (die Regel behandelt sie wie Texte) |
| Neulauf ohne Buchtsuche (`geometry_start` `skipBayDetection`) | #45 | neu, Entscheidung Christian |

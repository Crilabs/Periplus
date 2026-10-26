# Periplus 19 – Bildausschnitt und Licht der Ortsbilder

Stand 26.10.2026, umgesetzt mit Plan `docs/superpowers/plans/2026-10-26-periplus-19-bildausschnitt-licht.md`. Ergänzt Teil-Spec 13 (Ortsbilder) und ersetzt dort die Kameraregeln des Titelbilds (Teil B,
`camera-3`), die Komposition „Ankerplatz bei einer Stadt“, die Lichtregel „bei einer Stadt“ (Teil C) und die Boots-Blöcke
des Prompts. Alles Übrige aus Spec 13 gilt weiter (Quellen, Rendering-Aufbau, Prüfung, Freigabe, Vertrag).

Grundlage ist eine Laborreihe vom 26.10.2026 (zwölf Runden ohne Bildmodell, danach 16 Bilder mit Bildmodell) an den
Orten des Testlaufs Attika: 16 Ankerplätze, 9 Marinas, 1 Hafen.

## Absicht

Die Ortsbilder sind Katalogbilder. Sie sollen einen Eindruck der Bucht oder des Hafens vermitteln und den Liegeplatz
erkennbar zeigen: die Marina ganz, die Ankerbucht mittig, nah genug, dass man sie versteht.

Die Bilder bis `camera-3` taten das oft nicht. Teile der Marina waren abgeschnitten, das Becken lag am unteren Rand,
Buchten waren zu weit weg oder lagen am oberen Rand. Bei Buchten mit Ort bestimmte der Ort die Perspektive, auch wenn er
für den Ankerplatz keine Rolle spielt.

## Ziele

1. Der Liegeplatz liegt vollständig und mittig im Bild: das Becken bei Marina und Hafen, die Bucht mit ihrem Ufer beim
   Ankerplatz.
2. Die Kamera wird aus dem Umriss des Liegeplatzes bestimmt, nicht aus festen Höhen.
3. Ob ein Ausschnitt taugt, wird vor dem Rendern geprüft, ohne Rendering und ohne Bildmodell.
4. Abendlicht mit Beleuchtung nur dort, wo es etwas zu beleuchten gibt: Marina, Hafen, Ankerplatz bei einer größeren
   Stadt.
5. Das Bildmodell erfindet nichts, was eine falsche Aussage wäre (Bauten auf dem Wasser), und lässt nichts weg, was eine
   Gefahr ist (Fischzucht).

## Nicht-Ziele

- **Boote an Ankerplätzen.** Ein Boot sagt „hier ankert man“ und müsste auf Sand, außerhalb von Seegras, an der richtigen
  Stelle stehen. Das verlangt Daten, die es nicht weltweit und nicht genau genug gibt (Abschnitt „Verworfen“).
  Entscheidung Christian, 26.10.2026: „dann lieber ohne Boot“.
- Inselbilder und weitere Ansichten mit eigener Komposition (bleiben wie in Spec 13).
- Bessere Ankerflächen. Die Datenbefunde (Abschnitt „Datenbefunde“) gehören in die Geometrie (Teil-Spec 04) und werden
  dort geplant.

## Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft)

- Das Bild zeigt eine andere Bucht als den Ankerplatz, oder es bleibt unklar, welche gemeint ist.
- Das Bildmodell malt Gebäude, Hütten oder Plattformen aufs Wasser, eine belebte Promenade an ein Dorf mit drei Häusern
  oder entfernt eine Fischzucht.
- Die Kamera wird erst nach dem bezahlten Bild als untauglich erkannt.

## Entscheidungen (Christian, 26.10.2026)

- **Neigung 40°, Füllung 60 %:** der Liegeplatz nimmt höchstens 60 % von Breite und Höhe ein. Die Kamerahöhe ergibt sich
  daraus.
- **Die Komposition „Ankerplatz bei einer Stadt“ entfällt.** Auch bei einem Ort in der Nähe gilt die Regel für
  Ankerplätze.
- **Marina ohne Beckenumriss:** das Becken wird aus den OSM-Molen und -Stegen abgeleitet.
- **Blickrichtung am Ankerplatz:** zur durchschnittlichen Küstenlinie, nicht zum nächsten Ufer und nicht zum Ort. Die
  Richtung nach Highlights (Runde 6) war schlechter, weil ein Ort im Hintergrund die Perspektive bestimmte, ohne für den
  Ankerplatz wichtig zu sein.
- **Licht:** Häfen und Ankerplätze bei einer größeren Stadt am Abend mit Beleuchtung, alle anderen mittags.
- **Fischzucht:** Fischzuchtanlagen bleiben im Bild, weil sie Gefahrenstellen sind.
- **Keine Boote an Ankerplätzen.** An Ankerplätzen bei einer Stadt werden keine Boote hinzugefügt.

## Teil A: Kamera aus dem Umriss

Gemeinsames Verfahren für alle Ortsarten: ein **Fokus** (ein oder mehrere Polygone) wird mit derselben three.js-Kamera
projiziert, mit der gerendert wird.

**Ergebnis:** gesucht ist die niedrigste Kamera, bei der der Fokus

- ganz im sicheren Bereich liegt (10 % Abstand zu jedem Rand),
- höchstens den Anteil `fill` von Breite und Höhe einnimmt,
- mit seiner Mitte auf der vorgegebenen Bildhöhe liegt.

**Suche:**

- **Höhe:** von `minHeightM` (100 m) bis `maxHeightM` (900 m), in Schritten von × 1,04.
- **Blickziel:** wird je Höhe bis zu 15-mal seitlich und in Blickrichtung nachgeführt, bis die Fokusmitte auf ±2 % der
  Bildmaße sitzt.
- **Bodenpunkt:** liegt der Bodenpunkt der Kamera über Land, wird wie bisher der Azimut in 10°-Schritten gedreht.

Die Kamerahöhe ergibt sich aus dem Umriss. Untergrenze ist die Höhe der Titel-Zoomstufe, die das Luftbild erlaubt
(`titleZoomFor`): mit Kataster z2 (160 m), nur mit Sentinel-2 z1 (260 m). Die Zoomstufe bleibt damit Teil des
Erzeugungsschlüssels wie in Spec 13.

Weitere Ansichten (Slots `view-<n>`, von einem Admin angelegt) behalten ihre Zoomstufen z1–z3 und die Regeln aus Spec 13.

### Marina und Hafen

| Fokus | Wann |
| --- | --- |
| Wasserfläche des Beckens (`anchor_area.outputs.water`) | Der Ort ist in OSM eine Fläche |
| Hülle der Molen und Stege | Der Ort ist ein Punkt. Gebildet aus allen OSM-Linien `man_made=pier|breakwater|groyne` innerhalb von 300 m um den Punkt, jede Linie 25 m verbreitert, darum die konvexe Hülle. Im Testlauf haben 32 von 41 Punkt-Marinas und -Häfen solche Linien |
| Regel aus Spec 13 (`camera-3`) | Punkt ohne Molen und Stege |

Neigung 40°, Füllung 60 %, Fokusmitte 5 % unter der Bildmitte. Startrichtung ist die bisherige
(`baseAzimuthFor`).

**Ergebnis:** In allen 9 Marinas und dem Hafen liegen Molen und Stege vollständig und mittig im Bild. Die Bilder mit
Bildmodell (Abend) gehören zu den stärksten der Reihe.

### Ankerplatz: Ankerfenster entlang der Küstenlinie

Die Ankerfläche aus der Geometrie (EMODnet, 115-m-Zellen) taugt als Fokus nicht. Sie ist zu grob, überdeckt Flachwasser,
verfehlt kleine Buchten und lag in den Runden 1–5 oft quer zur sichtbaren Bucht. Fokus ist darum ein **Ankerfenster** um
den Ankerpunkt (`anchor_position`, sonst `position`):

1. **Küstenrichtung:** 36 Strahlen im 10°-Abstand bis 1.500 m vom Ankerpunkt, je Strahl das erste Land (Landpolygone).
   Die Blickrichtung ist der Mittelwert der Richtungen mit Land, jede gewichtet mit 1 / Entfernung (mindestens 50 m). Die
   Kamera schaut damit in die Bucht hinein, auch wenn das nächste Ufer seitlich liegt.
2. **Uferpunkt:** das erste Land vom Ankerpunkt aus in Küstenrichtung. Ohne Land in dieser Richtung gilt das nächste Land.
3. **Fensterpunkt:** auf der Linie Uferpunkt → Ankerpunkt, höchstens 100 bzw. 150 m vor dem Ufer. Ein Ankerpunkt, der
   näher am Ufer liegt, bleibt, wo er ist.
4. **Fokus:** ein Kreis mit dem Fensterradius (100 bzw. 150 m) um den Fensterpunkt, dazu ein Kreis von 60 m um den
   Uferpunkt (Strand, Ufer dahinter).
5. **Abstimmung:** Jede Kombination wird angepasst (Teil A) und vorab geprüft (Teil B):
   - Fensterradius 100 oder 150 m,
   - Neigung 40° oder 45°,
   - Fokusmitte 5 %, 15 % oder 22,5 % unter der Bildmitte,
   - Azimut bis ±30° um die direkte Sicht auf den Uferpunkt.

   Gewählt wird die Kombination mit der kleinsten Bewertung:

   > |vorhergesagter Wasseranteil − 0,45| × 20 + Abweichung von der direkten Sicht in Grad / 10
   > + max(0, Höhe − 350 m) / 50 − Highlights / 2

   Highlights zählen nur, wenn sie innerhalb von 800 m liegen und im Bild sind:
   - Gewicht je Kategorie: Essen 3, Strand 2, Versorgung 2, Kultur 1, Aktiv 1;
   - doppelt innerhalb von 500 m;
   - je Kategorie zählt nur das höchste Gewicht.

**Ergebnis Runde 12 (16 Ankerplätze):**

- Höhe meist 365 m, an zwei Plätzen 337 bzw. 379 m, Neigung 40° (45° an zwei Plätzen).
- Gemessener Wasseranteil 36–53 %.

| Bewertung | Orte |
| --- | --- |
| Gut: Bucht klar und mittig (10) | Kalamaki, Agios Nikolaos, Almyropigada, Aegina, Poros, Nisiza, Karathona, Vathy Avlaki, Boukouraki, Mazari |
| Mäßig (2) | Sarpa (Bucht am rechten Rand, Kap im Bild), Astros (langer Strand, keine Bucht) |
| Schwach (4) | Lefkanti, Agriliou, Stavroti, Marathon: gerade Küste, offene Reede |

Die schwachen Fälle sind keine Kamerafrage. An einer geraden Küste gibt es keine Bucht zu zeigen. Siehe „Datenbefunde“.

## Teil B: Vorab-Prüfung ohne Rendering

Für jede Kandidatenkamera wird der Wasseranteil vorhergesagt, bevor gerendert wird:

- **Verfahren:** ein Raster von 32 × 21 Sehstrahlen wird auf Meereshöhe geschnitten und gegen die Landpolygone geprüft.
  Strahlen über dem Horizont oder weiter als 20 km zählen als Himmel.
- **Treffsicherheit:** in Runde 12 lag die Vorhersage im Mittel 2,5 Prozentpunkte neben dem Wasseranteil der Rendermaske,
  höchstens 5.
- **Kosten:** die Prüfung braucht nur Datenbank und Projektion. Sie läuft im Plan, nicht im Render.
- **Fehlschlag:** Findet keine Kombination eine Kamera über Wasser, endet der Ort wie bisher mit
  `reason: "no_water_view"`.

## Teil C: Detailfenster

Das Kernfenster des Luftbilds (bisher fest 1,5 × 1,5 km um das Blickziel) richtet sich nach dem Bodenabdruck der Kamera:
es umschließt den Boden der unteren zwei Drittel des Bildes mit `window.coreMarginM` (200 m) Rand, mindestens
`window.coreSizeM` (1,5 km), höchstens `window.coreMaxSizeM` (3 km). Das obere Drittel ist ferner Hintergrund, dort reicht
Sentinel-2. Bei 365 m und 40° Neigung bleibt es bei 1,5 km; erst höhere Kameras (etwa 600 m) bekommen ein größeres
Fenster. Die Regel ist eine Annahme aus der Umsetzung (26.10.2026) und wird an den ersten Bildern geprüft.

## Teil D: Licht

| Ort | Licht | Boote |
| --- | --- | --- |
| Marina, Hafen | Abend mit Beleuchtung (`light_evening`) | Boote aus dem Luftbild behalten (`boats_keep`) |
| Ankerplatz, Bojenfeld bei einer größeren Stadt | Abend mit Beleuchtung | Boote aus dem Luftbild behalten, keine hinzufügen (`boats_keep`) |
| Alle anderen Ankerplätze und Bojenfelder | Mittag (`light_midday`) | Boote entfernen (`boats_remove`) |

**„Bei einer größeren Stadt“** heißt: Eine Siedlung mit OSM `place=town|city` liegt im Bild. Das wird vor dem Rendern
geprüft:

- **Projektion:** der Siedlungspunkt wird mit der Kamera projiziert und muss im Bild liegen, mit 5 % Rand.
- **Entfernung:** höchstens `light.townRadiusM` (1.500 m) vom Ankerpunkt.
- **Dorf:** `village` zählt nicht mehr. Der Abend-Prompt verlangt beleuchtete Promenaden, Straßenlaternen und
  Spaziergänger. An einem Dorf mit wenigen Häusern würde das Modell eine Promenade dazuerfinden, die es nicht gibt.

Im Testlauf trifft das Aegina (Ort in 430 m) und Poros (1,2 km). Sarpa, Kalamaki und Astros haben nur ein Dorf in der
Nähe und bleiben mittags.

## Teil E: Prompt v2

`config/prompts/generate-place-image/v2.md`; `promptVersion` 2 in `config/models.json`. Änderungen gegenüber v1:

| Block | Änderung |
| --- | --- |
| `boats_near_town`, `composition_near_town` | entfallen. Die Bootsgröße nennt kein Block, und das Modell malte die hinzugefügten Yachten zwei- bis dreimal zu groß (gemessen an Aegina: 45–60 px statt 15–25 px bei 0,5 m/px) |
| `boats_remove` | ergänzt: entfernte Boote werden durch offenes Wasser mit seinem Grund ersetzt |
| `do_not_add` | ergänzt: nichts steht oder schwimmt auf dem Wasser, keine Gebäude, Hütten, Plattformen. Anlass: an Vathy Avlaki wurde ein Boot aus dem Luftbild zu einem Haus im Wasser |
| `hazards` (neu) | Fischzuchtanlagen (Käfige, Ringe), Muschelleinen, Muringbojen und Fahrwassertonnen bleiben, wo das Rendering sie zeigt, in gleicher Größe, als echte Anlagen gezeichnet. Sie sind Gefahrenstellen und werden nicht entfernt, auch wenn Boote entfernt werden |
| `preserve` | Neigung nicht mehr als Zahl nennen (40° oder 45°), nur „the same downward angle“ (steht schon so) |

Szene: `near_town` entfällt aus `scene` in `config/images.json`. Der Alt-Text richtet sich nach der Ortsart.

**Ergebnis der Probebilder (Prompt v1 mit den Lichtregeln aus Teil D, 10 Bilder):**

- **Abend:** alle 5 Bilder brauchbar: Aegina, Poros, zwei Marinas, ein Hafen. Bei Poros liegt der Sportplatz mittig hinter
  der Bucht, das ist echt, lenkt aber ab.
- **Mittag:** 5 Bilder mit gutem Ausschnitt; schwach ist nur Almyropigada (kleine Bucht am rechten Rand).

## Konfiguration

`config/images.json`:

- `camera.rulesVersion`: `camera-4`. Geht in den Erzeugungsschlüssel ein, alle Titelbilder werden neu erzeugt.
- `composition.fit`:
  `{ "margin": 0.1, "minHeightM": 100, "maxHeightM": 900, "heightStep": 1.04, "centreTolerance": 0.02, "maxIterations": 15 }`
- `composition.harbour`:
  `{ "tiltDeg": 40, "fill": 0.6, "centreY": -0.1, "pierRadiusM": 300, "pierBufferM": 25 }`; die OSM-Arten der Molen stehen beim Datensatz (`config/datasets.json`, `harbourStructures.manMade`: `["pier", "breakwater", "groyne"]`)
- `composition.anchorWindow`:
  `{ "fill": 0.6, "rayMaxM": 1500, "rayStepDeg": 10, "minRayM": 50, "radiiM": [100, 150], "shoreRadiusM": 60, "tilts": [40, 45], "centres": [-0.1, -0.3, -0.45], "spanDeg": 30, "targetWater": 0.45, "maxHeightM": 350, "highlightReachM": 800, "highlightNearM": 500, "highlightWeights": { "food": 3, "beach": 2, "supply": 2, "culture": 1, "active": 1 }, "score": { "water": 20, "offDegPerPoint": 10, "heightMPerPoint": 50, "highlightFactor": 0.5 } }`
- `composition.prediction`: `{ "gridX": 32, "gridY": 21, "maxRayM": 20000 }`
- `window.coreMarginM`: 200; `window.coreMaxSizeM`: 3000.
- `light`:
  - `townPlaces`: `["town", "city"]`;
  - `nearTown`: `"evening"`;
  - `townInFrameMargin`: 0.05.
- Entfällt: `composition.nearTown`, `composition.openWater.zoom` und `composition.openWater.shoreBelowCentreDeg` (bleiben
  nur für die Rückfallregel bei Punkt-Marinas ohne Molen), `scene.near_town`.

`centres` sind Bildkoordinaten von −1 (unten) bis 1 (oben). −0,1 heißt 5 % unter der Bildmitte.

## Umsetzung

- **Kamera:** `lib/domain/images/render-plan.ts` bekommt die Kameraanpassung (`fitCamera`), die Vorab-Prüfung
  (`predictShares`), das Ankerfenster mit Küstenrichtung und die Beckenregel. Die Projektion nutzt dieselbe Kameradefinition
  wie `lib/pipeline/images/render.ts`, damit Vorhersage und Rendering nicht auseinanderlaufen.
- **Molen und Stege:** ein neuer Datensatz `harbour_structures` je Landesteil, geladen wie die Straßen über den
  Overpass-Adapter (`lib/adapters/overpass.ts`), Tabelle `harbour_structures`. Weder lokal noch auf Produktion liegen
  OSM-Stege heute als Linien vor. Plan und Job lesen die Tabelle, ohne Netzaufruf.
- **Ort im Bild:** die Prüfung „Stadt im Bild“ läuft im Plan, nach der Kamerawahl. `lightFor` bekommt die Kamera.
- **Labor:** Das Laborskript `scripts/lab-image-framing.ts` bleibt lokal und wird nicht eingecheckt. Die Logik wird neu in
  `lib/domain/images` geschrieben.

## Tests

- **Kameraanpassung:** ein Quadrat als Fokus liegt nach der Anpassung im sicheren Bereich, bei der Füllung und mit der Mitte
  auf ±2 %; die Höhe steigt mit der Fokusgröße.
- **Küstenrichtung:** gegen `db-test` mit einer künstlichen U-Bucht aus Landpolygonen. Die Blickrichtung zeigt in den
  Buchtscheitel, auch wenn das nächste Ufer seitlich liegt.
- **Beckenregel:** Fläche → Wasserfläche; Punkt mit Stegen → Hülle; Punkt ohne → Rückfallregel.
- **Vorab-Prüfung:** für eine Kamera über einer Küste aus zwei Halbebenen ist der Wasseranteil analytisch bekannt.
- **Licht:** Stadt im Bild → Abend; Stadt außerhalb des Bildes oder nur `village` → Mittag.
- **Prompt:** die Zusammensetzung je Ortsart und Licht als feste Erwartung, mit `hazards` in jeder Variante.
- **Netz:** über `MockModel` und `MockImageModel`, ohne Netz.

## Prüfung vor dem Ausrollen

Ein Probelauf ohne Bildmodell (nur Renderings) über alle Orte des Landesteils GR-I. Christian sieht die Renderings durch,
bevor `camera-4` auf Produktion Bilder erzeugt. Mit Bildmodell danach zuerst 10 Orte (etwa 2,50 €).

## Verworfen

- **Ankerfläche als Fokus** (Runden 1–5): zu grob, siehe „Datenbefunde“.
- **Richtung nach Highlights** (Runde 6): der Ort im Hintergrund bestimmte die Perspektive.
- **Strahlen von der Bucht, nur Landstrahlen, nächstes Ufer** (Runden 7–11): bei gerader Küste oder seitlichem Ufer
  zeigten sie die falsche Bucht oder offenes Wasser.
- **Boote am Ankerplatz:** drei Wege getestet (6 Bilder):
  - **Maßstab im Prompt:** richtige Größe, aber das Modell wählt den Ort selbst. In Kalamaki lag das Boot außerhalb der
    Bucht.
  - **Bootsform im Rendering:** Ort und Größe stimmen.
  - **Sand aus dem Luftbild bestimmt:** in Kalamaki lag das Boot im Seegras, wo Ankern verboten ist. Die Farbe des Luftbilds
    trennt Sand nicht sicher von Seegras: das Wasserzeichen verdeckt Flächen, und tiefer Sand ist so dunkel wie Seegras.
  - **Seegras-Karten als Ausweg:** keine taugliche weltweite Karte. UNEP-WCMC ist zu grob und wohl nicht für kommerzielle
    Nutzung freigegeben, der Allen Coral Atlas deckt nur die Tropen ab. Für das Mittelmeer und Griechenland gibt es Karten
    mit 72–76 % Genauigkeit.

  Der Aufwand steht in keinem Verhältnis zu einem Katalogbild.

## Datenbefunde (für Teil-Spec 04, nicht Teil dieser Umsetzung)

- **Ankerfläche zu grob:**
  - EMODnet-Zellen von 115 m überdecken Flachwasser und verfehlen kleine Buchten.
  - An mehreren Orten passt die Ankerfläche sichtbar nicht zum Luftbild.
  - Am Ankerplatz mit Fischzucht (ff66) überlappt die Ankerfläche die Anlage.
- **Falsche Ortsart:** „Schiffsmuseum Trokadero Marina“ (0ed5) ist als Ankerplatz erfasst. Im Bild liegen Museums- und
  Marineschiffe mittig, ein Ankerplatz ist nicht erkennbar.
- **Buchtpunkte weit draußen:** einige OSM-Buchtpunkte (`position`) liegen weit vor der Küste.
- **Gerade Küsten als „Bucht“:** Lefkanti, Agriliou, Stavroti und Marathon sind offene Reeden. Zu klären ist, ob sie als
  Ankerplatz richtig erfasst sind und was ein gutes Bild für sie wäre.

## Aufwand (grob)

| Teil | Tage |
| --- | --- |
| Kameraanpassung, Vorab-Prüfung, Beckenregel | 1,5 |
| Ankerfenster mit Küstenrichtung und Abstimmung | 1,5 |
| Molen und Stege aus OSM (Geometriestufe) | 1 |
| Detailfenster nach Bodenabdruck | 0,5 |
| Licht „Stadt im Bild“, Prompt v2 | 0,5 |
| Tests, Probelauf GR-I, Runbook | 1 |
| **Summe** | **6** |

## Offene Punkte

- Detailfenster: Regel und Kostenfolge im Labor prüfen (Teil C).
- Gerade Küsten: Bildregel für offene Reeden, abhängig vom Datenbefund.
- Poros: der Sportplatz in der Bildmitte. Highlights nach Kategorie „sport“ abwerten oder hinnehmen?
- Karathona: das Bild aus Runde 11 mit Mole war gleichwertig. Soll bei gleicher Bewertung eine sichtbare Mole den
  Ausschlag geben?
- `hazards` mit einem Ort mit Fischzucht testen, sobald die Ankerfläche dort stimmt.

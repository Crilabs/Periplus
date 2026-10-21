# Periplus 16 – Highlights je Ort: höchstens fünf je Kategorie, Wichtigkeit, Stufe

Stand: 21.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Anlass: Prüfung mit echten Daten (Teil-Spec 12, Befund B8) · Ändert: Teil-Spec 03 (POIs im Gazetteer), 06 (Highlight-Facts), 07 (Wichtigkeit, Highlights je Ort), 08 (Highlights im Vertrag), 09 (Admin-UI) · Quell-Spec: Abschnitt „Highlight“, Fact-Schema „Highlights je Kategorie“

## Zweck

Periplus beliefert einen Törnplaner. Wer abends vor einem Ort liegt, will wissen, was es an Land gibt: Kultur, Essen, Einkaufen, Strand. Eine Liste jeder Gedenktafel und jedes Restaurants von Athen hilft nicht. Gebraucht werden die wichtigsten Dinge, die man nennen würde, und eine Einschätzung, ob es darüber hinaus wenig oder sehr viel gibt.

Die Prüfung mit echten Daten hat gezeigt, dass das heute nicht so gebaut ist: Der Gazetteer übernimmt jedes benannte OSM- und Wikidata-POI im Landesteil ohne Küstenbezug. Für Attika sind das 22.000 POIs, zwei Drittel davon im Zentrum Athens, und 1.218 Paar-Aufgaben aus Baudenkmälern mit Adressen als Namen („Makri 1-3“ ~ „Makri 3“).

Leitgedanke (Christian, 21.10.2026): Ein System entscheidet je Ort, welche Highlights einzeln nötig sind. Auf einer Insel mit nur einer Ruine ist die Ruine das wichtigste Kultur-Highlight. In Athen ist die Stadt selbst das Highlight; einzeln geführt werden die Akropolis und wenige weitere, und für den Rest genügt das Wissen, dass es dort sehr viel davon gibt.

## Entscheidungen

- Je Ort und Kategorie werden **höchstens fünf Highlights** einzeln geführt (Christian).
- Diese Highlights werden **vollständig erfasst wie bisher**: Geo-Objekt mit `hl_`-ID, Position, Namen, Quellen, Zuordnung zu Spots, Lieferung in `highlights.json` (Christian).
- **Jedes Highlight hat eine Wichtigkeit 1–5, die über Orte hinweg vergleichbar ist**: Die Akropolis ist wichtiger als die Ruine auf der Insel, auch wenn beide bei ihrem Ort die Nummer eins der Kultur sind (Christian).
- Statt einer Zählung „und 240 weitere“ bekommt jeder Ort je Kategorie eine **Stufe**: „nur das“, „einiges mehr“, „sehr viel mehr“. Ein Planer, der Kultur gewichtet, muss erkennen, dass Athen interessanter ist als die einsame Insel mit einer Ruine (Christian).
- Wichtigkeit und Stufe werden **berechnet**, nicht von einem Modell geschätzt. Trägt die Rechnung mit echten Daten nicht, kommt eine Modell-Einschätzung mit Belegen dazu (Christian: „wenn die Rechnung ok ist, können wir erstmal damit gehen“).
- **Reichweite** schließt Taxi, Bus und Ausflug ein, nicht nur den Fußweg (Christian). Sie hängt von der Wichtigkeit ab (Vorschlag Claude, von Christian bestätigt).

## Begriffe

| Begriff | Bedeutung |
| --- | --- |
| **POI-Kandidat** | Geo-Objekt vom Typ `poi` aus OSM oder Wikidata mit Kategorie. Rohmaterial für die Auswahl; wird nicht geliefert und nicht geprüft, solange es nicht ausgewählt ist. |
| **Highlight** | POI-Kandidat, der bei mindestens einem Ort unter den fünf wichtigsten seiner Kategorie in Reichweite ist. Nur Highlights werden geliefert, auf Dubletten geprüft und in der Oberfläche als solche gezeigt. |
| **Reichweite** | Luftlinie vom Liegeplatz (Ankerposition, sonst Ortsposition) zum POI, bis zu der er für den Ort zählt; abhängig von der Wichtigkeit des POI. |
| **Stufe** | je Ort und Kategorie: `none` (nur das), `some` (einiges mehr), `many` (sehr viel mehr). |

Die Kategorien sind die bisherigen aus `config/categories.json` und dem Vertrag: `food`, `supply`, `beach`, `nature`, `active`, `culture`, `town`. `quiet` bleibt eine berechnete Spot-Eigenschaft, keine Highlight-Kategorie (Quell-Spec).

## Gazetteer (ändert Teil-Spec 03)

- POIs werden weiter aus OSM (`config/categories.json`) und Wikidata (`wikidata.classes` → `poi`) geholt, aber nur bis `gazetteer.poiCoastDistanceKm` (Start 20) zur Küste; das ist die größte Reichweite (unten). Weiter im Land liegende POIs werden beim Import übersprungen und gezählt.
- Für POIs entstehen beim Import **keine Paar-Aufgaben** mehr. Ein unsicherer Wikidata-Treffer zwischen zwei POIs bleibt ein eigenes Objekt; die Dubletten-Prüfung findet erst unter Highlights statt (unten). Für alle anderen Typen bleibt die Zusammenführung wie bisher.
- Die bestehenden offenen Paar-Aufgaben zwischen zwei POIs werden mit der Umstellung als hinfällig geschlossen (Muster der Migration 0052).

## Wichtigkeit (ändert Teil-Spec 07)

Die Wichtigkeit eines POI-Kandidaten bleibt die bestehende Rechnung `importanceOf` (`config/consolidation/<version>.json`, `importance`): Punkte aus unabhängigen Textquellen, die den POI nennen, aus Wikipedia-Sitelinks und einem Bonus je Kategorie; daraus über Schwellen die Stufe 1–5. Ergänzt wird:

- **Bonus je Art** (`importance.tagBonus`): OSM- und Wikidata-Arten, die schon für sich Bedeutung tragen, z. B. `historic=castle|archaeological_site|monastery`, `tourism=museum`, `man_made=lighthouse`, `natural=cave_entrance`; Gedenktafeln, Wegkreuze, Grenzsteine, einzelne denkmalgeschützte Wohnhäuser bekommen keinen Bonus. Die Liste steht in der Konfiguration.
- Die Wichtigkeit wird für **jeden** POI-Kandidaten in Reichweite eines Orts gerechnet, nicht nur für gelieferte. Sie ist die Grundlage der Auswahl.
- **Nur die Wichtigkeit, kein volles Profil** für Kandidaten (Entscheidung Claude): Ein Kandidat bekommt keine Zusammenfassung vom Modell, keine Konflikt-Aufgaben, kein Ortsbild und keine Änderungsereignisse. Die volle Konsolidierung eines POI (Profil, `consolidation.summary`, Änderungs-Feed) läuft nur für Highlights. Grund: Attika hätte sonst rund 22.000 zusätzliche Modellaufrufe.
- Der Bonus gilt für OSM-Tags **und** Wikidata-Klassen nebeneinander (Entscheidung Claude). Dafür kommt `man_made` auf die Liste der gespeicherten OSM-Tags, und ein Wikidata-POI speichert seine Klasse in `tags` (`wikidata_class`), ohne Schemaänderung. Beides wirkt erst nach einem neuen Gazetteer-Lauf; die Umstellung rechnet `GR-I` ohnehin neu.

Der Builder kalibriert Schwellen und Boni an echten Daten aus `GR-I`, bis gilt: Akropolis 5; Tempel von Aphaia (Ägina), Kloster Zoodochos Pigi (Poros) 3–4; eine namenlose Kapelle oder eine einzelne Taverne ohne Textnennung 1–2.

## Auswahl je Ort (neu)

Für jeden Ort (Status, wie ihn `delivery.spots.statuses` liefert) und jede Kategorie:

1. **Kandidaten in Reichweite:** alle POI-Kandidaten der Kategorie, deren Luftlinie zum Liegeplatz höchstens `highlights.reachKm[Wichtigkeit]` beträgt. Startwerte: Wichtigkeit 1–2 → 1 km (zu Fuß), 3 → 5 km (Taxi, Bus), 4–5 → 20 km (Ausflug).
2. **Rangfolge:** Wichtigkeit absteigend, dann Punktzahl der Wichtigkeitsrechnung absteigend, dann Entfernung aufsteigend, dann ID.
3. **Die ersten `highlights.maxPerCategory` (5)** sind die Highlights des Orts in dieser Kategorie.
4. **Stufe** aus dem Rest (alle Kandidaten in Reichweite außer den fünf): gewichtete Summe `Σ highlights.levelWeights[Wichtigkeit]` (Start `[0.1, 0.5, 2, 5, 10]`, damit tausend Kleinigkeiten nicht so viel zählen wie zehn bedeutende Ziele). Unter `highlights.levelThresholds[0]` → `none`, unter `[1]` → `some`, sonst `many`. Startwerte setzt der Builder so, dass Agistri bei Kultur `none`, Poros `some` und Piräus/Athen `many` ergibt.
5. **Texte zählen mit:** Ein Fact `highlight.<category>` aus Texten mit einem Namen, der keinem POI zugeordnet ist, zählt in der Stufe wie ein Kandidat der Wichtigkeit 2. Ein Name, der einem POI zugeordnet ist, hebt über die Textquellen dessen Wichtigkeit (wie bisher).

**Dubletten vor der Rangfolge** (Entscheidung Claude): Kandidaten derselben Kategorie mit gleichem normalisierten Namen näher als `validation.highlightDuplicateM` (500 m) zählen als einer (der wichtigere, Gleichstand nach ID), bevor gerankt wird. So bleiben es fünf echte Highlights, und die Stufe zählt keine Dublette doppelt. Die bisherige Zusammenführung bei der Lieferung bleibt als Sicherung.

**Textnamen** (Entscheidung Claude): Ein Name gilt als einem POI zugeordnet, wenn die Extraktion zu ihm eine Erwähnung des POI angelegt hat (bestehender Abgleich `matchPoi`, 2 km). Nicht zugeordnete Namen zählen je normalisiertem Namen einmal, egal wie viele Quellen ihn nennen. Eine Kategorie mit nur solchen Namen und ohne Kandidaten erscheint trotzdem in `highlightLevels`.

Ein POI-Kandidat ist **Highlight**, wenn er bei mindestens einem Ort ausgewählt ist. Seine `spotIds` sind genau die Orte, bei denen er ausgewählt ist, nach Entfernung sortiert.

Die Auswahl läuft in der Konsolidierung je Ort (`consolidation.geo` ist der Ort, an dem heute `derived.spot_ids` entsteht) und wird als Profil-Attribut des Orts gespeichert (`derived.highlights.<category>` mit den ausgewählten IDs, der Stufe und den Eingangsdaten: Kandidaten mit Wichtigkeit und Entfernung). **Aktualität** (Entscheidung Claude): Ändert sich die Wichtigkeit eines Kandidaten (neue Textnennung, neue Sitelinks) oder entsteht ein neuer Kandidat, rechnet derselbe Lauf die Auswahl aller Orte neu, in deren größter Reichweite (20 km) er liegt. Das ist nur die Auswahl, keine volle Konsolidierung dieser Orte; ändert sich dadurch ihr Ergebnis, wird ihr Profil aktualisiert. Reihenfolge im Lauf: erst die Wichtigkeit der Kandidaten, dann die Auswahl der Orte.

## Dubletten unter Highlights

Erst ausgewählte Highlights werden auf ähnliche Namen geprüft: Zwei Highlights derselben Kategorie mit ähnlichem, aber nicht gleichem Namen (Trigramm ≥ `gazetteer.merge`-Schwelle) näher als 2 km ergeben eine Paar-Aufgabe. Gleiche Namen unter 500 m fasst schon die Auswahl zusammen (oben). So bleibt die Review-Last bei höchstens fünf Objekten je Ort und Kategorie.

## Liefervertrag (ändert Teil-Spec 08)

- `highlights.json` enthält nur Highlights (oben). `highlight.importance` bleibt 1–5, `highlight.spotIds` sind die Orte der Auswahl.
- `spot.highlightIds` bleibt: die Highlights des Orts, alle Kategorien, je Kategorie in Rangfolge.
- **Neu** `spot.highlightLevels`: `{ <category>: "none" | "some" | "many" }` für jede Kategorie, in der der Ort mindestens ein Highlight oder einen Kandidaten in Reichweite hat. Fehlt eine Kategorie, gibt es dort nichts.
- Minor-Version (neues optionales Feld). Die Lieferung nach `radiusNm` (5–50 sm) entfällt als Kriterium für `spotIds` und `no_spot_in_radius`; ein Highlight ohne Auswahl wird mit Grund `not_selected` nicht geliefert.
- Highlights, die bisher geliefert wurden und nicht mehr ausgewählt sind, erscheinen im Änderungs-Feed als entfernt; ihre `hl_`-IDs bleiben dem Geo-Objekt, falls sie später wieder ausgewählt werden.

## Admin-UI (ändert Teil-Spec 09)

- Ortsseite, neuer Abschnitt „Highlights“ (Reiter Profil oder eigener Reiter, Builder): je Kategorie die bis zu fünf Highlights mit Wichtigkeit und Entfernung, die Stufe und, aufklappbar, die übrigen Kandidaten in Reichweite mit Wichtigkeit (nur intern).
- Karte: Ebene „Highlights“ zeigt nur ausgewählte Highlights, eingefärbt nach Wichtigkeit; POI-Kandidaten bleiben über die Geo-Objekt-Ebene erreichbar.
- Review: Paar-Aufgaben nur noch für Highlights (oben).

## Konfiguration

| Datei | Neu |
| --- | --- |
| `config/gazetteer.json` | `poiCoastDistanceKm` |
| `config/consolidation/<neue Version>.json` | `importance.tagBonus`; `highlights.maxPerCategory`, `highlights.reachKm` (je Wichtigkeit), `highlights.levelWeights`, `highlights.levelThresholds` |

Neue Konsolidierungsversion, damit bestehende Profile nachvollziehbar bleiben (Muster Teil-Spec 07).

## Umstellung

1. Konfiguration und Code ausrollen.
2. Offene Paar-Aufgaben POI ~ POI schließen (Migration).
3. Gazetteer für `GR-I` neu (POIs über 20 km im Land enden über `valid_to`); dann „Konsolidieren“ für die Probekachel und Prüfung nach Teil-Spec 12 (P1, P7).

## Tests

- Insel mit einer Ruine (Wichtigkeit 2, ohne weitere Kultur): Ruine ist Highlight, Stufe `none`.
- Stadt mit 300 Kultur-Kandidaten (eine mit Wichtigkeit 5, zehn mit 3, Rest 1): genau fünf Highlights, die 5er zuerst, Stufe `many`; tausend Kandidaten mit Wichtigkeit 1 allein ergeben nicht `many`.
- Reichweite: ein 5er in 15 km zählt, ein 2er in 3 km nicht.
- Rangfolge bei gleicher Wichtigkeit: Punktzahl, dann Entfernung, dann ID (deterministisch).
- Ein POI ist bei Ort A ausgewählt und bei Ort B nicht: `spotIds = [A]`.
- Textname ohne POI zählt in der Stufe.
- Gazetteer: POI 25 km im Land wird übersprungen; unsicherer Wikidata-Treffer zwischen POIs erzeugt keine Paar-Aufgabe.
- Dubletten: zwei ausgewählte Highlights ähnlichen Namens in 800 m erzeugen eine Paar-Aufgabe; zwei nicht ausgewählte nicht.
- Vertrag: `highlightLevels` validiert; Highlight ohne Auswahl fehlt mit `not_selected`.

## Was dem Builder überlassen ist

Ort der Berechnung in der Konsolidierung und Speicherform der Auswahl, Index- und Abfragegestaltung (POI-Kandidaten in Reichweite schnell finden, vgl. Befunde B1/B7 zu großen Geometrien), Startwerte von `tagBonus`, `levelWeights` und `levelThresholds` nach Kalibrierung an `GR-I`, Gestaltung der UI innerhalb von Teil-Spec 09.

## Abweichungen

Für Abschnitt 4 des Gesamtdesigns:

| Quell-Spec | Periplus | Grund |
| --- | --- | --- |
| Highlight zählt für alle Spots in seinem Bedeutungsradius (5–50 sm je Wichtigkeit) | Highlight zählt für die Orte, bei denen es unter den fünf wichtigsten seiner Kategorie in Reichweite (1–20 km Landweg) ist | Entscheidung Christian: höchstens fünf je Kategorie; „dort“ heißt an Land erreichbar, nicht im Segelradius |
| Highlights je Kategorie als Fact „vorhanden, Anzahl, …“ | „Anzahl“ wird zur Stufe `none`/`some`/`many` | Entscheidung Christian: Einschätzung statt Zählung |

## Offene Punkte

- Modell-Einschätzung von Wichtigkeit und Stufe mit Belegen, falls die Rechnung an echten Daten nicht trägt.
- Ob die Reichweite später Fahrzeiten statt Luftlinie nutzt (Straßennetz liegt als Datensatz vor).
- Live-Referenzen (`googlePlaceIds`) je Kategorie bleiben bis M8 leer.

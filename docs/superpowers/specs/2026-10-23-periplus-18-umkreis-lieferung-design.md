# Periplus 18 – Lieferung nach Umkreis um eine Heimatmarina

Stand: 23.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Angekündigt in: Teil-Spec 14 (Lieferumfang, `popularity`) · Ändert: Teil-Spec 07 (`popularity`), 08 (Paket, API, Vertragsversion), 09 (Admin-UI) · Zeitpunkt: nach M7, vor dem ersten Abnehmer

## Zweck

Die Crew wählt in der Törn-App eine Heimatmarina, keinen Landesteil und kein Revier (Teil-Spec 14, Entscheidung Christian). Bisher liefert Periplus aber nur Pakete je Landesteil. Das passt nicht zum Törn: Ein Törn ab Poros berührt Attika und den Peloponnes, ein Törn ab Lefkada drei Landesteile, und ein Landesteil wie die Südliche Ägäis ist für eine Woche viel zu groß.

Diese Spec legt fest, wie Periplus ein Paket für **einen Umkreis um eine Heimatmarina** liefert, das die App vor dem Törn lädt und an Bord **offline** nutzt. Dazu bekommt `popularity` eine feste Nachbarschaft je Ort, damit derselbe Ort in jedem Paket denselben Wert hat.

## Entscheidungen (Christian, 23.10.2026)

- Die Daten müssen **offline an Bord** verfügbar sein. Die App lädt vor dem Törn ein Paket und fragt unterwegs nicht online ab.
- Der Umkreis ergibt sich aus der Törndauer: **höchstens 50 sm pro Tag**, gerechnet wird nur **die Hälfte der Tage**, weil die Crew wieder zurück muss.

  `Radius (sm) = 50 × Tage / 2`, z. B. 7 Tage → 175 sm, 14 Tage → 350 sm, 3 Tage → 75 sm.

## Ziele, Nicht-Ziele, Anti-Ziele

**Ziele**

- Ein Abnehmer bekommt mit einer Marina und einer Törndauer ein vollständiges, gültiges Paket für den Umkreis, über Landesteil-Grenzen hinweg.
- Das Paket ist an Bord ohne Netz vollständig nutzbar (alle Dateien, die der Vertrag kennt, auch Küste, Wetterpunkte und Bilder).
- Ist die Crew wieder im Hafen und online, holt die App nur die Änderungen seit ihrem Paket.
- Derselbe Ort hat in jedem Paket dieselben Werte, auch `popularity`.

**Nicht-Ziele**

- Korridore entlang einer geplanten Route, Distanz über Seewege, Online-Abfragen unterwegs.
- Nutzerkonten, gespeicherte Heimatmarinas je Crew (Sache der App).
- Pakete um beliebige Koordinaten (nur um ausgelieferte Marinas, siehe unten).

**Anti-Ziele** (wäre ein Fehlschlag, auch wenn es technisch läuft)

- Ein Umkreis-Paket, das Werte enthält, die in keinem gültigen Landesteil-Paket stehen (eine zweite Wahrheit neben dem Landesteil).
- Ein Paket, das eine Lücke verschweigt: Liegt ein Teil des Umkreises in einem noch nicht aufgebauten Landesteil, muss die App das erkennen können, statt „hier gibt es nichts“ anzunehmen.
- Ein Ort, der in zwei Paketen unterschiedliche `popularity` hat.

## Umkreis

- **Mittelpunkt:** die Position der Heimatmarina (Spot mit `kind = marina`, der ausgeliefert wird, Teil-Spec 17). Andere Ortsarten und freie Koordinaten sind nicht zulässig. (Claude: die App wählt eine Heimatmarina; ein Ankerplatz als Start ist kein Charterfall.)
- **Tage:** ganze Zahl von 1 bis 28. (Claude: 28 deckt Langtörns; mehr ergibt einen Radius über 700 sm und damit halbe Mittelmeerpakete.)
- **Radius:** `nmPerDay × days × returnFactor` mit `nmPerDay = 50` und `returnFactor = 0,5` (Christian), beide in `config/delivery.json` unter `radius`.
- **Distanz:** Luftlinie vom Mittelpunkt (Großkreis). (Claude: Der Seeweg ist immer mindestens so lang wie die Luftlinie; der Kreis deckt also alles ab, was in der Zeit erreichbar ist, und ist einfach und stabil zu rechnen.)

## Was im Paket steht

Das Umkreis-Paket hat **dieselben Dateien** wie ein Landesteil-Paket (`manifest.json`, `spots.json`, `highlights.json`, `regions.json`, `coast.geojson`, `weather-points.json`, Bilder) und dieselben Objektformate, aber **kein `changes.json`**: Änderungen holt die App über die API (unten). Eine App, die ein Landesteil-Paket lesen kann, liest auch ein Umkreis-Paket; nur Manifest und Dateikopf (`scope`) unterscheiden sich (unten).

Inhalt:

| Datei | Im Umkreis-Paket |
| --- | --- |
| `spots.json` | alle Spots, deren Position im Kreis liegt |
| `highlights.json` | alle Highlights, die einem enthaltenen Spot zugeordnet sind (`spotIds`), dazu alle Highlights im Kreis; `spotIds` werden auf enthaltene Spots gekürzt |
| `regions.json` | alle Regionen, deren Polygon den Kreis schneidet, dazu ihre Elternkette (Land, Landesteil) |
| `coast.geojson` | Land, Küstenlinie und Sperrflächen im Kreis plus `coast.marginNm` (2 sm), auf diesen Kreis zugeschnitten |
| `weather-points.json` | alle Wetterpunkte im Kreis plus `coast.marginNm` |
| Bilder | die Bilder der enthaltenen Spots, wie im Landesteil-Paket (nur wenn die Lieferung für das Land freigeschaltet ist, Teil-Spec 13) |

## Woraus es gebaut wird

Das Umkreis-Paket wird **aus den aktuellen gültigen Landesteil-Paketen zusammengesetzt**, nicht neu aus den Profilen gerechnet. Damit gibt es keine zweite Wahrheit: jedes Objekt im Umkreis-Paket steht genau so in einem gültigen Landesteil-Paket. (Claude, folgt aus dem ersten Anti-Ziel.)

1. Die Landesteile bestimmen, deren Polygon den Kreis schneidet.
2. Je Landesteil das aktuelle gültige Paket lesen (S3, `deliveries`). Hat ein Landesteil kein gültiges Paket, ist er eine **Lücke** (unten).
3. Objekte nach den Regeln oben auswählen. Ein Objekt, das in zwei Landesteil-Paketen steht (Regionen an der Grenze, Elternkette), wird einmal übernommen; die Fassungen müssen gleich sein, sonst schlägt der Bau fehl (Bericht nennt das Objekt).
4. Küste und Wetterpunkte aus den Landesteil-Dateien vereinigen und auf den Kreis zuschneiden.
5. Validieren: Schema jeder Datei und die Verweisregeln aus Teil-Spec 08 (jeder `spotId` eines Highlights, jeder `parentId` einer Region zeigt auf ein Objekt im Paket). Die inhaltlichen Prüfungen (15-Wörter-Regel, fremde Inhalte, Wertebereiche) sind schon an den Landesteil-Paketen gelaufen und werden nicht wiederholt.

**Bau auf Anfrage mit Zwischenspeicher:** Ein Umkreis-Paket ist eindeutig durch Marina, Tage und die `dataVersion` jedes beteiligten Landesteils bestimmt. Gleiche Eingaben ergeben dasselbe Paket; es wird einmal gebaut, in S3 unter `deliveries/radius/<marina-id>/<tage>/<schlüssel>/` abgelegt und danach von dort geliefert. Der Schlüssel ist ein Hash über die beteiligten Landesteil-Versionen. (Claude: Vorbauen für alle Marinas mal 28 Dauern wäre bei 1.000 Marinas im Mittelmeer ein Vielfaches des tatsächlichen Bedarfs.)

Ob der Bau innerhalb der Anfrage läuft oder als Job mit „bitte später erneut“ (HTTP 202), entscheidet der Builder an der gemessenen Bauzeit; Ziel ist, dass ein 14-Tage-Paket im Saronischen Golf in wenigen Sekunden bereitsteht.

## Lücken

Liegt ein Teil des Kreises in einem Landesteil ohne gültiges Paket (noch nicht aufgebaut, fehlgeschlagen, ausgeschlossen), wird das Paket trotzdem geliefert, aber das Manifest sagt es:

- `manifest.coverage`: je berührtem Landesteil `{ id, key, name, status: "delivered" | "missing", dataVersion | null }`.
- `manifest.tiles`: wie bisher die Kacheln mit Stand, dazu alle Küstenkacheln im Kreis aus Landesteilen ohne Paket mit `lastRunAt: null`.

Die App kann so „hier fehlen noch Daten“ anzeigen. Ein Paket, in dem der Landesteil der Heimatmarina selbst fehlt, kann es nicht geben (die Marina steht nur in einem gelieferten Paket).

## Änderungen nach dem Törn

Jedes Umkreis-Paket hat einen Schlüssel (`scope.key` im Manifest und in jeder Datei). Die App fragt mit dem Schlüssel ihres Pakets nach Änderungen:

- `GET /radius/changes?marina=&days=&since=<key>` vergleicht das Paket `since` (aus dem Zwischenspeicher) mit dem aktuellen Paket für Marina und Tage (wird bei Bedarf gebaut) und liefert:
  - die zusammengeführten Änderungen der beteiligten Landesteile zwischen den Versionen beider Pakete (`mergeChanges` wie bei `/subdivisions/{sd}/changes`), beschränkt auf Objekte, die in einem der beiden Pakete stehen;
  - für ein Objekt, das nur im neuen Paket steht und keine solche Änderung hat, `created` (z. B. ein Landesteil, der vorher `missing` war, oder ein Ort, der durch Korrektur in den Kreis rückt); für eines, das nur im alten steht, `removed`. Beide mit `severity: info`, leerem `fields`, der `profileVersion` des Objekts und `summary.de` „Neu im Umkreis“ bzw. „Nicht mehr im Umkreis“.
- Antwort: `{ schemaVersion, since, key, changes }`; `since` gleich dem aktuellen Schlüssel ergibt keine Änderungen, ein unbekannter Schlüssel oder einer für andere Marina oder Tage ist 400.
- Alternativ lädt die App einfach das aktuelle Paket neu; beides muss zum selben Stand führen.

## `popularity` mit fester Nachbarschaft (ändert Teil-Spec 07 und 14)

Heute ist `popularity` innerhalb des Landesteils normiert (Teil-Spec 14). In einem Umkreis-Paket aus zwei Landesteilen wären die Werte damit nicht vergleichbar, und derselbe Ort hätte je nach Paket einen anderen Bezug.

Neu: **Nachbarschaft je Ort** = alle bestätigten Orte im Umkreis von `popularity.neighbourhoodNm` um den Ort, über Landesteil-Grenzen hinweg.

- `popularity = log(1 + n) / log(1 + max)`, wobei `max` das Maximum der unabhängigen Quellen in der Nachbarschaft des Orts ist (der Ort selbst eingeschlossen). Formel und Quellenzählung bleiben wie in Teil-Spec 07.
- `neighbourhoodNm = 50`, eine Tagesetappe. (Claude: Das ist die Auswahl, vor der eine Crew an einem Tag steht; ein Wert, der Athen mit Kythira vergleicht, hilft bei dieser Wahl nicht.) In `config/delivery.json`.
- Der Wert hängt nur vom Ort und seiner Nachbarschaft ab, nicht vom Paket. Er wird beim Bau des Landesteil-Pakets gerechnet, wie heute.
- Folge: Ist ein Nachbar-Landesteil noch nicht aufgebaut, ist die Nachbarschaft unvollständig; der Wert ändert sich, wenn er hinzukommt. Das erscheint als normale Änderung (Schwere wie bisher für `popularity`).
- Beim Ausrollen ändert sich `popularity` an fast jedem Ort einmal. Die Landesteil-Pakete werden danach neu gebaut; die Änderungen gehen wie jede andere durch den Feed.

## Liefervertrag 3.0

Das Manifest bekommt einen Umfang, der Landesteil oder Umkreis sein kann. Das ändert eine Pflichtangabe jedes Manifests, also neue Hauptversion **3.0**. (Claude, wie bei 2.0: es gibt noch keinen Abnehmer.)

- `manifest.scope`: entweder `{ type: "subdivision", subdivision: {…wie bisher in 2.3}, dataVersion, previousDataVersion }` oder `{ type: "radius", key, homeMarina: { id, name }, center: { lat, lon }, days, radiusNm, circle: <Polygon> }`.
- `manifest.subdivision`, `manifest.dataVersion` und `manifest.previousDataVersion` entfallen (stecken in `scope`).
- `manifest.coverage` (oben) in beiden Fällen; beim Landesteil-Paket mit genau einem Eintrag.
- `bbox`, `tiles`, `areas`, `generatedAt`, `objectCounts`, `licenses`, `files` unverändert. Beim Umkreis-Paket: `bbox` des Kreises, `areas` und `licenses` aus den beteiligten Paketen vereinigt, `objectCounts.changes = 0`.
- **Dateikopf** aller übrigen JSON-Dateien: statt `subdivision` und `dataVersion` ein `scope`, entweder `{ type: "subdivision", id: "sd_…", dataVersion }` oder `{ type: "radius", key }`; `schemaVersion` und `generatedAt` bleiben. `changes.json` (nur Landesteil-Pakete) behält `previousDataVersion`.
- Die Objekte selbst (Spot, Highlight, Region, Wetterpunkt, Küste) bleiben unverändert gegenüber 2.3.
- Schemas unter `contract/schema/3.0/`, die alten Versionen bleiben abrufbar wie bisher.

## API (`/api/v3`)

| Endpunkt | Liefert |
| --- | --- |
| `GET /home-marinas?bbox=` | ausgelieferte Marinas (ID, Name, Position, Landesteil), zur Auswahl in der App |
| `GET /radius/package?marina=&days=` | Manifest des Umkreis-Pakets mit Links auf die Dateien (baut oder liest aus dem Zwischenspeicher) |
| `GET /radius/package/{file}?marina=&days=&key=` | eine Datei dieses Pakets; `key` aus dem Manifest, damit Manifest und Dateien zum selben Stand gehören |
| `GET /radius/changes?marina=&days=&since=` | Änderungen seit den Landesteil-Versionen (oben) |
| `/subdivisions/…`, `/spots/{id}`, `/schema/…`, `/ping` | wie bisher unter `/api/v2`; Landesteil-Pakete bleiben als Lieferweg für Partner erhalten |

Fehler: unbekannte oder nicht ausgelieferte Marina → 404, `days` außerhalb 1–28 → 400. Authentifizierung, Rate-Limit, `ETag`, Fehlerformat wie Teil-Spec 08. `/api/v3` **ersetzt** `/api/v2` (die Routen ziehen um); es gibt noch keinen Abnehmer. Gespeicherte Pakete älterer Versionen bleiben abrufbar, mit ihrer eigenen `schemaVersion`. (Claude.)

## Admin-UI (ändert Teil-Spec 09)

- Auf `/deliveries` ein Abschnitt „Umkreis-Paket“: Marina wählen, Tage eingeben, Ergebnis auf der Karte (Kreis, Landesteile mit Status `delivered`/`missing`), Zahl der Objekte je Datei, Größe des Pakets, Download als ZIP. Dient der Prüfung vor dem ersten Abnehmer.
- Liste der zwischengespeicherten Umkreis-Pakete mit Abrufzahl (für die Frage, welche Marinas gefragt sind; vgl. Teil-Spec 14, „nächster Landesteil nach Nachfrage“).

## Konfiguration

`config/delivery.json`, neu:

```json
"radius": { "nmPerDay": 50, "returnFactor": 0.5, "minDays": 1, "maxDays": 28 },
"popularity": { "neighbourhoodNm": 50 }
```

## Tests

- Radius: 7 Tage → 175 sm, 1 Tag → 25 sm, 0 und 29 Tage → Fehler.
- Auswahl: Spot knapp innerhalb und knapp außerhalb des Kreises; Highlight außerhalb, aber einem Spot innerhalb zugeordnet (enthalten, `spotIds` gekürzt); Region, die den Kreis nur schneidet (enthalten mit Elternkette).
- Zwei Landesteile: Kreis über eine Landesteil-Grenze enthält die Orte beider; ein gemeinsames Objekt erscheint einmal; abweichende Fassungen lassen den Bau scheitern.
- Lücke: ein berührter Landesteil ohne Paket erscheint in `coverage` als `missing`, seine Küstenkacheln in `tiles` mit `lastRunAt: null`.
- Kein neuer Wert: jedes Objekt im Umkreis-Paket ist byte-gleich mit seiner Fassung im Landesteil-Paket (bis auf gekürzte `spotIds`).
- Zwischenspeicher: gleiche Eingaben bauen einmal; neue `dataVersion` eines beteiligten Landesteils ergibt einen neuen Schlüssel.
- Änderungen: Ort rückt durch Korrektur aus dem Kreis → `removed`; neu aufgebauter Landesteil → seine Orte als `created`; Änderung an einem Ort im Kreis → `updated` aus dem Landesteil-Feed; die IDs aus altem Paket plus Änderungen ergeben die IDs des neuen Pakets.
- `popularity`: zwei Orte an einer Landesteil-Grenze, Nachbarschaft über die Grenze; Wert gleich, egal welches Paket ihn liefert; Ort ohne Nachbarn mit Quellen → 1 bei n > 0.
- Vertrag 3.0: Schema-Tests für beide `scope`-Arten; alte Schemas weiter abrufbar.

## Was dem Builder überlassen ist

Bau in der Anfrage oder als Job (nach Messung), Form des Zwischenspeicher-Schlüssels, Speicherung der Abrufzahlen, Vereinfachung des Kreispolygons, Indexwahl für die Nachbarschaftssuche, ZIP-Erzeugung in der Admin-UI.

## Offene Punkte

- Ob die App Bilder getrennt laden soll (Paket ohne Bilder plus Bilder nach Bedarf), wenn die Pakete zu groß werden. Erst messen, wenn Bilder ausgeliefert werden.
- Ob nach Pilot und erstem Ausbau der nächste Landesteil nach der Nachfrage aus den Umkreis-Abrufen startet (Teil-Spec 14, offene Punkte).

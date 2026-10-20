# M6 Abnahme: Lieferung

Abnahmekriterium aus der Roadmap (Gesamtdesign): Paket des Pilotreviers besteht alle Validierungsregeln und ist per API mit Schlüssel abrufbar. Teil-Spec 08: „Paket des Pilotreviers besteht alle Validierungsregeln; per API mit Schlüssel abrufbar“; „ein Spot zum Stand vor dem Revisit (M7) abrufbar“. Dazu der offene Punkt der Spec: die ODbL-Trennung ist vor der Weitergabe rechtlich zu prüfen; bis dahin werden Pakete nur intern genutzt.
Ablauf: `docs/runbook.md`, Abschnitt „Lieferung“.

**Stand (wie Ruling M4-J-R0):** Die Entwicklungsdatenbank ist leer (0 Geo-Objekte, 0 Orte; Migrationsstand 0037, vor dem ersten Lauf `npm run db:migrate`). Alle Messwerte auf echten Daten werden deshalb **im Pilot (M7) gemessen**, nach Gazetteer, Geometrie, Crawl, Text-Läufen und Konsolidierung. M6 baut und prüft jeden Schritt an der Synthetik (Fixture-Revier, `withRollback`, Testdatenbank und Test-Bucket); M6 braucht keinen externen Dienst, für die Umsetzung wurde kein Geld ausgegeben.

## Vom Code geprüft (Stand der Umsetzung)
- [x] **Vertrag „Periplus Data Contract“ 1.0** als zod-Schemas in `contract/v1/` (Feldnamen camelCase, Enum-Werte wie Teil B, Koordinaten mit 5 Nachkommastellen, nur http(s)-Links); JSON-Schemas (Draft 2020-12) daraus unter `contract/schema/1.0/`, ein Test hält Dateien und Laufzeit gleich (`npm run contract:generate`).
- [x] **Paket je Revier** (`buildDelivery`, `lib/domain/delivery/build.ts`): `manifest.json`, `spots.json`, `highlights.json`, `regions.json`, `coast.geojson`, `weather-points.json`, ab dem zweiten Paket `changes.json`; Bau unter der Revier-Sperre aus einem Snapshot, deterministisch (gemischte Ladereihenfolge ergibt dieselben Dateien), S3 vor der Zeile `deliveries`. Snapshot-Test gegen eingecheckte erwartete Dateien: `build.test.ts` „the fixture area builds a valid package equal to the checked-in files“.
- [x] **16 Validierungsregeln**, jede als benannte Prüfung mit Fundstellen, jede mit einem minimal kaputten Paket getestet (`validate.test.ts`); ein Verstoß lehnt das Paket ab, die Dateien liegen dann unter `rejected/<id>/` und das Revier liefert weiter das letzte gültige (`build.test.ts` „a summary with a copied 16-word passage rejects the package …“).
- [x] **Versionen und Änderungen**: `dataVersion` je Revier +1 nur bei gültigem Paket mit Änderung („Unverändert“ sonst), `profileVersion` je Vertragsobjekt nach Inhalts-Hash, `changes.json` genau mit den Objekten, deren Version gestiegen ist, Severity aus Vertragsregel und `change_events` im Snapshot-Fenster (`build.test.ts` „a changed shelter value gives data version 2 with one updated change and severity safety“, „a merged place keeps its last content with mergedInto and event merged“; `changes.test.ts`, `versioning.test.ts`).
- [x] **Liefer-API** `/api/v1` mit Schlüssel (Scope `delivery:read`), `ETag`/304, `Cache-Control`, `Periplus-Schema-Version`, Fehlerformat `{ error: { code, message } }`, Rate-Limit je Schlüssel: `GET /areas`, `/areas/{area}/package`, `/areas/{area}/package/{file}?dataVersion=`, `/areas/{area}/changes?since=`, `/spots/{id}?asOf=`, `/schema/{version}/{file}` (`app/__tests__/api-package.test.ts`, `api-changes-spots.test.ts`: Anmeldung, gesperrter Schlüssel, falscher Scope, Archiv je `dataVersion`, ETag).
- [x] **Spot zum Datum** (`asOf`) aus dem Paketarchiv: `api-changes-spots.test.ts` „asOf returns the spot version delivered on that date“, „asOf before the first delivery is 404“, „a removed spot is 404 after removal and found before“.
- [x] **Change-Feed** `since`: „changes since 1 merge the change files of versions 2 and 3“, „since equal to the current version is empty, since 0 is 400“.
- [x] **Abnehmer-Prüfung** `npm run delivery:consume -- --base-url … --area …` (`scripts/delivery-consume.ts`, Schlüssel per `--key` oder `PERIPLUS_API_KEY`): nur über die API, SHA-256 je Datei gegen das Manifest, eigenes Ajv 2020 gegen das ausgelieferte Schema, Exit 1 bei einem Fehler. Test gegen die echten Route-Handler (`scripts/__tests__/delivery-consume.test.ts`): „a built package is consumed with matching hashes and no schema errors“, „a tampered file fails the hash check“, Schemafehler mit JSON-Pointer, falscher Schlüssel und unbekanntes Revier.
- [x] **Oberfläche**: „Lieferungen“ (Reviere mit aktueller Version, „Paket bauen“, Liste aller Bauten, Detailseite mit Bericht, Warnungen, Änderungen, Dateien zum Herunterladen), Ort-Reiter „Lieferung“ (geliefertes Vertragsobjekt, Vorschau des nächsten Pakets), „Mit Ort zusammenlegen“ für Spot-Dubletten, API-Clients sperren unter „Einstellungen“. End-to-End-Test `e2e/delivery.spec.ts`: Login → `/deliveries` → Synthetik-Revier `e2e-delivery` zeigt Version 1 und „Gültig“ → Detailseite „Alle 16 Prüfungen bestanden.“ mit 16 × „ok“ → Download von `spots.json` liefert 200 → „Paket bauen“ führt auf die Laufseite mit Stufe `delivery.build` (der Lauf wird danach beendet, im e2e läuft kein Worker). Das Synthetik-Revier legt `e2e/global-setup.ts` einmal an und baut sein Paket (Ruling M6-P29).
- [x] **Lauf „Paket bauen“** (Stufe `delivery.build`, `lib/jobs/handlers/delivery.ts`, `lib/pipeline/delivery-run.ts`) auf dem Pool wie im Worker getestet: Sperre, Snapshot, nichts geschrieben im Lesepfad (`lib/pipeline/__tests__/delivery-run.test.ts`).

## Messwerte
| Wert | Fixtures (M6) | Echte Daten |
| --- | --- | --- |
| Paket Saronischer Golf `valid` | Fixture-Revier: `valid`, Version 1 (Test und e2e) | wird im Pilot (M7) gemessen: „Lieferungen“ → „Paket bauen“ bei `saronic` |
| Prüfungen bestanden | 16 von 16 (e2e „Alle 16 Prüfungen bestanden.“) | wird im Pilot (M7) gemessen: Detailseite des Pakets |
| Spots / Highlights / Regionen / Wetterpunkte | Fixture: 3 Spots (davon 1 ausgeschlossen), 1 Highlight, 2 Regionen, 2 Wetterpunkte, 3 Küsten-Features (`test/fixtures/delivery/expected/manifest.json`) | wird im Pilot (M7) gemessen: Spalte „Objekte“ unter „Lieferungen“ bzw. `objectCounts` im Manifest |
| Warnungen (nicht geliefert) | Fixture: Spot ohne vollständigen Schutz | wird im Pilot (M7) gemessen: Detailseite → „Warnungen“ |
| `delivery:consume` gegen den Server | Test: ok (alle Dateien SHA-256 ok, 0 Schemafehler) | wird im Pilot (M7) gemessen: `PERIPLUS_API_KEY=pk_… npm run delivery:consume -- --base-url https://<domain> --area saronic` |
| Spot per `asOf` | Test: Version des Pakets am Datum | wird im Pilot (M7) gemessen: `curl -sH "Authorization: Bearer $PERIPLUS_API_KEY" "https://<domain>/api/v1/spots/<sp_…>?asOf=<Datum des ersten Pakets>"` |
| `changes.json` nach zweitem Bau | Test: ein `updated` mit Severity `safety` nach geändertem Schutz | wird im Pilot (M7) gemessen: zweiter Bau nach einer Konsolidierung mit Änderungen, Detailseite → „Änderungen“ bzw. `GET /areas/saronic/changes?since=1` |
| Bauzeit je Revier | Fixture: unter 1 s | wird im Pilot (M7) gemessen: Laufseite des Baus |
| Kosten | 0 € (kein externer Dienst) | 0 € (der Bau ruft keinen externen Dienst) |

## Offen für Christian (Übergabe, nicht automatisierbar)
Voraussetzung: Profile beider Reviere aus M5 auf dem Server (`check:profiles` Exit 0, Pilot M7).
1. [ ] **ODbL-Trennung rechtlich prüfen lassen** (Teil-Spec 08 „Lizenz und ODbL“): `coast.geojson` vollständig, OSM-Namen und Regionspolygone als Felder im Manifest unter `licenses` (`config/delivery.json`); `spots.json` enthält keine OSM-Geometrien. Bis dahin gehen Pakete nur an interne Abnehmer.
2. [ ] **„Paket bauen“** auf dem Server für `saronic` (und `argolic`); Bericht prüfen, Verstöße nach Runbook beheben, neu bauen, bis „Gültig“.
3. [ ] **API-Schlüssel** für den Test-Abnehmer: `dc run --rm worker node --import tsx scripts/apikey.ts create <abnehmer> --scope delivery:read` (lokal `npm run apikey:create -- <abnehmer> --scope delivery:read`).
4. [ ] **`delivery:consume`** gegen den Server bis `OK` (Befehl oben); Ausgabe unter „Ergebnis“ eintragen.
5. [ ] **Spot per `asOf`** abrufen (Befehl oben) und nach einem zweiten Bau `changes?since=1` ansehen.
6. [ ] **Entscheidungen** zu den Vorgaben und strengeren Regeln unten (P4, P7, P15; strengere Prüfungen) bestätigen oder ändern.
7. [ ] Abnahme-Checkliste unten abhaken.

## Abnahmekriterien
- [ ] **Paket Saronischer Golf `valid`**: „Lieferungen“ zeigt bei `saronic` eine Version und den Status „Gültig“ (Code: e2e am Synthetik-Revier [x]).
- [ ] **Alle 16 Prüfungen grün**: Detailseite „Alle 16 Prüfungen bestanden.“ (Code: `validate.test.ts`, e2e [x]).
- [ ] **`delivery:consume` gegen den Server grün**: Ausgabe endet mit `OK` (Code: `delivery-consume.test.ts` [x]).
- [ ] **Ein Spot per `asOf` abrufbar** (Code: `api-changes-spots.test.ts` [x]). Für M7: vor dem simulierten Revisit ein Paket bauen, damit der Stand davor im Archiv liegt.
- [ ] **`changes.json` nach zweitem Bau plausibel**: nur Objekte mit gestiegener Version, Severity `safety` bei Ausschluss, Schutz (> 0,2 je Sektor), Grenzen oder Gefahren (Code: `build.test.ts`, `changes.test.ts` [x]).
- [ ] **ODbL-Prüfung erledigt** (Übergabe 1).

## Kosten der Umsetzung (echte Aufrufe)
| Dienst | Bündel H | M6 gesamt |
| --- | ---: | ---: |
| alle | 0 € (keine externen Aufrufe) | 0 € |

## Offene Punkte aus den Reviews
### Vorgaben, die Christian bestätigen oder ändern kann
| Punkt | Ort |
| --- | --- |
| **P4**: ein ganzjähriges Text-Ankerverbot (`prohibitions` `{ kind: "anchoring", months: null }`, auch alle 12 Monate) schließt den Spot im Vertrag als `anchoringProhibited` aus, obwohl `exclude` im Profil false bleibt; ein saisonales wird Saisonhinweis „Ankerverbot“. Dazu (Ruling M6-B-R2): ausgeschlossen ist ein Spot auch bei Ortsstatus `no_anchoring`, wenn das Profil noch nicht nachgezogen ist. Kosten bei falscher Vorgabe: ein veraltetes Text-Verbot schließt einen guten Spot aus, bis ein Admin den Eintrag entfernt | `lib/domain/delivery/map-spot.ts` |
| **P7**: `score.confidence` eines Highlights = Profil-Konfidenz, sonst Konfidenz des `exists`-Attributs, sonst `consolidation.poiConfidence` (0,6); POI-Profile haben nie eine Profil-Konfidenz, keine Spec definiert den Wert | `lib/domain/delivery/map-highlight.ts` |
| **P15**: Spot-Dubletten blockieren das Paket (Teil B); Abhilfe ist die neue Ort-Aktion „Mit Ort zusammenlegen“ (Alternative: Prüfung im Pilot nur als Warnung). „Position korrigieren“ gibt es nicht | `app/(admin)/places/[id]/actions.ts`, `lib/domain/place-merge.ts` |
| Strengere Prüfungen als Teil B (Christian kann sie lockern): das erste Paket muss `dataVersion` 1 haben und darf keine `changes.json` haben; ein Text, der eine verbotene Domain auch ohne Link nennt, blockiert; „wenig belegt“ gilt auch für Highlights mit geringer Konfidenz; `foreign_content` prüft auch Namen und `www.`-Links; `data_version` prüft auch `previousDataVersion` (Bündel D) | `lib/domain/delivery/validate.ts` |
| Gefahrenarten über Teil B hinaus: `hazards.kind` `current`, `fishFarm`, `other` (Weglassen würde Sicherheitshinweise verschlucken); ein unbekannter Gefahrentyp wird `other`, nie verworfen; berechnete Kabelzonen ergeben die Gefahr `cable` (Rulings M6-A-R2, M6-B-R2) | `contract/v1/spot.ts`, `lib/domain/delivery/vocab.ts` |
| Weitere Vertragserweiterungen (additiv, Hauptversion bleibt 1): `berth.bookable`, `mooring.buoys`, `mooring.lineAshoreRequired`, `score.quietness`, `regions.facts.*` dürfen `null` sein; `region.polygon` darf `MultiPolygon` sein | `contract/v1/` |
| Hafen-Schutz: als Beleg unter 0,8 zählen Text, Beobachtung und Review (`harbourShelterSources`, eine menschliche Entscheidung zählt) (Ruling M6-D-R2) | `config/delivery.json` |
| Regionszugehörigkeit: die kleinste Region, deren Polygon mit 0,5 sm Puffer (`regions.memberMarginNm`) den Spot enthält; Regionen ohne Fläche (nur Punkt) konkurrieren nie nach Größe (Rulings M6-C-R1, M6-E-R2). Kosten bei falscher Wahl: ein Spot gehört zur Insel statt zu keiner Region | `lib/domain/delivery/map-region.ts` |
| Ein ausgeschlossener Spot ohne Namen wird als „Ankerplatz ohne Namen“ geliefert, ohne Profil oder Schutzwerte mit Schutz 0 und dem Zusatz „ausgeschlossen – keine Schutzwerte“ in `exclude.detail`; nicht ausgeschlossene Spots ohne Namen, Profil oder vollständigen Schutz entfallen mit Warnung (Rulings M6-B-R2, M6-C-R1) | `lib/domain/delivery/map-spot.ts` |

### Übergaben (Handoff)
| Punkt | Ort |
| --- | --- |
| Server-Schritte oben unter „Offen für Christian“, zuerst die ODbL-Prüfung | Pilot M7 |
| **Kopierte Summary ohne Abhilfe**: die Prüfung `verbatim_text` vergleicht mit dem ganzen Archiv, die M5-Summary-Prüfung nur mit den Zitaten des Objekts. Eine `ok`-Summary, die das Paket blockiert, lässt sich in der Oberfläche nicht neu erzeugen („Neu erzeugen“ gibt es nur an Aufgaben fehlgeschlagener Summaries); eine neue entsteht erst mit einer neuen Profilversion. Entscheidung nötig, falls das im Pilot auftritt (z. B. Aktion „Summary neu erzeugen“ am Ort) | `lib/pipeline/consolidation/summary.ts` (`summaryTargets`), `lib/domain/delivery/validate.ts` |
| Quellen auf verbotenen Domains, die vor dem Schutz (Bündel D) vorgeschlagen wurden, lassen sich nur noch ablehnen (Aufräumhinweis) | `lib/domain/sources/` |
| S3-Uploads des Baus sind nicht bedingt (kein „If-None-Match“-Put); eine Wiederholung überschreibt dieselben Schlüssel mit denselben Bytes (Ruling M6-E-R2) | `lib/domain/delivery/build.ts` |
| Der Change-Feed liest je Version eine `changes.json` aus S3; bei vielen Versionen später begrenzen oder zusammenfassen (Ruling M6-F-R2) | `lib/domain/delivery/read.ts` (`changesSince`) |
| Rate-Limit der API greift erst nach erfolgreicher Anmeldung (seit M1): Fluten mit ungültigen Schlüsseln wird nicht gedrosselt (Bündel F, Security-Review) | `lib/api/handler.ts` |
| Committende Tests hinterlassen anfügende Zeilen an beendeten Objekten bei −150/−50 (Kacheln `q025:119..121:159`) und −120,3/−60,3; zwei gleichzeitige `npm test` auf derselben Testdatenbank kollidieren dort (Bündel E/G). Das e2e-Synthetik-Revier `e2e-delivery` bleibt bei −140/−40 dauerhaft in der Testdatenbank (Ruling M6-P29); fehlen seine Dateien im Test-Bucket, beendet `e2e/global-setup.ts` es und legt es neu an | `test/fixtures/delivery/area.ts`, `e2e/global-setup.ts` |
| Tests, die das Fixture-Revier anlegen, laufen nacheinander im Vitest-Projekt `delivery-fixture` (Wartezeiten auf eindeutige Schlüssel unter Last); ein neuer Test mit `seedDeliveryArea` muss in `DELIVERY_FIXTURE_TESTS` | `vitest.config.mts` |
| `followup.test.ts` rechnete mit festem Datum; auf `main` schlägt CI bis zum Merge von M6 fehl (Controller-Fix 81de100) | `lib/pipeline/__tests__/followup.test.ts` |
| Admin-Routen (nicht `/api/v1`) antworten mit `{ error: { code } }` ohne `message` (Bündel F) | `lib/security/require-admin.ts` |
| Bestehende `deliveries`-Zeilen vor Migration der `bbox` haben `bbox` null, bis das Revier neu gebaut wird (Bündel G) | `lib/domain/delivery/read.ts` (`listAreas`) |
| `distanceToPolygonNm` ist linear in der Zahl der Polygon-Ecken (Re-Review C; im Pilot ausreichend) | `lib/domain/delivery/geo.ts` |

### Bewusst angenommen (Verhalten im Pilot beobachten)
| Punkt | Ort |
| --- | --- |
| Status `unchanged`: ein Bau ohne Änderung wird mit Bericht protokolliert, schreibt aber weder Dateien noch eine `dataVersion`; ein erneuter Bau ohne Änderung schreibt eine weitere Zeile „Unverändert“ (Ruling M6-E-R2) | `lib/domain/delivery/build.ts` |
| Ein Bau, dessen Inhalt unverändert ist, der aber jetzt eine Prüfung verletzt, wird abgelehnt, nicht „unverändert“ (Ruling M6-E-R2) | `lib/domain/delivery/build.ts` |
| Abgelehnte Pakete liegen unter `deliveries/<ar>/rejected/<id>/` ohne `data_version` | `lib/domain/delivery/build.ts` |
| Vertragsversionen je `public_id` für Spots und Highlights, je Revier für Regionen; ein umgezogener Spot behält seine Version, das alte Revier schreibt einmal `removed` (Rulings M6-P13, M6-D-R1) | `lib/domain/delivery/versioning.ts` |
| `asOf` liest das Paketarchiv; Zeilen eines alten Reviers gelten, bis es neu gebaut wird; beendete Reviere zählen auch für ein historisches `asOf` nicht (Bündel F, G) | `lib/domain/delivery/read.ts` (`spotAsOf`) |
| Änderungsfenster je Paket über den gespeicherten Snapshot (`change_snapshot`), nicht `xmin` (Ruling M6-D-R3); der M5-Outbox-Filter bleibt für Live-Leser | `lib/domain/delivery/snapshot.ts`, `lib/domain/change-feed.ts` |
| `fields` nur bei `updated`; `merged`, `excluded`, `created`, `removed` tragen `fields: []` (Severity trotzdem aus den echten Feldern); entfernt → erzeugt → geändert ergibt `created` (Bündel D) | `lib/domain/delivery/changes.ts` |
| `onlyGoneSources` senkt die gelieferte Konfidenzklasse nicht (Ruling M6-B-R2 M-4) | `lib/domain/delivery/map-spot.ts` |
| Eine Herkunft je Schutz-Objekt (nicht je Sektor), zusammengefasst review vor observed vor text vor computed, Konfidenz = Minimum (Ruling M6-D-R2 M-2) | `lib/domain/delivery/map-spot.ts` |
| `depth.approach` und die Verbotsarten Schwimmen, Fischen, Feuer, Jetski, sonstige werden nicht geliefert (kein Feld in Teil B); berechnete Militär-, Schutz- und Aquakulturgebiete nur in `coast.geojson` (Ruling M6-B-R2 M-5) | `lib/domain/delivery/map-spot.ts` (`SPOT_FIELDS`) |
| POIs mit `exists: false` werden nicht geliefert; Highlight-Dubletten werden beim Bau zusammengeführt (der bedeutendere bleibt, Warnung); Highlights ohne Spot im Radius entfallen mit Warnung | `lib/domain/delivery/map-highlight.ts` |
| `oftenFull` wird in v1 nie erzeugt (keine Datenbasis); `externalRefs.googlePlaceIds` bleibt `{}` bis M8 | `lib/domain/delivery/vocab.ts` |
| Ein neues Textfeld in einer weiteren Sprache erhöht die Vertragsversion (`textDe` bleibt strikt, Ruling M6-A-R2 M-4) | `contract/v1/common.ts` |
| Die Liste der Reviere (`GET /areas`) nennt Reviere ohne Paket mit `null`-Werten; ein kaputtes Manifest bricht die Liste nicht (Bündel F) | `lib/domain/delivery/read.ts` |
| Eine Datei, deren Bytes nicht zum gespeicherten Hash passen oder die fehlt, ergibt 500 statt falscher Bytes; die Detailseite zeigt dann „Änderungsdatei nicht lesbar“ (Bündel F, G) | `lib/domain/delivery/read.ts`, `app/(admin)/deliveries/[id]/page.tsx` |
| Pool und Nebenläufigkeit: ein Bau hält zwei Verbindungen; `lockTimeoutMs` 300.000; Wettlauf zweier Reviere um dieselbe Version über eindeutigen Index und Wiederholung (Ruling M6-E-R2) | `config/delivery.json`, `config/queues.json` |
| „Mit Ort zusammenlegen“ wird als entschiedene Aufgabe (`subject_type place_merge`) protokolliert; die Bestätigung „über Reviergrenzen“ erscheint auch, wenn die Kachel des Ziels zu keinem Revier gehört (Bündel G) | `lib/domain/place-merge.ts` |
| API-Clients werden unter „Einstellungen“ gesperrt (Spec 09), nicht auf einer eigenen Seite; angelegt werden sie per CLI | `app/(admin)/settings/page.tsx` |
| `/api/v1/schema/…` braucht wie alle `/api/v1`-Routen einen Schlüssel (Default-Deny) | `lib/security/route-policy.ts` |

## Ergebnis
Datum der Abnahme: _offen_ (Pilot M7). Paket `saronic`: Version _offen_, Status _offen_, Prüfungen _offen_ von 16. Paket `argolic`: _offen_. Ausgabe `delivery:consume` gegen den Server: _offen_. Spot per `asOf`: _offen_. `changes.json` nach zweitem Bau: _offen_. ODbL-Prüfung: _offen_.

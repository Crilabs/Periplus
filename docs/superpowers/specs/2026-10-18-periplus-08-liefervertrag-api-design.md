# Periplus 08 – Liefervertrag und API

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilensteine: M6 (Paket, Profile, Changes), M8 (voller Endpunktsatz, Meldungen, Partner) · Quell-Spec: Teil A „Schnittstelle zur Törn-App“; Teil B vollständig

> **Stand ab Vertrag 3.0:** Die Liefer-API liegt unter `/api/v3` (`/api/v2` entfällt); Manifest und Dateikopf tragen einen `scope` (Landesteil oder Umkreis um eine Heimatmarina), dazu kommen `/radius/package`, `/radius/changes` und `/home-marinas`. Beschrieben in `2026-10-23-periplus-18-umkreis-lieferung-design.md`; die Angaben zu Version und Pfaden unten gelten, soweit dort nicht geändert.

## Zweck und Verhältnis zu Teil B

Teil B der Quell-Spec ist die fachliche Grundlage dieses Vertrags: Lieferprinzip mit vier Regeln, Paket je Revier, Felder und Wertebereiche von Spot, Highlight und Region, Küste und Wetterpunkte, Versionierung, Change-Feed, Validierungsregeln. Sie gelten unverändert, mit diesen Ausnahmen (Entscheidung Christian: DSTAP war Prototyp, keine Kompatibilität nötig):

- **Entfällt:** Abschnitt „Zuordnung zum heutigen App-Modell“, die `legacyIdMap`, die Spalte „Ersetzt heute“ der Paket-Tabelle, Alias-Kategorien alter Schlüssel. Ablage beim Abnehmer (`data/areas/<area>/`) ist dessen Sache.
- **Der Vertrag heißt „Periplus Data Contract“**, `schemaVersion` beginnt bei `1.0`. Die JSON-Schemas liegen im Periplus-Repo unter `contract/schema/<version>/` und werden aus den zod-Schemas erzeugt; Abnehmer beziehen sie über `GET /api/v1/schema/<version>/<file>`. (Teil B sah sie im App-Repo; hier ist Periplus die Quelle.)
- **Feldnamen camelCase** wie in Teil B; Enum-Werte wie in Teil B (`anchorage`, `mooringField` …).
- **Ergänzt:** Abschnitte API, Authentifizierung, Lizenz, Paketbau unten.

## Paket

Je Revier (Geo-Objekt Typ `area`, öffentliche ID `ar_…`, Schlüssel aus `config/areas/`) die Dateien aus Teil B: `manifest.json`, `spots.json`, `highlights.json`, `regions.json`, `coast.geojson`, `weather-points.json`, ab der zweiten Lieferung `changes.json`.

- **Paketbau** (`delivery.build` je Revier, manuell aus der UI im Pilot, ab M8 nach der wöchentlichen Konsolidierung): liest die aktuellen Profile, bildet die Vertragsobjekte (`lib/domain/delivery/map-*.ts`, eine Funktion je Objektart), validiert, schreibt nach S3 `deliveries/<area>/<dataVersion>/<file>` und eine Zeile `deliveries` (area_id, data_version, schema_version, generated_at, file_hashes, object_counts, validation_report, status `valid`/`rejected`). Ein abgelehntes Paket wird gespeichert (zur Diagnose), aber nie ausgeliefert.
- **`dataVersion`:** ganze Zahl, je Revier um 1 steigend, nur bei gültigem Paket mit mindestens einer Änderung.
- **`changes.json`:** aus `change_events` zwischen den beiden Paketen, abgebildet auf `created`, `updated`, `excluded`, `merged`, `removed` (Teil B) mit `severity` aus Teil-Spec 07; enthält genau die Objekte, deren `profileVersion` gestiegen ist.
- **`profileVersion` im Vertrag** = Version des Vertragsobjekts, nicht der internen Profilversion: steigt nur, wenn sich das gelieferte Objekt ändert (Hash des serialisierten Objekts ohne Versionsfelder). Tabelle `delivered_objects` (public_id, profile_version, content_hash, first_delivery_id) hält das fest.
- **Ausgeschlossene Spots** werden mit `exclude.excluded = true` und Grund geliefert (Teil B). Verworfene oder zusammengelegte Orte: `mergedInto` gesetzt bzw. Ereignis `removed`.
- **`coast.geojson`:** Landpolygone und Küstenlinie aus `land_polygons`, vereinfacht (10 m Toleranz), Revier-Box plus 2 sm; dazu `restrictedArea`-Features aus `restricted_areas`.
- **`weather-points.json`:** Ableitung nach Teil B (Region: Punkt maximaler Wasserdistanz zum Land im Regionspolygon; Enge/Kanal: Mittelpunkt; Kap: 1 sm seewärts entlang der Winkelhalbierenden).
- **Feldzuordnung Profil → Spot:** eine Tabelle in `lib/domain/delivery/map-spot.ts` mit einem Test je Feld; `provenance` aus `profiles.provenance`; `sources` = URLs der beteiligten Dokumente (ohne Zitate), `kind` aus `doc_type` (camelCase).

## Validierung

Alle Regeln aus Teil B „Validierungsregeln“, implementiert in `lib/domain/delivery/validate.ts`, jede als benannte Prüfung mit Fundstellen im Bericht. Dazu:

- Schema-Prüfung jeder Datei gegen das JSON-Schema der Version (ajv), zusätzlich zur zod-Prüfung beim Bau.
- **15-Wörter-Regel:** jedes Textfeld (`summary`, `character`, `seasonNote.text`, `hazards.text`, Highlight-`summary`) wird in 15-Wort-Schindeln zerlegt (normalisiert); jede Schindel wird gegen `text_shingles` (Hash-Index über alle Chunks, Teil-Spec 02) geprüft. Ein Treffer = Verstoß.
- Keine fremden Inhalte: Prüfung, dass `externalRefs` nur IDs enthält und keine Felder aus Google/Navily-Quellen stammen (Herkunftsart `review` mit Navily-Bezug ist im Datenmodell nicht möglich, Teil-Spec 10).

## API

Basis `/api/v1`, JSON, `Authorization: Bearer pk_…`, Antworten mit `schemaVersion` und `dataVersion` im Body bzw. Header `Periplus-Schema-Version`. Fehler als `{ error: { code, message } }` mit 400/401/403/404/429/500, ohne interne Details. `ETag` je Antwort, `Cache-Control: private, max-age=60`. Rate-Limit je Client.

**M6 (Pilot):**

| Endpunkt | Liefert |
| --- | --- |
| `GET /areas` | Reviere mit `dataVersion`, bbox, Stand |
| `GET /areas/{area}/package` | Manifest des aktuellen Pakets mit Links auf die Dateien |
| `GET /areas/{area}/package/{file}?dataVersion=` | Eine Paketdatei (Standard: aktuell; ältere Versionen aus dem Archiv) |
| `GET /areas/{area}/changes?since={dataVersion}` | Zusammengeführte Änderungen seit einer Version |
| `GET /spots/{id}?asOf=YYYY-MM-DD` | Ein Spot im Vertragsformat zum Datum |
| `GET /schema/{version}/{file}` | JSON-Schema |

**M8 (Dauerbetrieb, Endpunktsatz aus Teil A, englische Pfade):**

| Endpunkt | Teil A |
| --- | --- |
| `GET /geo?type=&parent=` / `GET /geo/{id}` | `/geo` |
| `GET /tiles?bbox=` | `/kacheln` |
| `GET /spots?tile=&bbox=&geo=&kind=` | `/orte` |
| `GET /spots/{id}/profile?asOf=` | `/orte/{id}/profil` |
| `GET /spots/{id}/highlights` | `/orte/{id}/highlights` |
| `GET /routes?bbox=&from=&to=` | `/routen` |
| `GET /changes?since={cursor}` | `/changes` (Cursor = `seq`) |
| `POST /reports` | `/meldungen` (Spot-ID, Attribut, Text, Datum, optional Position; löst einen ereignisgesteuerten Lauf aus und wird als `observations`-Zeile mit `source = app` gespeichert, Gewicht siehe Quell-Spec offener Punkt) |

**Partner:** derselbe Endpunktsatz mit eigenem Schlüssel (`api_clients.omit_quotes = true` ist ohnehin Standard, weil keine Zitate ausgeliefert werden) und eigenem Mengenlimit; Freischaltung per CLI.

## Lizenz und ODbL (offener Punkt der Quell-Spec, Vorschlag)

`coast.geojson`, Namen und Geometrien aus OSM sind ein „abgeleiteter Datenbestand“ unter ODbL; das Manifest trägt `licenses` mit OSM-Attribution und ODbL-Hinweis für genau diese Dateien/Felder. Eigene Facts (berechnet aus Geometrie + Texten) werden als „Produced Work“ bzw. getrennte Datenbank behandelt, indem `spots.json` keine OSM-Geometrien enthält, nur Punkte und eigene Werte. Diese Trennung ist ein Vorschlag und vor M6 rechtlich zu prüfen; bis dahin werden Pakete nur intern genutzt.

## UI-Anteil

Seite „Lieferungen“: Pakete je Revier mit Status, Validierungsbericht (Prüfung, Fundstellen, Link zum Objekt), Objektzahlen, Diff zur Vorversion, Download; „Paket bauen“. Seite „API-Clients“: Liste, Sperren (Anlage per CLI).

## Tests und Abnahme

- Für jede Validierungsregel ein Test mit einem minimal kaputten Paket.
- Snapshot-Test: Paket aus Fixture-Profilen gegen eingecheckte erwartete Dateien.
- API-Tests für Anmeldung, Scopes, `asOf`, `dataVersion`-Archiv, ETag.
- Abnahme M6: Paket des Pilotreviers gültig, per API mit Schlüssel abrufbar; ein Spot zum Stand vor dem Revisit (M7) abrufbar.

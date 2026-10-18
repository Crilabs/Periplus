# Periplus 02 – Datenmodell und Zeitachse

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilensteine: M0 (Grundtabellen), wächst mit M1–M8 · Quell-Spec: Abschnitte „Datenmodell“, „Änderungserkennung und Versionierung“, Grundprinzipien 1, 4, 5, 8

## Zweck

Die zwölf Entitäten der Quell-Spec plus die technischen Tabellen als Postgres-Schema, mit festen Regeln für Zeitachse und Unveränderlichkeit. Feldlisten der Quell-Spec gelten; hier steht, was für die Umsetzung dazukommt oder präzisiert wird. Spaltennamen englisch, snake_case.

## Klassen von Tabellen

| Klasse | Regel | Tabellen |
| --- | --- | --- |
| **Stabil mit Gültigkeit** | Zeilen werden nicht gelöscht; Ende über `valid_to`; fachliche Änderungen an Kernfeldern (Geometrie, Typ, Name) erzeugen eine Zeile in `<tabelle>_history` per Trigger | `geo_objects`, `geo_names`, `places`, `tiles`, `sources`, `documents`, `external_refs`, `restricted_areas` |
| **Nur anfügend** | Trigger verbietet `DELETE` und `UPDATE`; Ausnahme nur für ausdrücklich gelistete technische Spalten (z. B. `documents.last_checked_at`) | `document_versions`, `chunks`, `mentions`, `facts`, `computations`, `observations`, `profiles`, `change_events`, `routes`, `route_stops`, `review_decisions`, `deliveries`, `comparison_results` |
| **Arbeitszustand** | Normal veränderlich | `runs`, `run_stages`, `review_tasks`, `external_calls`, `rate_limits`, `users`, `api_clients`, `worker_heartbeats`, pg-boss |

Der Trigger ist eine generische Funktion `forbid_mutation()` mit Spalten-Whitelist als Argument; ein Test prüft für jede Tabelle der Klasse „nur anfügend“, dass `UPDATE`/`DELETE` scheitern.

## Tabellen

Nur die Felder, die über die Quell-Spec hinausgehen oder sie präzisieren. Alle Tabellen haben `id uuid` (UUIDv7) und `created_at timestamptz`.

### Gazetteer und Raum

- **`geo_objects`**: `type` (Enum: `sea`, `area`, `gulf`, `island`, `islet`, `archipelago`, `coast_section`, `cape`, `strait`, `channel`, `bay`, `harbour`, `settlement`, `poi`), `parent_id`, `geom geometry(Geometry,4326)` (Punkt oder Polygon), `centroid geometry(Point,4326)` (berechnet), `osm_id text` (`node/…`, `way/…`, `relation/…`), `geonames_id`, `wikidata_id`, `origin` (`osm`, `geonames`, `wikidata`, `text`, `review`, `computed`, `manual`), `public_id` (nur für Typen, die geliefert werden: `ar_` für `area`, `rg_` für `island`/`archipelago`/`coast_section`/`gulf`/`channel`, `hl_` für `poi`), `category` (nur `poi`: `food`, `supply`, `beach`, `nature`, `active`, `culture`, `town`), `valid_from`, `valid_to`. Ein `poi` ist die interne Form eines Highlights (Gesamtdesign, Abschnitt 4).
- **`geo_names`**: wie Quell-Spec („Name“), zusätzlich `name_normalized` (klein, ohne Akzente, griechisch zusätzlich als ELOT-743-Transliteration in einer zweiten Zeile mit `script = 'latin'`, `origin = 'transliteration'`), `is_preferred` je Sprache. GIN-Index `gin_trgm_ops` auf `name_normalized`.
- **`tiles`**: `id text` im Format `q025:<col>:<row>` mit `col = floor((lon + 180) / 0.25)`, `row = floor((lat + 90) / 0.25)`; das Präfix hält eine spätere andere Rastergröße (Quell-Spec, offener Punkt) ohne Kollision offen. Felder wie Quell-Spec plus `area_id` (Label-Revier), `has_coast`, `priority`, `cycle_days`.
- **`tile_geo_objects`**: (tile_id, geo_object_id), berechnet per `ST_Intersects`, nach jedem Gazetteer-Lauf neu geschrieben (Arbeitszustand).
- **`places`**: wie Quell-Spec („Ort“), `geo_object_id` 1:1, `kind` (`anchorage`, `port`, `marina`, `mooring_field`), `status` (`candidate`, `confirmed`, `rejected`, `abandoned`, `no_anchoring`), `status_reason`, `public_id` (`sp_…`), `merged_into_id`, `tile_id` (aus `position`, per Trigger gesetzt), `position geometry(Point,4326)` (Buchtmitte), `anchor_position`, `anchor_confidence`, `anchor_origin`.
- **`restricted_areas`**: amtliche Ausschlussflächen (Teil-Spec 04): `kind` (`military`, `cable`, `protected_area`, `aquaculture`, `ferry_lane`, `firing_area`), `geom`, `source_id`, `source_ref`, `valid_from`, `valid_to`.
- **`external_refs`**: wie Quell-Spec; `fetched_at`, da Google-place_ids je Kachel-Lauf erneuert werden. Gespeichert wird ausschließlich die ID.

### Quellen und Archiv

- **`sources`**: wie Quell-Spec, `status` (`proposed`, `approved`, `rejected`, `paused`), `crawl_rules jsonb` (Schema in Teil-Spec 05), `change_rate` (`high`, `normal`, `static`) für den täglichen Fetch.
- **`documents`**: wie Quell-Spec, `url_normalized` eindeutig, `last_checked_at`, `consecutive_gone` (Zähler für 404/410).
- **`document_versions`**: wie Quell-Spec; `content_hash` (SHA-256 des normalisierten Markdown), `raw_key` und `md_key` (S3-Schlüssel), `diff_key` (Diff zur Vorversion), `language`, `published_at`, `observed_at`, `observed_at_basis` (`explicit`, `published`, `fetched`), `doc_type` (`pilot_guide`, `trip_report`, `forum`, `marina`, `authority`, `dataset`, `travel_guide`, `other`), `converter` (welcher Konverter), `simulated bool` (Teil-Spec 10). Eindeutig: (document_id, content_hash).
- **`chunks`**: `document_version_id`, `ordinal`, `text`, `text_normalized`, `char_start`, `char_end`, `embedding vector(<dim>)` (nullable, später gefüllt), `carried_from_chunk_id` (unverändert aus Vorversion übernommen).
- **`text_shingles`**: (shingle_hash bigint, chunk_id) für die 15-Wörter-Prüfung des Liefervertrags (Teil-Spec 08); Arbeitszustand, aus `chunks` neu erzeugbar.

### Ableitungen

- **`mentions`**: wie Quell-Spec plus `chunk_id`, `match_score`, `extraction_status` (`pending`, `done`, `skipped`; einzige veränderliche Spalte).
- **`extraction_runs`**: (id, task, model, prompt_version, fact_schema_version, started_at); jeder Fact verweist darauf.
- **`facts`**: wie Quell-Spec; `geo_object_id`, genau eins von `mention_id` / `computation_id` / `observation_id` / `review_decision_id` (Check-Constraint), `attribute` (Schlüssel aus dem Fact-Schema), `value jsonb` (gegen das Schema validiert), `quote` (wörtlich, Pflicht bei `mention_id`), `quote_verified bool`, `observed_at date`, `confidence real`, `extraction_run_id`. Eindeutig: (mention_id, attribute, extraction_run_id).
- **`computations`**: `kind` (`shelter`, `fetch`, `depth`, `seabed`, `anchor_area`, `quietness`, `restriction`), `inputs jsonb` (Datensatz-IDs, Versionen, Parameter), `rules_version`, `geo_object_id`.
- **`observations`**: wie Quell-Spec; in M0–M7 leer, ab M8 aus `POST /reports`.
- **`routes`**, **`route_stops`**: Route je Dokumentversion eines Törnberichts; Stopps mit Reihenfolge, `geo_object_id` (nullable bis zugeordnet), Datum, Leg-Hinweise (`distance_nm`, `duration_h`, `wind`).
- **`profiles`**: wie Quell-Spec („Ortsprofil“): `geo_object_id`, `version int` (je Geo-Objekt steigend), `valid_from date`, `attributes jsonb`, `provenance jsonb` (je Attribut Herkunft, Konfidenz, observed_at, Fact-IDs), `conflicts jsonb`, `gaps text[]`, `sources_count`, `fact_schema_version`, `rules_version`, `run_id`. Eindeutig: (geo_object_id, version). Eine neue Version entsteht nur, wenn sich `attributes` ändert.
- **`change_events`**: `geo_object_id`, `profile_version`, `type` (`new_attribute`, `changed`, `uncertain`, `expired`, `place_new`, `place_abandoned`, `geo_changed`), `attribute`, `old_value`, `new_value`, `severity` (`info`, `notable`, `safety`), `run_id`, `seq bigserial` (Cursor des Change-Feeds).

### Review, Qualität, Lieferung

- **`review_tasks`**: `kind` (`source_approval`, `place_candidate`, `conflict`, `failed_job`, `coast_tile_without_area`, `uncertain_change`, `comparison_deviation`), `subject_type`, `subject_id`, `context jsonb`, `status` (`open`, `decided`, `dismissed`), `priority`.
- **`review_decisions`**: unveränderlich: `task_id`, `decision jsonb`, `decided_by`, `decided_at`. Entscheidungen, die einen Wert setzen, erzeugen zusätzlich einen Fact mit `review_decision_id` (Quell-Spec: „als Fact mit Quelle Review“).
- **`comparison_set`**, **`comparison_results`**: Teil-Spec 10.
- **`deliveries`**: Teil-Spec 08.

## Fact-Schema als Konfiguration

- Datei `config/fact-schema/v1.ts` exportiert je Ebene (`place`, `area`, `island`, `cape_strait`, `poi`) eine Liste von Attributen: Schlüssel, zod-Schema des Werts, Konsolidierungsregel (Name, Teil-Spec 07), Herkunftsarten (`computed`, `text`, `observed`), Beschreibung für den Prompt. Als TypeScript mit zod statt JSON, weil die Werteschemata sonst doppelt gepflegt würden; geändert wird sie wie Konfiguration (eigene Version, keine Logik).
- Die aktive Version steht in `config/fact-schema/active.json`. Facts und Profile speichern die Version, mit der sie entstanden.
- **Schutz-Kodierung (offener Punkt der Quell-Spec, Entscheidung Claude):** intern und im Vertrag eine Zahl 0–1 je Sektor. Texte, die nur „gut/mäßig/kein Schutz“ sagen, werden in der Extraktion auf 0,9 / 0,5 / 0,1 abgebildet (Tabelle im Fact-Schema). Schwell (`swell`) ebenso 0–1.
- Attributschlüssel v1 (Auszug, vollständig beim Bau von M2/M4): `shelter.N` … `shelter.NW`, `swell_protection`, `opening_bearing`, `depth.min`, `depth.max`, `depth.anchoring_min`, `depth.anchoring_max`, `seabed`, `holding`, `mooring.types`, `mooring.buoys`, `mooring.line_ashore_required`, `capacity`, `max_draft`, `max_length`, `occupancy` (je Monat), `services.water` … `services.dinghy_landing`, `prohibitions`, `hazards`, `highlight.<category>`, `season_notes`, `prices`, `contact`; Revier/Insel: `meltemi_exposure`, `wind_systems`, `ferry_traffic`, `restricted_zones`, `charter_bases`, `supply_ports`; Kap/Enge: `passage_notes`, `sea_state`, `hazards`.

## Indizes und Größen

GIST auf allen Geometrien, GIN trgm auf `geo_names.name_normalized` und `chunks.text_normalized` (für Nachschlagen in der UI), HNSW auf `chunks.embedding`, B-Tree auf (geo_object_id, attribute, observed_at) in `facts`. Erwartung Pilot: < 1.000 Geo-Objekte, < 5.000 Dokumentversionen, < 50.000 Facts — keine Partitionierung.

## Abfragen „Stand zum Datum“

`profile_as_of(geo_object_id, date)` = Profil mit größtem `valid_from <= date`. Geo-Objekte und Orte zum Datum über `valid_from <= date AND (valid_to IS NULL OR valid_to > date)`. Diese Regeln stehen genau einmal in `lib/domain/timeline.ts`.

## Tests

Trigger-Tests je Tabellenklasse; Eindeutigkeiten (Dokument-Hash, Fact-Schlüssel) mit Wiederanlauf-Test; `profile_as_of` mit drei Versionen; Tile-ID-Berechnung an Rändern (negative Längen, exakt auf der Kante).

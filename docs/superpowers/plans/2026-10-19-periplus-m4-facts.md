# Periplus M4 – Erwähnungen und Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stufen 6 und 7 für das Pilotgebiet als Jobs: Dokument-Klassifikation, deterministischer Trigram-Match gegen den Gazetteer mit Disambiguierung nur für mehrdeutige Treffer, neue Namen über Nominatim als Review-Aufgabe, Fact-Extraktion mit hart geprüftem wörtlichem Zitat über die Message Batches API, Routen aus Törnberichten, Belegtreue-Kontrolle je Lauf, Modellvergleich Sonnet/Opus an 200 Erwähnungen (Werkzeug plus vorläufige Wahl), Facts mit hervorgehobenem Zitat in Dokument-, Geo- und Ort-Ansicht.

**Architecture:** Ein Lauf „Texte auswerten“ (auch als `reprocess`) mit den Stufen `classify.document_version → mentions.batch → mentions.disambiguate → mentions.geocode → extraction.mention → extraction.route → extraction.check` auf der vorhandenen Run-Mechanik. Modellstufen reichen einen Batch ein und verlängern ihre Stufe um eine Einheit (`extendStage` aus M3); der selbst nachplanende Job `ai.batch.poll` holt Ergebnisse, verteilt sie über eine Handler-Tabelle je Task und meldet die Einheit als erledigt (`recordJobOutcome`). Fachregeln (Namens-N-Gramme, Affixe, Kandidatenraum, Match-Auflösung, Zitatprüfung, Fact-Verarbeitung, Routen, Vergleich) liegen in `lib/domain/mentions`, `lib/domain/extraction`, Abläufe in `lib/pipeline/text`, Modellzugriff nur über `ModelClient` (`lib/ai`), Nominatim über `lib/adapters`. Die Datenbank erzwingt per Check-Constraint, dass kein Text-Fact ohne geprüftes Zitat existiert.

**Tech Stack:** wie M3 (Next.js 16.4.2, React 19.3, Drizzle 0.45, pg-boss 12, zod 4, Vitest 5, Playwright 1.64, `@anthropic-ai/sdk` mit `messages.batches.create/retrieve/results`, pg_trgm), keine neuen npm-Abhängigkeiten.

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-06-erwaehnungen-facts-design.md` (primär), `…-02-datenmodell-design.md` (`mentions`, `extraction_runs`, `facts`, `routes`, `route_stops`, Fact-Schema als Konfiguration), `…-01-fundament-design.md` (`ModelClient`, `ai.batch.poll`, Prompts, `models.json`, Budgets, `MockModel`), `…-09-admin-ui-design.md` (Facts mit Zitat, `/compare/models`, Erwähnungen, Review `place_candidate`), `…-10-qualitaet-pilot-design.md` (Belegtreue, Routen-Rekonstruktion), `…-07-konsolidierung-design.md` (nur „aktiver Lauf je Dokumentversion“, Regelnamen), Gesamtdesign `…-periplus-design.md` (Roadmap M4, Offene Punkte „Modellklasse Extraktion“, „Kachelgrenzen“). Fachlich maßgebend: `.idea/datendienst-spec.md` (Grundprinzipien 5, 7, 8, 11; Stufen 6 und 7; Qualitätsmetriken). Baut auf den Plänen M2 (`2026-10-19-periplus-m2-geometrie.md`: `facts`, `computations`, `config/fact-schema/`, `validateFactValue`, `canonicalJson`) und M3 (`2026-10-19-periplus-m3-quellen.md`: `sources`, `documents`, `document_versions`, `chunks` mit `carried_from_chunk_id`, `normalizeText`, `httpCall` mit `rateKey`/`okStatuses`/`budget`, `extendStage`, `ArchiveMarkdown`, `fixtures-record.ts`) auf.

## Global Constraints

- Alle Global Constraints aus M0–M3 gelten weiter (Next 16.4.2, Next-Doku in `node_modules/next/dist/docs/` vor Routen, `proxy.ts`, `next.config.ts`; kein `console.*`; Englisch im Code, Deutsch in der UI; Tests gegen `db-test`, kein Netz, KI nur über `MockModel`; Route-Policy je Route; `external_calls` je Aufruf; Schwellen in `config/`; Tests zählen nie DB-weit, Geo-Testdaten in `withRollback` oder außerhalb der Pilotbox 23,0–23,75° O × 37,0–38,0° N, Synthetik um 21,0° O / 35,2° N).
- „Ein Fact ohne wörtliches Zitat existiert nicht.“ `quote` „muss ein zusammenhängender wörtlicher Ausschnitt sein (≤ 300 Zeichen)“; „normalisiert (Whitespace, typografische Anführungszeichen, Bindestriche) und muss als Teilstring im normalisierten Chunk-Text vorkommen. Kein Treffer → Fact wird verworfen und gezählt.“
- Belegtreue = „Anteil Facts mit `quote_verified = true` unter allen Text-Facts des Laufs; < 100 % sperrt die Konsolidierung des Laufs“.
- Match: „Wort-N-Gramme (1–4 Wörter) normalisieren (wie `geo_names.name_normalized`, griechische Wörter zusätzlich transliteriert)“; „exakter Treffer oder `similarity ≥ 0,75` (pg_trgm) bei Namen ≥ 5 Zeichen“; mehrdeutig = „gleicher Name mehrfach, Transliteration unsicher, Similarity 0,6–0,75“; Disambiguierung „mit Chunk und den 2–6 in Frage kommenden Objekten (Name, Typ, Eltern, Koordinate)“.
- Kandidatenraum: „Kacheln, die das Dokument bereits berührt … plus deren 8 Nachbarn; bei unbekanntem Bezug das Revier der Quelle“; Test-Schalter für den Zweierring in `config/mentions.json`.
- `mentions.batch` je 50 Dokumentversionen; Klassifikation mit „Titel, URL, ersten 1.500 Wörtern“; „Ohne explizites Beobachtungsdatum gilt `published_at`, sonst Abrufdatum“; „Mai 2024“ → `2024-05-15`.
- Neue Namen: „Ein Name in ≥ 2 Dokumenten verschiedener Quellen → Nominatim-Umkreissuche (20 km um die Kachel) → Review-Aufgabe `place_candidate`“; Nominatim „höchstens 1 Anfrage/s, nur Umkreissuche“.
- Extraktion: Einheit je (Dokumentversion, Geo-Objekt) mit Nachbar-Chunks; Highlight-POI „im Umkreis von 2 km“; Routen bei „> 20.000 Wörtern in Abschnitten“; „Zitate bleiben in der Originalsprache; die Werte sind sprachneutral (Enums, Zahlen)“ – keine Freitextwerte außer Eigennamen.
- Schutz-Wörter „gut/mäßig/kein Schutz“ → 0,9 / 0,5 / 0,1 (Tabelle im Fact-Schema); Schwell ebenso 0–1.
- Modelle: Klassifikation und Disambiguierung `claude-haiku-5-5`, Extraktion im Vergleich `claude-sonnet-5-5` und `claude-opus-5-5`; Modellvergleich „200 Erwähnungen aus mindestens 8 Quellen und allen Dokumenttypen“, „Stichprobe von 50 Abweichungen“; Facts des nicht gewählten Laufs bleiben, werden nicht konsolidiert.
- Prompts englisch, Dateien `config/prompts/classify-document/v1.md`, `disambiguate-mention/v1.md`, `extract-facts/v1.md`, `extract-route/v1.md`, je mit `## system` und `## user`; gemeinsame Regeln: „nur aus dem Text, nichts erschließen, jedes Fact mit wörtlichem Zitat, im Zweifel weglassen, Datum nur wenn im Text“.
- Nur anfügend (Trigger `forbid_mutation`): `mentions` (einzige freie Spalte `extraction_status`), `facts`, `routes`, `route_stops`, `document_classifications`. Eindeutig: Fact `(mention_id, attribute, extraction_run_id)`.
- Batch-Kosten = Token × Preis aus `config/models.json` × `batch.discount` 0,5; Budget `anthropic` aus `config/budgets.json` vor jeder Einreichung.
- Abnahme M4: „Belegtreue 100 %; Modellwahl dokumentiert; Kosten je Erwähnung gemessen; Anteil Erwähnungen ohne Modellaufruf > 70 %“; „Facts mit hervorgehobenem Zitat in der UI“.

## Review Focus

1. **Echtes Zitat mit anderer Typografie gegen gefälschtes Zitat.** Modelle glätten Anführungszeichen, Gedankenstriche, Zeilenumbrüche, Markdown-Auszeichnung (`**Sand**`) und griechische Akzente (NFC/NFD) – das muss als wörtlich gelten; Paraphrase, Auslassung („…“), aus zwei Sätzen zusammengesetzte oder klein geschriebene Zitate dürfen nie durchkommen. → Task 3 Tests, Task 13 Test `a fabricated quote is dropped and counted`, Task 20 Smoke-Test über echte Antworten.
2. **Batch-Ergebnis wird doppelt verteilt** (Poll-Job nach Teilverteilung wiederholt, zwei Poll-Jobs, Einreich-Job nach Absturz wiederholt): keine doppelten Mentions, Facts oder Routen, die Stufen-Einheit wird genau einmal gemeldet, der Lauf geht genau einmal weiter. → Task 6 Tests `distributing twice …`, `a retried submit job reuses its batch`.
3. **Ortsnamen, die gewöhnliche Wörter sind, und überlappende N-Gramme** („Marina“, „Port“, „Agios“, „Kap“, „Agia Marina“ neben „Marina“, Affix allein): keine falschen Erwähnungen, der längste Treffer gewinnt. → Task 8 Tests, Task 9 Test `longest match wins and affix-only names never match`.
4. **Gleicher Name an mehreren Orten im Kandidatenraum** (zwei „Agios Georgios“ in Nachbarkacheln, Transliteration „Porto Cheli/Heli“ im Band 0,6–0,75): nie stillschweigend der erste – Disambiguierung mit allen Kandidaten, Antwort „keines“ erzeugt nichts. → Task 9 Tests `two objects with the same name …`, Task 10 Tests.
5. **Neue Version mit übernommenen Chunks und Reprozessierung**: übernommene Chunks werden nicht erneut abgeglichen und kosten keine Extraktion; ein Reprozess-Lauf erzeugt einen neuen `extraction_run`, alte Facts bleiben, keine Dublette entsteht. → Task 9 Test `carried chunks are not matched again`, Task 17 Tests `reprocess …`.

---

## File Structure

```
lib/db/schema/text.ts                    mentions, ambiguous_matches, unmatched_names, name_candidates,
                                         document_classifications, extraction_runs, extraction_units,
                                         routes, route_stops, ai_batches, ai_batch_items, pipeline_passes,
                                         model_comparisons, model_comparison_units, model_comparison_ratings (+ Enums)
lib/db/schema/derived.ts                 facts + quote_chunk_id, quote_start, quote_end
drizzle/00NN_*.sql                       generiert + handgeschrieben (Trigger, Checks, FKs, Indizes)
config/fact-schema/{v2.ts,active.json}   Fact-Schema v2 (Text-Attribute aller Ebenen, Abbildungstabellen)
config/mentions.json, config/name-affixes.json, config/extraction.json, config/models.json, config/queues.json
config/prompts/{classify-document,disambiguate-mention,extract-facts,extract-route}/v1.md
lib/config/{schemas,index}.ts
lib/domain/facts/{schema-types,schema,levels}.ts
lib/domain/extraction/{quote,units,facts,routes,fidelity,active-run,comparison}.ts
lib/domain/mentions/{ngrams,affixes,scope,match,store,unmatched,classification}.ts
lib/domain/review-decisions.ts, lib/domain/review-view.ts      + name_candidate
lib/domain/{text-annotations,geo-facts,model-comparison-view}.ts
lib/ai/{types,anthropic,mock,batch-store,fixtures}.ts
lib/ai/tasks/{classify-document,disambiguate-mention,extract-facts,extract-route}.ts
lib/adapters/nominatim.ts
lib/pipeline/text/{classify,mentions,disambiguate,geocode,extract,routes,check,run}.ts
lib/jobs/{queues,stages,registry,batch-handlers}.ts, lib/jobs/handlers/{text,ai-batch}.ts
app/(admin)/documents/[id]/page.tsx, app/(admin)/geo/[id]/page.tsx, app/(admin)/places/[id]/{page.tsx,facts-tab.tsx}
app/(admin)/_components/{annotated-text.tsx,quote-context.tsx,labels.ts,nav.tsx}
app/(admin)/review/[id]/{page.tsx,actions.ts}, app/(admin)/tiles/[id]/{page.tsx,actions.ts}, app/(admin)/sources/actions.ts
app/(admin)/compare/models/{page.tsx,actions.ts}, app/(admin)/settings/page.tsx
lib/security/route-policy.ts
scripts/{fixtures-record,compare-models,model-report,check-texts}.ts
test/fixtures/texts/{gazetteer.json,de-trip-report.md,en-pilot-guide.md,el-forum.md,expected.json}
test/fixtures/ai/**, test/fixtures/http/nominatim/**
docs/runbook.md, docs/pilot/{m4-abnahme,m4-modellvergleich}.md, e2e/facts.spec.ts
```

---

### Task 1: Text-Schema und Beleg-Constraint

**Files:**
- Create: `lib/db/schema/text.ts`, Migration (generiert) + handgeschrieben `drizzle/00NN_text_triggers.sql`
- Modify: `lib/db/schema/index.ts`, `lib/db/schema/derived.ts` (Spalten an `facts`)
- Test: `lib/db/__tests__/text-schema.test.ts`

**Interfaces:**
- Consumes: `forbid_mutation()`, `document_versions`, `chunks`, `sources` (M3), `geo_objects`, `tiles`, `runs`, `facts` (M2).
- Produces:
  - Enums: `match_kind` (`deterministic, model, review`), `extraction_status` (`pending, done, skipped`), `ambiguous_status` (`pending, resolved, none`), `name_candidate_status` (`collecting, geocoded, review, decided`), `extraction_purpose` (`regular, reprocess, comparison`), `extraction_run_status` (`running, finished, blocked, failed`), `unit_status` (`pending, submitted, done, failed`), `mooring_kind` (`anchor, buoy, quay, marina, unknown`), `batch_status` (`submitting, submitted, ended, distributed, failed`), `batch_item_status` (`pending, succeeded, failed, retried`), `comparison_verdict` (`a_correct, b_correct, both_ok, both_wrong, unclear`).
  - `mentions` (nur anfügend, `forbid_mutation('extraction_status')`): `id`, `document_version_id`, `chunk_id`, `geo_object_id`, `surface text` (Wortlaut im Chunk), `char_start`, `char_end` (Offsets in `chunks.text`), `type_hint text`, `observed_at date not null`, `confidence real` (Check 0–1), `match_kind`, `match_score real`, `model text`, `prompt_version int`, `extraction_status` (Default `pending`), `run_id → runs`, `created_at`; eindeutig `(chunk_id, geo_object_id, char_start)`; Indizes `geo_object_id`, `document_version_id`.
  - `ambiguous_matches` (Arbeitszustand): `id`, `document_version_id`, `chunk_id`, `surface`, `char_start`, `char_end`, `type_hint`, `candidates jsonb` (`[{ geoObjectId, similarity }]`), `status`, `run_id`, `created_at`, `updated_at`; eindeutig `(chunk_id, char_start, char_end)`.
  - `unmatched_names` (Arbeitszustand): `id`, `name_normalized`, `display_name`, `hint text`, `document_version_id`, `chunk_id`, `source_id`, `tile_id` (nullable), `created_at`; eindeutig `(name_normalized, chunk_id)`.
  - `name_candidates` (Arbeitszustand): `id`, `name_normalized`, `display_name`, `hint`, `tile_id not null`, `status`, `documents int`, `sources int`, `geocode jsonb`, `created_at`, `updated_at`; eindeutig `(name_normalized, tile_id)`.
  - `document_classifications` (nur anfügend): `id`, `document_version_id`, `doc_type`, `languages text[]`, `published_at date`, `observed_at date not null`, `observed_at_basis`, `observed_at_reason text`, `area_hints text[]`, `model`, `prompt_version`, `run_id`, `created_at`; eindeutig `(document_version_id, model, prompt_version)`.
  - `extraction_runs` (Arbeitszustand): `id`, `task text` (`extract-facts|extract-route`), `model`, `prompt_version`, `fact_schema_version`, `purpose`, `comparison_id uuid` (nullable), `run_id → runs`, `status` (Default `running`), `stats jsonb default '{}'`, `quote_check jsonb`, `started_at`, `finished_at`; eindeutig `(run_id, task, model)`.
  - `extraction_units` (Arbeitszustand): `id`, `extraction_run_id`, `document_version_id`, `geo_object_id`, `part int`, `level text`, `mention_ids uuid[]`, `chunk_ids uuid[]`, `status`, `stats jsonb`, `input_tokens`, `output_tokens`, `cost_eur numeric(12,6)`, `created_at`, `updated_at`; eindeutig `(extraction_run_id, document_version_id, geo_object_id, part)`.
  - `routes` (nur anfügend): `id`, `document_version_id`, `extraction_run_id`, `stops_count int`, `created_at`; eindeutig `(document_version_id, extraction_run_id)`. `route_stops` (nur anfügend): `id`, `route_id`, `ordinal`, `name`, `geo_object_id` (nullable), `mention_id` (nullable), `date date`, `mooring`, `quote not null`, `quote_verified bool not null` (Check `= true`), `quote_chunk_id`, `leg jsonb`, `created_at`; eindeutig `(route_id, ordinal)`.
  - `ai_batches` (Arbeitszustand): `id`, `provider_batch_id text` (eindeutig, nullable bis eingereicht), `task`, `model`, `prompt_version`, `status`, `run_id`, `stage`, `outcome_key`, `poll_count int default 0`, `request_count`, `cost_eur numeric(12,6)`, `submitted_at`, `ended_at`, `created_at`; partiell eindeutig `(run_id, stage, outcome_key) where status not in ('distributed', 'failed')` (höchstens ein offener Batch je Stufen-Einheit). `ai_batch_items`: `id` (= `custom_id`), `batch_id`, `subject_type`, `subject_id`, `input jsonb`, `status`, `attempt int default 1`, `output jsonb`, `error text`, `input_tokens`, `output_tokens`, `cost_eur numeric(12,6)`, `distributed_at`, `created_at`.
  - `pipeline_passes` (Arbeitszustand): PK `(document_version_id, stage, config_key)`, `run_id`, `created_at`.
  - `model_comparisons`, `model_comparison_units`, `model_comparison_ratings` legt Task 19 an.
  - `facts` + `quote_chunk_id uuid → chunks`, `quote_start int`, `quote_end int`; FK `facts.mention_id → mentions`, `facts.extraction_run_id → extraction_runs` (in M2 ohne FK angelegt); Check `facts_text_quote_verified`: `mention_id is null or (quote_verified and quote_chunk_id is not null)`.

- [ ] **Step 1: Failing tests**

```ts
it.each(["mentions", "facts", "routes", "route_stops", "document_classifications"])("%s rejects DELETE", …); // /append-only/
it("mentions allow only extraction_status to change", …);         // update extraction_status ok; update confidence → /append-only/
it("a text fact without a verified quote is impossible", async () => withRollback(async (tx) => {
  // insert fact with mention_id, quote 'x', quote_verified false → violates facts_text_quote_verified
  // same with quote_verified true but quote_chunk_id null → violates
}));
it("a route stop with quote_verified false is rejected", …);
it("(chunk_id, geo_object_id, char_start) is unique for mentions", …);
it("(mention_id, attribute, extraction_run_id) is unique for facts", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/text-schema.test.ts` → FAIL (Tabellen fehlen).
- [ ] **Step 3: Implementieren.** `npm run db:generate`; Trigger, Checks und die FKs auf `facts` in der handgeschriebenen Migration mit `--> statement-breakpoint` und Journal-Eintrag (Muster `0006_geo_triggers.sql`). Tests in `withRollback`.
- [ ] **Step 4: Run** `npx vitest run lib/db` → PASS.
- [ ] **Step 5: Commit** `feat(db): mentions, extraction runs, routes, batches; no text fact without a verified quote`

### Task 2: Fact-Schema v2 mit Text-Attributen und Ebenen

**Files:**
- Create: `config/fact-schema/v2.ts`, `lib/domain/facts/levels.ts`
- Modify: `lib/domain/facts/schema-types.ts`, `lib/domain/facts/schema.ts`, `config/fact-schema/active.json` (`{ "version": "v2" }`), `app/(admin)/settings/page.tsx`
- Test: `lib/domain/facts/__tests__/schema-v2.test.ts`, `lib/domain/facts/__tests__/levels.test.ts`

**Interfaces:**
- Consumes: `FactSchema`, `AttributeDef`, `SECTORS`, `getFactSchema`, `validateFactValue` (M2 Task 2).
- Produces:
  - `AttributeDef` + optional `textValue?: z.ZodType` (was das Modell liefern darf) und `fromText?: (v: unknown) => unknown` (Abbildung auf den gespeicherten Wert); fehlt `textValue`, gilt `value`. Nur Attribute mit `origins` ∋ `text` dürfen aus Texten kommen.
  - `TEXT_SCALE = { good: 0.9, moderate: 0.5, poor: 0.1 } as const` (Schutz-Kodierung), exportiert aus `v2.ts` und im Prompt als Abbildungstabelle.
  - `factSchemaV2: FactSchema` = alle v1-Attribute unverändert, plus:
    - `place` (text): `shelter.<Sektor>` und `swell_protection` mit `textValue: enum(good|moderate|poor)` → `TEXT_SCALE`; `depth.min`, `depth.max`, `depth.anchoring_min`, `depth.anchoring_max` (Zahl 0–200, m); `seabed` (wie v1; `textValue`: Array von Grundtypen ohne Anteile → gleichverteilte Anteile, Summe 1); `holding` (`good|moderate|poor`, Regel `holding`); `mooring.types` (Array, ≥ 1, aus `anchor, buoy, lines_ashore, stern_to, alongside, pontoon`); `mooring.buoys` (`{ present: boolean; count: int ≥ 1 | null; paid: boolean | null }`); `mooring.line_ashore_required` (bool); `capacity` (int 1–2000); `max_draft`, `max_length` (Zahl, m); `occupancy` (`Record<"1".."12", "empty"|"moderate"|"full">`, ≥ 1 Monat); `services.water`, `services.electricity`, `services.fuel`, `services.dinghy_landing`, `services.waste`, `services.showers`, `services.wifi` (bool); `prohibitions` (Array `{ kind: anchoring|swimming|fishing|fire|jet_ski|other; months: int 1–12[] | null }`); `hazards` (Array `{ kind: rock|shoal|wreck|cable|current|swell|fish_farm|other; name: string ≤ 80 | null }`); `highlight.<category>` für `food, supply, beach, nature, active, culture, town` (`{ present: boolean; names: string ≤ 80 [] ≤ 10 }`, Regel `highlight`); `quietness` (`quiet|moderate|busy|noisy`); `season_notes` (`{ months: int 1–12[] ≥ 1; kind: open|closed|crowded|meltemi|other }`); `prices` (`{ amount: number ≥ 0; currency: "EUR"; unit: night|meter_night|other }`); `contact` (`{ vhf: string ≤ 10 | null; phone: string ≤ 30 | null; url: url | null }`).
    - `area` und `island`: `meltemi_exposure` (`textValue` `TEXT_SCALE`-Wörter `low|moderate|high` → 0,1/0,5/0,9), `wind_systems` (Array `{ name: meltemi|sirocco|bora|maestral|land_breeze|other; months: int[] }`), `ferry_traffic` (`none|low|moderate|high`), `restricted_zones` (Array `{ kind: military|firing|protected|other; name: string ≤ 80 | null }`), `charter_bases` (Array Eigennamen ≤ 80), `supply_ports` (Array Eigennamen ≤ 80).
    - `cape_strait`: `passage` (`{ difficulty: easy|moderate|difficult; notes: (acceleration|current|overfalls|traffic|shallow)[] }`), `sea_state` (`calm|moderate|rough`), `hazards` (wie Ort).
    - `poi`: `exists` (bool), `season_notes` (wie Ort), `dinghy_access` (bool).
    - Regelnamen (`rule`) nach Spec 07: `shelter`, `swell_protection`, `bathymetry`, `holding`, `latest_observation`, `occupancy`, `highlight`, `prohibitions`, `area_weighted`, `default`.
  - `validateTextFact(level: FactLevel, attribute: string, raw: unknown, version?: string): { ok: true; value: unknown } | { ok: false; reason: "unknown_attribute" | "not_text" | "invalid_value" }` – Attribut der Ebene mit Herkunft `text`, `textValue` parsen, `fromText`, dann `value` parsen.
  - `levelFor(db, geoObjectId: string): Promise<FactLevel | null>` in `levels.ts` – gültiger `places`-Eintrag mit Status ≠ `rejected` → `place`; sonst nach Typ: `area, gulf, sea` → `area`; `island, islet, archipelago, coast_section` → `island`; `cape, strait, channel` → `cape_strait`; `poi` → `poi`; `bay, harbour` ohne Ort → `place`; `settlement` ohne Ort → `null`.
  - `attributesForPrompt(level: FactLevel, version?: string): string` – je Zeile `key — description — Wertformat` (aus `z.toJSONSchema(textValue ?? value)` kompakt).

- [ ] **Step 1: Failing tests**

```ts
it("v2 keeps every v1 key and value schema", …);                     // v1 keys ⊂ v2 keys; validateFactValue gleich für shelter.N 0.4
it("shelter words map to the scale", () => {
  expect(validateTextFact("place", "shelter.N", "good")).toEqual({ ok: true, value: 0.9 });
  expect(validateTextFact("place", "shelter.N", 0.4)).toMatchObject({ ok: false, reason: "invalid_value" });
});
it("computed-only attributes cannot come from text", () => {
  expect(validateTextFact("place", "anchor_area", { areaM2: 1 })).toMatchObject({ reason: "not_text" });
});
it("an attribute of another level is unknown", () => {
  expect(validateTextFact("island", "shelter.N", "good")).toMatchObject({ reason: "unknown_attribute" });
});
it("seabed from text gets equal shares", () => {
  expect(validateTextFact("place", "seabed", ["sand", "weed"])).toEqual({ ok: true, value: [{ type: "sand", share: 0.5 }, { type: "weed", share: 0.5 }] });
});
it("highlight values hold names, not prose", …);                     // names entry of 81 chars → invalid_value
// levels.test.ts (withRollback)
it("a bay with a confirmed place is level place, a settlement without place none, an islet island", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/facts` → FAIL.
- [ ] **Step 3: Implementieren.** `v2.ts` importiert `factSchemaV1` und erweitert es; `getFactSchema` kennt `v1` und `v2`. `/settings` zeigt die aktive Version und je Ebene die Zahl der Attribute.
- [ ] **Step 4: Run** → PASS (M2-Tests für v1 bleiben grün).
- [ ] **Step 5: Commit** `feat(facts): fact schema v2 with text attributes for all levels`

### Task 3: Zitatprüfung und Text-Segmente

**Files:**
- Create: `lib/domain/extraction/quote.ts`
- Test: `lib/domain/extraction/__tests__/quote.test.ts`

**Interfaces:**
- Consumes: `normalizeText` (M3 Task 8).
- Produces:
  - `normalizeForQuote(s: string): { text: string; map: number[] }` – Reihenfolge: Inline-Markdown abstreifen (`[t](u)` → `t`, `**`, `__`, `` ` ``, einzelnes `*`/`_` an Wortgrenzen), weiches Trennzeichen U+00AD und Nullbreiten-Zeichen weg, dann die Regeln von `normalizeText` (NFC, Anführungszeichen → `"`/`'`, Striche → `-`, Leerraum → ein Leerzeichen, trim). `map[i]` = Offset des Zeichens `i` im Original. Groß/Klein und Akzente bleiben.
  - `type QuoteCheck = { ok: true; start: number; end: number } | { ok: false; reason: "empty" | "too_long" | "too_short" | "ellipsis" | "not_found" }`
  - `locateQuote(chunkText: string, quote: string, cfg: { minChars: number; maxChars: number }): QuoteCheck` – Zitat > `maxChars` (300) → `too_long`; normalisiert < `minChars` → `too_short`; enthält `…` oder `...` → `ellipsis`; sonst erster Teilstring-Treffer im normalisierten Chunk, Offsets über `map` zurück auf den Original-Chunk (`end` exklusiv).
  - `type Span = { start: number; end: number; kind: "mention" | "quote"; ref: string }`; `segmentText(text: string, spans: Span[]): Array<{ text: string; kinds: Array<"mention" | "quote">; refs: string[] }>` – Grenzen aller Spans, überlappende Spans erzeugen Segmente mit mehreren `kinds`, Spans außerhalb des Texts werden gekappt.

- [ ] **Step 1: Failing tests**

```ts
const cfg = { minChars: 12, maxChars: 300 };
const de = "Der Ankergrund ist **Sand**, gut haltend.\nDie „Taverne Nikos“ – direkt am Steg – öffnet im Mai.";
it("markdown, quotes, dashes and line breaks do not matter", () => {
  expect(locateQuote(de, "Der Ankergrund ist Sand, gut haltend", cfg)).toMatchObject({ ok: true, start: 0 });
  const r = locateQuote(de, 'Die "Taverne Nikos" - direkt am Steg', cfg);
  expect(r.ok && de.slice(r.start, r.end)).toBe("Die „Taverne Nikos“ – direkt am Steg");
});
it("greek in NFD matches greek in NFC", () => {
  const el = "Ο όρμος προσφέρει καλή προστασία από τα βόρεια.";
  expect(locateQuote(el, "όρμος προσφέρει καλή προστασία".normalize("NFD"), cfg).ok).toBe(true);
});
it.each([
  ["Der Ankergrund ist sandig", "not_found"],                 // Paraphrase
  ["der ankergrund ist sand, gut haltend", "not_found"],       // Groß/Klein
  ["Der Ankergrund … gut haltend", "ellipsis"],
  ["gut haltend. Die Taverne Nikos öffnet im Mai", "not_found"], // aus zwei Sätzen zusammengesetzt
  ["Sand", "too_short"],
  ["x".repeat(301), "too_long"],
])("%s is rejected as %s", (quote, reason) => expect(locateQuote(de, quote, cfg)).toEqual({ ok: false, reason }));
it("segments overlapping mention and quote spans", () => {
  expect(segmentText("abcdef", [{ start: 1, end: 4, kind: "quote", ref: "f" }, { start: 2, end: 3, kind: "mention", ref: "m" }]))
    .toEqual([{ text: "a", kinds: [], refs: [] }, { text: "b", kinds: ["quote"], refs: ["f"] },
              { text: "c", kinds: ["quote", "mention"], refs: ["f", "m"] }, { text: "d", kinds: ["quote"], refs: ["f"] },
              { text: "ef", kinds: [], refs: [] }]);
});
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/extraction/__tests__/quote.test.ts` → FAIL.
- [ ] **Step 3: Implementieren.** Normalisierung zeichenweise mit Offset-Liste; keine Regex über den ganzen Text, die Offsets verliert.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(extraction): verbatim quote check with offset mapping and text segments`

### Task 4: Konfiguration für Erwähnungen, Extraktion und Modelle

**Files:**
- Create: `config/mentions.json`, `config/name-affixes.json`, `config/extraction.json`
- Modify: `config/models.json`, `config/queues.json`, `lib/config/schemas.ts`, `lib/config/index.ts`, `app/(admin)/settings/page.tsx`
- Test: `lib/config/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  - `MentionsConfig`: `{ exactMinChars 3, fuzzyMinChars 5, sureSimilarity 0.75, uncertainSimilarity 0.6, maxNgramWords 4, maxCandidates 6, neighbourRing 1 /* Test-Schalter: 2 */, versionsPerJob 50, prepassTypes ["area", "gulf", "archipelago", "island"], fallbackScope "source_areas", stopNames ["agios", "agia", "agioi", "ag", "port", "porto", "marina", "kap", "cape", "bay", "nisos", "nisi", "limani"] }`.
  - `NameAffixesConfig = Array<{ affix: string /* normalisiert */; position: "prefix" | "suffix"; hint: "bay" | "harbour" | "anchorage" | "cape" | "island" | "marina" }>` mit: prefix `ormos`, `orm`, `ormo`, `ormou`, `ορμοσ`, `ορμο`, `ορμου`, `bay of`, `bucht von`, `baie de`, `limani`, `limanaki`, `λιμανι`, `porto`, `port`, `ankerplatz`, `ankerbucht`, `kap`, `cape`, `akrotirio`, `nisos`, `nisis`, `νησοσ`, `marina` (hint `marina`); suffix `bay`, `cove`, `anchorage`, `harbour`, `harbor`, `bucht`, `hafen`, `marina`, `island`, `insel`.
  - `ExtractionConfig`: `{ quote { minChars 12, maxChars 300 }, unit { neighbourChunks 1, maxChunksPerUnit 6 }, maxFactsPerUnit 40, unitsPerBatch 100, classifyWords 1500, routeSectionWords 20000, poiMatchRadiusM 2000, poiSimilarity 0.75, geocode { minDocuments 2, minSources 2, radiusKm 20, limit 5, endpoint "https://nominatim.openstreetmap.org/search", ratePerMinute 60 }, earliestDate "1990-01-01", comparison { units 200, minSources 8, ratingSample 50, numericTolerance 0.1 } }`.
  - `models.json`: Task-Eintrag erweitert um optional `effort` (`low|medium|high`, Default `low`), `maxTokens` (Default 4096), `cacheSystem` (bool, Default false), `decision?: { status: "provisional" | "decided"; note: string }`; neue Tasks `classify-document` (`claude-haiku-5-5`, v1, low, 1024), `disambiguate-mention` (`claude-haiku-5-5`, v1, low, 512), `extract-facts` (`claude-sonnet-5-5`, v1, medium, 8000, `cacheSystem` true, `decision { status "provisional", note "Vorläufig Sonnet bis zur Auswertung des Vergleichs an 200 Erwähnungen." }`), `extract-route` (`claude-sonnet-5-5`, v1, medium, 8000); Abschnitt `batch: { discount 0.5, pollSeconds 60, maxHours 26, maxRequests 1000 }`; `comparison: { models: ["claude-sonnet-5-5", "claude-opus-5-5"] }`. Preise vor Aufzeichnung der Fixtures gegen die Anthropic-Preisliste prüfen (Abweichungen in der Commit-Nachricht).
  - `config/queues.json`: `classify.document_version`, `mentions.batch` (2), `mentions.disambiguate`, `mentions.geocode` (1), `extraction.mention`, `extraction.route`, `extraction.check`, `ai.batch.poll` (1); sofern nicht genannt concurrency 1, retryLimit 2, 60 s, Backoff.
  - `AppConfig` + `mentions`, `nameAffixes`, `extraction`; `models`-Schema wie oben.

- [ ] **Step 1: Failing tests**

```ts
it("the extraction model starts provisional on sonnet", () => {
  expect(cfg.models.tasks["extract-facts"]).toMatchObject({ model: "claude-sonnet-5-5", decision: { status: "provisional" } });
});
it("every model named in tasks and comparison has a price", …);
it("affixes are stored normalized", …);   // each affix === normalizeName(affix)
it("an unknown affix hint is rejected", …);
it("neighbourRing only allows 1 or 2", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; `/settings` zeigt Modelle je Task mit Entscheidungsstatus und Prompt-Version. **Step 4: Run** `npx vitest run lib/config` → PASS.
- [ ] **Step 5: Commit** `feat(config): mentions, name affixes, extraction and model task settings`

### Task 5: `ModelClient` mit Batches, Modell-Override und Fixture-Wiedergabe

**Files:**
- Create: `lib/ai/fixtures.ts`
- Modify: `lib/ai/types.ts`, `lib/ai/anthropic.ts`, `lib/ai/mock.ts`
- Test: `lib/ai/__tests__/ai.test.ts`, `lib/ai/__tests__/batch.test.ts`

**Interfaces:**
- Consumes: `assertWithinBudget`, `recordExternalCall`, `loadPrompt`, `renderPrompt`, `canonicalJson`, Task 4.
- Produces:
  - `type ModelCallOptions = { runId?: string; stage?: string; model?: string }` (ersetzt den bisherigen `ctx`, kompatibel).
  - `type BatchRequest<I> = { customId: string; input: I }`; `type BatchItemResult<O> = { customId: string; ok: true; output: O; usage: { inputTokens: number; outputTokens: number }; costEur: number } | { customId: string; ok: false; error: string; retryable: boolean }`.
  - `ModelClient` + `submitBatch<I, O>(task: ModelTask<I, O>, requests: BatchRequest<I>[], opts?: ModelCallOptions): Promise<{ batchId: string; model: string; promptVersion: number }>` und `collectBatch<I, O>(task: ModelTask<I, O>, batchId: string, opts?: ModelCallOptions): Promise<{ status: "in_progress" | "ended"; results: BatchItemResult<O>[] }>`.
  - Anthropic: gemeinsame `buildParams(task, input, taskCfg, model)` für `call` und Batch (System mit `cache_control: { type: "ephemeral" }`, wenn `cacheSystem`; `output_config: { effort, format: json_schema }`; `max_tokens` aus Konfiguration); `submitBatch` prüft das Budget und ruft `messages.batches.create({ requests: [{ custom_id, params }] })`; `collectBatch` ruft `retrieve`, bei `processing_status === "ended"` `results` und ordnet nach `custom_id`. Ergebnis `succeeded` → Text parsen und gegen `task.output` prüfen (ungültig → `ok: false, retryable: true`); `errored` mit `invalid_request` → nicht wiederholbar, sonst wiederholbar; `expired`, `canceled` → wiederholbar. Kosten je Treffer = Token × Preis × `batch.discount`; ein `external_calls`-Eintrag je eingesammeltem Batch (`operation "<task>.batch"`, `units` = Summe Token, `meta { batchId, model, items }`).
  - `AnthropicMessagesApi` = `Pick<Anthropic, "messages">` bleibt (Fake-SDK in Tests mit `messages.batches`).
  - `MockModel`: `submitBatch` speichert die Anfragen unter `mock-batch-<n>`, `collectBatch` antwortet sofort `ended` über die registrierten Funktionen; wirft die Funktion `new MockBatchError(message, retryable)`, entsteht `ok: false`; jede andere Ausnahme `ok: false, retryable: false`.
  - `fixtureKey(taskName: string, input: unknown): string` = sha256 von `canonicalJson({ task, input })`; `loadAiFixtures(dir = "test/fixtures/ai"): Record<string, (input: unknown) => unknown>` (Dateien `<task>/<key>.json` mit `{ task, key, input, output, model, recordedAt }`); `MockModel.fromFixtures(dir?)`.

- [ ] **Step 1: Failing tests**

```ts
it("submitBatch sends one request per item with custom_id, effort and json schema", …); // fake SDK captures params
it("collectBatch maps results by custom_id, not by position", …);                      // fake returns reversed order
it("an invalid_request error is not retryable, an overloaded one is", …);
it("schema-invalid output becomes a retryable failure", …);
it("batch cost applies the 0.5 discount and writes one external_calls row", …);        // 1M in-tokens sonnet → 0.88865
it("an exhausted anthropic budget throws BudgetExceeded before submitting", …);
it("opts.model overrides the configured model", …);
it("MockModel.fromFixtures answers a recorded input and throws for an unknown one", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/ai` → FAIL.
- [ ] **Step 3: Implementieren.** Feld- und Methodennamen der SDK aus `typescript/claude-api/batches.md` (claude-api-Skill) übernehmen, Typfehler vom Compiler klären lassen.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ai): message batches, model override and recorded fixtures`

### Task 6: Batch-Ablage und `ai.batch.poll`

**Files:**
- Create: `lib/ai/batch-store.ts`, `lib/jobs/batch-handlers.ts`, `lib/jobs/handlers/ai-batch.ts`
- Modify: `lib/jobs/{queues,registry}.ts`, `worker/index.ts` (Model-Client im Job-Kontext)
- Test: `lib/ai/__tests__/batch-store.test.ts`

**Interfaces:**
- Consumes: Task 1, 5; `extendStage` (M3), `recordJobOutcome`, `enqueueRunAdvance`.
- Produces:
  - `type BatchItemInput = { subjectType: string; subjectId: string; input: unknown }`
  - `submitStageBatch(db, deps: { model: ModelClient; boss: PgBoss }, req: { task: ModelTask<unknown, unknown>; runId: string; stage: string; key: string; items: BatchItemInput[]; modelOverride?: string }): Promise<{ batchId: string | null; items: number; reused: boolean }>` – leer → nichts; vorhandener offener Batch `(runId, stage, key)` → `reused`; sonst in einer Transaktion `ai_batches` (`submitting`, `outcome_key = "batch:" + key`) + Items + `extendStage(runId, stage, 1)`; danach `submitBatch`, `provider_batch_id`, `submitted`, Poll-Job `ai.batch.poll` mit `startAfter = pollSeconds`. Ein wiederholter Job mit Batch im Zustand `submitting` reicht erneut ein (siehe Abweichungen).
  - `type BatchHandler = (db: Db, item: { subjectType: string; subjectId: string; input: unknown; output: unknown; batch: { id: string; model: string; promptVersion: number; runId: string; stage: string } }) => Promise<void>`; `BATCH_HANDLERS: Record<string, BatchHandler>` in `lib/jobs/batch-handlers.ts` (Tasks 7, 10, 13, 16 tragen sich ein).
  - `pollBatch(db, deps: { model: ModelClient; boss: PgBoss; now?: () => Date }, batchId: string): Promise<"waiting" | "distributed" | "resubmitted" | "failed">`:
    1. `in_progress` → `poll_count + 1`, neuer Poll-Job (`startAfter` `pollSeconds`, Job-ID uuidv5 `batchId:poll_count`); älter als `maxHours` → `failed`, Items `failed`, Einheit als `failed` gemeldet.
    2. `ended` → Ergebnisse an Items (`succeeded` mit `output`, Token, Kosten; `failed` mit `error`); wiederholbare Fehler mit `attempt = 1` → neuer Batch mit demselben `outcome_key`, Items umgehängt (`attempt 2`, alter Status `retried`).
    3. Verteilen: je Item mit `succeeded` und `distributed_at is null` in eigener Transaktion `BATCH_HANDLERS[task]` und `distributed_at = now()`.
    4. Kein Folge-Batch offen → `recordJobOutcome(runId, stage, outcome_key, "done")`, bei `nextStage` → `enqueueRunAdvance`; Batch `distributed`.
  - Queue `ai.batch.poll` (nicht Teil eines Laufs; Fehler → `failed_job` wie jede Queue).

- [ ] **Step 1: Failing tests**

```ts
// MockModel + echte Stufen-Zähler (createRun/beginStage), BATCH_HANDLERS-Fake zählt Aufrufe
it("a stage with 1 submit job finishes only after its batch is distributed", …);   // total 1 → extend → 2; done after poll
it("distributing twice calls each handler once and records the outcome once", …);  // pollBatch zweimal → handler-Zähler 3 bei 3 Items
it("a retried submit job reuses its batch", …);                                    // submitStageBatch zweimal gleicher key → reused, 1 Batch
it("retryable failures are resubmitted once, then fail", …);                       // MockBatchError(…, true) zweimal → Item failed, Outcome done
it("a batch older than maxHours fails its unit", …);
it("an empty item list submits nothing and does not extend the stage", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/ai/__tests__/batch-store.test.ts` → FAIL.
- [ ] **Step 3: Implementieren.** Der Worker reicht `createAnthropicClient(db)` über einen Getter im Handler-Modul (Tests setzen `MockModel`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ai): batch store, self-rescheduling poll job, idempotent distribution`

### Task 7: Dokument-Klassifikation (`classify.document_version`)

**Files:**
- Create: `lib/ai/tasks/classify-document.ts`, `config/prompts/classify-document/v1.md`, `lib/domain/mentions/classification.ts`, `lib/pipeline/text/classify.ts`, `lib/pipeline/text/run.ts` (nur `textRunVersions`)
- Modify: `lib/jobs/{batch-handlers,stages,registry}.ts`, `lib/jobs/handlers/text.ts`
- Test: `lib/domain/mentions/__tests__/classification.test.ts`

**Interfaces:**
- Consumes: Task 1, 4–6, `DOC_TYPES`, `documents`, `document_versions`, Archiv (Markdown über `md_key`).
- Produces:
  - Task `classify-document`: Eingabe `{ title: string | null; url: string; fetchedAt: string; text: string }`; Ausgabe `{ doc_type: DocType; languages: string[] (2 Buchstaben, ≤ 5); published_at: string | null /* YYYY-MM-DD */; observed_at: string | null /* YYYY-MM oder YYYY-MM-DD */; observed_at_explicit: boolean; observed_at_reason: string | null (≤ 300); areas: string[] (≤ 10) }`. Prompt-Variablen `title`, `url`, `fetched_at`, `doc_types`, `text`.
  - `firstWords(md: string, n: number): string`.
  - `resolveObservedAt(out, fetchedAt: Date, earliest: string): { observedAt: string; basis: "explicit" | "published" | "fetched"; publishedAt: string | null }` – Monat → Tag 15; Datum vor `earliest` oder nach `fetchedAt` verworfen; explizit nur mit `observed_at_explicit`.
  - `storeClassification(db, versionId: string, out, meta: { model: string; promptVersion: number; runId: string; fetchedAt: Date }): Promise<void>` (Konflikt → nichts).
  - `effectiveVersionMeta(db, versionId: string): Promise<{ docType: DocType; languages: string[]; observedAt: string; basis: ObservedAtBasis; areaHints: string[]; sourceId: string; fetchedAt: Date }>` – jüngste Klassifikation, sonst Spalten der Version.
  - `type TextRunParams = { documentVersionIds?: string[]; pending?: true; tileId?: string; areaKey?: string; reprocess?: true; rematch?: true; comparisonId?: string; models?: string[] }`; `textRunVersions(db, params: TextRunParams, cfg): Promise<string[]>` – hier nur `documentVersionIds` (direkt) und `pending` (aktuelle Versionen aktiver Dokumente ohne `pipeline_passes (mentions.batch, mentionsConfigKey)`, bis Task 9 den Schlüssel liefert: ohne jeden Pass); Task 17 ergänzt die übrigen Felder.
  - Stufe `classify.document_version`: Plan = Versionen des Laufs (`textRunVersions`) ohne Klassifikation für das aktive (Modell, Prompt-Version), Jobs zu je `unitsPerBatch`; Job → `submitStageBatch`. Batch-Handler schreibt die Klassifikation.

- [ ] **Step 1: Failing tests**

```ts
it("'Wir waren im Mai 2024' gives 2024-05-15 explicit", …);
it("without an explicit date the published date wins, else the fetch date", …);
it("a future or pre-1990 date is ignored", …);
it("the effective meta prefers the classification over the fetch columns", …);
it("the stage plans only unclassified versions and stores one row per version", …); // MockModel, zweimal → 1 Zeile
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Prompt nach den gemeinsamen Regeln (nur aus dem Text, Datum nur wenn im Text). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(text): document classification with observed date and area hints`

### Task 8: N-Gramme, Affixe, Ortshinweise

**Files:**
- Create: `lib/domain/mentions/ngrams.ts`, `lib/domain/mentions/affixes.ts`, `lib/domain/mentions/unmatched.ts`
- Test: `lib/domain/mentions/__tests__/ngrams.test.ts`

**Interfaces:**
- Consumes: `normalizeName`, `isGreek`, `transliterateElot743` (M1), `NameAffixesConfig`.
- Produces:
  - `type Ngram = { start: number; end: number; surface: string; forms: string[]; words: number }` – `forms` = `normalizeName(surface)` und, bei griechischen Wörtern, `normalizeName(transliterateElot743(surface))`, dedupliziert.
  - `ngrams(text: string, maxWords: number): Ngram[]` – Wörter = Folgen von Buchstaben/Ziffern (mit Binnen-Apostroph und -Bindestrich), N-Gramme überschreiten keine Satzgrenze (`.!?;·` und Zeilenumbruch).
  - `stripAffix(form: string, affixes: NameAffixesConfig): { core: string; hint: Hint } | null` – nur wenn ein Wort übrig bleibt.
  - `isStopName(form: string, cfg: MentionsConfig, affixes): boolean` – Form in `stopNames`, nur ein Affix, kürzer als `exactMinChars` oder nur Ziffern.
  - `type UnmatchedDraft = { display: string; nameNormalized: string; hint: Hint; start: number; end: number }`; `nameHints(text: string, affixes): UnmatchedDraft[]` – Präfix-Affix gefolgt von 1–3 Wörtern mit Großbuchstaben am Anfang, oder 1–3 solche Wörter gefolgt von einem Suffix-Affix; `display` = diese Wörter im Original.

- [ ] **Step 1: Failing tests**

```ts
it("1–4 word n-grams stop at sentence ends", () => {
  const g = ngrams("Wir ankerten vor Kolona. Danach Vathy", 4).map((n) => n.forms[0]);
  expect(g).toContain("vor kolona"); expect(g).not.toContain("kolona danach");
});
it("greek n-grams carry their transliteration", () => {
  expect(ngrams("στο Πόρτο Χέλι", 2).find((n) => n.surface === "Πόρτο Χέλι")!.forms).toEqual(["πορτο χελι", "porto cheli"]);
});
it("affixes are stripped with their hint", () => {
  expect(stripAffix("bucht von kolona", affixes)).toEqual({ core: "kolona", hint: "bay" });
  expect(stripAffix("vathy bay", affixes)).toEqual({ core: "vathy", hint: "bay" });
  expect(stripAffix("ορμο βαθυ", affixes)).toEqual({ core: "βαθυ", hint: "bay" });
  expect(stripAffix("bay", affixes)).toBeNull();
});
it("stop names never match on their own", () => {
  for (const s of ["marina", "port", "agios", "kap", "bucht", "12"]) expect(isStopName(s, cfg, affixes)).toBe(true);
});
it("name hints find Kolona Bay, Ormos Vathy and όρμο Βαθύ", () => {
  expect(nameHints("We anchored in Kolona Bay, later at Ormos Vathy.", affixes).map((h) => [h.display, h.hint]))
    .toEqual([["Kolona", "bay"], ["Vathy", "bay"]]);
  expect(nameHints("Αγκυροβολήσαμε στον όρμο Βαθύ.", affixes)[0]).toMatchObject({ display: "Βαθύ", nameNormalized: "βαθυ" });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mentions): name n-grams with transliteration, affixes and place hints`

### Task 9: Kandidatenraum, Match und Stufe `mentions.batch`

**Files:**
- Create: `lib/domain/mentions/scope.ts`, `lib/domain/mentions/match.ts`, `lib/domain/mentions/store.ts`, `lib/pipeline/text/mentions.ts`, `test/fixtures/texts/{gazetteer.json,de-trip-report.md,en-pilot-guide.md,el-forum.md,expected.json}`
- Modify: `lib/jobs/{stages,registry}.ts`, `lib/jobs/handlers/text.ts`
- Test: `lib/domain/mentions/__tests__/match.test.ts`, `lib/pipeline/__tests__/mentions.test.ts`

**Interfaces:**
- Consumes: Task 1, 4, 7, 8; `tileNeighbours`, `tile_geo_objects`, `tiles.area_id`, `geo_names` (GIN trgm), `serp_queries` (M3, Bezug Quelle → Revier/Kachel), `effectiveVersionMeta`.
- Produces:
  - `candidateTiles(db, versionId: string, cfg: MentionsConfig): Promise<{ tiles: string[]; basis: "prepass" | "history" | "source" | "fallback" }>` – Vereinigung aus (a) Vorlauf: N-Gramme aller Chunks der Version gegen Namen gültiger Objekte der Typen `prepassTypes` (exakte Formen, ohne Kachel-Einschränkung) und gegen `areaHints` der Klassifikation → Kacheln dieser Objekte bzw. Reviere; (b) Kacheln der Erwähnungen früherer Versionen desselben Dokuments; (c) Revier-/Kachel-Bezug der Quelle aus `serp_queries`; dann Ring `neighbourRing` (1 = 8 Nachbarn, 2 = 24) um jede Kachel; leer → alle Kacheln der Reviere aus `config/areas` (`fallback`).
  - `candidateObjects(db, tiles: string[]): Promise<string[]>` – gültige Objekte in `tile_geo_objects` dieser Kacheln plus deren Eltern.
  - `type MatchHit = { start: number; end: number; surface: string; geoObjectId: string; similarity: number; exact: boolean; hint: Hint | null }`
  - `findNameHits(db, forms: Array<{ ngram: number; form: string }>, objectIds: string[], cfg): Promise<MatchHit[]>` – ein SQL je Chunk: `unnest` der Formen (voll und ohne Affix) gegen `geo_names.name_normalized` (und deren affixfreie Form) gültiger Namen der Kandidaten; exakt (`=`) ab `exactMinChars`, unscharf `similarity ≥ uncertainSimilarity` nur bei Namen ≥ `fuzzyMinChars`; Stop-Namen nie.
  - `resolveHits(hits: MatchHit[], cfg): Array<{ kind: "sure"; hit: MatchHit } | { kind: "ambiguous"; start: number; end: number; surface: string; hint: Hint | null; candidates: Array<{ geoObjectId: string; similarity: number }> }>` – je Textspanne die Objekte gruppieren; Spannen nach (Wörter absteigend, beste Similarity absteigend, Start) wählen, überlappende verwerfen; sicher = genau ein Objekt mit exaktem Treffer oder Similarity ≥ `sureSimilarity`; mehrere Objekte → bei Affix-Hinweis genau eines vom passenden Typ (`bay` → `bay`, `harbour`/`marina` → `harbour`, `cape` → `cape`, `island` → `island|islet`) sicher, sonst mehrdeutig; ein Objekt im Band 0,6–0,75 → mehrdeutig; höchstens `maxCandidates`, nach Similarity.
  - `matchVersion(db, versionId: string, ctx: { runId: string; cfg: AppConfig }): Promise<{ mentions: number; ambiguous: number; unmatched: number; chunks: number }>` – nur Chunks mit `carried_from_chunk_id is null`; sichere Treffer → `mentions` (`deterministic`, `confidence = similarity`, `observed_at` aus `effectiveVersionMeta`), mehrdeutige → `ambiguous_matches`, `nameHints` ohne Treffer an derselben Stelle → `unmatched_names` (Kachel = Kachel des im Chunk nächstgelegenen erwähnten Objekts, sonst die häufigste Kachel der Version); `pipeline_passes (version, "mentions.batch", mentionsConfigKey(cfg))`. Alles idempotent über die Eindeutigkeiten.
  - `mentionsConfigKey(cfg: AppConfig): string` = `"mentions:" + sha256(canonicalJson({ mentions, nameAffixes })).slice(0, 12)`.
  - Stufe `mentions.batch`: Plan = Versionen des Laufs (`textRunVersions`, Task 7), Jobs zu je `versionsPerJob` (50), Job-Daten `{ key, versionIds }`.

- [ ] **Step 1: Failing tests**

```ts
// match.test.ts – synthetische Objekte um 21,0° O / 35,2° N in withRollback (Kacheln q025:804:481 ff.)
it("an exact unique name is a deterministic mention with confidence 1", …);
it("longest match wins and affix-only names never match", () => {
  // Objekte "Agia Marina" (bay) und "Marina" (harbour); Text "in Agia Marina" → eine Erwähnung Agia Marina; Text "zur Marina" → keine
});
it("two objects with the same name in neighbour tiles are ambiguous with both candidates", …);
it("a 'Bay' hint picks the one bay among same-named objects", …);
it("'porto heli' against 'porto cheli' lands in the uncertain band", …);  // similarity ≈ 0,64 → ambiguous (Ruling T7-R1)
it("greek text matches the latin transliteration exactly", …);           // "Πόρτο Χέλι" ↔ Name "Porto Cheli"
it("an object two tiles away matches only with neighbourRing 2", …);
it("islands and areas are mentioned too", …);
// mentions.test.ts – Fixture-Texte de/en/el gegen test/fixtures/texts/gazetteer.json
it("fixture documents yield exactly the expected mentions, ambiguities and unmatched names", …); // expected.json
it("carried chunks are not matched again", …);              // Version 2 mit übernommenen Chunks → 0 neue Zeilen für sie
it("a second pass adds nothing", …);
it("at least 70 % of the fixture mentions need no model", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/mentions lib/pipeline/__tests__/mentions.test.ts` → FAIL.
- [ ] **Step 3: Implementieren.** Schwelle explizit im SQL (`similarity(n.name_normalized, f) >= $min`); für die Index-Nutzung zusätzlich `n.name_normalized % f` mit `SET LOCAL pg_trgm.similarity_threshold = <uncertainSimilarity>` in der Transaktion des Jobs.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mentions): candidate tiles, trigram matching with longest-span resolution`

### Task 10: Disambiguierung (`mentions.disambiguate`)

**Files:**
- Create: `lib/ai/tasks/disambiguate-mention.ts`, `config/prompts/disambiguate-mention/v1.md`, `lib/pipeline/text/disambiguate.ts`
- Modify: `lib/jobs/{batch-handlers,stages,registry}.ts`, `lib/jobs/handlers/text.ts`
- Test: `lib/pipeline/__tests__/disambiguate.test.ts`

**Interfaces:**
- Consumes: Task 1, 6, 9; `displayNameSql`, Eltern-Kette (`geo_objects.parent_id`), Zentroid.
- Produces:
  - Task `disambiguate-mention`: Eingabe `{ chunk: string /* mit [[surface]] markiert */; surface: string; candidates: Array<{ n: number; name: string; type: GeoObjectType; parents: string[]; lon: number; lat: number }> }`; Ausgabe `{ choice: number /* 0 = keines, sonst n */; confidence: number /* 0–1 */ }`. Prompt-Variablen `chunk`, `surface`, `candidates` (nummerierte Liste).
  - `disambiguationInput(db, ambiguousId: string): Promise<DisambiguateInput>` – Markierung an `char_start/char_end`, Chunk höchstens 4000 Zeichen um die Stelle.
  - `applyDisambiguation(db, ambiguousId: string, out, meta: { model; promptVersion; runId }): Promise<"mention" | "none">` – `choice` außerhalb der Kandidaten oder 0 → `none`; sonst Erwähnung `match_kind model`, `confidence = out.confidence`, `match_score` = Similarity des gewählten Kandidaten; Status `resolved`/`none`.
  - Stufe `mentions.disambiguate`: Plan = `ambiguous_matches` `pending` der Versionen des Laufs, Jobs zu je `unitsPerBatch`.

- [ ] **Step 1: Failing tests**

```ts
it("choice 2 creates a model mention of the second candidate", …);
it("choice 0 creates nothing and marks the match none", …);
it("a choice outside the candidates is treated as none", …);
it("applying the same answer twice creates one mention", …);
it("the input lists every candidate with type, parents and coordinate", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mentions): model disambiguation for ambiguous matches only`

### Task 11: Neue Namen, Nominatim und Review-Aufgabe (`mentions.geocode`)

**Files:**
- Create: `lib/adapters/nominatim.ts`, `lib/pipeline/text/geocode.ts`, `test/fixtures/http/nominatim/**`
- Modify: `lib/jobs/{stages,registry}.ts`, `lib/jobs/handlers/text.ts`, `scripts/fixtures-record.ts` (`--nominatim <q> <tileId>`)
- Test: `lib/adapters/__tests__/nominatim.test.ts`, `lib/pipeline/__tests__/geocode.test.ts`

**Interfaces:**
- Consumes: `httpCall` (`rateKey`, `okStatuses`), `tileBbox`, `createReviewTask`, Task 1, 4, 9.
- Produces:
  - `type NominatimHit = { osmId: string /* node/… */; name: string; lon: number; lat: number; category: string; type: string; distanceM: number }`
  - `searchNominatim(transport, q: { query: string; tileId: string; radiusKm: number; limit: number }, ctx: CallContext, cfg: ExtractionConfig["geocode"]): Promise<NominatimHit[]>` – GET `<endpoint>?format=jsonv2&q=<query>&viewbox=<w,n,e,s>&bounded=1&limit=<limit>&accept-language=de,en,el`, `viewbox` = Kachel um `radiusKm` erweitert (Breite `radiusKm / 111.32`, Länge `/ (111.32 · cos(lat))`), Service `nominatim`, `ratePerMinute 60`, `rateKey "nominatim"`; `distanceM` zum Kachelmittelpunkt; nach Distanz sortiert.
  - `collectNameCandidates(db, runId: string, cfg): Promise<string[]>` – `unmatched_names` gruppiert nach `(name_normalized, tile_id)`: ≥ `minDocuments` Dokumente aus ≥ `minSources` Quellen → `name_candidates` (Upsert, Zähler aktualisiert); nur Kandidaten mit Status `collecting` ohne entschiedene Aufgabe werden zurückgegeben.
  - `geocodeCandidate(db, candidateId: string, deps: { transport }, ctx): Promise<{ hits: number; taskId: string }>` – Nominatim mit `display_name`; Kandidat `geocode = hits`, Status `review`; Aufgabe `place_candidate`, `subjectType "name_candidate"`, Kontext `{ name, hint, tileId, hits (≤ 5), occurrences: [{ documentId, versionId, chunkId, snippet (± 150 Zeichen), start, end }] (≤ 10) }`, `priority = documents`. Ohne Treffer trotzdem Aufgabe (Position per Klick).
  - Stufe `mentions.geocode`: Plan = `collectNameCandidates`, ein Job je Kandidat.

- [ ] **Step 1: Failing tests**

```ts
it("builds a bounded viewbox 20 km around the tile and sorts hits by distance", …);  // Fixture-Transport prüft URL-Parameter
it("records one external call per request under service nominatim at 60 per minute", …);
it("a name in 2 documents of one source is not a candidate", …);
it("a name in 2 documents of 2 sources becomes one review task with its occurrences", …);
it("a decided candidate is not geocoded again", …);
it("no nominatim hit still opens a task", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Fixtures mit `fixtures:record -- --nominatim "Kolona" q025:813:510` (≤ 3 Aufrufe). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mentions): unmatched names geocoded via nominatim into place candidate tasks`

### Task 12: Review-Entscheidung „Neuer Name“

**Files:**
- Modify: `lib/domain/review-decisions.ts`, `lib/domain/review-view.ts`, `app/(admin)/review/[id]/page.tsx`, `app/(admin)/review/[id]/actions.ts`, `app/(admin)/_components/labels.ts`
- Test: `lib/domain/__tests__/review-decisions.test.ts`, `app/(admin)/__tests__/review-name.test.ts`

**Interfaces:**
- Consumes: `decideReviewTask`, `addNames`, `upsertGeoObject`/Anlage wie M1, `newPublicId`, `places`, `MiniMap`.
- Produces:
  - `reviewDecisionSchema` + `{ action: "create_place"; kind: PlaceKind; position: LonLat; name: string (1–120); language: string (2) }`, `{ action: "assign_name"; geoObjectId: uuid }`; `ALLOWED["place_candidate/name_candidate"] = ["create_place", "assign_name", "reject"]`.
  - Wirkung: `create_place` → Geo-Objekt (Typ aus Hinweis: `bay`/`anchorage` → `bay`, `harbour`/`marina` → `harbour`, `cape` → `cape`, `island` → `islet`, `poi:<cat>` → `poi` mit `category`), `origin "text"`, Name `origin "text"`, Kachel-Verknüpfung; bei Typ `bay`/`harbour` ein Ort `status confirmed`, `kind`, `position`, `public_id sp_…`; `assign_name` → Name an das Objekt (`origin "review"`), Objekt muss gültig sein und im Kandidatenraum der Kachel liegen (sonst `DecisionNotAllowed`); `reject` → nur Status. Kandidat `decided`. Rückgabe enthält `documentVersionIds` der Fundstellen.
  - Den Rematch-Lauf nach der Entscheidung hängt Task 17 an die Server Action.
  - Review-Seite „Neuer Name“: Fundstellen mit hervorgehobenem Namen (`AnnotatedText`, Task 18), Karte mit Kachel, Nominatim-Treffern und nächsten Orten, Formular „Ort anlegen“ (Art, Position per Klick oder Treffer, Name, Sprache), Liste „Einem Objekt zuordnen“, Knöpfe mit Tastenkürzeln 1–3.

- [ ] **Step 1: Failing tests**

```ts
it("create_place makes a bay object, its name and a confirmed place in one decision", …);
it("a poi hint creates a poi object with category and no place", …);
it("assign_name adds a review name to the chosen object", …);
it("assign_name to an object outside the candidate tiles is not allowed", …);
it("deciding twice fails with TaskNotOpen", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/domain app && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(review): new names from texts become places or name variants`

### Task 13: Extraktions-Einheiten, Task `extract-facts` und Fact-Verarbeitung

**Files:**
- Create: `lib/domain/extraction/units.ts`, `lib/domain/extraction/facts.ts`, `lib/ai/tasks/extract-facts.ts`, `config/prompts/extract-facts/v1.md`
- Test: `lib/domain/extraction/__tests__/units.test.ts`, `lib/domain/extraction/__tests__/facts.test.ts`

**Interfaces:**
- Consumes: Task 1–3, 7, 9; `levelFor`, `attributesForPrompt`, `validateTextFact`, `TEXT_SCALE`, `findNameHits` (POI-Abgleich), `unmatched_names`.
- Produces:
  - `type ExtractionUnitDraft = { documentVersionId: string; geoObjectId: string; part: number; level: FactLevel; mentionIds: string[]; chunkIds: string[] /* nach ordinal */ }`
  - `planUnits(db, mentionIds: string[], cfg: ExtractionConfig["unit"]): Promise<{ units: ExtractionUnitDraft[]; skipped: string[] }>` – gruppiert nach (Version, Objekt); Chunks = Chunks der Erwähnungen ± `neighbourChunks` (Ordinal, gleiche Version); mehr als `maxChunksPerUnit` → in Teile zu je höchstens 6 Chunks (`part` 0, 1, …); `levelFor` `null` → `skipped`.
  - Task `extract-facts`: Eingabe `{ level: FactLevel; object: { name: string; type: GeoObjectType; parents: string[] }; docType: DocType; observedAt: string; chunks: Array<{ n: number; text: string }> }`; Variablen: System `level`, `attributes` (`attributesForPrompt`), `mappings` (`TEXT_SCALE` als Tabelle); Nutzer `object`, `doc_type`, `observed_at`, `chunks` (`<chunk n="1">…</chunk>`). Ausgabe `{ facts: Array<{ attribute: string; value: string /* JSON-Text */; quote: string (≤ 300); chunk: number; confidence: number (0–1); observed_at: string | null; poi_name: string | null (≤ 80) }> }` (≤ 40).
  - `type FactStats = { proposed: number; stored: number; rejectedQuote: number; invalidValue: number; unknownAttribute: number; duplicate: number; poiMentions: number; poiUnmatched: number }`
  - `processFactOutput(db, unit: { id: string; extractionRunId: string; documentVersionId: string; geoObjectId: string; level: FactLevel; mentionIds: string[]; chunkIds: string[] }, output: ExtractFactsOutput, cfg: AppConfig): Promise<FactStats>`:
    1. `JSON.parse(value)` scheitert → `invalidValue`; `validateTextFact` → `unknownAttribute`/`invalidValue`.
    2. `locateQuote` im Chunk `chunk` (Nummer) der Einheit, sonst in den übrigen Chunks der Einheit; kein Treffer → `rejectedQuote`.
    3. Erwähnung = Erwähnung der Einheit im Zitat-Chunk mit kleinstem Abstand zur Zitatstelle, sonst die im nächstgelegenen Chunk (Ordinal).
    4. `observed_at`: `YYYY-MM` → Tag 15; zwischen `earliestDate` und Abrufdatum, sonst `effectiveVersionMeta.observedAt`.
    5. Gleiches Attribut zweimal → höhere Konfidenz bleibt, Rest `duplicate`.
    6. Insert `facts` (`mention_id`, `quote`, `quote_verified true`, `quote_chunk_id`, `quote_start`, `quote_end`, `confidence`, `extraction_run_id`, `fact_schema_version` aktiv), `onConflictDoNothing`.
    7. `highlight.*` mit `poi_name`: gültiges `poi`-Objekt ≤ `poiMatchRadiusM` (2000 m) um das Geo-Objekt mit Name exakt oder Similarity ≥ `poiSimilarity` → zusätzliche Erwähnung des POI (`match_kind model`, Spanne = Zitat, `extraction_status done`); sonst `unmatched_names` mit `hint "poi:<category>"`.
    Rückgabe der Zähler; Einheit `done`, `stats`, Token und Kosten aus dem Batch-Item.

- [ ] **Step 1: Failing tests**

```ts
// units.test.ts
it("three mentions of one place in a version form one unit with neighbour chunks", …);  // chunks ordinal 3..7
it("a unit with more than 6 chunks is split into parts", …);
it("a mention of a settlement without place is skipped", …);
// facts.test.ts (withRollback, Fixture-Version mit 3 Chunks)
it("a verified fact is stored with mention, quote offsets and schema v2", …);
it("a fabricated quote is dropped and counted", …);            // stats.rejectedQuote 1, 0 facts
it("'good' shelter is stored as 0.9", …);
it("an island attribute on a place and broken JSON are counted separately", …);
it("the quote is found in a neighbour chunk when the given chunk number is wrong", …);
it("duplicate attributes keep the higher confidence", …);
it("'2024-05' becomes 2024-05-15, a future date falls back to the version date", …);
it("a named taverna 1.2 km away becomes a poi mention, an unknown one an unmatched name", …);
it("processing the same output twice stores nothing new", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/extraction` → FAIL.
- [ ] **Step 3: Implementieren.** Prompt: gemeinsame Regeln, `value` als JSON im Format der Attributliste, Zitat als zusammenhängender Ausschnitt in Originalsprache, Chunk-Nummer des Zitats, Konfidenz nach Deutlichkeit, Datum nur aus dem Text.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(extraction): units per place and version, fact processing with hard quote check`

### Task 14: Stufe `extraction.mention` und Extraktionsläufe

**Files:**
- Create: `lib/pipeline/text/extract.ts`
- Modify: `lib/jobs/{batch-handlers,stages,registry}.ts`, `lib/jobs/handlers/text.ts`
- Test: `lib/pipeline/__tests__/extract.test.ts`

**Interfaces:**
- Consumes: Task 6, 13; `getConfig().models`.
- Produces:
  - `ensureExtractionRun(db, input: { runId: string; task: "extract-facts" | "extract-route"; model: string; promptVersion: number; purpose: ExtractionPurpose; comparisonId?: string }): Promise<{ id: string }>` – eindeutig je `(runId, task, model)`; `fact_schema_version` = aktive Version.
  - Stufe `extraction.mention`: Plan –
    - regulär/`rematch`: Erwähnungen `pending` der Versionen des Laufs → `planUnits`; übersprungene → `extraction_status skipped`; Einheiten anlegen (`pending`), Erwähnungen der Einheiten `done`; Extraktionslauf für das konfigurierte Modell; Jobs zu je `unitsPerBatch` mit `{ key, extractionRunId, unitIds }`.
    - `reprocess`: alle Erwähnungen der Versionen des Laufs unabhängig vom Status, neuer Extraktionslauf `purpose reprocess`.
    - (`comparison` ergänzt Task 19.)
  - Job → `submitStageBatch` mit `modelOverride` = Modell des Extraktionslaufs, Items `{ subjectType "extraction_unit", subjectId }`, Eingabe aus `unitInput(db, unitId)`.
  - Batch-Handler `extract-facts` → `processFactOutput`; fehlgeschlagene Items → Einheit `failed`.
  - `extractionRunStats(db, extractionRunId): Promise<{ units: number; done: number; failed: number; facts: number } & FactStats & { costEur: number; costPerMentionEur: number | null }>` – schreibt `extraction_runs.stats`.

- [ ] **Step 1: Failing tests**

```ts
it("a run extracts every pending mention once and marks it done", …);   // MockModel; zweiter Lauf: keine neuen Einheiten
it("skipped mentions are marked skipped and cost nothing", …);
it("a retried extraction job does not duplicate units or facts", …);
it("run stats sum facts, rejections and cost per mention", …);
it("fixture documents yield the expected facts", …);   // test/fixtures/texts/expected.json, MockModel aus Fixture-Antworten
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(extraction): extraction stage over the batch api with extraction runs`

### Task 15: Belegtreue-Kontrolle und aktiver Lauf (`extraction.check`)

**Files:**
- Create: `lib/domain/extraction/fidelity.ts`, `lib/domain/extraction/active-run.ts`, `lib/pipeline/text/check.ts`
- Modify: `lib/jobs/{stages,registry}.ts`, `lib/jobs/handlers/text.ts`
- Test: `lib/domain/extraction/__tests__/fidelity.test.ts`

**Interfaces:**
- Consumes: `locateQuote`, `facts`, `route_stops`, `extraction_runs`, `getConfig().models`.
- Produces:
  - `checkQuoteFidelity(db, extractionRunId: string, cfg): Promise<{ facts: number; verified: number; ratio: number; failures: Array<{ factId: string; reason: string }> }>` – prüft jeden Text-Fact und Routen-Stopp des Laufs unabhängig vom gespeicherten Flag erneut gegen `chunks.text` (`quote_chunk_id`), dazu Offsets gleich; `ratio = 1` bei 0 Facts. Ergebnis in `quote_check`; `ratio < 1` → Status `blocked`, sonst `finished`, `finished_at`.
  - Stufe `extraction.check`: ein Job je Extraktionslauf des Laufs.
  - `activeExtractionRun(db, documentVersionId: string, cfg = getConfig()): Promise<{ id: string } | null>` – jüngster Lauf mit Status `finished`, Task `extract-facts`, Modell und Prompt-Version = aktive Konfiguration, `fact_schema_version` = aktive Version und mindestens einer Einheit `done` für die Version; Läufe `blocked` oder `comparison` nie. (Konsumiert M5.)
  - `belegtreue(db, runId: string): Promise<{ facts: number; verified: number; ratio: number }>` – über alle Extraktionsläufe eines Laufs (Kennzahl Spec 10).

- [ ] **Step 1: Failing tests**

```ts
it("a run whose facts all verify is finished with ratio 1", …);
it("a fact whose chunk text no longer contains the quote blocks the run", …); // Fact per Fixture-Insert mit falschem quote_start (Check erlaubt es, Kontrolle findet es)
it("a blocked run is never the active run", …);
it("the active run follows the configured model; a comparison run is ignored", …);
it("a newer finished run replaces an older one for the same version", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(extraction): quote fidelity check per run and active run per version`

### Task 16: Routen aus Törnberichten (`extraction.route`)

**Files:**
- Create: `lib/ai/tasks/extract-route.ts`, `config/prompts/extract-route/v1.md`, `lib/domain/extraction/routes.ts`, `lib/pipeline/text/routes.ts`
- Modify: `lib/jobs/{batch-handlers,stages,registry}.ts`, `lib/jobs/handlers/text.ts`
- Test: `lib/domain/extraction/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: Task 3, 6, 7, 14; `SECTORS`, Erwähnungen der Version (inkl. Erwähnungen in übernommenen Ursprungs-Chunks).
- Produces:
  - `routeSections(md: string, maxWords: number): string[]` – ganze Datei bis 20 000 Wörter; darüber an Überschriften (Ebene 1–3) zu Abschnitten ≤ `maxWords`, ein Abschnitt ohne Überschrift hart nach Wörtern.
  - Task `extract-route`: Eingabe `{ section: number; sections: number; observedAt: string; text: string }`; Ausgabe `{ stops: Array<{ name: string (≤ 80); date: string | null; mooring: MooringKind; quote: string (≤ 300); leg: { distance_nm: number | null; duration_h: number | null; wind_direction: Sector | null; wind_beaufort: int 0–12 | null; quote: string | null } | null }> }` (≤ 60).
  - `assignStop(db, versionId: string, name: string, cfg): Promise<{ geoObjectId: string; mentionId: string } | null>` – unter den Objekten der Erwähnungen dieser Version: exakter oder ≥ 0,75 Similarity-Treffer (auch ohne Affix); genau ein Objekt → Zuordnung, sonst `null`.
  - `storeRoute(db, input: { versionId: string; extractionRunId: string; sections: ExtractRouteOutput[] }, cfg): Promise<{ stops: number; dropped: number; assigned: number }>` – Abschnitte in Reihenfolge zusammengesetzt; Stopp-Zitat (und Leg-Zitat, sonst Leg weg) über `locateQuote` gegen die Chunks der Version; ohne Beleg verworfen; Ordinal fortlaufend; Route nur mit ≥ 1 Stopp; idempotent über `(document_version_id, extraction_run_id)`.
  - Stufe `extraction.route`: Plan = Versionen des Laufs mit effektivem `doc_type = trip_report` ohne Route im Extraktionslauf `extract-route` dieses Laufs; ein Batch-Item je Abschnitt (`subjectId = versionId:section`); der Handler speichert, sobald alle Abschnitte einer Version da sind (`ai_batch_items` derselben Version zählen).
  - `routeOpenStops(db, scope: { runId?: string }): Promise<{ routes: number; complete: number; openStops: number }>` – vollständig = alle Stopps einem Objekt mit bestätigtem Ort zugeordnet (Kennzahl Routen-Rekonstruktion).

- [ ] **Step 1: Failing tests**

```ts
it("a 45,000-word report is split at headings into sections of at most 20,000 words", …);
it("stops keep their order across sections and get their mentioned place", …);
it("a stop without a verifiable quote is dropped, an unknown name stays unassigned", …);
it("a leg without verifiable quote is removed, the stop stays", …);
it("storing twice keeps one route", …);
it("route completeness counts only stops at confirmed places", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(extraction): routes from trip reports with verified stops`

### Task 17: Lauf „Texte auswerten“, Reprozessierung und Auslöser

**Files:**
- Modify: `lib/pipeline/text/run.ts`, `lib/jobs/stages.ts`, `app/(admin)/tiles/[id]/{page.tsx,actions.ts}`, `app/(admin)/sources/actions.ts`, `app/(admin)/sources/[id]/page.tsx`, `app/(admin)/runs/page.tsx`, `app/(admin)/review/[id]/actions.ts`
- Test: `lib/pipeline/__tests__/text-run.test.ts`

**Interfaces:**
- Consumes: alle Stufen der Tasks 7–16, `startRun`, `pipeline_passes`.
- Produces:
  - `TEXT_RUN_STAGES = ["classify.document_version", "mentions.batch", "mentions.disambiguate", "mentions.geocode", "extraction.mention", "extraction.route", "extraction.check"]`.
  - `textRunVersions` (Task 7) erweitert: `pending` mit `mentionsConfigKey`; `tileId`/`areaKey` → aktuelle Versionen mit Erwähnungen von Objekten in diesen Kacheln (`tile_geo_objects`) plus `pending`; `rematch` und `reprocess` ignorieren die Pässe.
  - `startTextRun(db, boss, input: TextRunParams & { triggeredBy: string }): Promise<{ id: string }>` – Art `stage`, Umfang `system`/`texts` (bzw. `tile`/`area`), alle Stufen; `startReprocessRun(db, boss, { scope: { tileId } | { areaKey }; triggeredBy })` – Art `reprocess`, `params.reprocess true`; `startModelComparisonRun` kommt in Task 19.
  - Review-Action `create_place`/`assign_name` (Task 12) startet danach `startTextRun(db, boss, { documentVersionIds, rematch: true, triggeredBy })`.
  - UI: Kachel-Seite „Texte auswerten“ und „Reprozessieren (Stufen 6–7)“; Quellen-Seite „Neue Texte auswerten“ (`pending`); Lauf-Seite zeigt je Extraktionslauf Modell, Facts, verworfene Zitate, Belegtreue, Status (`blocked` rot).

- [ ] **Step 1: Failing tests**

```ts
it("pending selects only versions without a mention pass", …);
it("a full text run over the fixture documents ends finished with belegtreue 1", async () => {
  // Stufenfunktionen direkt (ohne pg-boss), MockModel, pollBatch nach jeder Batch-Stufe; withRollback
});
it("reprocess creates a new extraction run and keeps the old facts", …);  // facts beider Läufe vorhanden, alte unverändert
it("reprocess adds no duplicate mentions", …);
it("a rematch run after a new name extracts only the new mentions", …);
it("the create_place action starts a rematch run for the occurrences", …);   // runs-Zeile mit params.rematch true
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Next-Doku zu Server Actions vor den Aktionen lesen. **Step 4: Run** `npx vitest run lib/pipeline && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(text): text run and reprocessing for stages 6 and 7`

### Task 18: Erwähnungen und Facts mit hervorgehobenem Zitat in der UI

**Files:**
- Create: `lib/domain/text-annotations.ts`, `lib/domain/geo-facts.ts`, `app/(admin)/_components/annotated-text.tsx`, `app/(admin)/_components/quote-context.tsx`, `app/(admin)/places/[id]/facts-tab.tsx`
- Modify: `app/(admin)/documents/[id]/page.tsx`, `app/(admin)/geo/[id]/page.tsx`, `app/(admin)/places/[id]/page.tsx`, `app/(admin)/_components/labels.ts`
- Test: `lib/domain/__tests__/text-annotations.test.ts`, `lib/domain/__tests__/geo-facts.test.ts`, `app/(admin)/__tests__/annotated-text.test.tsx`

**Interfaces:**
- Consumes: `segmentText`, `activeExtractionRun`, `displayNameSql`, `documentDetail` (M3).
- Produces:
  - `versionAnnotations(db, versionId: string): Promise<Array<{ chunkId: string; ordinal: number; text: string; carriedFrom: string | null; spans: Span[]; mentions: Array<{ id; geoObjectId; name; matchKind; confidence }>; facts: Array<{ id; attribute; value; confidence; model; extractionRunId }> }>>` – für übernommene Chunks die Erwähnungen und Facts des Ursprungs-Chunks.
  - `type FactView = { id: string; attribute: string; value: unknown; confidence: number; observedAt: string; origin: "text" | "computed" | "review" | "observed"; quote: string | null; context: { before: string; quote: string; after: string } | null; source: { domain: string; weight: number } | null; documentId: string | null; model: string | null; extractionRunId: string | null; active: boolean }`
  - `geoFacts(db, geoObjectId: string, opts: { runs: "active" | "all" }): Promise<Array<{ attribute: string; facts: FactView[] }>>` – nach Attribut (Reihenfolge des Fact-Schemas), dann `observed_at` absteigend; `context` = bis 200 Zeichen vor und nach dem Zitat aus dem Chunk, an Wortgrenzen; `active` = Fact aus `activeExtractionRun` seiner Version oder Berechnung/Review.
  - `geoMentions(db, geoObjectId: string, page: number): Promise<{ rows: Array<{ documentId; url; domain; observedAt; matchKind; confidence; snippet }>; total: number }>` (50 je Seite).
  - `<AnnotatedText text spans />` (Server-Komponente, `<mark data-kind="mention|quote">`, Text als React-Kinder, kein `dangerouslySetInnerHTML`); `<QuoteContext before quote after />`.
  - Dokument-Seite: Reiter „Erwähnungen und Zitate“ je Chunk mit `AnnotatedText`, Legende, Liste der Facts je Chunk; Geo-Seite: Abschnitte „Erwähnungen“ und „Facts“ (Schalter „nur aktiver Lauf“/„alle Läufe“ als URL-Parameter); Ort-Seite: Reiter „Facts“ mit `geoFacts` (Attribut-Label aus `FACT_ATTRIBUTE_LABELS`, Wert formatiert, Zitat hervorgehoben, Quelle mit Link zum Dokument, Datum, Konfidenz, Modell, Lauf).

- [ ] **Step 1: Failing tests**

```ts
it("annotations of a carried chunk come from its origin chunk", …);
it("geoFacts groups by attribute, newest first, and marks comparison facts inactive", …);
it("the quote context cuts at word boundaries", …);
it("annotated text escapes html in the source text", () => {
  const html = renderToStaticMarkup(<AnnotatedText text={"<img src=x onerror=a()> Kolona"} spans={[{ start: 24, end: 30, kind: "mention", ref: "m" }]} />);
  expect(html).not.toContain("<img"); expect(html).toContain('<mark data-kind="mention">Kolona</mark>');
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; vor den Seiten die Next-Doku zu `searchParams` und Cache Components lesen. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): mentions and facts with highlighted quotes on document, geo and place pages`

### Task 19: Modellvergleich (`/compare/models`)

**Files:**
- Create: `lib/domain/extraction/comparison.ts`, `lib/domain/model-comparison-view.ts`, `app/(admin)/compare/models/{page.tsx,actions.ts}`, `scripts/compare-models.ts`, `scripts/model-report.ts`, Migration (generiert)
- Modify: `lib/db/schema/text.ts` (+ `model_comparisons`, `model_comparison_units`, `model_comparison_ratings`), `lib/pipeline/text/run.ts` (`startModelComparisonRun`), `lib/pipeline/text/extract.ts` (Plan-Modus `comparison`), `lib/security/route-policy.ts`, `app/(admin)/_components/nav.tsx`, `package.json` (Skripte `compare:models`, `report:models`)
- Test: `lib/domain/extraction/__tests__/comparison.test.ts`, `scripts/__tests__/model-report.test.ts`

**Interfaces:**
- Consumes: Task 13–15, `ExtractionConfig["comparison"]`, `canonicalJson`.
- Produces:
  - `model_comparisons` (Arbeitszustand): `id`, `label`, `models text[]` (2), `run_id`, `created_by`, `created_at`. `model_comparison_units`: `comparison_id`, `document_version_id`, `geo_object_id`, `mention_ids uuid[]`, `source_id`, `doc_type`; PK `(comparison_id, document_version_id, geo_object_id)`. `model_comparison_ratings`: `comparison_id`, `unit_key text`, `attribute`, `verdict`, `rated_by`, `rated_at`; PK `(comparison_id, unit_key, attribute)`.
  - `pickComparisonUnits(db, cfg: ExtractionConfig["comparison"]): Promise<{ units: Array<{ documentVersionId; geoObjectId; mentionIds; sourceId; docType }>; sources: number; docTypes: DocType[]; shortfall: string[] }>` – Kandidaten = (Version, Objekt) mit Erwähnungen und Ebene ≠ `null`; Reihenfolge reihum über Dokumenttypen, darin reihum über Quellen, darin nach `md5(versionId || geoObjectId)`; bis `units` (200); `shortfall` meldet `< minSources` Quellen bzw. fehlende Dokumenttypen (alle in den Kandidaten vorkommenden).
  - `createModelComparison(db, input: { label: string; createdBy: string; cfg }): Promise<{ id: string; units: number; shortfall: string[] }>`; `startModelComparisonRun(db, boss, { comparisonId, triggeredBy })` – Stufen `["extraction.mention", "extraction.check"]`, `params { comparisonId, models }`.
  - Plan-Modus `comparison` in `extraction.mention`: Einheiten aus `model_comparison_units`, ein Extraktionslauf je Modell aus `params.models` (`purpose comparison`), Erwähnungsstatus unverändert.
  - `estimateComparisonCostEur(db, comparisonId: string, cfg): Promise<number>` – Eingabe-Token ≈ Zeichen der Einheiten / 4 + 3000 (System), Ausgabe-Token 800 je Einheit, je Modell Preis × `batch.discount`.
  - `type ComparisonSummary = { runs: Array<{ extractionRunId; model; units; facts; rejectedQuote; invalidValue; unknownAttribute; costEur; costPerUnitEur }>; agreement: { same: number; deviation: number; onlyA: number; onlyB: number; pct: number } }`; `compareRuns(db, comparisonId: string, cfg): Promise<ComparisonSummary>` – Schlüssel `(unit, attribute)`; gleich = Zahlen (auch 0–1-Skalen) mit `|a − b| ≤ numericTolerance`, Arrays als Mengen, sonst `canonicalJson` gleich; je Schlüssel der Fact höchster Konfidenz.
  - `deviationSample(db, comparisonId: string, size = 50): Promise<Array<{ unitKey; attribute; a: FactView | null; b: FactView | null; verdict: ComparisonVerdict | null }>>` – Abweichungen und Einseitige nach `md5(unitKey || attribute)`; `rateDeviation(db, input: { comparisonId; unitKey; attribute; verdict; by })`; `ratingSummary(db, comparisonId)` → Anteile je Urteil.
  - Seite `/compare/models?comparison=<id>&item=<n>`: Kopf (Einheiten, Quellen, Dokumenttypen, Hinweise aus `shortfall`, Kostenschätzung, Knöpfe „Vergleich anlegen“, „Lauf starten“), Tabelle je Modell (Facts, verworfene Zitate, ungültige Werte, Kosten, Kosten je Einheit), Übereinstimmung, Bewertungsansicht nebeneinander (Wert, Zitat mit `QuoteContext`) mit Urteilsknöpfen 1–5, Fortschritt „n von 50 bewertet“, aktuelle Entscheidung aus `config/models.json`.
  - `npm run compare:models -- --label <l> [--max-eur 10] [--start]` legt den Vergleich an, gibt Einheiten, Quellen, Dokumenttypen und Schätzung aus; bricht ab, wenn die Schätzung `--max-eur` übersteigt; `--start` startet den Lauf. `renderModelReport(input)` + `npm run report:models -- <comparisonId>` schreibt `docs/pilot/m4-modellvergleich.md` (Methode, Kennzahlen je Modell, Übereinstimmung, Urteile der Stichprobe, Kosten, Abschnitt „Entscheidung“ mit Status „Vorläufig“/„Entschieden“ aus `models.json`).
  - Route `/compare/models` → admin; Navigation „Modellvergleich“.

- [ ] **Step 1: Failing tests**

```ts
it("a comparison run writes two extraction runs on the same units and leaves mention status alone", …);
it("the sample spreads 200 units over doc types and sources", …);   // 10 Quellen, 4 Typen synthetisch → alle vertreten, ≤ 200
it("fewer than 8 sources is reported as shortfall", …);
it("0.5 and 0.55 agree, 0.5 and 0.7 deviate, a fact of one model only counts as onlyA", …);
it("the deviation sample is stable and holds 50 items", …);
it("a rating is stored once per item and can be changed", …);       // Upsert, rated_at neu
it("the cost estimate refuses above max-eur", …);
it("the report marks the provisional decision", …);                  // enthält "Vorläufig" und "claude-sonnet-5-5"
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(compare): model comparison on 200 mentions with ratings and report`

### Task 20: Aufzeichnung echter Antworten, Abnahme-Prüfung, Runbook, Übergabe

**Files:**
- Create: `scripts/check-texts.ts`, `lib/ai/__tests__/recorded.test.ts`, `test/fixtures/ai/**`, `docs/pilot/m4-abnahme.md`, `e2e/facts.spec.ts`
- Modify: `scripts/fixtures-record.ts` (`--ai <task> --limit <n> --max-eur <x>`), `package.json` (`check:texts`), `docs/runbook.md`
- Test: `scripts/__tests__/check-texts.test.ts`

**Interfaces:**
- Consumes: alle vorigen Tasks.
- Produces:
  - `fixtures:record -- --ai extract-facts --limit 5 --max-eur 1` (auch `classify-document`, `disambiguate-mention`, `extract-route`): nimmt die ersten n Einheiten/Eingaben aus der Entwicklungs-DB, ruft `createAnthropicClient().call` synchron, bricht ab, sobald die Summe `--max-eur` erreicht; schreibt je Antwort `test/fixtures/ai/<task>/<fixtureKey>.json` mit `input`, `output`, Modell, Datum und – für `extract-facts` – den Chunk-Texten der Einheit.
  - Smoke-Test `recorded.test.ts`: für jede aufgezeichnete `extract-facts`-Antwort `processFactOutput` gegen die mitgespeicherten Chunks; erwartet: jeder gespeicherte Fact hat `quote_verified`, `checkQuoteFidelity` = 1, und die Zahl verworfener Zitate wird als Testausgabe festgehalten (kein Fehlschlag, Zahl landet in `docs/pilot/m4-abnahme.md`).
  - `measureTileBorders(db, cfg): Promise<{ unmatchedNames: number; matchedWithRing2: number }>` – `unmatched_names` der letzten 30 Tage erneut mit `neighbourRing 2` (Trockenlauf, nichts schreiben).
  - `checkTexts(db, cfg = getConfig()): Promise<{ belegtreue: { facts: number; verified: number; ratio: number }; blockedRuns: number; modelDecision: "provisional" | "decided"; costPerMentionEur: number | null; deterministicShare: number; mentions: number; routes: { routes: number; complete: number; openStops: number }; tileBorders: { unmatchedNames: number; matchedWithRing2: number } }>` – `costPerMentionEur` = `external_calls` `anthropic` der Text-Läufe / Erwähnungen; `deterministicShare` = Erwähnungen `deterministic` / alle.
  - CLI `npm run check:texts` – Ausgabe der Werte; Exit 1 bei `ratio < 1`, `blockedRuns > 0`, `modelDecision === "provisional"` oder `deterministicShare ≤ 0.7`.
  - e2e: Login → Ort-Seite einer Fixture-Bucht → Reiter „Facts“ zeigt ein Fact mit `<mark data-kind="quote">` → Link zum Dokument zeigt dasselbe Zitat hervorgehoben.

- [ ] **Step 1: Failing test** – `check-texts.test.ts`: `reports a provisional model and a 0.65 deterministic share as failing` und `ratio 1 with decided model and 0.8 share passes`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Fixtures aufzeichnen (≤ 5 je Task, zusammen ≤ 1 EUR, Preise vorher geprüft). **Step 4: Run** → PASS.
- [ ] **Step 5: Runbook** – Abschnitt „Erwähnungen und Facts“: Reihenfolge nach dem M3-Crawl: „Neue Texte auswerten“ → Review „Neuer Name“ → `compare:models -- --label pilot --start` → 50 Abweichungen auf `/compare/models` bewerten → `report:models` → Entscheidung in `config/models.json` (`decision.status "decided"`, Modell setzen) und Deploy → Reprozessieren je Revier, falls das Modell wechselt → `check:texts`. Budget-Stopp (Queue `ai.batch.poll` läuft weiter, Einreichungen pausieren), blockierter Extraktionslauf (Belegtreue < 100 %: Fall prüfen, Lauf nicht konsolidieren). `docs/pilot/m4-abnahme.md`: Checkliste aus Roadmap und Spec 06 (Belegtreue 100 %, Modellwahl dokumentiert, Kosten je Erwähnung, Anteil ohne Modell > 70 %, Facts mit hervorgehobenem Zitat, Messung Kachelgrenzen mit Ergebnis und Entscheidung).
- [ ] **Step 6: Gesamtprüfung** – `npm run lint && npm run typecheck && npx vitest run && npm run test:e2e && npm run build` → alles grün.
- [ ] **Step 7: Commit** `docs: M4 acceptance check, recorded model fixtures and runbook`
- [ ] **Step 8: Übergabe an Christian (nicht vom Ausführenden zu erledigen)** – Text-Lauf auf dem Server über die gecrawlten Quellen; Vergleich starten (Kosten laut Schätzung, Budget `anthropic` 20 EUR/Tag), 50 Abweichungen bewerten, Modell in `config/models.json` entscheiden, Offene Punkte „Modellklasse Extraktion (M4)“ und „Kachelgrenzen (M4)“ im Gesamtdesign abhaken, `check:texts` grün.

---

## Bewusste Abweichungen und Entscheidungen dieses Plans

- **Klassifikation in eigener, nur anfügender Tabelle `document_classifications`** statt technischer Spalten an `document_versions`: die Version bleibt vollständig unveränderlich, eine neue Prompt-/Modellversion klassifiziert erneut ohne Überschreiben; `effectiveVersionMeta` liest Klassifikation vor Abruf-Spalten. Der Dokumenttyp der Klassifikation gewinnt über den Quellentyp.
- **Datenbank-Schranke für Belege:** Check `facts_text_quote_verified` (und `route_stops.quote_verified = true`) macht einen Text-Fact ohne geprüftes Zitat technisch unmöglich; der Kontrolljob `extraction.check` prüft trotzdem jeden Lauf unabhängig erneut und sperrt ihn (`blocked`) bei < 100 %. Dazu `quote_chunk_id`, `quote_start`, `quote_end` an `facts` für die Hervorhebung.
- **Zitat-Normalisierung erweitert:** neben Spec-Regeln (Whitespace, Anführungszeichen, Bindestriche) auch Inline-Markdown, weiches Trennzeichen und NFC, weil die Chunks Markdown sind und Modelle Auszeichnung weglassen. Groß/Klein und Akzente bleiben, Auslassungen sind verboten; Mindestlänge 12 Zeichen, damit „Sand“ nicht als Beleg gilt.
- **`value` als JSON-Text in der Modellausgabe**, geprüft gegen das Attribut-Schema im Code: ein einheitliches Ausgabeschema für alle Attribute, das die strukturierte Ausgabe sicher abbildet; Schutz- und Expositions-Wörter liefert das Modell als Klasse, der Code bildet sie über `TEXT_SCALE` ab.
- **Fact-Schema v2 statt Erweiterung von v1:** M2-Facts tragen v1, Text-Facts v2; v2 enthält v1 unverändert. Werte sind sprachneutral; Freitext gibt es nur für Eigennamen (≤ 80 Zeichen), damit keine Textpassagen Dritter in Werte und später in Lieferungen gelangen.
- **Nur nicht übernommene Chunks gehen in Stufe 6/7:** Erwähnungen und Facts übernommener Chunks bleiben an ihrem Ursprungs-Chunk (M3 `carried_from_chunk_id`); Anzeige und Routen lesen sie von dort. Neue Gazetteer-Namen erreichen alte Chunks über „Reprozessieren“ oder den Rematch-Lauf nach einer Review-Entscheidung.
- **Batch als Stufen-Einheit:** der Einreich-Job verlängert seine Stufe um eins, `ai.batch.poll` meldet die Einheit. So bleibt die Stufenreihenfolge der Run-Mechanik erhalten, ohne dass ein Job auf das Modell wartet. `ai.batch.poll` plant sich selbst nach (`startAfter`), weil der Cron-Scheduler erst mit M8 kommt. Wiederholbare Fehler werden genau einmal in einem Folge-Batch nachgereicht. Bricht ein Einreich-Job zwischen Anlage und Einreichung ab, reicht die Wiederholung neu ein; ein dabei verwaister Provider-Batch kostet höchstens einmal doppelt (in Kauf genommen).
- **Kandidatenraum über einen Revier-/Insel-Vorlauf:** „Kacheln, die das Dokument bereits berührt“ entstehen aus exakten Treffern von Revier-, Golf-, Archipel- und Inselnamen, den `areaHints` der Klassifikation, früheren Versionen und dem SERP-Bezug der Quelle; ohne Bezug gelten alle Pilotreviere. Inseln vom Typ `islet` sind nicht im Vorlauf, weil ihre Namen im Mittelmeer zu oft vorkommen.
- **Stop-Namen und Affix-Liste in Konfiguration:** häufige Wörter („Marina“, „Port“, „Agios“) treffen nie allein; der längste Treffer gewinnt. Affix-Hinweise entscheiden nur zwischen gleichnamigen Objekten verschiedenen Typs.
- **Neue Namen:** Kachel eines Namens = Kachel des im selben Chunk nächstgelegenen erwähnten Objekts; Nominatim nur mit `bounded`-Viewbox (Kachel + 20 km), auch ohne Treffer entsteht eine Aufgabe (Position per Klick). Die Entscheidung „Ort anlegen“ legt Objekt, Name und bestätigten Ort an und startet einen Rematch-Lauf für die Fundstellen.
- **Extraktions-Einheit höchstens 6 Chunks** (Erwähnungs-Chunks ± 1); längere Gruppen werden geteilt, damit Eingaben begrenzt bleiben. Mehrfach genannte Attribute einer Einheit: höchste Konfidenz bleibt.
- **Highlights:** POI-Erwähnung nur bei Namensgleichheit (≥ 0,75) im 2-km-Umkreis; sonst ein `unmatched_names`-Eintrag mit Hinweis `poi:<Kategorie>`, der denselben Weg wie neue Ortsnamen geht (Kandidat ab zwei Dokumenten verschiedener Quellen).
- **Routen sind unveränderlich:** Stopps werden beim Speichern zugeordnet; eine spätere Zuordnung entsteht mit einer neuen Route in einem Reprozess-Lauf. Routen ohne einen belegten Stopp werden nicht gespeichert.
- **Aktiver Lauf** (für M5): jüngster `finished` Lauf mit aktivem Modell, Prompt und Fact-Schema; `blocked` und Vergleichsläufe nie.
- **Modellwahl vorläufig Sonnet** (`decision.status "provisional"`): günstiger, laut Spec Kandidat; `check:texts` bleibt bis zur dokumentierten Entscheidung rot. Der echte Vergleich (zwei Läufe, Batch, geschätzt wenige EUR) und die Bewertung der 50 Abweichungen macht Christian; das Skript bricht über `--max-eur` ab.
- **Aufgezeichnete echte Antworten** (≤ 5 je Task, ≤ 1 EUR) dienen nur dem Smoke-Test der Zitatprüfung gegen reale Modellausgaben; alle anderen Tests nutzen handgeschriebene `MockModel`-Antworten.
- **Kachelgrenzen:** gemessen statt entschieden – `measureTileBorders` zählt, wie viele neue Namen mit dem Zweierring gefunden würden; Entscheidung in `docs/pilot/m4-abnahme.md`, Schalter `neighbourRing` bleibt 1 bis dahin.
- **Kein automatischer Text-Lauf nach dem Crawl:** ausgelöst per „Neue Texte auswerten“ (Quellen- und Kachel-Seite), wie in M0–M7 alle Läufe manuell; der Scheduler verknüpft beides in M8.
- **Stufe 8 im Reprozess-Lauf fehlt bis M5:** `startReprocessRun` umfasst Stufen 6–7; M5 hängt `consolidation.geo` an `TEXT_RUN_STAGES`.

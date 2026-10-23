# Periplus N4a – Aktueller Stand je Liegeplatz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Für jeden bestätigten Liegeplatz einen überschreibbaren aktuellen Stand bilden: Kernwerte nach den bestehenden Regeln (berechnet + Text), gebündelte Fakten, Anlandestellen und das von dort Erreichbare an Land (zu Fuß, mit Bus/Taxi).

**Architecture:** Neue Tabelle `berth_states` (eine Zeile je Platz, überschrieben, keine Versionen). Kernwerte: Eingaben aus berechneten Facts (alte Tabelle `facts` mit `computation_id`) und `berth_facts`-Kernwerten (Einheiten `done`, aktives Modell) werden in `ConsolidationInput` übersetzt und mit `applyRule` (`lib/domain/consolidation/rules`) je v4-Attribut entschieden. Fakten-Bündelung über einen Batch-Modellaufruf je Platz, der nur IDs gruppiert und Repräsentanten wählt (kein neuer Text). Anlandestellen aus OSM (Steg, Pier, Slipanlage, Strand) im Umkreis der Ankerfläche, sonst Rückfall nächster Strand/Ufer; Erreichbares über Luftlinie × Umwegfaktor. Stufe `research.state` am Ende des Recherche-Laufs und in der Folgekette.

**Tech Stack:** TypeScript, Drizzle + PostGIS, pg-boss, Anthropic Batches, Vitest gegen `db-test`.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (5.7, 5.7b, 7.1, 7.2)

## Global Constraints

- Branch `feat/n4a-stand` von `feat/n3b-nachschaerfen`.
- Nur bestätigte Liegeplätze bekommen einen Stand; fällt ein Platz aus `confirmed`, bleibt die Zeile, wird aber nicht geliefert (die Lieferung filtert auf Status).
- Kernwerte nur aus Facts mit Beleg: berechnet (Computation) oder Text (geprüftes Zitat in `berth_facts`, Einheit `done`, aktives `extract-berth`-Modell); keine Werte aus Navily, keine aus alten `mentions`-Facts.
- Die Bündelung erzeugt keinen neuen Text: Repräsentant ist immer eine bestehende `berth_facts`-Zeile.
- Schwellen, Radien, Faktoren, Kategorien in `config/research.json` (`state`) bzw. `config/categories.json`.
- Kein Wert älter als seine jüngere Widerlegung: bei gleichem Thema gilt der jüngere Fakt (Modellgruppierung mit `superseded`).
- Geteilte DB-Regeln; Navily-Regel; Code englisch, Oberfläche deutsch; grün nach jeder Aufgabe (`vitest`, `tsc`, `lint`); Commit-Trailer wie bisher.

## Review Focus

- Platz ohne einzigen Text-Kernwert → Stand mit berechneten Werten, Lücken ausgewiesen (Test Task 2).
- Hafen/Marina: Anlandestelle ist der Hafen selbst, keine Strandsuche (Test Task 4).
- Bushaltestelle 2 km von der Anlandestelle → kein Bus-Zugang (Fußgrenze 1,5 km × Faktor), Sehenswürdigkeit 10 km weg wird nicht `transport` (Test Task 5).
- Zwei gleichbedeutende Fakten 2019 „gute Taverne“ und 2025 „Taverne geschlossen“ → nur der jüngere im Stand (Test Task 3, Mock).
- Ein Platz wird nach Bestätigung zurückgenommen → nächster Stand-Lauf überspringt ihn, alte Zeile bleibt unverändert (Test Task 6).

---

### Task 1: Schema, Konfiguration, Kategorien

**Files:** `lib/db/schema/research-state.ts`, Migration `research_state`, `config/research.json` (`state`), `lib/config/schemas.ts`, `config/categories.json`; Tests Schema/Config.

**Interfaces:**
- `berth_states`: `place_id` PK → places, `core jsonb` (`{ [attribute]: { value, confidence, origin: "computed"|"text"|"rule", observedAt: string|null, factIds: string[] } }`), `gaps text[]`, `facts jsonb` (`Array<{ factId, subject: "berth"|"landside", subjectName: string|null, subjectCategory: string|null, statement, observedAt, tone, safety, mentions: number }>`), `landing jsonb` (`Array<{ kind: "harbour"|"pier"|"slipway"|"beach"|"shore"|"text", lon: number|null, lat: number|null, geoObjectId: string|null, description: string|null }>`), `nearby jsonb` (`Array<{ geoObjectId, category, distanceM, access: "foot"|"transport" }>`), `run_id`, `updated_at`.
- `config/research.json` `state`: `{ "landingRadiusM": 600, "footMaxM": 1500, "detourFactor": 1.4, "transportMaxM": 15000, "transportCategories": ["culture","town","nature","beach"], "transportMinSitelinks": 5, "alwaysCategories": ["food","supply","bakery","beach","transport"] }`.
- `config/categories.json`: ergänzen `shop=bakery` → `bakery`; `highway=bus_stop`, `amenity=bus_station`, `amenity=taxi`, `amenity=ferry_terminal` → `transport`; `man_made=pier`, `leisure=slipway` → `landing` (nur für Anlandestellen, nicht als Erreichbares). Prüfen, ob das POI-Enum/`PoiCategory` erweitert werden muss (Migration), und ob der Gazetteer-Import die neuen Kategorien beim nächsten Lauf holt (N7 kümmert sich um den Umkreis; hier nur Kategorien).

- [ ] Steps: Tests (Schema-Form, Config-Werte, neue Kategorien gelesen), fail, implement + Migration, pass, commit `feat(research): berth state schema and landside categories (N4a)`.

### Task 2: Kernwerte

**Files:** `lib/domain/research/state-core.ts`; Test.

**Interfaces:** `coreInputs(db, placeId, cfg): Promise<ConsolidationInput[]>` (berechnete Facts des Geo-Objekts aus `facts` mit `computation_id`, wie `loadInputs` sie liest — nur die Computation-Zweige wiederverwenden; Text-Kernwerte aus `berth_facts` mit Attribut, Einheit `done`, aktives Modell, `origin: "text"`, `sourceKey` = registrierbare Domain, `sourceWeight` aus `config/source-types.json` nach `page_kind` (Abbildung `page_kind → doc_type` dokumentieren), `confidence` 0,8, `observedAt`/`dateKnown` aus Basis); `decideCore(inputs, place, cfg): { core: BerthState["core"]; gaps: string[] }` (rein: je v4-Attribut `applyRule(def.rule, inputs dieses Attributs, ctx)`; Lücken = v4-Attribute ohne Wert).

- [ ] Steps: Tests (Schutz berechnet + ein Text-Schutz ±1 Stufe; Halt nur Text; Gebühr jüngste; Platz ohne Text → nur berechnet, Lücken), fail, implement, pass, commit `feat(research): core values of a berth from computed and text facts (N4a)`.

### Task 3: Fakten bündeln

**Files:** `lib/ai/tasks/bundle-facts.ts`, `config/prompts/bundle-facts/v1.md`, `config/models.json` (`bundle-facts`: Sonnet, effort low, maxTokens 8000); `lib/domain/research/state-facts.ts`, `lib/pipeline/research/state.ts` (Batch-Teil); Batch-Eintrag; Tests.

**Interfaces:** Eingabe je Platz: Liste `{ id, subject, subjectName, statement, observedAt, tone }` aller freien Fakten (Einheiten `done`); Ausgabe `{ groups: Array<{ ids: string[]; representative: string; superseded: string[] }> }` — jede ID genau einmal; `representative ∈ ids`; `superseded` = IDs, die ein jüngerer Fakt derselben Gruppe widerlegt. Prüfung beim Empfang: unbekannte/fehlende IDs → Gruppe verworfen, betroffene Fakten einzeln übernommen. `bundleFacts(...)` speichert in `berth_states.facts` die Repräsentanten (ohne `superseded`) mit `mentions` = Zahl unabhängiger Domains der Gruppe.

- [ ] Steps: Tests mit MockModel (gleichbedeutend → 1 Fakt mit mentions 2; jüngeres „geschlossen“ ersetzt älteres „gut“; kaputte Antwort → einzeln), fail, implement, pass, commit `feat(research): bundle equivalent facts per berth without new text (N4a)`.

### Task 4: Anlandestellen

**Files:** `lib/domain/research/landing.ts`; Test.

**Interfaces:** `landingPoints(db, placeId, cfg): Promise<BerthState["landing"]>` — `marina`/`port`: `[{ kind: "harbour", lon, lat }]` an der Ortsposition. Sonst: OSM-Objekte der Kategorie `landing` und Strände im Umkreis `landingRadiusM` der Ankerfläche (sonst Ankerposition); ohne Treffer der nächste Uferpunkt (Landpolygon) zur Ankerposition als `shore`; dazu jede `landing_hints`-Beschreibung (Einheit `done`) als `{ kind: "text", description }` ohne Position.

- [ ] Steps: Tests (Marina → harbour; Bucht mit Steg 300 m → pier; ohne alles → shore; Hinweis-Text übernommen), fail, implement, pass, commit `feat(research): landing points of a berth (N4a)`.

### Task 5: Erreichbares an Land

**Files:** `lib/domain/research/reach.ts`; Test.

**Interfaces:** `reachable(db, landing, cfg, opts: { transportFact: boolean }): Promise<BerthState["nearby"]>` — Entfernung = Luftlinie × `detourFactor` von der nächsten positionierten Anlandestelle. `foot`: POIs aller Kategorien außer `landing` mit Entfernung ≤ `footMaxM`. `transport`: wenn ein POI der Kategorie `transport` zu Fuß erreichbar ist oder `opts.transportFact` (freier Fakt mit `subjectCategory` taxi/bus oder Aussage, die Taxi/Bus am Ort belegt — Kategorie aus `berth_facts.subject_category`), dann POIs der `transportCategories` bis `transportMaxM` mit Wikidata-Sitelinks ≥ `transportMinSitelinks` (Tabelle `wikidata_sitelinks`). Sortiert nach Entfernung, je Kategorie höchstens 10.

- [ ] Steps: Tests (Review-Focus-Fall Bus 2 km; Bus 800 m + Kloster 10 km mit 8 Sitelinks → transport; ohne Sitelinks nicht), fail, implement, pass, commit `feat(research): what is reachable on land from a berth (N4a)`.

### Task 6: Stufe `research.state`, Folgekette, Oberfläche

**Files:** `lib/pipeline/research/state.ts`, Registrierung (Queue `research.state`, Stufe nach `research.confirm` in `RESEARCH_STAGES`; `BERTH_FOLLOWUP_STAGES` = `research.state` vor `images.place`), Handler; `lib/domain/research/view.ts` + Reiter „Stand“ auf der Ortsseite (Kernwerte mit Herkunft, Lücken, Fakten, Anlandestellen, Erreichbares); Tests; `npm run build`.

**Interfaces:** `planResearchState(db, run)` (bestätigte Plätze der Kandidaten des Laufs bzw. `params.placeIds` der Folgekette), Job je Platz: `buildBerthState(db, placeId, deps, ctx)` = Kernwerte + Anlandestellen + Erreichbares sofort, Fakten-Bündelung als Batch (Ergebnis-Handler schreibt `facts` nach); upsert in `berth_states`.

- [ ] Steps: Tests (Lauf hat 8 Stufen; zurückgenommener Platz übersprungen, Zeile bleibt; Folgekette baut Stand vor Bild), fail, implement, pass, build, commit `feat(research): berth state stage in the research run and follow-up (N4a)`.

### Task 7: Probe (Messung)

- [ ] Stand für die bestätigten Plätze von `GR-I` bauen; je 5 Plätze Kernwerte, Fakten, Anlandestellen, Erreichbares von Hand prüfen; Befunde und Kosten in `docs/pilot/neuausrichtung/n4a-stand.md`.

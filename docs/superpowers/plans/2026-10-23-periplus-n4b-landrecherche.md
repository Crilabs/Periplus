# Periplus N4b – Landrecherche je bestätigtem Liegeplatz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Für jeden bestätigten Liegeplatz gezielt nach den erreichbaren Orten und Sehenswürdigkeiten an Land suchen (auch Reiseblogs, Wikivoyage, Ortsseiten), daraus freie Fakten zu den Dingen an Land ziehen und in den Stand übernehmen – ohne dass diese Seiten je als Beleg für den Liegeplatz selbst zählen.

**Architecture:** Neuer Zweck `landside` für Recherche-Treffer und neue Einheitenart `landside`. Suche je bestätigtem Platz mit den Namen seiner erreichbaren Orte/Sehenswürdigkeiten (`berth_states.nearby`) und des nächsten Orts; Holen und Seitenbewertung wie bisher; Extraktion mit eigenem Task `extract-landside` (nur Fakten über Dinge an Land, keine Signale, keine Kernwerte, keine Anlandehinweise). Bestätigung und Kernwerte lesen ausschließlich Einheiten der Art `berth`. Die Folgekette bekommt die Landrecherche-Stufen vor `research.state`.

**Tech Stack:** wie N4a.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (5.7a, 5.7b)

## Global Constraints

- Branch `feat/n4b-landrecherche` von `feat/n4a-stand`.
- **Landseiten sind nie Liegeplatz-Belege:** keine `berth_signals`, keine Kernwerte, keine `landing_hints` aus Einheiten der Art `landside`; `loadEvidence`, `coreInputs`, Anlandehinweise filtern auf `kind = 'berth'`.
- Eine Quelle reicht für einen Landfakt (Spec 5.7a); SEO/KI-Seiten weiterhin ausgeschlossen (Seitenbewertung).
- Nur für bestätigte Liegeplätze; ein Ort, der von mehreren Plätzen erreichbar ist, wird einmal gesucht (Suchanfrage-Wiederverwendung) und gilt für alle.
- Werte in `config/research.json` (`landside`), Prompt `config/prompts/extract-landside/v1.md`, Modell `extract-landside` (Sonnet, effort low).
- Geteilte DB-Regeln, Navily-Regel, Code englisch, Oberfläche deutsch, grün nach jeder Aufgabe, Commit-Trailer wie bisher.

## Review Focus

- Eine Landseite sagt „wir ankerten in der Bucht“ → kein Signal, keine Bestätigung (Test Task 3).
- Platz ohne `berth_states.nearby` → nur der nächste Ort als Suchbegriff, kein Fehler (Test Task 2).
- Zwei Plätze erreichen denselben Ort → dieselbe Anfrage wird wiederverwendet, beide bekommen die Treffer (Test Task 2).
- Landfakt nennt ein Ding, das nicht in `nearby` steht → bleibt als Fakt mit Namen, ohne Position (Test Task 3).

---

### Task 1: Schema und Konfiguration

**Files:** Migration `research_landside` (`research_units.kind` enum `berth|landside` default `berth`, Unique-Index um `kind` erweitern; `research_purpose` + `landside`), Schema, `config/research.json` (`landside`: `{ "templates": [ {"template":"{subject} things to do","lang":"en"}, {"template":"{subject} taverna","lang":"en"}, {"template":"{subject} beach","lang":"en"}, {"template":"{subject} Sehenswürdigkeiten","lang":"de"}, {"template":"{subject} cosa vedere","lang":"it"} ], "maxSubjectsPerPlace": 5, "maxHitsPerSubject": 10 }`), Schema in `lib/config/schemas.ts`; Tests.

- [ ] Steps: Tests, fail, implement + Migration, pass, commit `feat(research): landside purpose and unit kind (N4b)`.

### Task 2: Landsuche

**Files:** `lib/domain/research/landside-queries.ts`, `lib/pipeline/research/landside-search.ts`; Tests.

**Interfaces:** `landsideSubjects(db, placeId, cfg): Promise<Array<{ name: string; lang: string; geoObjectId: string | null }>>` — aus `berth_states.nearby` die Orte (`town`) und Sehenswürdigkeiten mit den meisten Sitelinks, höchstens `maxSubjectsPerPlace`, dazu immer der nächste Ort (Siedlung) des Platzes; Namen in den Sprachen der Vorlagen wie `buildResearchQueries`. `searchLandside(db, placeId, deps, ctx)`: Anfragen über `runQuery` (Wiederverwendung wie bisher), Treffer mit `purpose = landside`, je Thema höchstens `maxHitsPerSubject`, ohne `skipDomains`/verbotene Domains. Stufe `RESEARCH_LANDSIDE_SEARCH_STAGE = "research.landside_search"`, Plan: bestätigte Plätze der Lauf-Parameter.

- [ ] Steps: Tests (Review Focus 2 und 3), fail, implement, pass, commit `feat(research): landside search per confirmed berth (N4b)`.

### Task 3: Landextraktion

**Files:** `lib/ai/tasks/extract-landside.ts`, `config/prompts/extract-landside/v1.md`, `config/models.json`; `lib/pipeline/research/landside-extract.ts`; Filter in `lib/domain/research/confirmation.ts`, `state-core.ts`, `landing.ts`, `state-facts.ts` (Landfakten zählen in Fakten, nie in Belege/Kernwerte/Anlandung); Tests.

**Interfaces:** Einheiten `kind = landside` für (aktuelle, aktiv bewertete, nicht generierte Version einer Landtreffer-Seite, Platz), nur wenn die Seite ein Thema des Platzes nennt (`namesOccur`). Ausgabe `{ facts: Array<{ subject_name, subject_category, statement, quote, observed_at, tone, safety }> }`; Speicherung in `berth_facts` mit denselben Prüfungen wie N2 (Zitat, Übernahme, Name im Zitat), `subject_category` nie leer (`other`). Stufe `research.landside_extract` (Batch).

- [ ] Steps: Tests (Review Focus 1 und 4; Landeinheit erzeugt nie `berth_signals`; `loadEvidence`/`coreInputs`/Anlandung ignorieren Landeinheiten; Fakten erscheinen in `standingFacts`), fail, implement, pass, commit `feat(research): landside facts from landside pages, never berth evidence (N4b)`.

### Task 4: Folgekette und Oberfläche

**Files:** `lib/pipeline/berth-followup-run.ts` (`BERTH_FOLLOWUP_STAGES` = `research.state`, `research.landside_search`, `research.fetch`, `research.assess`, `research.landside_extract`, `research.state`, `images.place` — prüfen, ob eine Stufe zweimal in einem Lauf vorkommen darf; sonst `research.state` nur am Ende und die Landsuche liest `nearby` aus dem vorigen Stand bzw. berechnet `reachable` direkt), Registrierung (Queues, Stufen, Handler), Recherche-Lauf: Landrecherche nur in der Folgekette, nicht im Lauf je Landesteil; Reiter „Stand“: Herkunft der Fakten („Liegeplatz-Seite“ / „Landseite“); Tests; `npm run build`.

- [ ] Steps: Tests (Folgekette mit Landstufen; Reiter zeigt Herkunft), fail, implement, pass, build, commit `feat(research): landside research in the follow-up chain (N4b)`.

### Task 5: Probe (Messung)

- [ ] Für die bestätigten Plätze von GR-I die Folgekette laufen lassen; Landfakten je Platz, Kosten, Stichprobe von 20 Landfakten von Hand; `docs/pilot/neuausrichtung/n4b-land.md`.

# Periplus N2 – Extraktion und Bestätigung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aus den bewerteten Trefferseiten (N1) je Seite und Liegeplatz Kernwerte, freie Fakten, Bestätigungs- und Negativsignale, Anlandehinweise und Routen ziehen (mit geprüftem Zitat), unbekannte Stopps aus Routen verankert lokalisieren und Liegeplätze nach der Bestätigungsregel automatisch bestätigen oder zurücknehmen; jede Bestätigung startet die Folgekette.

**Architecture:** Der Lauf „Recherche“ bekommt nach `research.assess` die Stufen `research.extract` (Batch, je Einheit = Seite × Liegeplatz), `research.routes` (Batch, Törnberichte), `research.discover` und `research.confirm`. Neue Tabellen `research_units`, `berth_facts`, `berth_signals`, `landing_hints`, `research_route_stops`. Die Bestätigungsregel ist eine reine Funktion über Signale, Seitenbewertungen und Domains; ihr Ergebnis setzt `places.status` und protokolliert wie heute als System-Entscheidung. Die alte Auto-Bestätigung in der Konsolidierung wird abgeschaltet.

**Tech Stack:** TypeScript, Drizzle + PostgreSQL 17, pg-boss, zod 4, Anthropic Batches über `ModelClient`, Vitest gegen `db-test`.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (Abschnitte 4, 5.3 „Zuordnung bleibt klein“, 5.4, 5.5, 5.6, 5.7b, 6 „Danach ohne menschliche Freigabe“, 7.1)

## Global Constraints

- Branch `feat/n2-extraktion` von `feat/n1-recherche` (N1 noch nicht auf `main`); nach dem Merge von N1 auf `main` rebasen.
- **Sicherheit zuerst:** Ein Liegeplatz wird nur bestätigt, wenn die Regel in Task 6 erfüllt ist; Unsicheres zählt nicht und erzeugt keine Review-Aufgabe (Spec 4.8, 5.6).
- Kein Fakt, Signal oder Hinweis ohne Zitat, das nach `locateQuote` (`lib/domain/extraction/quote.ts`) im Seitentext steht; ein nicht gefundenes Zitat wird verworfen und gezählt.
- Aussagen (`statement`) englisch, in eigenen Worten: keine `research.extraction.maxSharedWords` (Start 8) aufeinanderfolgenden Wörter aus dem Seitentext (Prüfung über `shingleWindowHashes` aus `lib/domain/documents/shingles.ts`); sonst verworfen und gezählt.
- Seiten mit `page_assessments.generated = true` werden nie extrahiert; Seiten ohne aktive Bewertung auch nicht.
- Schwellen, Radien, Gewichte, Seitenarten in `config/research.json` (Abschnitte `extraction`, `confirmation`, `discovery`); Prompts `config/prompts/extract-berth/v1.md` und Routen über den bestehenden Task `extract-route`; Modelle in `config/models.json` (`extract-berth`: `claude-sonnet-5-5`, effort `medium`, `maxTokens` 16000).
- Alte Tabellen (`facts`, `mentions`, `profiles` …) werden nicht beschrieben; alte Stufen bleiben, außer der abgeschalteten Auto-Bestätigung (Task 6).
- Geteilte Dev- und Test-DB: nur `withRollback` in Tests und `npm run db:migrate`; nie von Hand ändern.
- Code, Bezeichner, Tabellen, Prompts englisch; Oberfläche deutsch. Fachlogik in `lib/domain/research`, Stufen in `lib/pipeline/research`.
- Nach jeder Aufgabe grün: `npx vitest run <betroffene Dateien>`, `npx tsc --noEmit`, `npm run lint`.
- Commits enden mit `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- Eine Seite nennt zwei Liegeplätze („von Vathi rüber nach Agios Georgios“) → zwei Einheiten, jedes Signal nur am richtigen Platz; ein Signal ohne klaren Bezug wird nicht zugeordnet (Test Task 4).
- Fünf Seiten derselben Domain berichten „wir ankerten hier“ → zählt als **eine** unabhängige Quelle (Test Task 6).
- Ein jüngeres Ankerverbot neben drei älteren positiven Berichten → nicht bestätigt bzw. Bestätigung zurückgenommen, Grund steht am Platz (Test Task 6).
- Seite ohne Datum (Beobachtung = Abrufdatum) mit Negativsignal → gilt als jünger als ältere datierte positive Belege; ist das so gewollt: ja, Negatives im Zweifel als aktuell (Test Task 6).
- Sehr lange Seite (Revierführer-PDF mit 80.000 Wörtern) → Einheit nur aus Fenstern um die Namen des Liegeplatzes, nicht das ganze Dokument (Test Task 3).

---

### Task 1: Schema, Fact-Schema v4, Konfiguration

**Files:**
- Create: `lib/db/schema/research-extract.ts`; Modify: `lib/db/schema/index.ts`
- Create: `drizzle/<nächste Nummer>_research_extract.sql` (über `npx drizzle-kit generate --name research_extract`)
- Create: `config/fact-schema/v4.ts`; Modify: `config/fact-schema/index.ts` (v4 registrieren, `active.json` bleibt v3 — die alte Pipeline liest es; die Recherche liest v4 über `config/research.json` `extraction.factSchema: "v4"`)
- Modify: `config/research.json`, `lib/config/schemas.ts` (`researchSchema` erweitern)
- Test: `lib/db/__tests__/research-extract-schema.test.ts`, `lib/config/__tests__/research-config.test.ts`, `config/__tests__/fact-schema-v4.test.ts` (Ort nach bestehendem Muster)

**Interfaces:**
- Produces:
  - Enums: `researchUnitStatusEnum` (`pending`, `done`, `failed`, `skipped`), `berthSignalKindEnum` (`anchored`, `moored_buoy`, `berthed`, `listed_as_berth`, `prohibited`, `buoys_private`, `no_space`, `unsafe`, `closed`), `toneEnum` (`positive`, `negative`, `neutral`).
  - `research_units`: `id`, `document_version_id → document_versions`, `place_id → places`, `model`, `prompt_version`, `status`, `reason text null`, `dropped jsonb` (Zähler `{ quote: n, value: n, verbatim: n }`), `run_id → runs`, `created_at`; Unique `(document_version_id, place_id, model, prompt_version)`.
  - `berth_facts`: `id`, `unit_id → research_units`, `place_id`, `document_version_id`, `attribute text null`, `value jsonb null`, `statement text null`, `subject_name text null`, `subject_category text null`, `quote text`, `quote_start int`, `quote_end int`, `observed_at date`, `observed_at_basis observed_at_basis`, `tone tone null`, `safety boolean not null default false`, `created_at`; Check: genau eins von (`attribute` und `value` gesetzt) oder (`statement` gesetzt).
  - `berth_signals`: `id`, `unit_id`, `place_id`, `document_version_id`, `kind berth_signal_kind`, `first_hand boolean`, `confidence real` (0–1, Check), `quote`, `quote_start`, `quote_end`, `observed_at date`, `observed_at_basis`, `created_at`.
  - `landing_hints`: `id`, `unit_id`, `place_id`, `document_version_id`, `description text`, `quote`, `quote_start`, `quote_end`, `observed_at date`, `created_at`.
  - `research_route_stops`: `id`, `document_version_id`, `seq int`, `name text`, `mooring_kind text null`, `quote`, `observed_at date`, `place_id → places null` (zugeordnet), `match text null` (`name` | `corridor` | null), `model`, `prompt_version`, `created_at`; Unique `(document_version_id, seq, model, prompt_version)`.
  - `factSchemaV4: FactSchema` (nur Ebene `place`): die Definitionen aus v3 für genau diese Schlüssel, soweit in v3 vorhanden: `place.kind_evidence`, `berthable`, alle `shelter.*`, `swell_protection`, alle `depth.*`, `seabed`, `holding`, `mooring.buoys`, `mooring.types`, `mooring.line_ashore_required`, `prices`, `occupancy`, `season_notes`, `prohibitions`, `hazards`, `max_draft`, `max_length`, `capacity`, `services.water`, `services.electricity`, `services.fuel`, `contact`. Fehlt einer in v3, wird er ausgelassen und im Bericht genannt.
- `config/research.json` (Startwerte, Entscheidung Claude):

```json
"extraction": { "factSchema": "v4", "placeRadiusKm": 15, "maxUnitWords": 12000, "windowWords": 600, "maxSharedWords": 8, "routeMaxStops": 40 },
"confirmation": {
  "minIndependentSources": 2,
  "minSignalConfidence": 0.7,
  "positiveKinds": ["anchored", "moored_buoy", "berthed", "listed_as_berth"],
  "negativeKinds": ["prohibited", "buoys_private", "no_space", "unsafe", "closed"],
  "countingPageKinds": ["trip_report", "pilot_guide", "forum", "marina", "authority"],
  "listedAsBerthPageKinds": ["pilot_guide"],
  "officialPageKinds": ["marina", "authority"]
},
"discovery": { "corridorBufferKm": 3, "minNameSimilarity": 0.8 }
```

- [ ] **Step 1: Write the failing tests** — Schema: Check von `berth_facts` lehnt eine Zeile mit `attribute` und `statement` ab und eine ohne beides; `berth_signals.confidence = 1.2` scheitert; Unique von `research_units`. Config: Werte geladen; `negativeKinds ∩ positiveKinds = ∅` sonst Ablehnung. v4: enthält `shelter.n` (oder den Sektorschlüssel der Repo-Konvention) und `prices`, enthält keinen `highlight.*`- oder `quietness`-Schlüssel, `levels` hat nur `place`.
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement**; Migration erzeugen und mit `npm run db:migrate` einspielen.
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit** `feat(research): schema for berth facts, signals and units; fact schema v4 (N2)`

---

### Task 2: Seiten den Liegeplätzen zuordnen

**Files:**
- Create: `lib/domain/research/assign.ts`
- Test: `lib/domain/research/__tests__/assign.test.ts`

**Interfaces:**
- Consumes: `normalizeName` (`lib/domain/gazetteer/names.ts`), `stripAffix` (`lib/domain/mentions/affixes.ts`), `page_assessments.berths`, `research_hits`.
- Produces:
  - `berthNameMatches(assessed: { name: string; island: string | null }, candidateNames: string[], affixes: NameAffixesConfig): boolean` (rein: normalisiert, Affixe abgestreift, gleich oder enthalten; Insel stimmt, falls beide genannt)
  - `type ResearchUnitPlan = { documentVersionId: string; placeIds: string[] }`
  - `unitsForPlaces(db: Db, placeIds: string[], cfg: AppConfig): Promise<ResearchUnitPlan[]>`: je aktueller, aktiv bewerteter, nicht `generated` Version eines Trefferdokuments der Plätze: der gesuchte Platz plus jeder Kandidat (Status `candidate`/`confirmed`) im Umkreis `extraction.placeRadiusKm` des gesuchten Platzes, dessen Name auf einen bewerteten Liegeplatz der Seite passt. Sortiert nach Version, Plätze nach id.

- [ ] **Step 1: Write the failing tests** — `berthNameMatches`: „Ormos Vathi“ passt auf „Vathi“; „Vathy Bay“ auf „Vathi“ nur, wenn `normalizeName` beide gleich macht (sonst nicht — kein Fuzzy); andere Insel → false. `unitsForPlaces` (`withRollback`): Seite ist Treffer von A, bewertet mit Liegeplätzen „A“ und „B“; B liegt 5 km entfernt → `[A, B]`; C mit gleichem Namen wie B in 40 km → nicht dabei; `generated`-Seite → keine Einheit; Seite ohne Bewertung → keine.
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit** `feat(research): assign assessed pages to nearby berth candidates (N2)`

---

### Task 3: Text einer Einheit, Zitat- und Übernahmeprüfung

**Files:**
- Create: `lib/domain/research/unit-text.ts`, `lib/domain/research/verbatim.ts`
- Test: `lib/domain/research/__tests__/unit-text.test.ts`, `lib/domain/research/__tests__/verbatim.test.ts`

**Interfaces:**
- Produces:
  - `unitText(markdown: string, names: string[], cfg: { maxUnitWords: number; windowWords: number }): { text: string; offset: number[] | null }` — bis `maxUnitWords` der ganze Text (`offset: null`); darüber nur Fenster von `windowWords` Wörtern vor und nach jedem Vorkommen eines Namens (normalisiert gesucht), zusammengelegt, in Dokumentreihenfolge, getrennt durch `\n\n[…]\n\n`; `offset` bildet Zeichen des Einheitentexts auf Zeichen des Markdowns ab (für `quote_start`/`quote_end` im Dokument). Kein Vorkommen → die ersten `maxUnitWords` Wörter.
  - `copiesSource(statement: string, sourceText: string, maxSharedWords: number): boolean` — true, wenn die Aussage eine Folge von `maxSharedWords` Wörtern mit dem Quelltext teilt (Wortnormalisierung wie `shingleWords`).

- [ ] **Step 1: Write the failing tests** — kurzer Text → unverändert; 80.000-Wörter-Text mit zwei Vorkommen von „Vathi“ → zwei Fenster, Länge ≤ 2 × (2 × 600 + Name), Zitat aus dem zweiten Fenster lässt sich über `offset` an der richtigen Stelle im Original finden (Review Focus); `copiesSource`: 8 gleiche Wörter → true, 7 → false, Groß-/Kleinschreibung und Satzzeichen egal.
- [ ] **Step 2–4:** fail, implement, pass
- [ ] **Step 5: Commit** `feat(research): unit text windows and verbatim check (N2)`

---

### Task 4: Extraktion `research.extract`

**Files:**
- Create: `lib/ai/tasks/extract-berth.ts`, `config/prompts/extract-berth/v1.md`; Modify: `config/models.json`
- Create: `lib/domain/research/extraction.ts` (Speichern), `lib/pipeline/research/extract.ts` (Stufe); Modify: `lib/jobs/batch-handlers.ts`
- Test: `lib/domain/research/__tests__/extraction.test.ts`, `lib/pipeline/__tests__/research-extract.test.ts`

**Interfaces:**
- Consumes: Task 1–3, `submitStageJobBatch`, `locateQuote`, `getFactSchema("v4")`, Datumsregel wie `storeAssessment` (N1).
- Produces:
  - `ExtractBerthInput = { berth: { name: string; names: string[]; kind: PlaceKind; island: string | null }; otherBerths: string[]; pageKind: PageKind; observedAt: string; attributes: Array<{ key: string; description: string; values: string }>; text: string }`
  - `ExtractBerthOutput = { core: Array<{ attribute: string; value: unknown; quote: string }>; facts: Array<{ about: "berth" | "landside"; subject_name: string | null; subject_category: string | null; statement: string; quote: string; observed_at: string | null; tone: "positive" | "negative" | "neutral"; safety: boolean }>; signals: Array<{ kind: BerthSignalKind; first_hand: boolean; confidence: number; quote: string; observed_at: string | null }>; landing: Array<{ description: string; quote: string }> }`
  - `storeExtraction(db: Db, unit: { id: string; placeId: string; documentVersionId: string; text: string; offset: number[] | null; observedAt: string; observedAtBasis: ObservedAtBasis; fetchedAt: Date }, out: ExtractBerthOutput, cfg: AppConfig): Promise<{ facts: number; signals: number; landing: number; dropped: { quote: number; value: number; verbatim: number } }>` — jedes Element: Zitat prüfen (sonst `dropped.quote`), Kernwert gegen das zod-Schema seines v4-Attributs (unbekannt oder ungültig → `dropped.value`), Aussage gegen `copiesSource` (→ `dropped.verbatim`); Datum je Element: eigenes `observed_at` nach der Datumsregel, sonst das der Seite. Setzt `research_units.status = done` und `dropped`.
  - `RESEARCH_EXTRACT_STAGE = "research.extract"`; `planResearchExtract(db, run, config?)` (Einheiten aus `unitsForPlaces` für die Kandidaten des Laufs, die für das aktive Modell/Prompt noch keine `done`/`failed`-Einheit haben; legt `research_units` mit `pending` an; `extraction.unitsPerBatch` je Job); `extractUnits(db, deps, job)`; `extractBerthBatchEntry: BatchHandlerEntry` (veraltetes Modell/Prompt verwerfen wie N1; Fehler des Items → `status = failed`, `reason`).

Prompt-Regeln (`v1.md`, englisch): nur über den genannten Liegeplatz; Aussagen über andere Liegeplätze (`otherBerths`) weglassen; Kernwerte nur mit Werten aus der Attributliste; Fakten frei, kurz, in eigenen Worten, englisch, ein Fakt je Aussage, mit `about = landside` und Name/Art des Dings an Land, wenn es um etwas an Land geht; Signale: `anchored`/`moored_buoy`/`berthed` nur bei eigener Erfahrung der Autoren (`first_hand = true`), sonst `first_hand = false`; `listed_as_berth` nur, wenn die Seite den Platz ausdrücklich als Ankerplatz/Bojenfeld/Liegeplatz führt; Negativsignale bei Verbot, privaten Bojen, keinem Platz mehr, Gefahr, Schließung; `confidence` = wie sicher die Zuordnung zu genau diesem Liegeplatz und die Einordnung ist; Zitate wörtlich, zusammenhängend, ≤ 300 Zeichen; Datum nur, wenn im Text; im Zweifel weglassen.

- [ ] **Step 1: Write the failing tests** — `extraction.test.ts` (`withRollback`): erfundenes Zitat → verworfen, `dropped.quote = 1`; Kernwert `holding: "excellent"` (nicht im Enum) → `dropped.value`; Aussage, die 9 Wörter der Seite übernimmt → `dropped.verbatim`; gültiger Fakt über „Taverna Nikos“ mit `about = landside` → `subject_name`, `subject_category`; Signal `anchored` mit `first_hand` und Datum `2024-06` → `observed_at = 2024-06-15`; Zitat aus einem Fenster einer langen Seite → `quote_start` zeigt in das Original. `research-extract.test.ts` (`MockModel`, `pollBatch`): zwei Plätze auf einer Seite ergeben zwei Einheiten, jede mit eigenem Batch-Item und eigenen Signalen (Review Focus); erneuter Plan legt keine Einheiten doppelt an; `generated`-Seite plant nichts.
- [ ] **Step 2–4:** fail, implement, pass
- [ ] **Step 5: Commit** `feat(research): extract core values, free facts and signals per page and berth (N2)`

---

### Task 5: Routen und verankerte Entdeckung

**Files:**
- Create: `lib/pipeline/research/routes.ts`, `lib/domain/research/discovery.ts`; Modify: `lib/jobs/batch-handlers.ts`
- Test: `lib/domain/research/__tests__/discovery.test.ts`, `lib/pipeline/__tests__/research-routes.test.ts`

**Interfaces:**
- Consumes: bestehender Task `extract-route` (`lib/ai/tasks/extract-route.ts`) mit seinen Eingaben; Zitatprüfung; Task 2 `berthNameMatches`.
- Produces:
  - `RESEARCH_ROUTES_STAGE = "research.routes"`: je aktiv bewerteter, nicht `generated` Seite mit `page_kind = trip_report` der Treffer des Laufs ohne Stopps für aktives Modell/Prompt ein Batch-Item (lange Berichte in Abschnitten wie `lib/pipeline/text/routes.ts`); Ergebnis → `research_route_stops` (Zitat geprüft, sonst Stopp verworfen).
  - `matchStops(db: Db, documentVersionId: string, cfg: AppConfig): Promise<{ byName: number; byCorridor: number; open: number }>` (`RESEARCH_DISCOVER_STAGE = "research.discover"`, ein Job je Seite):
    1. Stopp passt per `berthNameMatches` auf genau einen Kandidaten (Status nicht `rejected`) im Umkreis der Nachbarstopps bzw. im Landesteil der Seite → `place_id`, `match = name`.
    2. Sonst, wenn vorheriger und nächster Stopp zugeordnet sind: Kandidaten vom Typ `anchorage`/`mooring_field` (Status `candidate`, nicht `no_anchoring`) im Puffer `discovery.corridorBufferKm` um die Strecke zwischen beiden; genau einer mit Namensähnlichkeit ≥ `discovery.minNameSimilarity` (pg_trgm `similarity` auf normalisierte Namen) → zugeordnet (`match = corridor`); hat der Kandidat keinen Namen und ist er der einzige unbenannte im Puffer und keiner hat einen passenden Namen → zugeordnet und der Stoppname wird als Name angelegt (`geo_names`, `origin = 'research'` — Enum ergänzen, falls nötig, in Task 1-Migration nachziehen nicht erlaubt: eigene Migration), Sprache der Seite.
    3. Sonst bleibt der Stopp offen.
    Ein zugeordneter Stopp macht die Seite zur Quelle dieses Platzes: `research_hits`-Zeile mit `purpose = positive`, `rank = 0`, ohne SERP-Bezug ist nicht möglich (FK) → stattdessen gilt die Seite in `unitsForPlaces` als Seite des Platzes, wenn ein Stopp auf ihn zeigt (Task 2 entsprechend erweitern, Test dort ergänzen).

- [ ] **Step 1: Write the failing tests** — `discovery.test.ts`: Route Hydra → „Ormos X“ → Poros, Hydra und Poros als Kandidaten bekannt, X unbekannt, im Korridor genau eine unbenannte Ankerbucht → zugeordnet, Name angelegt; zwei unbenannte im Korridor → offen; „Vathi“ mit genau einem Namenstreffer 10 km weg → `match = name`; Stopp ohne Nachbarn → offen. `research-routes.test.ts` (`MockModel`): Törnbericht ergibt Stopps mit geprüften Zitaten; Forenseite plant nichts.
- [ ] **Step 2–4:** fail, implement, pass
- [ ] **Step 5: Commit** `feat(research): routes from trip reports and anchored discovery of unknown stops (N2)`

---

### Task 6: Bestätigungsregel und Status

**Files:**
- Create: `lib/domain/research/confirmation.ts`, `lib/pipeline/research/confirm.ts`
- Modify: `lib/domain/places/auto-status.ts` (Bestätigungspfad abschalten: `applyAutoStatus` bestätigt nicht mehr und setzt kein `no_anchoring` aus Text; der Wechsel der Ortsart bleibt) und die Tests, die die alte Bestätigung erwarten (anpassen: sie erwarten jetzt `action: "none"` bzw. nur `kind_changed`)
- Test: `lib/domain/research/__tests__/confirmation.test.ts`, `lib/pipeline/__tests__/research-confirm.test.ts`

**Interfaces:**
- Produces:
  - `type Evidence = { signalId: string; kind: BerthSignalKind; firstHand: boolean; confidence: number; observedAt: string; domain: string; pageKind: PageKind; generated: boolean }`
  - `type Verdict = { status: "confirmed" | "candidate" | "no_anchoring"; reason: string; independentSources: string[]; blockingSignalId: string | null }`
  - `decideBerth(placeKind: PlaceKind, evidence: Evidence[], cfg: ResearchConfig["confirmation"]): Verdict` (rein):
    1. Gezählt werden nur Signale mit `confidence ≥ minSignalConfidence`, nicht `generated`, `pageKind ∈ countingPageKinds`.
    2. Positiv zählt `anchored`/`moored_buoy`/`berthed` nur mit `firstHand`; `listed_as_berth` nur aus `listedAsBerthPageKinds`.
    3. Unabhängige Quellen = verschiedene Domains der zählenden positiven Signale.
    4. Ein zählendes Negativsignal, dessen `observedAt` nach allen zählenden positiven liegt (gleich zählt als jünger), blockiert: `prohibited` aus `authority` → `no_anchoring`; jedes andere → `candidate` mit Grund.
    5. `anchorage`/`mooring_field`: bestätigt bei ≥ `minIndependentSources`; `marina`/`port`: bestätigt bei mindestens einer Quelle aus `officialPageKinds` plus einer weiteren unabhängigen Domain.
    6. Sonst `candidate` mit Grund (z. B. „1 von 2 unabhängigen Quellen“). Gründe deutsch (Oberfläche).
  - `applyBerthVerdicts(db: Db, placeIds: string[], now: Date, cfg: AppConfig): Promise<Array<{ placeId: string; from: PlaceStatus; to: PlaceStatus }>>`: lädt Belege je Platz, entscheidet, ändert `places.status`/`status_reason` (bestätigt → `public_id` vergeben wie bisher), nimmt eine alte Bestätigung zurück (`confirmed` → `candidate`), lässt `rejected`, `abandoned` und von einem Admin gesetzte Status unangetastet, protokolliert jede Änderung als System-Entscheidung wie `recordDecision` in `auto-status.ts` (`auto: true`, `rule: "research"`, Signal-IDs); gibt die Wechsel zurück.
  - `RESEARCH_CONFIRM_STAGE = "research.confirm"`: ein Job für alle Kandidaten des Laufs.

- [ ] **Step 1: Write the failing tests** — `confirmation.test.ts` (Tabellentest der reinen Funktion): zwei Domains mit `anchored`+`firstHand` → `confirmed`; fünf Seiten einer Domain → `candidate`, „1 von 2“ (Review Focus); `anchored` ohne `firstHand` zählt nicht; `listed_as_berth` aus `pilot_guide` + ein Törnbericht → bestätigt; `listed_as_berth` aus `travel_guide` zählt nicht; Signal mit `confidence 0.5` zählt nicht; `generated` zählt nicht; jüngeres `prohibited` aus `authority` → `no_anchoring`; jüngeres `buoys_private` aus Forum → `candidate` mit Grund (Review Focus); Negativsignal mit Abrufdatum als Beobachtung gegen datierte positive → blockiert (Review Focus); Marina mit Marina-Seite + Törnbericht → bestätigt, nur Marina-Seite → nicht. `research-confirm.test.ts` (`withRollback`): Kandidat mit zwei Quellen wird `confirmed` mit `public_id` und System-Entscheidung; bisher `confirmed` ohne Belege → `candidate`; `rejected` bleibt; alte `applyAutoStatus` bestätigt nicht mehr (bestehender Test angepasst).
- [ ] **Step 2–4:** fail, implement, pass; danach `npx vitest run lib/domain/places lib/domain/consolidation lib/pipeline/__tests__/consolidation-run.test.ts`
- [ ] **Step 5: Commit** `feat(research): confirmation rule replaces the old auto-confirmation (N2)`

---

### Task 7: Lauf erweitern, Folgekette, Oberfläche

**Files:**
- Modify: `lib/pipeline/research-run.ts` (`RESEARCH_STAGES` um `research.extract`, `research.routes`, `research.discover`, `research.confirm`), `lib/jobs/queues.ts`, `config/queues.json` (extract/routes wie assess; discover/confirm `concurrency 2, retryLimit 2`), `lib/jobs/stages.ts`, `lib/jobs/registry.ts`, `lib/jobs/handlers/research.ts`
- Create: `lib/pipeline/berth-followup-run.ts`
- Modify: `lib/domain/research/view.ts`, `app/(admin)/places/[id]/research-tab.tsx`
- Test: `lib/pipeline/__tests__/research-run.test.ts`, `lib/pipeline/__tests__/berth-followup-run.test.ts`, `lib/domain/research/__tests__/view.test.ts`, `app/(admin)/__tests__/research-tab.test.tsx`

**Interfaces:**
- Produces:
  - `startBerthFollowupRun(db: Db, boss: PgBoss, placeIds: string[], triggeredBy: string): Promise<{ id: string } | null>` — Lauf `kind = "event"`, Scope `system`/`"berth-followup"`, Stufen `BERTH_FOLLOWUP_STAGES` (in N2 nur `images.place` mit den Plätzen, wenn deren Bild-Stufe Plätze als Parameter annimmt; N4 ergänzt Anlandestellen, Erreichbares, Landrecherche); null ohne Plätze.
  - `research.confirm` ruft nach `applyBerthVerdicts` für alle Wechsel nach `confirmed` `startBerthFollowupRun` (Spec 5.7b); ein Wechsel weg von `confirmed` startet nichts (die Lieferung filtert auf `confirmed`).
  - `researchView` liefert zusätzlich je Platz `verdict: Verdict` und je Treffer die Zahl der Fakten/Signale; der Reiter zeigt oben „Bestätigt: 2 unabhängige Quellen (a.example, b.example)“ bzw. den Grund, und je Seite die Signale mit Zitat und die Fakten (Aussage, Bezug, Datum, Tendenz).

- [ ] **Step 1: Write the failing tests** — Lauf hat die acht Stufen in Reihenfolge; End-to-End mit `MockModel`: zwei Quellen → Platz bestätigt, Folgelauf gestartet mit dem Platz; Reiter zeigt Grund und Signale.
- [ ] **Step 2–4:** fail, implement, pass; dann `npm run build`
- [ ] **Step 5: Commit** `feat(research): extract, routes, discover and confirm in the research run; follow-up run on confirmation (N2)`

---

### Task 8: Probelauf Saronischer Golf (Messung, kein Code)

**Files:** Create: `docs/pilot/neuausrichtung/n2-probelauf.md`

- [ ] **Step 1:** Worker mit neuem Code, Recherche-Lauf für `GR-I` (Suche und Holen werden wiederverwendet).
- [ ] **Step 2:** Messen und eintragen: Einheiten, Fakten/Signale/Hinweise je Einheit, verworfen nach Grund, Routenstopps (nach Name, Korridor, offen), Bestätigt/Kandidat/Zurückgenommen mit Gründen, Kosten je Kandidat. SQL mit ins Dokument.
- [ ] **Step 3:** Grobvergleich mit der Navily-Referenz (nur Kennzahlen, keine Navily-Werte ins Repo) als Vorbereitung für N3.
- [ ] **Step 4: Commit** `docs(research): N2 trial run in the Saronic Gulf`

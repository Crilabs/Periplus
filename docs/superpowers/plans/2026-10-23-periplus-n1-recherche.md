# Periplus N1 – Recherche je Kandidat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Für jeden Liegeplatz-Kandidaten eines Landesteils gezielt suchen (positiv und nach Negativbelegen), die Trefferseiten einzeln holen und archivieren und jede Seite per Modell bewerten (Art, erste Hand, SEO/KI, Beobachtungsdatum, behandelte Liegeplätze).

**Architecture:** Neuer Lauf „Recherche“ mit drei Stufen `research.search` → `research.fetch` → `research.assess`, neben dem alten Ansatz (die alten Stufen bleiben unangetastet und werden nur nicht mehr gestartet). Suche nutzt `runQuery` aus `lib/domain/discovery/serp.ts`; Holen nutzt `fetchFollowing`, die Konverter und `storeFetched` über eine aus `fetchUrl` herausgelöste Funktion `convertAndStore`; Bewertung läuft als Message-Batch über `submitStageJobBatch` wie die heutige Klassifikation. Neue Tabellen `research_hits` und `page_assessments`.

**Tech Stack:** TypeScript, Drizzle + PostgreSQL 17, pg-boss, zod 4, Anthropic Batches über `ModelClient`, Vitest gegen `db-test`.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (Abschnitte 4, 5.2, 5.3, 5.6 Negativbelege, 8 Zeilen „Quellenfindung“, „Fetch und Archiv“, „Klassifikation“)

## Global Constraints

- Branch von `main` (`feat/n1-recherche`); die alten Stufen, Tabellen und Seiten werden in diesem Plan **nicht** entfernt oder geändert, außer `lib/pipeline/fetch/url.ts` (Herauslösen von `convertAndStore`, Verhalten unverändert).
- Kandidaten sind `places` mit `merged_into_id is null`, gültig (`valid_to is null`), Status `candidate` oder `confirmed`; `no_anchoring` und `rejected` werden nicht recherchiert (Spec 5.2).
- Navily wird nie gesucht, geholt oder gespeichert: `navily.com` steht in `research.skipDomains`.
- Schwellen, Vorlagen, Sprachen, Grenzen nur in `config/research.json`; Prompt in `config/prompts/assess-page/v1.md`; Modell in `config/models.json` (Task `assess-page`, `claude-sonnet-5-5`, Qualität vor Kosten).
- Kosten jedes Aufrufs über die bestehenden Adapter (`external_calls`) mit `runId`, `stage` und – für Suche – `tileId` des Kandidaten.
- Code, Bezeichner, Tabellen, Prompt englisch; Oberfläche deutsch.
- Tests gegen echte Postgres mit `withRollback` (`test/db.ts`), S3 über `memoryArchive()` (`test/s3.ts`), HTTP über einen eigenen Fake-`Transport` oder `startSiteServer()` (`test/site-server.ts`), KI über `MockModel` (`lib/ai/mock.ts`); kein Netz. `db-test` ist zwischen Worktrees geteilt; Migrationen sind additiv.
- Fachlogik in `lib/domain/research` und `lib/pipeline/research`; Job-Handler und Seiten dünn.
- Nach jeder Aufgabe grün: `npx vitest run <betroffene Dateien>`, `npx tsc --noEmit`, `npm run lint`.
- Commits enden mit `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- Dieselbe URL taucht bei mehreren Kandidaten auf → genau ein Holen und eine Bewertung, aber je Kandidat ein Treffer (Test in Task 3 und 4).
- Eine Trefferseite liegt auf einer Domain aus `config/sources-whitelist.json` oder einer abgelehnten alten Quelle → wird trotzdem geholt (Bewertung je Seite, nicht je Domain); nur `skipDomains` und `forbidden-domains` sperren (Test in Task 3).
- Ein Kandidat ohne Namen (unbenannte Bucht) → keine Positivsuche, keine Fehlschläge, Job endet mit `queries: 0` (Test in Task 2).
- Ein PDF (Revierführer) als Treffer → wird über den PDF-Adapter konvertiert und bewertet; zu große Dateien werden übersprungen statt den Lauf zu brechen (Test in Task 4).
- Die Modellantwort nennt ein Beobachtungsdatum in der Zukunft oder ein unlesbares Datum → wird verworfen, `observed_at` fällt auf `published_at` bzw. Abrufdatum zurück (Test in Task 5).

---

### Task 1: Schema und Konfiguration

**Files:**
- Create: `drizzle/0069_research.sql` (über `npx drizzle-kit generate`, dann Enum-Ergänzungen prüfen)
- Create: `lib/db/schema/research.ts`
- Modify: `lib/db/schema/index.ts` (Export), `lib/db/schema/sources.ts:49` (`sourceOriginEnum` + `"research"`), `lib/db/schema/sources.ts:237` (`serpLevelEnum` + `"research"`)
- Create: `config/research.json`
- Modify: `lib/config/schemas.ts` (`researchSchema`, `ResearchConfig`, Feld in `AppConfig`), `lib/config/index.ts` (`readJson(dir, "research", researchSchema)`)
- Test: `lib/db/__tests__/research-schema.test.ts`, `lib/config/__tests__/research-config.test.ts`

**Interfaces:**
- Produces: Tabellen `researchHits`, `pageAssessments`; Enums `researchPurposeEnum` (`positive`, `negative`), `pageKindEnum` (`trip_report`, `pilot_guide`, `marina`, `authority`, `forum`, `travel_guide`, `listing`, `other`); Typ `ResearchConfig`.

`research_hits`: `id uuid pk`, `place_id → places`, `geo_object_id → geo_objects`, `serp_query_id → serp_queries`, `serp_result_id → serp_results`, `url_normalized text`, `domain text`, `rank int`, `purpose research_purpose`, `run_id → runs`, `created_at`; Unique `(place_id, url_normalized, purpose)`; Index `url_normalized`.

`page_assessments`: `id uuid pk`, `document_version_id → document_versions`, `model text`, `prompt_version int`, `page_kind page_kind`, `first_hand boolean`, `generated boolean` (SEO/KI), `language text null`, `observed_at date`, `observed_at_basis observed_at_basis`, `observed_at_reason text null`, `berths jsonb` (Array `{ name: string, island: string | null, kind: "anchorage" | "mooring_field" | "marina" | "port" | "unknown" }`), `run_id → runs`, `created_at`; Unique `(document_version_id, model, prompt_version)`.

`config/research.json` (Startwerte, Entscheidung Claude):

```json
{
  "languagesByCountry": { "GR": ["el", "en", "de", "it", "fr"], "default": ["en", "de", "it", "fr"] },
  "locationCodes": { "el": 2300, "en": 2826, "de": 2276, "it": 2380, "fr": 2250, "es": 2724, "hr": 2191, "tr": 2792 },
  "templates": {
    "positive": [
      { "template": "{name} anchorage", "lang": "en" },
      { "template": "{name} {island} anchorage", "lang": "en" },
      { "template": "{name} sailing", "lang": "en" },
      { "template": "{name} Ankerplatz", "lang": "de" },
      { "template": "{name} {island} Törnbericht", "lang": "de" },
      { "template": "{name} ancoraggio", "lang": "it" },
      { "template": "{name} mouillage", "lang": "fr" },
      { "template": "{name} αγκυροβόλιο", "lang": "el" }
    ],
    "negative": [
      { "template": "{name} anchoring prohibited", "lang": "en" },
      { "template": "{name} Ankerverbot", "lang": "de" },
      { "template": "{name} απαγόρευση αγκυροβολίας", "lang": "el" }
    ]
  },
  "maxHitsPerCandidate": 40,
  "refetchDays": 90,
  "assessWords": 6000,
  "skipDomains": ["navily.com", "google.com", "youtube.com", "facebook.com", "instagram.com", "pinterest.com", "tripadvisor.com", "booking.com", "amazon.com"]
}
```

Regeln: Eine Vorlage mit `{island}` entfällt, wenn der Kandidat keine Insel als Vorfahr hat. Eine Vorlage, deren Sprache nicht in `languagesByCountry[Land]` (sonst `default`) steht, entfällt. `{name}` nimmt den Namen in der Sprache der Vorlage, sonst den englischen, sonst den ersten vorhandenen.

- [ ] **Step 1: Write the failing tests**
  - `research-config.test.ts`: `getConfig().research.templates.positive.length > 0`; `researchSchema.safeParse` lehnt eine Vorlage ohne `{name}` ab und eine Sprache ohne `locationCodes`-Eintrag.
  - `research-schema.test.ts` (`withRollback`): Einfügen zweier `research_hits` mit gleichem `(place_id, url_normalized, purpose)` scheitert am Unique-Index; gleicher Treffer mit `purpose = negative` gelingt. `page_assessments` lehnt einen zweiten Eintrag mit gleichem `(document_version_id, model, prompt_version)` ab.
- [ ] **Step 2: Run tests to verify they fail**
  Run: `npx vitest run lib/db/__tests__/research-schema.test.ts lib/config/__tests__/research-config.test.ts`
  Expected: FAIL (Tabelle bzw. Konfiguration fehlt)
- [ ] **Step 3: Implement** Schema in `lib/db/schema/research.ts` im Stil von `lib/db/schema/sources.ts`, Enum-Werte ergänzen, `npx drizzle-kit generate --name research` (ergibt `0069_research.sql`), `npm run db:migrate` (Dev; die Test-DB migriert `test/global-setup.ts`); `researchSchema` mit `superRefine` für die beiden Prüfungen.
- [ ] **Step 4: Run tests to verify they pass** (gleicher Befehl, PASS)
- [ ] **Step 5: Commit** `feat(research): schema and config for per-berth research (N1)`

---

### Task 2: Suchanfragen je Kandidat und Stufe `research.search`

**Files:**
- Create: `lib/domain/research/queries.ts`, `lib/domain/research/candidates.ts`, `lib/domain/research/hits.ts`
- Create: `lib/pipeline/research/search.ts`
- Test: `lib/domain/research/__tests__/queries.test.ts`, `lib/pipeline/__tests__/research-search.test.ts`

**Interfaces:**
- Consumes: `runQuery`, `runQueries` (`lib/pipeline/discovery.ts`), `DiscoveryQuery`, `queryKey`, `namesByLanguage` (`lib/domain/discovery/queries.ts`), `isForbiddenUrl(url, getConfig().delivery.forbiddenDomains)` (`lib/domain/sources/forbidden-domains.ts`).
- Produces:
  - `type CandidateNames = { names: Record<string, string>; island: Record<string, string> | null; countryCode: string; tileId: string | null }`
  - `buildResearchQueries(placeId: string, input: CandidateNames, cfg: ResearchConfig, purpose: "positive" | "negative"): DiscoveryQuery[]` (rein; `level = "research"`, `scopeId = placeId`, `priority` = Index der Vorlage, dedupliziert über `queryKey`)
  - `candidateNames(db: Db, placeId: string): Promise<CandidateNames>` (Namen des Geo-Objekts, nächster Vorfahr vom Typ `island`/`islet`, Land aus dem Landesteil)
  - `researchCandidates(db: Db, scope: { subdivisionKey: string } | { placeIds: string[] }): Promise<string[]>` (Place-IDs nach Spec 5.2, sortiert nach `id`)
  - `recordHits(db: Db, input: { placeId: string; geoObjectId: string; serpQueryId: string; purpose: "positive" | "negative"; runId: string }, cfg: ResearchConfig): Promise<number>` (übernimmt die `serp_results` der Anfrage, ohne `skipDomains` und verbotene Domains, `on conflict do nothing`; hält je Kandidat und Zweck höchstens `maxHitsPerCandidate` Treffer, bessere Ränge zuerst; gibt die Zahl neuer Zeilen zurück)
  - `RESEARCH_SEARCH_STAGE = "research.search"`; `planResearchSearch(db, run): Promise<JobData[]>` (ein Job je Kandidat, `key = placeId`); `searchCandidate(db, placeId: string, deps: { transport; archive }, ctx: CallContext & { runId: string }): Promise<{ queries: number; hits: number }>`

`runQuery` muss für `level = "research"` den `tileId` aus `q.tileId` nehmen (eine Zeile in `lib/domain/discovery/serp.ts:57`: Bedingung um `"research"` erweitern).

- [ ] **Step 1: Write the failing tests**
  - `queries.test.ts`: Kandidat `{ names: { en: "Vathi", el: "Βαθύ" }, island: { en: "Methana" }, countryCode: "GR" }` ergibt u. a. `"Vathi Methana anchorage"` (en, 2826) und `"Βαθύ αγκυροβόλιο"` (el, 2300); ohne Insel fehlt jede Anfrage mit `{island}`; mit `countryCode: "XX"` gibt es keine `el`-Anfrage; `names: {}` ergibt `[]`; zweimal derselbe Name in `en` und `de` erzeugt keine doppelten Schlüssel; `purpose: "negative"` nutzt nur `templates.negative`.
  - `research-search.test.ts` (`withRollback`, Fake-Transport für DataForSEO mit zwei Ergebnissen: `https://sailblog.example/vathi` und `https://www.navily.com/x`): `searchCandidate` legt `serp_queries` mit `level = 'research'` an und genau einen `research_hits`-Eintrag (Navily fehlt); ein zweiter Aufruf innerhalb `serp.reuseDays` stellt keine neue Anfrage und legt keine doppelten Treffer an; `researchCandidates` liefert `candidate` und `confirmed`, nicht `no_anchoring`, `rejected` oder zusammengeführte Plätze; ein Kandidat ohne Namen ergibt `{ queries: 0, hits: 0 }` ohne Fehler (Review Focus).
- [ ] **Step 2: Run tests to verify they fail**
  Run: `npx vitest run lib/domain/research/__tests__/queries.test.ts lib/pipeline/__tests__/research-search.test.ts`
  Expected: FAIL (Module fehlen)
- [ ] **Step 3: Implement** die Funktionen oben; `searchCandidate` baut positive und negative Anfragen, ruft `runQueries` (Fehlertoleranz je Anfrage bleibt dort) und danach `recordHits` je gestellter oder wiederverwendeter Anfrage (die Query-IDs liefert `runQuery`; `runQueries` dafür um eine Rückgabe der Query-IDs erweitern: `queryIds: string[]`).
- [ ] **Step 4: Run tests to verify they pass** (gleicher Befehl, PASS)
- [ ] **Step 5: Commit** `feat(research): targeted search per candidate with negative queries (N1)`

---

### Task 3: Seite holen ohne Crawl (`convertAndStore`, Recherche-Quellen)

**Files:**
- Create: `lib/pipeline/fetch/store-page.ts`
- Modify: `lib/pipeline/fetch/url.ts:473-613` (`fetchUrl` nutzt `convertAndStore`; Verhalten unverändert)
- Create: `lib/domain/research/sources.ts`
- Create: `lib/pipeline/research/fetch.ts`
- Test: `lib/pipeline/__tests__/fetch.test.ts` (bestehend, muss unverändert grün bleiben), `lib/pipeline/__tests__/research-fetch.test.ts`

**Interfaces:**
- Consumes: `fetchFollowing`, `formatOf`, `decodeHtml`, `urlJobKey` (`lib/pipeline/fetch/url.ts`), `ensureDocument`, `storeFetched` (`lib/domain/documents/store.ts`), `convertPdf`, Konverter aus `lib/adapters/fetch`.
- Produces:
  - `convertAndStore(db: Db, source: Source, page: { url: string; urlNormalized: string; documentId: string | null; raw: Uint8Array; contentType: string | null; finalUrl: string | null; etag: string | null; lastModified: string | null; fetchedAt: Date; ratePerMinute: number; isUpload: boolean }, deps: Pick<FetchUrlDeps, "archive" | "converters" | "pdf">, ctx: CallContext & { runId: string }): Promise<{ kind: "stored"; documentId: string; versionId: string; outcome: StoreOutcome; html: string | null; pageUrl: string } | { kind: "skipped"; reason: "pdf_disabled" | "redirect_offsite" | "unsupported_type" }>`
  - `ensureResearchSource(db: Db, domain: string): Promise<Source>`: bestehende aktuelle Quelle der Domain unverändert zurückgeben (auch `rejected` oder `proposed`); sonst neu mit `status = 'approved'`, `origin = 'research'`, `type = 'other'`, `weight = 0.5`, `crawlRules = { startUrls: [], allow: [], deny: [], maxDepth: 0, maxPages: 1, ratePerMinute: 20, render: "auto", converter: "auto", pdf: true }` (gültig nach `lib/domain/sources/crawl-rules.ts`). Gleichzeitige Aufrufe für dieselbe Domain erzeugen genau eine Quelle (Unique-Index `sources_domain_valid_unique`, bei Konflikt neu lesen).
  - `RESEARCH_FETCH_STAGE = "research.fetch"`; `planResearchFetch(db, run): Promise<JobData[]>`: je eindeutiger `url_normalized` der `research_hits` der Kandidaten des Laufs (`run.params`) ein Job `{ key: urlJobKey(url), url }`, außer das Dokument hat eine Version jünger als `refetchDays`.
  - `fetchResearchPage(db: Db, url: string, deps: FetchUrlDeps, ctx: CallContext & { runId: string }): Promise<{ outcome: "stored" | "unchanged" | "skipped" | "gone" | "failed"; versionId: string | null; reason?: string }>`: Quelle per `ensureResearchSource`, dann `fetchFollowing` (ohne Prüfung des Quellenstatus, ohne Frontier, ohne Linkverfolgung), 404/410 über `markGone`, zu groß → `skipped/too_large`, sonst `convertAndStore`.

- [ ] **Step 1: Write the failing tests** (`research-fetch.test.ts`, `withRollback`, `startSiteServer()` mit einer HTML-Seite, einem PDF über dem Größenlimit und einer 404-Seite, `memoryArchive()`)
  - HTML-Treffer → `outcome = "stored"`, ein `documents`-Eintrag an einer Quelle mit `origin = 'research'`, eine `document_versions`-Zeile, Markdown im Archiv.
  - Zweiter Aufruf derselben URL → `unchanged`, keine zweite Version.
  - Domain mit bestehender Quelle `status = 'rejected'` → Seite wird trotzdem geholt, keine neue Quelle (Review Focus).
  - PDF über `fetch.maxRawBytes` → `skipped` mit `reason = "too_large"`, kein Fehler (Review Focus).
  - 404 → `missing`/`failed` ohne Dokument; robots.txt-Verbot → `skipped` mit `reason = "robots"`.
  - `planResearchFetch`: zwei Kandidaten mit derselben URL ergeben einen Job (Review Focus); eine URL mit Version jünger als `refetchDays` ergibt keinen Job.
- [ ] **Step 2: Run tests to verify they fail**
  Run: `npx vitest run lib/pipeline/__tests__/research-fetch.test.ts`
  Expected: FAIL
- [ ] **Step 3: Implement** `convertAndStore` durch Herauslösen des Blocks „format → convert → ensureDocument → storeFetched“ aus `fetchUrl`; `fetchUrl` ruft es und behält Frontier, Linkverfolgung und Statusprüfung. Dann `ensureResearchSource`, `planResearchFetch`, `fetchResearchPage`.
- [ ] **Step 4: Run tests to verify they pass**
  Run: `npx vitest run lib/pipeline/__tests__/research-fetch.test.ts lib/pipeline/__tests__/fetch.test.ts lib/pipeline/__tests__/place-website-run.test.ts`
  Expected: PASS (die bestehenden Fetch-Tests unverändert)
- [ ] **Step 5: Commit** `feat(research): fetch single hit pages without a crawl (N1)`

---

### Task 4: Seitenbewertung `research.assess`

**Files:**
- Create: `lib/ai/tasks/assess-page.ts`, `config/prompts/assess-page/v1.md`
- Modify: `config/models.json` (Task `assess-page`: `"model": "claude-sonnet-5-5", "promptVersion": 1, "effort": "medium", "maxTokens": 4096`)
- Create: `lib/domain/research/assessment.ts`, `lib/pipeline/research/assess.ts`
- Modify: `lib/jobs/batch-handlers.ts` (Eintrag `assessPageBatchEntry`)
- Test: `lib/domain/research/__tests__/assessment.test.ts`, `lib/pipeline/__tests__/research-assess.test.ts`

**Interfaces:**
- Consumes: `submitStageJobBatch` (`lib/pipeline/text/stage-batch.ts`), `BatchHandlerEntry`, `MockModel`.
- Produces:
  - `assessPageTask: ModelTask<AssessPageInput, AssessPageOutput>` mit `AssessPageInput = { url: string; title: string | null; fetchedAt: string; publishedAt: string | null; text: string }` und `AssessPageOutput = { page_kind: PageKind; first_hand: boolean; generated: boolean; language: string | null; observed_at: string | null; observed_at_explicit: boolean; observed_at_reason: string | null; berths: Array<{ name: string; island: string | null; kind: "anchorage" | "mooring_field" | "marina" | "port" | "unknown" }> }`
  - `storeAssessment(db: Db, versionId: string, out: AssessPageOutput, meta: { model: string; promptVersion: number; runId: string; fetchedAt: Date; publishedAt: string | null }): Promise<void>` (Datumsregel unten, `on conflict do nothing`)
  - `RESEARCH_ASSESS_STAGE = "research.assess"`; `planResearchAssess(db, run, config?): Promise<JobData[]>` (aktuelle Versionen der Trefferdokumente der Kandidaten des Laufs ohne Bewertung für das aktive Modell und die aktive Prompt-Version, `extraction.unitsPerBatch` je Job, `key = "assess:<i>"`); `assessPages(db, deps, job): Promise<{ submitted: number; remainder: number; reused: boolean }>`; `assessPageBatchEntry: BatchHandlerEntry`

Datumsregel (`storeAssessment`): `observed_at` aus der Antwort gilt nur, wenn es `YYYY-MM` oder `YYYY-MM-DD` ist und nicht nach `fetchedAt` liegt (`YYYY-MM` → Tag 15); Basis `explicit` nur mit `observed_at_explicit = true`. Sonst `published_at` (Basis `published`), sonst Abrufdatum (Basis `fetched`). `observed_at_reason` auf 300 Zeichen, `berths` auf 50 Einträge gekürzt.

Prompt (`v1.md`, englisch): Rolle „Bewerte eine Webseite für einen Datendienst über Liegeplätze für Segelyachten“; Definitionen der `page_kind`-Werte (`listing` = Liste oder Aggregator ohne erkennbare eigene Erfahrung, `travel_guide` = Reiseführer für Landurlauber); `first_hand` = die Seite berichtet erkennbar aus eigener Erfahrung an diesen Orten (wir lagen, wir ankerten) oder ist ein eigenständiger Revierführer; `generated` = Merkmale von SEO- oder KI-Massentext (generische Floskeln, keine konkreten Details, Wiederholung des Suchbegriffs, Listen ohne Substanz); `berths` = jeder Liegeplatz (Ankerbucht, Bojenfeld, Marina, Hafen), den die Seite als Ort zum Liegen behandelt, mit Namen wie im Text und Insel, falls genannt; Datum nur, wenn im Text. Gemeinsame Regeln wie in den anderen Prompts: nur aus dem Text, nichts erschließen, im Zweifel weglassen.

- [ ] **Step 1: Write the failing tests**
  - `assessment.test.ts` (`withRollback`): `storeAssessment` mit `observed_at: "2031-06"` bei `fetchedAt` 2026-10-23 → `observed_at = published_at`, Basis `published` (Review Focus); mit `"2024-06"` und `observed_at_explicit: true` → `2024-06-15`, Basis `explicit`; mit `"Juni 2024"` → Rückfall; ohne `published_at` → Abrufdatum, Basis `fetched`; zweiter Aufruf gleicher Version/Modell/Prompt legt keine zweite Zeile an.
  - `research-assess.test.ts` (`withRollback`, `MockModel` mit Antwort für `assess-page`): Plan enthält nur unbewertete aktuelle Versionen; `assessPages` reicht einen Batch ein; nach `pollBatch` (wie in `lib/pipeline/__tests__/batches.test.ts`) steht je Version eine `page_assessments`-Zeile mit `model`, `prompt_version = 1`, `page_kind`, `berths`; ein Dokument, das bei zwei Kandidaten Treffer ist, wird einmal bewertet (Review Focus); ein PDF-Dokument wird wie HTML bewertet (Review Focus, PDF-Markdown aus dem Archiv).
- [ ] **Step 2: Run tests to verify they fail**
  Run: `npx vitest run lib/domain/research/__tests__/assessment.test.ts lib/pipeline/__tests__/research-assess.test.ts`
  Expected: FAIL
- [ ] **Step 3: Implement** Task, Prompt, Modellkonfiguration, `storeAssessment`, Stufe nach dem Muster von `lib/pipeline/text/classify.ts` (Text = erste `research.assessWords` Wörter des Markdowns, Titel aus der ersten Überschrift), Batch-Eintrag registrieren; ein Ergebnis eines inzwischen geänderten Modells oder einer anderen Prompt-Version wird wie bei der Klassifikation verworfen und geloggt.
- [ ] **Step 4: Run tests to verify they pass** (gleicher Befehl, PASS)
- [ ] **Step 5: Commit** `feat(research): assess every hit page with a model (N1)`

---

### Task 5: Lauf „Recherche“ und Registrierung

**Files:**
- Create: `lib/pipeline/research-run.ts`
- Create: `lib/jobs/handlers/research.ts`
- Modify: `lib/jobs/queues.ts` (`"research.search"`, `"research.fetch"`, `"research.assess"`), `config/queues.json` (je ein Eintrag: search `concurrency 2, retryLimit 2`; fetch `concurrency 8, retryLimit 2, expireInSeconds 1800`; assess `concurrency 2, retryLimit 2`, jeweils `retryDelaySeconds 60, retryBackoff true`), `lib/jobs/stages.ts`, `lib/jobs/registry.ts`
- Test: `lib/pipeline/__tests__/research-run.test.ts`

**Interfaces:**
- Consumes: alle Stufen aus Task 2–4, `startRun`, `enqueueStage`, `RunScopeNotReady`, `requireSubdivision`.
- Produces:
  - `RESEARCH_STAGES = [RESEARCH_SEARCH_STAGE, RESEARCH_FETCH_STAGE, RESEARCH_ASSESS_STAGE] as const`
  - `startResearchRun(db: Db, boss: PgBoss, input: { subdivisionKey: string } | { placeIds: string[] }, triggeredBy: string): Promise<{ id: string }>`: Lauf `kind = "stage"`, Scope `subdivision` bzw. `system`/`"places"`, `params` = Eingabe; wirft `RunScopeNotReady("geo_object_without_place")`, wenn `researchCandidates` leer ist.
  - Stufen-Definitionen `researchSearchStage`, `researchFetchStage`, `researchAssessStage` (wie `discoveryPlaceStage` in `lib/jobs/handlers/discovery.ts`).

- [ ] **Step 1: Write the failing test** (`research-run.test.ts`, `withRollback`, Fake-Transport, `startSiteServer()`, `MockModel`, aufzeichnender `boss` wie in `discovery.test.ts`): Für einen Testlandesteil mit zwei Kandidaten startet `startResearchRun` einen Lauf mit den drei Stufen in Reihenfolge; die Pläne der Stufen nacheinander ausgeführt ergeben Treffer, Dokumente und Bewertungen; ein Landesteil ohne Kandidaten wirft `RunScopeNotReady`; `STAGES` und `QUEUES` enthalten die drei Stufen, `config/queues.json` hat für jede einen Eintrag (`ensureQueues` wirft sonst).
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/pipeline/__tests__/research-run.test.ts`
  Expected: FAIL
- [ ] **Step 3: Implement** Starter, Handler (dünn: Daten mit zod prüfen, Funktion aus Task 2–4 rufen, Ergebnis loggen), Registrierung.
- [ ] **Step 4: Run tests to verify they pass**
  Run: `npx vitest run lib/pipeline/__tests__/research-run.test.ts lib/jobs`
  Expected: PASS
- [ ] **Step 5: Commit** `feat(research): research run with search, fetch and assess stages (N1)`

---

### Task 6: Oberfläche: Recherche starten und Treffer ansehen

**Files:**
- Modify: `app/(admin)/subdivisions/[key]/page.tsx` und `app/(admin)/subdivisions/actions.ts` (Knopf „Recherche starten“ → `startResearchRun({ subdivisionKey })`)
- Modify: `app/(admin)/places/[id]/page.tsx` (neuer Abschnitt bzw. Reiter „Recherche“), Create: `app/(admin)/places/[id]/research-tab.tsx`
- Create: `lib/domain/research/view.ts`
- Test: `lib/domain/research/__tests__/view.test.ts`, `app/(admin)/__tests__/research-tab.test.tsx`

**Interfaces:**
- Produces: `researchView(db: Db, placeId: string): Promise<Array<{ url: string; domain: string; rank: number; purpose: "positive" | "negative"; keyword: string; documentId: string | null; assessment: { pageKind: PageKind; firstHand: boolean; generated: boolean; observedAt: string; berths: string[] } | null }>>` (sortiert: Zweck, dann Rang)

Vor dem Ändern der Seiten die Next-16-Doku zu Server Actions und Seiten in `node_modules/next/dist/docs/` lesen. Tabelle im Reiter: Zweck („Bestätigung“/„Negativsuche“), Rang, Suchbegriff, Link auf die Dokument-Ansicht, Art (deutsche Bezeichnungen über `labels.ts`), „erste Hand“, „SEO/KI“, Beobachtungsdatum, genannte Liegeplätze. Leerer Zustand: „Noch keine Recherche für diesen Liegeplatz.“

- [ ] **Step 1: Write the failing tests**: `researchView` liefert für einen Kandidaten mit einem bewerteten und einem unbewerteten Treffer zwei Zeilen in der Sortierung oben, die unbewertete mit `assessment: null`; `research-tab.test.tsx` rendert Leerzustand und eine Zeile mit „erste Hand“.
- [ ] **Step 2: Run tests to verify they fail**
  Run: `npx vitest run lib/domain/research/__tests__/view.test.ts "app/(admin)/__tests__/research-tab.test.tsx"`
  Expected: FAIL
- [ ] **Step 3: Implement** View, Reiter, Knopf und Action (Fehler `RunScopeNotReady` als deutsche Meldung wie die bestehenden Run-Starts in `app/(admin)/_components/run-start.ts`).
- [ ] **Step 4: Run tests to verify they pass** (gleicher Befehl, PASS), dann `npm run build`
- [ ] **Step 5: Commit** `feat(research): start research per subdivision and show hits per place (N1)`

---

### Task 7: Probelauf Saronischer Golf (Messung, kein Code)

**Files:**
- Modify: `docs/pilot/pruefung/befunde.md` (neue Befunde), Create: `docs/pilot/neuausrichtung/n1-probelauf.md`

- [ ] **Step 1:** Worker mit neuem Code starten, im Admin für den Landesteil des Saronischen Golfs (`GR-I`) „Recherche starten“.
- [ ] **Step 2:** Nach Ende messen und in `n1-probelauf.md` eintragen: Kandidaten, Anfragen (gestellt/wiederverwendet/fehlgeschlagen), Treffer je Kandidat (Median, Max), geholte Seiten nach Ergebnis, Bewertungen nach `page_kind`, Anteil `first_hand`, Anteil `generated`, Kosten je Kandidat nach Dienst (`external_calls`). SQL der Messung mit ins Dokument.
- [ ] **Step 3:** Stichprobe 30 bewerteter Seiten von Hand gegen die Bewertung prüfen (Art, erste Hand, SEO/KI) und Abweichungen als Befunde eintragen; Navily-Werte nicht ins Repo schreiben.
- [ ] **Step 4: Commit** `docs(research): N1 trial run in the Saronic Gulf`

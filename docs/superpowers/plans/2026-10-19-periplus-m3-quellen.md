# Periplus M3 – Quellen und Archiv Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stufen 4 (Quellenfindung) und 5 (Fetch) für das Pilotgebiet als Jobs: SERP auf Revier- und Kachelebene, Linkgraph, Quellenvorschläge mit Review `source_approval`, Crawler mit Regeln und robots.txt, Konvertierung nach Markdown (Jina, Firecrawl, lokal mit Playwright-Fallback, PDF), versioniertes Archiv in S3 mit Diff, Chunks mit Übernahme, 15-Wort-Schindeln und Voyage-Embeddings, Wikivoyage als vorab freigegebene Quelle, Seiten „Quellen“, „Dokument“ und „Konverter-Vergleich“ – plus die Werkzeuge für die Abnahme (Whitelist 20–40, voller Crawl, Konverter- und PDF-Entscheidung dokumentiert, Kosten je Quelle).

**Architecture:** Drei Läufe auf der vorhandenen Run-Mechanik: „Quellenfindung“ (`discovery.area → discovery.tile → discovery.propose`), „Crawl“ (`fetch.source → fetch.url → embed.chunks`, Wikivoyage davor mit `sources.wikivoyage`) und „Konverter-Vergleich“ (`compare.converters`). `fetch.url` entdeckt Links und hängt neue Jobs an die laufende Stufe (`extendStage`), damit ein Crawl ein Lauf bleibt. Fachregeln (Crawl-Regeln, URL-Normalisierung, robots.txt, Vorschläge, Normalisierung, Chunking, Übernahme, Archiv-Schreiben) liegen in `lib/domain`, Abläufe in `lib/pipeline`, alle externen Dienste (DataForSEO, Jina, Firecrawl, Voyage, Wikidata, Claude-PDF, `pdftotext`, Playwright) hinter `lib/adapters`. Die HTTP-Transportschicht aus M1 wird um Header, Statuslisten, Kosten und Budget erweitert; Tests laufen gegen Fixtures und einen lokalen Test-HTTP-Server.

**Tech Stack:** wie M2 (Next.js 16.4.2, React 19.3, Drizzle 0.45, pg-boss 12, zod 4, Vitest 5, Playwright 1.64, pgvector) plus `tldts` (Public Suffix List), `robots-parser`, `linkedom` + `@mozilla/readability` + `turndown` + `@joplin/turndown-plugin-gfm` (lokaler Konverter), `playwright` 1.64 als Laufzeit-Abhängigkeit (Renderer im Worker, Image hat Chromium), `franc` (Sprache), `diff` (Unified Diff), `pdf-lib` (PDF-Seiten trennen), `react-markdown` + `remark-gfm` (Anzeige); Systempaket `poppler-utils` (`pdftotext`) im Worker-Image und in CI.

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-05-quellen-archiv-design.md` (primär), `…-02-datenmodell-design.md` (`sources`, `documents`, `document_versions`, `chunks`, `text_shingles`, Tabellenklassen), `…-09-admin-ui-design.md` (`/sources`, `/documents/[id]`, `/compare/converters`, Review `source_approval`, `failed_job` „Quelle pausieren“), `…-01-fundament-design.md` (Queues, Rate-Limits, Budgets, Adapter, Modell-Schnittstelle), `…-08-liefervertrag-api-design.md` (nur 15-Wort-Regel), `…-03-gazetteer-design.md` (Wikivoyage, Stufe 1 Schritt 4), Gesamtdesign `…-periplus-design.md` (Roadmap M3, Offene Punkte). Fachlich maßgebend: `.idea/datendienst-spec.md` (Stufen 4 und 5, Änderungserkennung Ebene 1, Technologie, Rechtliches). Baut auf dem M2-Plan `2026-10-19-periplus-m2-geometrie.md` auf (Queues/Stufen-Muster, `computations`/`facts`, `fixtures-record.ts`).

## Global Constraints

- Alle Global Constraints aus M0, M1 und M2 gelten weiter (Next 16.4.2, Next-Doku in `node_modules/next/dist/docs/` vor Routen, `proxy.ts`, `next.config.ts`; kein `console.*`; Englisch im Code, Deutsch in der UI; Tests gegen `db-test` und lokales S3; kein Netz in Tests, KI über `MockModel`; Route-Policy je Route; `external_calls` je Aufruf; Schwellen in `config/`).
- User-Agent jedes Abrufs: `Periplus/0.1 (+mailto:<CONTACT_EMAIL>)` (bestehende Funktion in `lib/adapters/http.ts`), auch im Playwright-Renderer.
- „robots.txt wird immer beachtet (auch für `startUrls`) und je Lauf neu gelesen; ein ausdrückliches Crawl-Verbot setzt die Quelle auf `paused` mit Hinweis.“ Auswertung nach RFC 9309: 4xx = alles erlaubt, 5xx/nicht erreichbar = nichts erlaubt (Job wird wiederholt).
- Crawl-Regeln exakt wie Spec 05 (`startUrls`, `allow`, `deny`, `maxDepth` 3, `maxPages` 500, `ratePerMinute` 20, `render` `auto`, `converter` `auto`, `pdf` true) plus optional `boilerplateSelectors` (Spec: „Boilerplate-Entfernung je Quelle über optionale CSS-Selektoren in den Crawl-Regeln“).
- `render: auto` = Playwright, „wenn der HTTP-Text < 500 Zeichen Hauptinhalt hat“.
- URL-Normalisierung: „Kleinschreibung von Host, ohne Fragment, ohne Tracking-Parameter (`utm_*`, `fbclid` …), sortierte Query“.
- 304 oder gleicher Inhalt → nur `last_checked_at`. 404/410 → `consecutive_gone + 1`; bei 2 → `documents.status = gone`.
- S3-Schlüssel: `serp/<YYYY-MM-DD>/<hash>.json`; `archive/<document_id>/<fetched_at ISO>_<hash8>.raw.<ext>`, `.md`, `.diff`; Uploads `uploads/<sha256>.pdf`, Dokument-URL `upload://<sha256>`.
- `content_hash` = SHA-256 des normalisierten Markdown; eindeutig `(document_id, content_hash)`.
- Chunks: „Zerlegung an Überschriften und Absätzen, Ziel 500 Wörter, harte Grenze 800, Überlappung 1 Absatz“; unveränderte Chunks mit `carried_from_chunk_id` übernommen.
- SERP: DataForSEO Google Organic Live/Regular, Tiefe 20; gleiche Query innerhalb von 30 Tagen nicht erneut; Pilotbudget < 500 Aufrufe.
- Vorschlag: neue Domain mit ≥ 3 SERP-Treffern oder ≥ 2 verlinkenden freigegebenen Quellen; Aggregation nach registrierbarer Domain (Public Suffix List); bekannte und abgelehnte Domains nie erneut. Navily-Domains werden nie vorgeschlagen (Grundprinzip 9).
- Gewichte je Typ: `pilot_guide` 0,9, `authority` 0,9, `marina` 0,8, `trip_report` 0,6, `travel_guide` 0,5, `forum` 0,4.
- Kachel-Suchbegriffe: Inseln, Küstenorte, Buchten mit Namen und (Ankerfläche ≥ 20.000 m² oder ≥ 2 Namen aus Wikidata).
- Embeddings: Voyage, Modell und Dimension aus `config/embeddings.json` (Start `voyage-3.5`, 1024); HNSW-Index (`vector_cosine_ops`) auf `chunks.embedding`.
- Konverter-Vergleich: 50 Seiten aus 10 Quellen, je `jina`, `firecrawl`, `local`; Entscheidung in `config/fetch.json`.
- Stabile Tabellen `sources`, `documents` werden nie gelöscht; `document_versions`, `chunks` sind nur anfügend (`chunks` erlaubt nur `embedding`, `embedding_model`).
- Testdaten mit stabilen Zeilen in `withRollback`; Tests, die committen müssen, nutzen Domains `*.test.invalid` mit eigener UUID und zählen nie DB-weit.

## Review Focus

1. **Seite kehrt zu einem früheren Inhalt zurück (A → B → A) oder derselbe Inhalt wird zweimal gleichzeitig gespeichert** (Wiederholung nach Timeout, zwei Läufe): die Eindeutigkeit `(document_id, content_hash)` darf keinen Job scheitern lassen; erwartet: keine neue Version, `current_version_id` zeigt auf A, genau eine Version je Inhalt. → Task 12 Tests `A → B → A …`, `two concurrent stores …`.
2. **Kleine Änderung in langem Text** (ein Absatz in Abschnitt 2 geändert): alle Chunks der übrigen Abschnitte werden übernommen, nur der geänderte Abschnitt geht neu in Stufe 6; ein verschobener Chunk-Schnitt darf nicht das ganze Dokument „neu“ machen. → Task 9 Test `editing one paragraph in section 2 carries every chunk of sections 1 and 3`.
3. **robots.txt-Sonderfälle**: eigene Gruppe für `Periplus` neben `*`, längste Regel gewinnt, 404 (alles erlaubt), 503 (nichts, Wiederholung), `Disallow: /` (Quelle `paused`), gesperrte `startUrls`. → Task 4 Tests, Task 13 Test `robots disallow-all pauses the source …`.
4. **Langsame Domain** (`Crawl-delay: 30`, 200 URLs, 8 parallele Worker): kein `fetch.url`-Job darf am Rate-Limit seine Versuche verbrauchen. → Task 2 Test `a call 240 s behind the bucket succeeds with maxRateWaitMs 600000`, Task 13 Test `effective rate honours crawl-delay`.
5. **Fremdes HTML aus dem Archiv im Admin-Ursprung** (Rohdatei-Link, gerendertes Markdown mit `<script>`/`javascript:`): darf kein Skript in der Admin-Sitzung ausführen. Erwartet: Rohdatei als Anhang mit `Content-Security-Policy: sandbox` und `nosniff`, Markdown ohne rohes HTML und ohne `javascript:`-Links. → Task 17 Tests.

---

## File Structure

```
lib/db/schema/sources.ts                 sources, documents, document_versions, chunks, text_shingles, crawl_frontier,
                                         serp_queries, serp_results, outlinks, converter_samples, converter_outputs (+ Enums)
lib/db/schema/ops.ts                     + external_calls.source_id
drizzle/00NN_*.sql                       generiert + handgeschrieben (Trigger, History, FKs, HNSW, trgm)
config/source-types.json, config/discovery.json, config/fetch.json,
config/embeddings.json, config/sources-whitelist.json
config/prompts/pdf.to_markdown/v1.md, config/models.json (+ Task pdf.to_markdown)
lib/config/{schemas,index}.ts            + sourceTypes, discovery, fetch, embeddings, whitelist
lib/env.ts                               + VOYAGE_API_KEY, DATAFORSEO_LOGIN/PASSWORD, JINA_API_KEY, FIRECRAWL_API_KEY (optional)
lib/adapters/http.ts                     Header, finalUrl, okStatuses, rateKey, maxRateWaitMs, budget, costOf, sourceId
lib/adapters/dataforseo.ts, lib/adapters/voyage.ts, lib/adapters/wikidata.ts (+ fetchSitelinks)
lib/adapters/fetch/{types,local,browser,jina,firecrawl,index}.ts
lib/adapters/pdf/{pdftotext,claude,split,index}.ts
lib/ai/{types,anthropic,mock}.ts         + Anhänge (PDF) je Task; lib/ai/tasks/pdf-to-markdown.ts
lib/domain/sources/{crawl-rules,urls,robots,store}.ts
lib/domain/discovery/{queries,serp,proposals}.ts
lib/domain/documents/{normalize,language,metadata,links,shingles,chunker,carry,structured,pdf-layout,store}.ts
lib/domain/runs.ts                       + extendStage
lib/domain/review-decisions.ts, lib/domain/review-view.ts   + source_approval, failed_job/pause_source
lib/domain/{sources-view,document-view,converter-comparison}.ts
lib/pipeline/discovery.ts, lib/pipeline/fetch/{source,url,run}.ts, lib/pipeline/embed.ts,
lib/pipeline/sources/wikivoyage.ts, lib/pipeline/compare-converters.ts
lib/jobs/{queues,stages,registry,worker}.ts, config/queues.json
lib/jobs/handlers/{discovery,fetch,embed,wikivoyage,compare}.ts
app/(admin)/sources/{page.tsx,actions.ts,[id]/page.tsx,[id]/actions.ts}
app/(admin)/documents/[id]/{page.tsx,raw/[versionId]/route.ts}
app/(admin)/compare/converters/{page.tsx,actions.ts}
app/(admin)/_components/{archive-markdown.tsx,crawl-rules-fields.tsx,labels.ts,nav.tsx}
app/(admin)/review/[id]/page.tsx, app/(admin)/tiles/[id]/{page.tsx,actions.ts}, app/(admin)/settings/page.tsx
next.config.ts                           serverActions.bodySizeLimit, proxyClientMaxBodySize
docker/worker.Dockerfile, .github/workflows/ci.yml   poppler-utils
scripts/{fixtures-record,converter-report,pdf-compare,check-sources}.ts
test/site-server.ts                      lokaler Test-HTTP-Server
test/fixtures/{http/dataforseo,http/jina,http/firecrawl,http/voyage,http/wikidata-sitelinks,robots,html,pdf}/**
docs/runbook.md, docs/pilot/{m3-abnahme,m3-konverter-vergleich,m3-pdf-vergleich}.md
```

---

### Task 1: Archiv-Schema

**Files:**
- Create: `lib/db/schema/sources.ts`, Migration (generiert) + handgeschrieben `drizzle/00NN_sources_triggers.sql`
- Modify: `lib/db/schema/index.ts`, `lib/db/schema/ops.ts` (`external_calls.source_id`)
- Test: `lib/db/__tests__/sources-schema.test.ts`

**Interfaces:**
- Consumes: `forbid_mutation()`, `forbid_delete()`, `record_history()` (Migrationen 0002/0006), `runs`, `restricted_areas`.
- Produces:
  - Enums: `doc_type` (`pilot_guide, trip_report, forum, marina, authority, dataset, travel_guide, other`; TS `DocType`, `DOC_TYPES`; gilt für `sources.type` und `document_versions.doc_type`), `source_status` (`proposed, approved, rejected, paused`), `source_format` (`html, pdf, table, geodata`), `change_rate` (`high, normal, static`), `source_origin` (`serp, linkgraph, whitelist, manual`), `document_status` (`active, gone`), `observed_at_basis` (`explicit, published, fetched`), `frontier_status` (`queued, fetched, skipped, failed`).
  - `sources` (stabil): `id`, `domain text not null` (registrierbare Domain), `name`, `type doc_type not null`, `format` (Default `html`), `languages text[]`, `weight real` (Check 0–1), `status`, `status_reason`, `crawl_rules jsonb not null`, `change_rate` (Default `normal`), `origin`, `valid_from`, `valid_to`, `created_at`, `updated_at`; partiell eindeutig `domain where valid_to is null`; `forbid_delete`; History `record_history('type,weight,status,crawl_rules,change_rate,valid_to')` → `sources_history`.
  - `documents` (stabil): `id`, `source_id → sources`, `url`, `url_normalized` (eindeutig), `doc_type`, `status` (Default `active`), `consecutive_gone int default 0`, `first_seen_at`, `last_checked_at`, `etag`, `last_modified`, `current_version_id → document_versions` (nullable, FK in der handgeschriebenen Migration), `valid_from`, `valid_to`, `created_at`, `updated_at`; `forbid_delete`; History `('status,url_normalized,valid_to')`.
  - `document_versions` (nur anfügend, `forbid_mutation('')`): `id`, `document_id`, `fetched_at`, `content_hash`, `raw_hash`, `raw_key`, `md_key`, `diff_key` (nullable), `content_type`, `final_url`, `language`, `published_at date`, `observed_at date not null`, `observed_at_basis`, `doc_type`, `converter text not null`, `simulated bool default false`, `char_count int`, `run_id → runs`, `created_at`; eindeutig `(document_id, content_hash)`.
  - `chunks` (nur anfügend, `forbid_mutation('embedding,embedding_model')`): `id`, `document_version_id`, `ordinal`, `text`, `text_normalized`, `text_hash`, `heading`, `char_start`, `char_end`, `word_count`, `embedding vector(1024)` (= `config/embeddings.json` `dimension`, Task 14 prüft beim Start), `embedding_model`, `carried_from_chunk_id → chunks`, `created_at`; eindeutig `(document_version_id, ordinal)`; Index `text_hash`; GIN `gin_trgm_ops` auf `text_normalized`; `chunks_embedding_hnsw` `USING hnsw (embedding vector_cosine_ops)`.
  - `text_shingles` (Arbeitszustand): `shingle_hash bigint`, `chunk_id → chunks`, PK `(shingle_hash, chunk_id)`.
  - `crawl_frontier` (Arbeitszustand): `id`, `source_id`, `url`, `url_normalized`, `depth`, `status`, `reason`, `discovered_at`, `last_run_id`, `updated_at`; eindeutig `(source_id, url_normalized)`.
  - `external_calls.source_id uuid` (ohne FK, Index `(source_id, at)`); FK `restricted_areas.source_id → sources`.
  - (`serp_*`, `outlinks`, `converter_*` legen die Tasks 5, 6 und 18 an, wo sie gebraucht werden.)

- [ ] **Step 1: Failing tests**

```ts
it.each(["document_versions", "chunks"])("%s rejects DELETE", …);          // /is append-only/
it("chunks allow setting the embedding but not changing the text", …);   // update embedding ok; update text → /append-only/
it.each(["sources", "documents"])("%s cannot be deleted", …);
it("changing a source's weight writes sources_history", …);
it("(document_id, content_hash) is unique", …);
it("only one valid source per domain", …);
it("chunks.embedding is vector(1024) with an hnsw index", async () => {
  // format_type(atttypid, atttypmod) = 'vector(1024)'; pg_indexes.indexdef like '%hnsw%vector_cosine_ops%'
});
```

- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/sources-schema.test.ts` → FAIL (Tabellen fehlen).
- [ ] **Step 3: Implementieren.** Drizzle-`vector("embedding", { dimensions: 1024 })` und `.using("hnsw", t.embedding.op("vector_cosine_ops"))`; `npm run db:generate`; Trigger, History-Tabellen (wie `0008_geo_history_fixes.sql`), zirkulärer FK und FK auf `restricted_areas` in der handgeschriebenen Migration mit `--> statement-breakpoint` und Journal-Eintrag. Alle Tests in `withRollback`.
- [ ] **Step 4: Run** `npx vitest run lib/db` → PASS.
- [ ] **Step 5: Commit** `feat(db): sources, documents, versions, chunks with append-only rules and hnsw`

### Task 2: HTTP-Transport für Crawl und bezahlte Dienste

**Files:**
- Modify: `lib/adapters/http.ts`, `lib/env.ts`, `.env.example`
- Create: `test/site-server.ts`
- Test: `lib/adapters/__tests__/http.test.ts`, `test/__tests__/site-server.test.ts`

**Interfaces:**
- Consumes: `takeToken`, `recordExternalCall`, `assertWithinBudget`, `BudgetService`, `external_calls.source_id` (Task 1).
- Produces:
  - `HttpRequest` + `rateKey?: string` (Bucket `http:<rateKey ?? service>`), `maxRateWaitMs?: number` (Default 60 000), `okStatuses?: number[]` (diese Status werden zurückgegeben statt geworfen), `budget?: BudgetService` (`assertWithinBudget` vor Token und Aufruf), `costOf?: (res: HttpResponse) => { units: number; unit: string; costEur: number }` (Default 1 `request`, 0 EUR), `meta?: Record<string, unknown>`.
  - `HttpResponse` + `headers: Record<string, string>` (Schlüssel klein), `finalUrl: string`; `makeResponse(status, body, init?: { headers?: Record<string, string>; finalUrl?: string })`.
  - `CallContext` + `sourceId?: string` → `external_calls.source_id`.
  - Fixture-Datei optional `headers`, `finalUrl` (alte Fixtures bleiben gültig); `fetchTransport` mit `redirect: "follow"`.
  - Env optional: `VOYAGE_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`.
  - `type SiteResponse = { status?: number; body: string | Uint8Array; headers?: Record<string, string> }`; `startSiteServer(): Promise<{ origin: string; set(path: string, res: SiteResponse | null): void; requests: Array<{ path: string; headers: Record<string, string> }>; close(): Promise<void> }>` – `node:http` auf `127.0.0.1:0`; `null` = 404; Antwort mit `etag`-Header und passendem `If-None-Match` → 304.

- [ ] **Step 1: Failing tests**

```ts
it("okStatuses returns a 404 instead of throwing and records the call", …);   // res.status 404, one external_calls row
it("costOf decides units and cost of the recorded call", …);                 // units 1234, unit "tokens", cost_eur 0.000025
it("an exhausted budget throws BudgetExceeded before any request", …);       // transport spy not called
it("rateKey separates the buckets of two domains of the same service", …);
it("a call 240 s behind the bucket succeeds with maxRateWaitMs 600000", async () => {
  // rate_limits row 'http:domain:slow.test.invalid' tokens = -7 at ratePerMinute 2 → retryAfter 240000 ms
  // fake now/sleep: resolves, total slept 240000; same setup with default maxRateWaitMs → RetryableHttpError
});
it("fixtures replay headers and final url", …);
it("sourceId lands in external_calls.source_id", …);
// site-server.test.ts
it("serves 304 for a matching If-None-Match and 404 for a removed path", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/adapters/__tests__/http.test.ts test/__tests__/site-server.test.ts` → FAIL.
- [ ] **Step 3: Implementieren.** Bestehende Adapter (Overpass, Wikidata, GeoNames, EMODnet) bleiben unverändert lauffähig; `costOf` läuft nur bei einer Antwort, ein Transportfehler wird wie bisher mit 0 EUR erfasst.
- [ ] **Step 4: Run** `npx vitest run lib/adapters test` → PASS.
- [ ] **Step 5: Commit** `feat(http): headers, status passthrough, per-domain rate keys, budgets and costs per call`

### Task 3: Konfiguration, Crawl-Regeln, URLs

**Files:**
- Create: `config/source-types.json`, `config/discovery.json`, `config/fetch.json`, `config/embeddings.json`, `config/sources-whitelist.json`, `lib/domain/sources/crawl-rules.ts`, `lib/domain/sources/urls.ts`
- Modify: `lib/config/schemas.ts`, `lib/config/index.ts`, `package.json` (`tldts`)
- Test: `lib/config/__tests__/config.test.ts`, `lib/domain/__tests__/crawl-rules.test.ts`, `lib/domain/__tests__/urls.test.ts`

**Interfaces:**
- Consumes: `DOC_TYPES`, `ChangeRate` (Task 1).
- Produces:
  - `crawlRulesSchema` (zod strict, mit Defaults): `startUrls: url[]` (`[]`), `allow: string[]` (`[]`, jeder Eintrag muss `new RegExp` überstehen), `deny: string[]` (`[]`), `maxDepth` int 0–10 (3), `maxPages` int 1–5000 (500), `ratePerMinute` 1–120 (20), `render` `never|always|auto` (`auto`), `converter` `auto|jina|firecrawl|local` (`auto`), `pdf` bool (true), `boilerplateSelectors: string[]` (`[]`); `type CrawlRules`; `DEFAULT_CRAWL_RULES = crawlRulesSchema.parse({})`.
  - `urlAllowed(url: string, rules: CrawlRules, sourceDomain: string): { ok: true } | { ok: false; reason: "other_domain" | "not_allowed" | "denied" | "pdf_disabled" }` – Regexe gegen `pathname + search`; leeres `allow` = alles; `deny` gewinnt; `.pdf` bei `pdf: false` → `pdf_disabled`.
  - `normalizeUrl(url: string, trackingParams: string[]): string | null` – nur http(s); Host klein (WHATWG-`URL`, IDN als Punycode), Standard-Port weg, Fragment weg, Tracking-Parameter weg (Einträge mit `*` als Präfix-Muster), Query nach Schlüssel, dann Wert sortiert, leere Query weg; Pfad unverändert.
  - `registrableDomain(url: string): string` – `tldts.getDomain(host) ?? host`.
  - `SourceTypesConfig = Record<DocType, { weight: number; changeRate: ChangeRate }>`: Spec-Gewichte; dazu `dataset` 0,9, `other` 0,3; `changeRate` `marina`/`forum` `high`, `pilot_guide`/`dataset` `static`, übrige `normal`.
  - `DiscoveryConfig`: `serp { endpoint "https://api.dataforseo.com/v3/serp/google/organic/live/regular", depth 20, reuseDays 30, maxQueriesPerRun 240, costPerQueryEur 0.0019, ratePerMinute 30, timeoutMs 120000 }`; `templates { area: [{ template "Törnbericht {name}", lang "de", locationCode 2276 }, { "Revierführer {name}", de, 2276 }, { "{name} anchorages", en, 2826 }], tile: [{ "Ankerplatz {name}", de, 2276 }, { "anchorage {name}", en, 2826 }, { "αγκυροβόλιο {name}", el, 2300 }] }`; `bay { minAnchorAreaM2 20000, minWikidataNames 2 }`; `proposals { minSerpHits 3, minLinkingSources 2, maxHitsInContext 20, ignoreDomains ["navily.com", "google.com", "youtube.com", "facebook.com", "instagram.com", "pinterest.com", "wikipedia.org", "tripadvisor.com", "tripadvisor.de", "tripadvisor.co.uk", "booking.com", "amazon.com", "amazon.de"], typeHints: [{ pattern, type }] (Task 6), defaultType "trip_report" }`.
  - `FetchConfig`: `defaultConverter "local"`, `converterBySource {}`, `decision { status "provisional", note "Vorläufig: lokaler Konverter bis zur Auswertung des 50-Seiten-Vergleichs." }`, `renderMinMainChars 500`, `timeoutMs 30000`, `maxRawBytes 20971520`, `maxRateWaitMs 600000`, `goneAfter 2`, `trackingParams ["utm_*", "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"]`, `languages { deu "de", eng "en", ell "el", ita "it", hrv "hr", fra "fr" }`, `chunk { targetWords 500, maxWords 800, maxOverlapWords 200 }`, `pdf { extractor "pdftotext", modelFallback true, unreadableMinChars 200, maxModelPagesPerDocument 40 }`, `jina { endpoint "https://r.jina.ai/", eurPerMTok 0.02, timeoutMs 60000 }`, `firecrawl { endpoint "https://api.firecrawl.dev/v2/scrape", eurPerCredit 0.0047, timeoutMs 60000 }`.
  - `EmbeddingsConfig`: `{ provider "voyage", endpoint "https://api.voyageai.com/v1/embeddings", model "voyage-3.5", dimension 1024, batchSize 64, eurPerMTok 0.055, ratePerMinute 300, timeoutMs 60000 }`.
  - `WhitelistConfig = Array<{ domain; name; type: DocType; changeRate: ChangeRate; crawlRules: Partial<CrawlRules> }>` mit genau einem Eintrag `wikivoyage.org` („Wikivoyage“, `travel_guide`, `normal`, Regeln `{ allow: ["^/wiki/[^:]+$"], maxDepth: 0, ratePerMinute: 30, render: "never", converter: "local", pdf: false, boilerplateSelectors: [".mw-editsection", "#toc", ".navbox", "#mw-navigation", "#footer", ".noprint"] }`).
  - `AppConfig` + `sourceTypes`, `discovery`, `fetch`, `embeddings`, `whitelist`. Preise und das Voyage-Modell vor dem Aufzeichnen der Fixtures gegen die Anbieter-Doku prüfen; Abweichungen in der Commit-Nachricht.

- [ ] **Step 1: Failing tests**

```ts
expect(normalizeUrl("HTTPS://Example.COM:443/a/b?utm_source=x&b=2&a=1#top", tp)).toBe("https://example.com/a/b?a=1&b=2");
expect(normalizeUrl("http://example.com", tp)).toBe("http://example.com/");
expect(normalizeUrl("https://x.gr/p?fbclid=1", tp)).toBe("https://x.gr/p");
expect(normalizeUrl("mailto:a@b.c", tp)).toBeNull();
expect(registrableDomain("https://de.wikivoyage.org/wiki/Ägina")).toBe("wikivoyage.org");
expect(registrableDomain("https://www.sailing.co.uk/x")).toBe("sailing.co.uk");
expect(registrableDomain("http://127.0.0.1:8080/")).toBe("127.0.0.1");
it("an invalid allow regex is rejected", …);           // allow ["(unclosed"] → ZodError mentioning allow.0
it("deny wins over allow", …);                          // allow ^/greece/, deny /tag/ → denied for /greece/tag/x
it("the source type weights match spec 05", …);         // pilot_guide 0.9 … forum 0.4
it("config/fetch.json starts with a provisional local converter", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/config lib/domain/__tests__/{crawl-rules,urls}.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(sources): crawl rules, url normalization, source and fetch configuration`

### Task 4: robots.txt

**Files:**
- Create: `lib/domain/sources/robots.ts`, `test/fixtures/robots/{ua-group.txt,disallow-all.txt,longest-match.txt,crawl-delay.txt}`
- Modify: `package.json` (`robots-parser`)
- Test: `lib/domain/__tests__/robots.test.ts`

**Interfaces:**
- Consumes: `httpCall`, `Transport`, `CallContext`, `Archive`.
- Produces:
  - `ROBOTS_AGENT = "Periplus"`.
  - `type RobotsPolicy = { origin: string; status: "parsed" | "allow_all"; text: string | null; crawlDelaySec: number | null; sitemaps: string[]; isAllowed(url: string): boolean }`
  - `parseRobots(origin: string, text: string | null): RobotsPolicy` – `null` → `allow_all`; Text über 500 KiB wird abgeschnitten (RFC 9309).
  - `fetchRobots(transport, origin: string, ctx: CallContext): Promise<RobotsPolicy>` – GET `<origin>/robots.txt`, Service `robots`, `okStatuses` 400–499 → `allow_all`; 5xx/Netzfehler → `RetryableHttpError` aus `httpCall`.
  - `robotsForRun(db, archive, transport, origin: string, runId: string, ctx): Promise<RobotsPolicy>` – liest `robots/<host>/<runId>.json` (`{ status, text }`) aus dem Archiv, sonst `fetchRobots` und ablegen (je Lauf neu gelesen, je Host einmal; doppelte Abrufe bei Gleichzeitigkeit sind harmlos).
  - `type RobotsSummary = { status: "parsed" | "allow_all"; disallowAll: boolean; blockedStartUrls: string[]; crawlDelaySec: number | null; sitemaps: number }`; `robotsSummary(policy, startUrls: string[]): RobotsSummary`.
  - `explicitBan(policy, startUrls: string[]): boolean` – `!isAllowed(origin + "/")` oder alle `startUrls` gesperrt (bei leerer Liste nur die erste Bedingung).
  - `effectiveRate(rulesRate: number, crawlDelaySec: number | null): number` – `max(1, min(rulesRate, floor(60 / crawlDelaySec)))`.

- [ ] **Step 1: Failing tests**

```ts
it("a Periplus group wins over *", …);                  // ua-group.txt: * Disallow /, Periplus Allow / → allowed
it("the longest matching rule wins", …);                // Disallow /a, Allow /a/b → /a/b/c allowed, /a/x not
it("Disallow: / for * is an explicit ban", …);          // explicitBan true; summary.disallowAll true
it("blocked start urls are listed", …);
it("404 means allow all", …);                           // fixture transport 404 → status allow_all
it("503 is retryable", …);                              // rejects RetryableHttpError
it("crawl-delay 10 is read and limits the rate", …);    // crawlDelaySec 10; effectiveRate(20, 10) === 6; effectiveRate(20, 120) === 1
it("robots are read once per host and run", …);         // second call same runId → no transport call
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sources): robots.txt per RFC 9309, cached per host and run`

### Task 5: DataForSEO und Suchbegriffe

**Files:**
- Create: `lib/adapters/dataforseo.ts`, `lib/domain/discovery/queries.ts`, `lib/domain/discovery/serp.ts`, Migration (generiert)
- Modify: `lib/db/schema/sources.ts` (+ `serp_queries`, `serp_results`), `scripts/fixtures-record.ts` (`--serp`)
- Test: `lib/adapters/__tests__/dataforseo.test.ts`, `lib/domain/__tests__/discovery-queries.test.ts`, `lib/domain/__tests__/serp.test.ts`, `test/fixtures/http/dataforseo/**`

**Interfaces:**
- Consumes: `httpCall` (Task 2), `DiscoveryConfig`, `normalizeUrl`, `registrableDomain`, `geo_names`, `tile_geo_objects`, `validAt`, M2-Tabellen `computations`/`facts` (Fact `anchor_area` `{ areaM2 }`).
- Produces:
  - `serp_queries` (Arbeitszustand): `id`, `keyword`, `language_code`, `location_code`, `depth`, `level` (`area|tile`), `scope_id`, `raw_key`, `run_id`, `fetched_at`; Index `(keyword, language_code, location_code, fetched_at desc)`. `serp_results`: `id`, `serp_query_id`, `rank`, `url`, `url_normalized`, `domain`, `title`, `snippet`; Index `domain`.
  - `type SerpItem = { rank: number; url: string; title: string; snippet: string }`
  - `searchOrganic(transport, q: { keyword: string; languageCode: string; locationCode: number }, ctx: CallContext, cfg: DiscoveryConfig["serp"]): Promise<{ raw: Uint8Array; items: SerpItem[] }>` – POST `[{ keyword, language_code, location_code, depth }]`, Basic-Auth aus Env, `budget "dataforseo"`, `costOf` 1 `query` × `costPerQueryEur`; nur `type === "organic"`, `rank = rank_absolute`; Task-Status `40xxx` → `HttpError`, `50xxx` → `RetryableHttpError`.
  - `type DiscoveryQuery = { keyword: string; languageCode: string; locationCode: number; level: "area" | "tile"; scopeId: string; priority: number }`
  - `areaQueries(db, areaKey: string, cfg: DiscoveryConfig): Promise<DiscoveryQuery[]>` – Namen des Revier-Geo-Objekts (`config_key`) je Template-Sprache (bevorzugter gültiger Name); fehlt die Sprache, entfällt die Query.
  - `tileQueries(db, tileId: string, cfg: DiscoveryConfig): Promise<DiscoveryQuery[]>` – gültige Objekte der Kachel: `island`/`islet`/`archipelago` (Priorität 1), `settlement` (2), benannte `bay` mit jüngstem `anchor_area`-Fact `areaM2 ≥ minAnchorAreaM2` oder ≥ `minWikidataNames` gültigen Namen mit `origin = 'wikidata'` (3); dedupliziert über `(keyword, languageCode, locationCode)`.
  - `capQueries(queries: DiscoveryQuery[], max: number): { kept: DiscoveryQuery[]; dropped: number }` – Ordnung `area` vor `tile`, dann `priority`, dann `keyword`.
  - `runQuery(db, q: DiscoveryQuery, deps: { transport: Transport; archive: Archive; now?: Date }, ctx: CallContext): Promise<{ queryId: string; reused: boolean; results: number }>` – gleiche `(keyword, language_code, location_code)` mit `fetched_at` innerhalb `reuseDays` → `reused`, kein Aufruf; sonst Aufruf, Roh-Antwort nach `serp/<YYYY-MM-DD>/<sha256(keyword|lang|location)>.json`, dann Zeilen. Kachel-Queries laufen mit `ctx.tileId`, damit die Kosten je Kachel sichtbar sind.
  - `scripts/fixtures-record.ts --serp --area saronic --limit 3` zeichnet höchstens 3 echte Queries auf.

- [ ] **Step 1: Failing tests**

```ts
it("parses only organic items with absolute ranks", …);           // fixture: 20 organic + 1 people_also_ask → 20 items, rank 1..20
it("a 40501 task status is not retried", …);                      // HttpError
it("a bay qualifies by anchor area or two wikidata names", async () => withRollback(async (tx) => {
  // tile outside the pilot box; bay A anchor_area 25000 → included; bay B 15000 + 1 wikidata name → excluded;
  // bay C no computation + 2 wikidata names (de, en) → included; island priority 1
}));
it("a language without a name yields no query", …);
it("capQueries keeps area queries first and reports the rest", …);  // 250 queries, max 240 → dropped 10, all area kept
it("the same query within 30 days is reused without a call", …);    // transport throws if called; reused true
it("the raw answer is archived under serp/<day>/<hash>.json", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Fixtures mit `fixtures:record -- --serp` aufzeichnen (≤ 3 Aufrufe). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(discovery): dataforseo adapter, area and tile queries with 30-day reuse`

### Task 6: Quellenvorschläge und Discovery-Lauf

**Files:**
- Create: `lib/domain/sources/store.ts`, `lib/domain/discovery/proposals.ts`, `lib/pipeline/discovery.ts`, `lib/jobs/handlers/discovery.ts`, Migration (generiert)
- Modify: `lib/db/schema/sources.ts` (+ `outlinks`), `config/discovery.json` (`typeHints`), `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`
- Test: `lib/domain/__tests__/proposals.test.ts`, `lib/pipeline/__tests__/discovery.test.ts`

**Interfaces:**
- Consumes: Task 3–5, `createReviewTask`, `seedTileIds` (M1), `startRun`.
- Produces:
  - `outlinks` (Arbeitszustand): `from_source_id → sources`, `to_domain`, `count int`, `run_id → runs`, PK `(from_source_id, to_domain, run_id)`.
  - `type Source = { id: string; domain: string; name: string; type: DocType; weight: number; status: SourceStatus; statusReason: string | null; crawlRules: CrawlRules; changeRate: ChangeRate; languages: string[]; origin: SourceOrigin }`; `getSource(db, id): Promise<Source | null>` (Regeln mit `crawlRulesSchema` geparst); `setSourceStatus(db, id: string, status: SourceStatus, reason: string | null): Promise<void>`.
  - `typeHints` (Reihenfolge = Vorrang, gegen `host + pathname`, ohne Groß/Klein): `(forum|viewtopic|showthread|thread|board)` → `forum`; `(gov\.gr|hnhs|hcg\.gr|ypa\.gr|limenarxeio)` → `authority`; `(marina|harbou?r|port-of)` → `marina`; `\.pdf$` → `pilot_guide`; `(pilot|guide|revierf)` → `pilot_guide`; `(/20\d{2}/|blog|log|toern|törn|reise|trip)` → `trip_report`.
  - `suggestType(urls: string[], cfg: DiscoveryConfig["proposals"]): DocType` – erster Hinweis, der mindestens die Hälfte der URLs trifft, sonst `defaultType`.
  - `suggestCrawlRules(urls: string[]): CrawlRules` – Host = häufigster Host der Treffer; erste Pfadsegmente der Treffer (sortiert, höchstens 5) → `startUrls` `https://<host>/<seg>/`, `allow` `^/(seg1|seg2)/`; Treffer direkt unter `/` → `startUrls ["https://<host>/"]`, `allow []`; `deny ["/tag/", "/comment", "\\?replytocom=", "/wp-login", "/feed/?$"]`; übrige Werte aus `DEFAULT_CRAWL_RULES`.
  - `type DomainCandidate = { domain: string; hits: Array<{ url: string; keyword: string; languageCode: string; rank: number; title: string; snippet: string }>; linkingSources: number }`
  - `domainCandidates(db, cfg: DiscoveryConfig["proposals"]): Promise<DomainCandidate[]>` – Domains mit ≥ `minSerpHits` Ergebniszeilen ∪ Domains, auf die ≥ `minLinkingSources` verschiedene freigegebene Quellen in ihrem jüngsten Lauf verlinken; ohne `ignoreDomains` (gleich oder Subdomain) und ohne jede Domain, für die eine `sources`-Zeile existiert (jeder Status, auch beendet).
  - `proposeSources(db, deps: { transport: Transport; archive: Archive }, ctx: CallContext & { runId: string }, cfg = getConfig()): Promise<{ proposed: number; skipped: number }>` – je Kandidat: `robotsSummary` (robots des häufigsten Hosts), Sprachen = Query-Sprachen der Treffer nach Häufigkeit, Quelle `proposed` mit Vorschlag (Typ, Gewicht aus `sourceTypes`, Regeln, `changeRate`), `origin serp|linkgraph`; Aufgabe `source_approval`, `subjectType "source"`, Kontext `{ hits (max 20, nach Rang), linkingSources, languages, robots, suggestion: { type, weight, changeRate, crawlRules } }`, `priority = hits + 2 × linkingSources`. Konflikt am Domain-Index → `skipped`.
  - Stufen und Queues `discovery.area` (ein Job je Revier: `areaQueries` gekappt auf `maxQueriesPerRun`, nacheinander `runQuery`), `discovery.tile` (ein Job je Küstenkachel aus `seedTileIds`; Plan kappt auf `maxQueriesPerRun − geplante Revier-Queries dieses Laufs`, die Queries stehen in den Job-Daten), `discovery.propose` (ein Job `propose`). `config/queues.json`: je concurrency 1 (`discovery.tile` 2), retryLimit 2, 60 s, Backoff.
  - `startDiscoveryRun(db, boss, scope: { areaKey: string } | { tileId: string }, triggeredBy: string): Promise<{ id: string }>` – Revier: `["discovery.area", "discovery.tile", "discovery.propose"]`; Kachel: `["discovery.tile", "discovery.propose"]`. `startProposalRun(db, boss, triggeredBy)` – nur `discovery.propose` (Linkgraph nach einem Crawl).

- [ ] **Step 1: Failing tests**

```ts
it("a domain with 3 hits becomes a proposed source with an open source_approval task", …);  // weight 0.6 for trip_report
it("2 hits are not enough", …);
it("navily.com is never proposed, even with 10 hits", …);
it("a rejected domain is not proposed again", …);
it("a domain linked from 2 approved sources is proposed without serp hits", …);  // origin 'linkgraph'
it("suggestCrawlRules derives start urls and allow from the hits", () => {
  expect(suggestCrawlRules(["https://x.com/greece/saronic/a", "https://x.com/greece/argolic/b", "https://x.com/blog/c"]))
    .toMatchObject({ startUrls: ["https://x.com/blog/", "https://x.com/greece/"], allow: ["^/(blog|greece)/"] });
});
it("suggestType: forum urls make a forum, otherwise trip_report", …);
// discovery.test.ts
it("the tile stage gets only the queries left under the per-run cap", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Tests mit eigenen Domains `*.test.invalid` und `serp_results` in `withRollback`. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(discovery): source proposals from serp and link graph, discovery run`

### Task 7: Entscheidung `source_approval` und „Quelle pausieren“

**Files:**
- Create: `app/(admin)/_components/crawl-rules-fields.tsx`
- Modify: `lib/domain/review-decisions.ts`, `lib/domain/review-view.ts`, `lib/jobs/worker.ts` (Kontext `sourceId`), `app/(admin)/review/[id]/page.tsx`, `app/(admin)/review/[id]/actions.ts`, `app/(admin)/_components/labels.ts`
- Test: `lib/domain/__tests__/review-decisions.test.ts`, `app/(admin)/__tests__/review-source.test.ts`

**Interfaces:**
- Consumes: `decideReviewTask`, `getSource`, `setSourceStatus`, `crawlRulesSchema`, `SourceTypesConfig`.
- Produces:
  - `reviewDecisionSchema` + `{ action: "approve"; type: DocType; weight: number /* 0–1 */; changeRate: ChangeRate; crawlRules: CrawlRules }`, `{ action: "pause_source" }`; `ALLOWED["source_approval/source"] = ["approve", "reject"]`, `ALLOWED["failed_job/job"] = ["retry", "ignore", "pause_source"]`.
  - Wirkung: `approve` nur bei `status = proposed` (sonst `DecisionNotAllowed`) → Werte setzen, `approved`, `status_reason null`; `reject` → `rejected`; `pause_source` braucht `context.sourceId` (sonst `DecisionNotAllowed`) → `paused`, Grund `"Job fehlgeschlagen: <queue>/<key>"`. Kein automatischer Crawl nach Freigabe (siehe Abweichungen).
  - Dead-Letter-Kontext enthält `sourceId`, wenn `job.data.sourceId` ein String ist.
  - `reviewTaskDetail` liefert für `subjectType "source"`: Domain, Treffer, Linkgraph-Zahl, Sprachen, robots-Zusammenfassung, Vorschlag.
  - `<CrawlRulesFields defaults={CrawlRules} />` (Server-Komponente: Felder je Regel, Listen als Textarea je Zeile) und `parseCrawlRulesForm(form: FormData): CrawlRules` (zod; Fehler je Feld).
  - Labels: `DOC_TYPE_LABELS` (Revierführer, Törnbericht, Forum, Marina, Behörde, Datensatz, Reiseführer, Sonstiges), `SOURCE_STATUS_LABELS` (Vorgeschlagen, Freigegeben, Abgelehnt, Pausiert), `CHANGE_RATE_LABELS` (Hoch (täglich), Normal, Statisch), `FRONTIER_STATUS_LABELS` (Offen, Abgerufen, Übersprungen, Fehlgeschlagen) als vollständige `Record`s.
  - Review-Seite „Quellenvorschlag“: Treffer-Tabelle (Rang, Query, Titel, Snippet, URL als Text), robots-Zusammenfassung, vorbelegtes Formular (Typ-Auswahl, Gewicht, Änderungsrate, Regeln), Knöpfe „Freigeben“ (1), „Ablehnen“ (2); `failed_job` zeigt „Quelle pausieren“ (3), wenn der Kontext `sourceId` hat.

- [ ] **Step 1: Failing tests**

```ts
it("approve sets type, weight, rules and status in one decision", …);  // one review_decisions row, task decided, sources_history row
it("approving a source that is not proposed is not allowed", …);       // DecisionNotAllowed, nothing written
it("an invalid regex in the rules is rejected before anything is written", …);
it("reject keeps the domain out of later proposals", …);              // proposeSources skips it
it("pause_source pauses the failed job's source", …);
it("pause_source without sourceId in the context is not allowed", …);
it("parseCrawlRulesForm reads one allow pattern per line", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/domain app && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(review): source approval and pause source decisions`

### Task 8: Inhalts-Werkzeuge (Normalisierung, Sprache, Datum, Links, Schindeln)

**Files:**
- Create: `lib/domain/documents/{normalize,language,metadata,links,shingles,structured}.ts`, `test/fixtures/html/{article.html,jsonld.html,nofollow.html}`
- Modify: `package.json` (`linkedom`, `franc`)
- Test: `lib/domain/__tests__/documents-content.test.ts`

**Interfaces:**
- Consumes: `normalizeUrl`, `FetchConfig`.
- Produces:
  - `normalizeMarkdown(md: string): string` – CRLF/CR → LF, NFC, Nullbreiten-Zeichen (`​-‍﻿`) weg, Leerraum am Zeilenende weg, ≥ 3 Leerzeilen → 2, genau ein abschließendes `\n`.
  - `contentHash(normalizedMd: string): string` – SHA-256 hex.
  - `normalizeText(t: string): string` – NFC, „“”„«» → `"`, ‚‘’‹› → `'`, ‐‑‒–—― → `-`, jeder Leerraum (inkl. NBSP) → ein Leerzeichen, trim; Groß/Klein und Akzente bleiben (dieselbe Funktion nutzt M4 für die Zitatprüfung).
  - `detectLanguage(text: string, map: FetchConfig["languages"]): string | null` – `franc(text, { only: Object.keys(map), minLength: 50 })`, `und` → `null`.
  - `extractPublishedAt(input: { html: string | null; url: string; hint: string | null; fetchedAt: Date }): string | null` (`YYYY-MM-DD`) – Reihenfolge `meta[property=article:published_time]`, JSON-LD `datePublished` (auch in `@graph`), `hint` (Konverter), URL-Muster `/(19|20)\d{2}/(0[1-9]|1[0-2])(/(0[1-9]|[12]\d|3[01]))?/` (Tag fehlt → 01); vor 1990 oder später als `fetchedAt` + 1 Tag → verworfen.
  - `observedFrom(publishedAt: string | null, fetchedAt: Date): { observedAt: string; basis: "published" | "fetched" }`.
  - `extractLinks(html: string, baseUrl: string, trackingParams: string[]): string[]` – `a[href]` aufgelöst, nur http(s), normalisiert, dedupliziert; `<meta name="robots">` mit `nofollow` → `[]`.
  - `shingleWords(text: string): string[]` (wie `normalizeName`: NFD ohne Zeichen der Kategorie M, klein, ς → σ, Trennung an Nicht-Buchstaben/Ziffern) und `shingleHashes(text: string, size = 15): bigint[]` – verschiedene Hashes, je `BigInt.asIntN(64, <erste 8 Byte von sha256(words.join(" "))>)`; weniger als 15 Wörter → `[]`.
  - `structuredToMarkdown(raw: Uint8Array, kind: "csv" | "geojson" | "kml"): string` – CSV und GeoJSON-Properties (höchstens 500 Zeilen, plus `lon`, `lat` des ersten Punkts) als Markdown-Tabelle, KML-`Placemark` mit Name und Koordinaten als Tabelle.

- [ ] **Step 1: Failing tests**

```ts
expect(normalizeMarkdown("a  \r\n\r\n\r\n\r\nb​")).toBe("a\n\nb\n");
expect(normalizeText("„Taverne“ – offen   jetzt")).toBe("\"Taverne\" - offen jetzt");
expect(detectLanguage(greekParagraph, map)).toBe("el"); expect(detectLanguage("Hi", map)).toBeNull();
expect(extractPublishedAt({ html: jsonLd, url: "https://x.gr/a", hint: null, fetchedAt })).toBe("2024-06-03");
expect(extractPublishedAt({ html: null, url: "https://x.gr/2023/07/aegina", hint: null, fetchedAt })).toBe("2023-07-01");
expect(extractLinks(articleHtml, "https://x.gr/blog/a", tp)).toEqual(["https://x.gr/blog/b", "https://y.example/z"]);  // fragment, mailto, duplicate dropped
expect(extractLinks(nofollowHtml, "https://x.gr/", tp)).toEqual([]);
expect(shingleHashes(words(14))).toEqual([]); expect(shingleHashes(words(16))).toHaveLength(2);
expect(shingleHashes("Ἄγιος Νικόλαος …15 Wörter")).toEqual(shingleHashes("αγιος νικολαος …"));
it("a csv becomes a markdown table with its header", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(documents): markdown normalization, language, dates, links, shingles`

### Task 9: Chunks und Übernahme

**Files:**
- Create: `lib/domain/documents/chunker.ts`, `lib/domain/documents/carry.ts`
- Test: `lib/domain/__tests__/chunker.test.ts`

**Interfaces:**
- Consumes: `normalizeText`, `FetchConfig["chunk"]`.
- Produces:
  - `type ChunkDraft = { ordinal: number; text: string; textNormalized: string; textHash: string; heading: string | null; charStart: number; charEnd: number; wordCount: number }` (`textHash` = sha256 von `textNormalized`; Wörter = Trennung an `/\s+/`).
  - `chunkMarkdown(md: string, cfg: FetchConfig["chunk"]): ChunkDraft[]` – auf normalisiertem Markdown; Blöcke = durch Leerzeilen getrennt, ein eingezäunter Code-Block ist ein Block. Eine Überschrift der Ebene 1–3 beginnt einen Abschnitt: der laufende Chunk endet, ohne Überlappung; die Überschrift ist erster Block des neuen Abschnitts und `heading` aller seiner Chunks. Innerhalb eines Abschnitts: Blöcke sammeln; würde der nächste Block `targetWords` überschreiten und hat der Chunk schon einen Block → Chunk schließen; der nächste Chunk beginnt mit dem letzten Block des vorigen, wenn dieser ≤ `maxOverlapWords` Wörter hat. Ein Block über `maxWords` wird an Satzgrenzen (`(?<=[.!?;·])\s+`) in Stücke ≤ `maxWords` geteilt, ein Satz über `maxWords` hart nach `maxWords` Wörtern. `text` = Ausschnitt `charStart…charEnd` des normalisierten Markdown.
  - `matchCarried(prev: Array<{ id: string; textHash: string; carriedFromChunkId: string | null }>, next: ChunkDraft[]): Array<string | null>` – je neuem Chunk der erste noch unbenutzte vorige Chunk mit gleichem `textHash` → `prev.carriedFromChunkId ?? prev.id` (zeigt immer auf den Chunk, aus dem extrahiert wurde), sonst `null`.

- [ ] **Step 1: Failing tests**

```ts
it("12 paragraphs of 100 words give chunks of 500, 500 and 400 words with one paragraph overlap", () => {
  const c = chunkMarkdown(paragraphs(12, 100), cfg);
  expect(c.map((x) => x.wordCount)).toEqual([500, 500, 400]);
  expect(c[1].text.startsWith(paragraph(5))).toBe(true); expect(c[2].text.startsWith(paragraph(9))).toBe(true);
});
it("no chunk exceeds 800 words", …);                         // one 2000-word paragraph without punctuation → [800, 800, 400]
it("a heading starts a new chunk without overlap", …);
it("a paragraph above 200 words is not repeated as overlap", …);
it("editing one paragraph in section 2 carries every chunk of sections 1 and 3", () => {
  // three sections à 2 chunks; change one word in section 2 → matchCarried non-null for all chunks of sections 1 and 3,
  // null for the changed chunk; at most 2 nulls in total
});
it("carried chunks point to the first extraction across three versions", …);
it("two identical chunks are matched one to one", …);
it("char positions slice the chunk text out of the normalized markdown", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(documents): section-aware chunking and carry-over matching`

### Task 10: HTML-Konverter (lokal mit Playwright-Fallback, Jina, Firecrawl)

**Files:**
- Create: `lib/adapters/fetch/{types,local,browser,jina,firecrawl,index}.ts`, `test/fixtures/html/boilerplate.html`
- Modify: `package.json` (`@mozilla/readability`, `turndown`, `@joplin/turndown-plugin-gfm`, `playwright@1.64`), `scripts/fixtures-record.ts` (`--converters <url>…`), `lib/jobs/worker.ts` (Renderer beim Herunterfahren schließen)
- Test: `lib/adapters/__tests__/converters.test.ts`, `test/fixtures/http/{jina,firecrawl}/**`

**Interfaces:**
- Consumes: `httpCall` (Budget, Kosten), `FetchConfig`, `CrawlRules`.
- Produces:
  - `type ConverterName = "jina" | "firecrawl" | "local"`; `type ConvertInput = { url: string; html: string | null; boilerplateSelectors: string[]; render: CrawlRules["render"] }`; `type Converted = { markdown: string; title: string | null; publishedHint: string | null; rendered: boolean; durationMs: number }`; `interface Converter { name: ConverterName; convert(input: ConvertInput, ctx: CallContext): Promise<Converted> }`.
  - `htmlToMarkdown(html: string, url: string, selectors: string[]): { markdown: string; title: string | null; mainChars: number }` – linkedom; `script, style, noscript, iframe` und `selectors` entfernen; Readability; Turndown (ATX-Überschriften, eingezäunte Code-Blöcke, GFM-Tabellen); `mainChars` = Länge des Readability-`textContent` ohne Leerraum.
  - `type RenderPage = (url: string, opts: { timeoutMs: number }) => Promise<{ html: string; finalUrl: string; status: number }>`; `createPlaywrightRenderer(): { render: RenderPage; close(): Promise<void> }` – Chromium headless, ein Browser je Prozess, lazy; User-Agent wie `http.ts`; Bilder, Fonts, Medien blockiert.
  - `createLocalConverter(deps: { renderPage?: RenderPage; cfg: FetchConfig }): Converter` – `render "always"`, oder `"auto"` und `mainChars < renderMinMainChars` → `renderPage` und erneut `htmlToMarkdown` (`rendered: true`); `"never"` rendert nie.
  - `createJinaConverter(transport, cfg: FetchConfig["jina"]): Converter` – GET `<endpoint><url>`, Header `Authorization: Bearer <JINA_API_KEY>`, `Accept: application/json`, `X-Return-Format: markdown`, `X-Remove-Selector` (Selektoren mit Komma); Budget `jina`; Kosten `data.usage.tokens × eurPerMTok / 1e6`; Ergebnis `data.content`, `data.title`, `data.publishedTime`.
  - `createFirecrawlConverter(transport, cfg: FetchConfig["firecrawl"]): Converter` – POST `{ url, formats: ["markdown"], onlyMainContent: true, excludeTags: selectors }`, Bearer `FIRECRAWL_API_KEY`; Budget `firecrawl`; Kosten `(data.metadata.creditsUsed ?? 1) × eurPerCredit`; `success: false` → `HttpError`.
  - `resolveConverter(rules: CrawlRules, sourceDomain: string, cfg: FetchConfig): ConverterName` – Regel ≠ `auto` → Regel; sonst `converterBySource[domain] ?? defaultConverter`.
  - `createConverters(deps: { transport: Transport; renderPage?: RenderPage; cfg: FetchConfig }): Record<ConverterName, Converter>`.

- [ ] **Step 1: Failing tests**

```ts
it("htmlToMarkdown keeps the table and drops boilerplate", () => {
  const r = htmlToMarkdown(boilerplateHtml, "https://x.gr/a", [".cookie-banner"]);
  expect(r.markdown).toContain("| Tiefe | Plätze |"); expect(r.markdown).not.toMatch(/Cookie|Newsletter/);
  expect(r.markdown).toMatch(/^# Ankern vor Perdika/m);
});
it("auto renders once when the main text has fewer than 500 characters", …);  // fake renderPage called once, rendered true
it("never does not render", …);
it("jina returns markdown and records its token cost", …);                   // fixture; external_calls service 'jina', cost_eur > 0
it("firecrawl returns markdown and records credits", …);
it("an exhausted jina budget throws before any request", …);
it("resolveConverter prefers the rule, then the per-source decision, then the default", …);
it.skipIf(!chromiumInstalled() /* Helfer in test/browser.ts: Executable von playwright vorhanden */)("the playwright renderer returns script-built html from the site server", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; `fixtures:record -- --converters <3 Pilot-URLs>` (höchstens 3 Aufrufe je Dienst). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(fetch): local, jina and firecrawl converters with playwright fallback`

### Task 11: PDF-Extraktion

Entscheidung `pdftotext -layout` (Poppler) als Standard: erhält Spalten von Tiefen- und Platztabellen, läuft lokal ohne Kosten, ist im Debian-Paket `poppler-utils` verfügbar. `pdfjs-dist` liefert nur Textstücke mit Koordinaten und bräuchte eigene Layout-Rekonstruktion. Claude mit PDF-Eingabe nur seitenweise für lokal unlesbare Seiten.

**Files:**
- Create: `lib/adapters/pdf/{pdftotext,split,claude,index}.ts`, `lib/domain/documents/pdf-layout.ts`, `lib/ai/tasks/pdf-to-markdown.ts`, `config/prompts/pdf.to_markdown/v1.md`, `test/fixtures/pdf/{layout-sample.txt,two-pages.pdf}`, `scripts/pdf-compare.ts`
- Modify: `lib/ai/types.ts`, `lib/ai/anthropic.ts`, `lib/ai/mock.ts`, `config/models.json`, `docker/worker.Dockerfile`, `.github/workflows/ci.yml`, `package.json` (`pdf-lib`, Skript `pdf:compare`)
- Test: `lib/domain/__tests__/pdf-layout.test.ts`, `lib/adapters/__tests__/pdf.test.ts`, `lib/ai/__tests__/ai.test.ts`

**Interfaces:**
- Consumes: `ModelClient`, `FetchConfig["pdf"]`.
- Produces:
  - `runPdftotext(bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<string>` – `pdftotext -layout -enc UTF-8 - -` über stdin; Binary fehlt → `Error("pdftotext not installed (poppler-utils)")`; `hasPdftotext(): Promise<boolean>`.
  - `layoutToMarkdown(text: string, minChars: number): { markdown: string; pages: Array<{ page: number; chars: number; unreadable: boolean }> }` – Seiten an `\f`; jede Seite beginnt mit `<!-- page N -->`; ≥ 3 aufeinanderfolgende Zeilen mit je ≥ 2 Lücken aus ≥ 2 Leerzeichen → eingezäunter Block ```` ```text ```` unverändert; sonst Absätze (Zeilen mit Leerzeichen verbunden, `-\n` vor Kleinbuchstaben verbunden); allein stehende Zeile in Großbuchstaben ≤ 60 Zeichen → `## `.
  - `isUnreadable(pageText: string, minChars: number): boolean` – weniger als `minChars` Buchstaben oder > 20 % Zeichen außerhalb Buchstaben/Ziffern/Satzzeichen/Leerraum.
  - `splitPdfPages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array[]>` (pdf-lib, 1-basiert).
  - `ModelTask` + optional `attachments?(input: I): Array<{ kind: "pdf"; data: Uint8Array }>`; `anthropic.ts` sendet sie als `document`-Blöcke (base64) vor dem Nutzertext; `MockModel` ignoriert sie.
  - Task `pdf.to_markdown` (Ausgabe `{ markdown: string }`, `config/models.json`: `claude-sonnet-5-5`, Prompt v1: Seite wörtlich als Markdown, Tabellen als Markdown-Tabellen, nichts ergänzen).
  - `convertPdf(bytes: Uint8Array, deps: { pdftotext: typeof runPdftotext; model?: ModelClient; cfg: FetchConfig["pdf"] }, ctx: { runId?: string; stage?: string }): Promise<{ markdown: string; converter: "pdftotext" | "pdftotext+claude"; modelPages: number[]; unreadablePages: number[] }>` – unlesbare Seiten durch die Modell-Ausgabe ersetzt, wenn `modelFallback` und Anzahl ≤ `maxModelPagesPerDocument`; sonst bleiben sie und stehen in `unreadablePages`.
  - Worker-Image: `apt-get install -y --no-install-recommends poppler-utils` vor `USER pwuser`; CI: Schritt `sudo apt-get install -y poppler-utils` vor `npm test`.
  - `npm run pdf:compare -- <pdf>… [--model-pages 1-6]` schreibt `docs/pilot/m3-pdf-vergleich.md`: je Datei Seitenzahl, Zeichen je Seite, unlesbare Seiten, für die gewählten Seiten `pdftotext`-Markdown und Claude-Markdown nebeneinander (als Abschnitte), Prüfliste „Ortsnamen korrekt“, „Tabellen (Tiefen, Plätze) korrekt“ je Verfahren zum Ausfüllen, Kosten aus `external_calls`; Abschnitt „Entscheidung“ zeigt `config/fetch.json` `pdf`.

- [ ] **Step 1: Failing tests**

```ts
it("layout tables stay as text blocks and hyphenation is joined", () => {
  const { markdown, pages } = layoutToMarkdown(sample, 200);
  expect(markdown).toContain("<!-- page 2 -->");
  expect(markdown).toMatch(/```text\n.*Perdika\s{2,}3-8 m\s{2,}40/s);
  expect(markdown).toContain("Ankerplatz"); expect(pages.map((p) => p.page)).toEqual([1, 2]);
});
it("an unreadable page is replaced by the model page", …);   // fake pdftotext: page 2 garbage; MockModel → modelPages [2], converter "pdftotext+claude"
it("modelFallback false calls no model", …);
it("attachments are sent as document blocks", …);           // fake SDK sees content[0].type === "document"
it.skipIf(!(await hasPdftotext()))("pdftotext reads the two-page fixture", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren (`two-pages.pdf` einmalig mit pdf-lib erzeugen und einchecken). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pdf): layout-preserving pdftotext with page-wise claude fallback`

### Task 12: Archiv schreiben

**Files:**
- Create: `lib/domain/documents/store.ts`
- Modify: `package.json` (`diff`)
- Test: `lib/domain/__tests__/documents-store.test.ts`

**Interfaces:**
- Consumes: `Archive`, `normalizeMarkdown`, `contentHash`, `chunkMarkdown`, `matchCarried`, `shingleHashes`, `observedFrom`.
- Produces:
  - `archiveKey(documentId: string, fetchedAt: Date, hash: string, suffix: string): string` – `archive/<documentId>/<fetchedAt.toISOString()>_<hash.slice(0, 8)>.<suffix>` (`raw.<ext>`, `md`, `diff`).
  - `ensureDocument(db, input: { sourceId: string; url: string; urlNormalized: string; docType: DocType }): Promise<{ id: string; created: boolean }>` – über `url_normalized`, nebenläufig sicher.
  - `type FetchedContent = { fetchedAt: Date; raw: Uint8Array; rawExt: string; contentType: string | null; finalUrl: string | null; markdown: string; converter: string; language: string | null; publishedAt: string | null; docType: DocType; etag: string | null; lastModified: string | null; simulated?: boolean; runId?: string }`
  - `storeFetched(db, archive, documentId: string, content: FetchedContent, cfg: FetchConfig["chunk"]): Promise<{ outcome: "new_version" | "unchanged" | "reverted"; versionId: string; chunks: { created: number; carried: number } }>` – Markdown normalisieren, hashen. Gleich `current_version_id` → `unchanged` (nur `last_checked_at`, `etag`, `last_modified`, `consecutive_gone 0`, `status active`). Gleich einer älteren Version → `reverted` (zusätzlich `current_version_id` auf diese). Sonst: erst S3 (`raw`, `md`, `diff` per `createTwoFilesPatch` gegen das Markdown der aktuellen Version; ohne Vorversion kein `diff`), dann eine Transaktion: Version, Chunks mit `matchCarried` gegen die Chunks der aktuellen Version (übernommene erhalten `embedding`, `embedding_model` der Herkunft), `text_shingles` nur für nicht übernommene Chunks, Dokument aktualisieren. Unique-Verletzung `(document_id, content_hash)` → neu lesen und als `unchanged`/`reverted` melden. S3-Objekte eines abgebrochenen Versuchs bleiben als harmlose Waisen.
  - `markChecked(db, documentId: string, input: { at: Date; etag?: string | null; lastModified?: string | null }): Promise<void>`
  - `markGone(db, documentId: string, at: Date, goneAfter: number): Promise<{ gone: boolean; consecutive: number }>` – `consecutive_gone + 1`, ab `goneAfter` `status gone` (`valid_to` bleibt leer; Facts beendet die Konsolidierung).

- [ ] **Step 1: Failing tests**

```ts
it("the first fetch writes raw and md, a version and its chunks", …);      // no diff key; chunks > 0; shingles exist
it("the same markdown again only updates last_checked_at", …);             // outcome unchanged; 1 version
it("a changed paragraph writes a diff and carries the other chunks with their embeddings", …);
it("A → B → A reports reverted and points back to version A", …);          // 2 versions, current_version_id = A
it("two concurrent stores of the same content create one version", …);    // committed rows, source *.test.invalid; Promise.all
it("shingles are written only for chunks that were not carried", …);
it("two 404 make a document gone, a later 200 makes it active again", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(documents): versioned archive with diff, carried chunks and shingles`

### Task 13: Crawl-Stufen `fetch.source` und `fetch.url`

**Files:**
- Create: `lib/pipeline/fetch/{source,url,run}.ts`, `lib/jobs/handlers/fetch.ts`
- Modify: `lib/domain/runs.ts` (`extendStage`), `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`
- Test: `lib/domain/__tests__/runs.test.ts`, `lib/pipeline/__tests__/fetch.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4, 8, 10–12, `getSource`, `setSourceStatus`, `enqueueStageJobs`, `startRun`.
- Produces:
  - `extendStage(db, runId: string, stage: string, by: number): Promise<void>` – `total += by`; Stufe nicht `running` → Error. Aufrufer erweitern, bevor ihr eigener Job abgeschlossen ist.
  - `FETCH_SOURCE_STAGE = "fetch.source"`, `FETCH_URL_STAGE = "fetch.url"`, `FETCH_RUN_STAGES = ["fetch.source", "fetch.url"]` (Task 14 hängt `embed.chunks` an).
  - `prepareSourceCrawl(db, sourceId: string, deps: { transport; archive }, ctx: CallContext & { runId: string }): Promise<{ status: "ready" | "paused" | "not_approved"; startUrls: number; robots: RobotsSummary | null }>` – nur `approved`; robots je Host der `startUrls` (`robotsForRun`); `explicitBan` → `setSourceStatus(paused, "robots.txt verbietet das Crawlen")`; erlaubte `startUrls` in `crawl_frontier` (Tiefe 0, `queued`).
  - `fetchUrlStage.plan`: für `params.sourceIds` (nur `approved`) Frontier-Zeilen außer `skipped`, nach Tiefe und `discovered_at`, höchstens `params.maxPages ?? rules.maxPages` je Quelle; dazu `params.documentIds` (Uploads). Job-Daten `{ key: sha256(url_normalized).slice(0, 32), sourceId, url, depth, documentId? }`.
  - `type FetchUrlDeps = { transport; archive; converters: Record<ConverterName, Converter>; pdf: { pdftotext; model?: ModelClient }; enqueue(tx: Db, jobs: JobData[]): Promise<number>; now?: () => Date }`
  - `fetchUrl(db, job: { sourceId: string; url: string; depth: number; documentId?: string }, deps: FetchUrlDeps, ctx: CallContext & { runId: string }): Promise<{ outcome: "new_version" | "unchanged" | "reverted" | "not_modified" | "gone" | "missing" | "disallowed" | "skipped" | "failed"; newUrls: number }>`:
    1. robots des Hosts → gesperrt: Frontier `skipped`, Grund `robots`.
    2. `upload://` → Rohdatei aus `uploads/<sha256>.pdf`. Sonst `httpCall` GET mit `If-None-Match`/`If-Modified-Since` aus dem Dokument, `okStatuses [304, 404, 410]`, `rateKey "domain:<registrableDomain>"`, `ratePerMinute = effectiveRate(rules.ratePerMinute, robots.crawlDelaySec)`, `maxRateWaitMs` aus `fetch.json`, `ctx.sourceId`.
    3. 304 → `markChecked` (`not_modified`); 404/410 → `markGone` (`gone` beim Umschalten, sonst `missing`); Größe > `maxRawBytes` → `skipped` (`too_large`); Weiterleitung auf eine andere registrierbare Domain → `skipped` (`redirect_offsite`).
    4. Format: PDF (Content-Type oder `.pdf`, nur bei `rules.pdf`) → `convertPdf`; CSV/GeoJSON/KML → `structuredToMarkdown`; HTML → `resolveConverter` und `convert`.
    5. Sprache, `extractPublishedAt`, `storeFetched` (Dokumenttyp = Quellentyp).
    6. Nur HTML: Links. Interne mit `urlAllowed` und `depth + 1 ≤ maxDepth`, solange die Frontier der Quelle < `maxPages` → neue Frontier-Zeilen und in derselben Transaktion `deps.enqueue` + `extendStage(by = eingefügte Jobs)`. Externe → `outlinks` `count += n` für `(sourceId, Domain, runId)`.
    7. Frontier `fetched`. `HttpError` (4xx außer 404/410/429) → Frontier `failed` mit `HTTP <status>`, Ergebnis `failed`, kein Wurf; `RetryableHttpError` wird geworfen (Wiederholung, dann `failed_job`).
  - Queues `fetch.source` (concurrency 2, retryLimit 2, 60 s, Backoff), `fetch.url` (concurrency 8, retryLimit 2, 120 s, Backoff); in Produktion `enqueue = (tx, jobs) => enqueueStageJobs(boss, "fetch.url", runId, FETCH_URL_STAGE, jobs, tx)`.
  - `startFetchRun(db, boss, input: { sourceIds: string[] | "approved"; triggeredBy: string; maxPages?: number }): Promise<{ id: string }>` – Umfang `source` (`scopeId` = einzige ID oder `"approved"`), Stufen `FETCH_RUN_STAGES`; `startTestCrawl(db, boss, sourceId, triggeredBy)` = `maxPages 10`; `startUploadFetchRun(db, boss, documentId, triggeredBy)` = Stufen ohne `fetch.source`, `params.documentIds`.

- [ ] **Step 1: Failing tests**

```ts
// runs.test.ts
it("a stage with total 1 extended by 2 finishes only after 3 outcomes", …);
// fetch.test.ts – site server, withRollback, stage functions called directly (no pg-boss); deps.enqueue collects jobs, the test loop runs them
it("run 1 archives every allowed page once", async () => {
  // /a links /b, /c?utm_source=x#f, /tag/x (denied), https://other.example/x; robots allows all
  // → documents a, b, c; c stored as <origin>/c; no frontier row for /tag/x; outlinks other.example count 1; each 1 version with chunks
});
it("run 2: same page 304, changed page new version with carried chunks, 404 once keeps the page active", …);
it("run 3: the second 404 makes the page gone", …);
it("robots disallow-all pauses the source and plans no urls", …);
it("the frontier stops at maxPages", …);                          // maxPages 2, 5 links → 2 frontier rows
it("maxDepth 0 follows no links", …);
it("a 403 marks the frontier row failed without throwing", …);
it("a 503 throws a retryable error", …);
it("effective rate honours crawl-delay", …);                       // robots Crawl-delay 30 → httpCall ratePerMinute 2
it("an uploaded pdf is read from the archive", …);                 // fake pdftotext; converter "pdftotext"
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Handler bauen `deps` aus `getTransport()`, `getArchive()`, `createConverters` (Playwright-Renderer im Worker, sonst ohne), `runPdftotext`, `createAnthropicClient`. **Step 4: Run** `npx vitest run lib/domain lib/pipeline lib/jobs` → PASS.
- [ ] **Step 5: Commit** `feat(fetch): crawl stages with robots, conditional get, gone detection and growing frontier`

### Task 14: Voyage-Embeddings

**Files:**
- Create: `lib/adapters/voyage.ts`, `lib/pipeline/embed.ts`, `lib/jobs/handlers/embed.ts`
- Modify: `lib/pipeline/fetch/run.ts` (`FETCH_RUN_STAGES` + `embed.chunks`), `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`, `worker/index.ts` (Startprüfung), `scripts/fixtures-record.ts` (`--voyage`)
- Test: `lib/adapters/__tests__/voyage.test.ts`, `lib/pipeline/__tests__/embed.test.ts`, `test/fixtures/http/voyage/**`

**Interfaces:**
- Consumes: `httpCall`, `EmbeddingsConfig`, `chunks`.
- Produces:
  - `embedTexts(transport, texts: string[], ctx: CallContext, cfg: EmbeddingsConfig): Promise<{ vectors: number[][]; tokens: number }>` – POST `{ input, model, input_type: "document", output_dimension: dimension }`, Bearer `VOYAGE_API_KEY`, Budget `voyage`, Kosten `usage.total_tokens × eurPerMTok / 1e6`, nach `data[].index` sortiert; Länge ≠ `dimension` → Error.
  - `assertEmbeddingDimension(db, cfg: EmbeddingsConfig): Promise<void>` – `format_type` von `chunks.embedding` muss `vector(<dimension>)` sein, sonst Error mit beiden Werten; der Worker ruft sie beim Start.
  - `EMBED_STAGE = "embed.chunks"`; Plan: Chunks mit `embedding is null` aus Versionen dieses Laufs (`params.all` → alle, höchstens 10 000), nach `id`, in Paketen zu `batchSize` → Job `{ key: <erste Chunk-ID>, chunkIds }`.
  - `embedChunks(db, chunkIds: string[], deps: { transport }, ctx: CallContext): Promise<{ embedded: number }>` – nur noch leere Chunks, eingebettet wird `text`; setzt `embedding`, `embedding_model`.
  - Queue `embed.chunks` (concurrency 2, retryLimit 2, 60 s, Backoff); `startEmbedBackfillRun(db, boss, triggeredBy)`.

- [ ] **Step 1: Failing tests**

```ts
it("returns 1024-dimensional vectors in input order and records the token cost", …);  // fixture with 2 texts
it("a vector of another length is an error", …);
it("the plan batches 130 empty chunks into 64, 64 and 2", …);
it("carried chunks with an embedding are not planned", …);
it("embedChunks skips chunks embedded in the meantime", …);
it("assertEmbeddingDimension accepts 1024 and rejects 512", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; `fixtures:record -- --voyage` (ein Aufruf). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(embeddings): voyage adapter and embed.chunks stage`

### Task 15: Wikivoyage als vorab freigegebene Quelle

**Files:**
- Create: `lib/pipeline/sources/wikivoyage.ts`, `lib/jobs/handlers/wikivoyage.ts`
- Modify: `lib/domain/sources/store.ts` (`ensureWhitelistSources`), `lib/adapters/wikidata.ts` (`fetchSitelinks`), `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`, `scripts/fixtures-record.ts` (`--wikivoyage`)
- Test: `lib/pipeline/__tests__/wikivoyage.test.ts`, `test/fixtures/http/wikidata-sitelinks/**`

**Interfaces:**
- Consumes: `WhitelistConfig`, `SourceTypesConfig`, `ensureDocument`, `crawl_frontier`, `tile_geo_objects`, `startRun`, Task 13/14.
- Produces:
  - `ensureWhitelistSources(db, cfg = getConfig()): Promise<{ created: number }>` – je Eintrag eine `approved`-Quelle (`origin whitelist`, Gewicht aus `sourceTypes`, Regeln = Defaults + Eintrag), nur wenn es für die Domain keine Zeile gibt (Änderungen des Admins gewinnen).
  - `fetchSitelinks(transport, qids: string[], sites: string[], ctx: CallContext): Promise<Map<string, Array<{ site: string; title: string; url: string }>>>` – `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=<≤ 50, |>&props=sitelinks/urls&sitefilter=<sites>&format=json`, Service `wikidata`.
  - `WIKIVOYAGE_STAGE = "sources.wikivoyage"`; `seedWikivoyage(db, areaKey: string, deps: { transport }, ctx: CallContext): Promise<{ objects: number; articles: number; newDocuments: number }>` – gültige Objekte `area`, `archipelago`, `island`, `islet`, `settlement` mit `wikidata_id` in Kacheln des Reviers (und das Revier selbst); Sites `<lang>wikivoyage` für `area.sourceLanguages`; je Artikel `ensureDocument` (`travel_guide`) und Frontier-Zeile Tiefe 0 `queued`.
  - Queue `sources.wikivoyage` (concurrency 1, retryLimit 2, 60 s, Backoff); `startWikivoyageRun(db, boss, areaKey: string, triggeredBy: string): Promise<{ id: string }>` – `ensureWhitelistSources`, Stufen `["sources.wikivoyage", ...FETCH_RUN_STAGES]`, `params { areaKey, sourceIds: [<wikivoyage>] }`.

- [ ] **Step 1: Failing tests**

```ts
it("ensureWhitelistSources creates wikivoyage once and leaves a paused row alone", …);  // weight 0.5, maxDepth 0
it("an island with en and de sitelinks yields two travel_guide documents at depth 0", …); // fixture for Aegina
it("an object without sitelinks yields nothing", …);
it("a second seed adds no documents or frontier rows", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; `fixtures:record -- --wikivoyage --area saronic` (ein `wbgetentities`-Aufruf, robots und HTML von drei Artikeln für den Fetch-Test). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sources): wikivoyage whitelist source seeded from wikidata sitelinks`

### Task 16: Seiten „Quellen“ und Quellen-Detail

Vor dem Code `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md` und `…/proxyClientMaxBodySize.md` lesen.

**Files:**
- Create: `lib/domain/sources-view.ts`, `app/(admin)/sources/{page.tsx,actions.ts}`, `app/(admin)/sources/[id]/{page.tsx,actions.ts}`
- Modify: `lib/domain/sources/store.ts`, `lib/security/route-policy.ts`, `app/(admin)/_components/nav.tsx`, `app/(admin)/tiles/[id]/{page.tsx,actions.ts}`, `next.config.ts`
- Test: `lib/domain/__tests__/sources-view.test.ts`, `app/(admin)/__tests__/sources-actions.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 7, 13, 15, `CrawlRulesFields`, `parseCrawlRulesForm`, `AutoRefresh`.
- Produces:
  - `type SourceRow = { id; domain; name; status: SourceStatus; type: DocType; weight: number; documents: number; versions: number; lastRun: { id: string; status: RunStatus; finishedAt: Date | null } | null; costEur30d: number }`
  - `listSources(db, filter: { status?: SourceStatus; type?: DocType; page: number }): Promise<{ rows: SourceRow[]; total: number }>` – 50 je Seite, nach Status, dann Domain.
  - `sourceDetail(db, id: string, opts: { docPage: number }): Promise<SourceDetail | null>` – Quelle mit Regeln und Grund, Frontier-Zähler je Status, Dokumente (URL, Status, Versionen, `last_checked_at`, Sprache; 50 je Seite), letzte 10 Läufe (Umfang diese Quelle oder `params.sourceIds` enthält sie), Kosten gesamt und je Dienst aus `external_calls.source_id`.
  - `updateSourceSettings(db, id: string, input: { name: string; type: DocType; weight: number; changeRate: ChangeRate; crawlRules: CrawlRules }): Promise<void>`; `createManualSource(db, input: { domain: string; name: string; type: DocType }): Promise<{ id: string }>` (`approved`, `origin manual`, Domain = `registrableDomain`, bekannte Domain → Error); `setSourceStatus` nur `approved ↔ paused` aus der UI.
  - `uploadPdf(db, archive, input: { sourceId: string; bytes: Uint8Array }): Promise<{ documentId: string; created: boolean }>` – Kopf `%PDF-` Pflicht; `uploads/<sha256>.pdf`; Dokument `upload://<sha256>`, Typ der Quelle; gleiche Datei → gleiches Dokument.
  - Server Actions (zod, `requireAdmin`): `saveSourceAction`, `pauseSourceAction`, `resumeSourceAction`, `testCrawlAction` („Testcrawl 10 Seiten“), `crawlAction`, `uploadPdfAction` (≤ 100 MB → `startUploadFetchRun`), `createSourceAction`, `crawlAllApprovedAction`, `discoveryAreaAction(areaKey)`, `proposalRunAction`, `wikivoyageRunAction(areaKey)`; Kachel-Seite: Aktion „Quellenfindung“ → `startDiscoveryRun({ tileId })`.
  - `next.config.ts`: `experimental.serverActions.bodySizeLimit: "100mb"`, `experimental.proxyClientMaxBodySize: "100mb"`.
  - Routen `/sources`, `/sources/[id]` → admin; Navigation „Quellen“. Liste mit Filtern als URL-Parameter (Status, Typ), Kopf mit Zählern je Status und Knöpfen „Quellenfindung“ je Revier, „Linkgraph-Vorschläge“, „Wikivoyage“, „Alle freigegebenen crawlen“; Detail mit Formular, Status-Knöpfen, Testcrawl/Crawl, Upload, Dokumentliste (Link `/documents/<id>`), Läufen, Kosten.

- [ ] **Step 1: Failing tests**

```ts
it("listSources filters by status and type and counts documents and versions", …);
it("costs per source come from external_calls.source_id", …);
it("saving rules with an invalid regex changes nothing", …);
it("a proposed source cannot be paused from the source page", …);
it("the same pdf uploaded twice is one document", …);              // url upload://<sha256>
it("a file that is not a pdf is rejected", …);
it("saveSourceAction rejects weight 1.5", …);
it("createManualSource refuses a known domain", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS (Route-Policy-Test eingeschlossen).
- [ ] **Step 5: Commit** `feat(admin): sources list and detail with rules, crawls and pdf upload`

### Task 17: Dokument-Viewer

**Files:**
- Create: `lib/domain/document-view.ts`, `app/(admin)/_components/archive-markdown.tsx`, `app/(admin)/documents/[id]/page.tsx`, `app/(admin)/documents/[id]/raw/[versionId]/route.ts`
- Modify: `lib/security/route-policy.ts`, `package.json` (`react-markdown`, `remark-gfm`)
- Test: `lib/domain/__tests__/document-view.test.ts`, `app/(admin)/__tests__/document-raw.test.ts`, `app/(admin)/__tests__/archive-markdown.test.tsx`

**Interfaces:**
- Consumes: Task 12, `Archive`.
- Produces:
  - `documentDetail(db, id: string): Promise<DocumentDetail | null>` – Dokument, Quelle (Domain, Typ, Gewicht), Versionen neueste zuerst (`id`, `fetchedAt`, `hash8`, `converter`, `language`, `publishedAt`, `observedAt`, `basis`, `chunks`, `carried`, `simulated`).
  - `versionContent(db, archive, documentId: string, versionId: string): Promise<{ markdown: string; chunks: Array<{ ordinal; heading; wordCount; carried: boolean; embedded: boolean; charStart; charEnd }> } | null>` – Version eines anderen Dokuments → `null`.
  - `versionDiff(db, archive, documentId: string, fromId: string, toId: string): Promise<Array<{ kind: "same" | "added" | "removed"; text: string }> | null>` – `diffLines`; gleiche Strecken über 6 Zeilen auf je 3 am Rand gekürzt (`…`).
  - `<ArchiveMarkdown markdown={string} />` – `react-markdown` mit `remark-gfm`, `skipHtml`, Standard-`urlTransform`; Links `rel="noopener noreferrer nofollow"`, `target="_blank"`.
  - `GET /documents/[id]/raw/[versionId]` (admin): Rohdatei aus S3; Header `Content-Type` der Version (sonst `application/octet-stream`), `Content-Disposition: attachment; filename="<hash8>.<ext>"`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`; fremde Version oder fehlendes Objekt → 404.
  - Seite `/documents/[id]?v=<versionId>&diff=<versionId>`: Kopf (URL als Link „Original“, Quelle, Status, `last_checked_at`, „gone“-Hinweis), Zeitleiste der Versionen, Markdown der gewählten Version, Diff zur gewählten Vergleichsversion, Chunk-Liste (Ordinal, Überschrift, Wörter, „übernommen“, „Embedding“), Link „Rohdatei“. Erwähnungen und Zitate kommen in M4 dazu.

- [ ] **Step 1: Failing tests**

```ts
it("the raw route serves archived html as a sandboxed attachment", async () => {
  const res = await GET(req, { params: Promise.resolve({ id, versionId }) });
  expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(res.headers.get("content-security-policy")).toContain("sandbox");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});
it("a version of another document is 404", …);
it("archive markdown renders neither raw html nor javascript links", () => {
  const html = renderToStaticMarkup(<ArchiveMarkdown markdown={"<script>x()</script>\n\n[a](javascript:alert(1)) | t |\n|---|\n| 1 |"} />);
  expect(html).not.toContain("<script"); expect(html).not.toContain("javascript:"); expect(html).toContain("<table");
});
it("versionDiff marks the changed line and collapses long unchanged runs", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): document viewer with versions, diff, chunks and sandboxed raw files`

### Task 18: Konverter-Vergleich

**Files:**
- Create: `lib/domain/converter-comparison.ts`, `lib/pipeline/compare-converters.ts`, `lib/jobs/handlers/compare.ts`, `app/(admin)/compare/converters/{page.tsx,actions.ts}`, `scripts/converter-report.ts`, Migration (generiert)
- Modify: `lib/db/schema/sources.ts` (+ `converter_samples`, `converter_outputs`), `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`, `lib/security/route-policy.ts`, `app/(admin)/_components/nav.tsx`, `app/(admin)/settings/page.tsx`, `package.json` (Skript `report:converters`)
- Test: `lib/domain/__tests__/converter-comparison.test.ts`, `scripts/__tests__/converter-report.test.ts`

**Interfaces:**
- Consumes: `createConverters`, `httpCall`, `robotsForRun`, `ArchiveMarkdown`, `FetchConfig`.
- Produces:
  - `converter_samples` (Arbeitszustand): `id`, `source_id`, `url`, `url_normalized` (eindeutig), `created_at`. `converter_outputs`: `id`, `sample_id`, `converter`, `md_key`, `chars`, `duration_ms`, `cost_eur numeric(12,6)`, `error`, `rating jsonb` (`{ mainContent: boolean; boilerplateRemoved: boolean; tablesKept: boolean | null }`), `rated_by`, `rated_at`, `created_at`; eindeutig `(sample_id, converter)`.
  - `CONVERTER_SAMPLE = { pages: 50, sources: 10, perSource: 5 }`; `pickConverterSample(db): Promise<{ added: number; sources: number }>` – die 10 freigegebenen Quellen mit den meisten aktiven HTML-Dokumenten (ohne `upload://`), je 5 Dokumente nach `md5(url_normalized)`; bestehende Stichprobe bleibt.
  - `compareSample(db, sampleId: string, deps: { transport; archive; converters: Record<ConverterName, Converter> }, ctx: CallContext & { runId: string }): Promise<void>` – robots prüfen, Rohseite einmal per `httpCall`, dann alle drei Konverter (lokal mit HTML, Jina/Firecrawl mit URL) mit Dauer und Kosten (Summe `external_calls` des Aufrufs); Markdown nach `comparison/converters/<sampleId>/<converter>.md`; Fehler je Konverter in `error`, `BudgetExceeded` wird geworfen; Upsert, Wiederholung erzeugt keine Dubletten.
  - Queue/Stufe `compare.converters` (concurrency 2, retryLimit 2, 60 s, Backoff); `startConverterComparison(db, boss, triggeredBy): Promise<{ id: string; samples: number }>` – Umfang `system`/`converters`, Jobs nur für Stichproben ohne drei Ausgaben.
  - `type Rating = { mainContent: boolean; boilerplateRemoved: boolean; tablesKept: boolean | null }`; `rateConverterOutput(db, input: { sampleId: string; converter: ConverterName; rating: Rating; by: string }): Promise<void>`.
  - `type ConverterSummary = { converter: ConverterName; pages: number; errors: number; rated: number; mainContentPct: number | null; boilerplatePct: number | null; tablesPct: number | null; avgCostEur: number; avgDurationMs: number; avgChars: number }`; `converterSummary(db): Promise<ConverterSummary[]>` (Prozente über bewertete Seiten; `tablesKept null` zählt nicht).
  - Seite `/compare/converters?sample=<id>`: Zusammenfassung je Konverter, Fortschritt „n von 50 bewertet“, Liste der Seiten, Seitenansicht mit drei Spalten (`ArchiveMarkdown`) und je Spalte drei Kontrollkästchen + „Speichern“, Knopf „Vergleich starten“, Hinweis auf die aktuelle Entscheidung aus `config/fetch.json`. `/settings` zeigt Konverter-Entscheidung, PDF-Extraktor und Embedding-Modell/Dimension.
  - `renderConverterReport(input: { generatedAt: Date; summary: ConverterSummary[]; samples: Array<{ url: string; domain: string; ratings: Partial<Record<ConverterName, Rating | null>>; errors: Partial<Record<ConverterName, string>> }>; decision: FetchConfig["decision"] & { defaultConverter: ConverterName; converterBySource: Record<string, ConverterName> } }): string` – Markdown: Kopf, Methode (50 Seiten, 10 Quellen, Kriterien), Tabelle je Konverter, Kosten und Laufzeit, Seitenliste, Abschnitt „Entscheidung“ mit Status („Vorläufig“/„Entschieden“), Standard und Ausnahmen; `npm run report:converters` schreibt `docs/pilot/m3-konverter-vergleich.md`.

- [ ] **Step 1: Failing tests**

```ts
it("the sample takes 5 pages from each of the 10 largest approved sources", …);   // 12 sources → 10 used, 50 samples
it("a converter error is stored and the others still run", …);                    // fake jina throws → 3 rows, one with error
it("a retried sample does not duplicate outputs", …);
it("summary percentages count only rated pages", …);                              // 2 rated, one mainContent false → 50
it("the report marks a provisional decision", …);                                 // contains "Vorläufig" and "local"
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(compare): converter comparison on 50 pages with ratings and report`

### Task 19: Abnahme-Prüfung, Runbook, Übergabe

**Files:**
- Create: `scripts/check-sources.ts`, `docs/pilot/m3-abnahme.md`, `e2e/sources.spec.ts`
- Modify: `package.json` (`check:sources`), `docs/runbook.md`
- Test: `scripts/__tests__/check-sources.test.ts`

**Interfaces:**
- Produces:
  - `checkSources(db, cfg = getConfig()): Promise<{ approved: number; inRange: boolean; perSource: Array<{ domain: string; documents: number; versions: number; queued: number; failed: number; costEur: number }>; openFailedFetchJobs: number; converterDecision: "provisional" | "decided"; pdfExtractor: string }>` – `inRange` = 20 ≤ `approved` ≤ 40; `openFailedFetchJobs` = offene `failed_job`-Aufgaben der Queues `fetch.*` und `embed.chunks`.
  - CLI `npm run check:sources` – gibt die Werte aus, Exit 1 bei `!inRange`, `openFailedFetchJobs > 0` oder `converterDecision === "provisional"`.
  - e2e: Login → `/sources` → vorgeschlagene Quelle im Review freigeben → Quelle erscheint als „Freigegeben“.

- [ ] **Step 1: Failing test** – `reports 19 approved sources as out of range and a provisional decision`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Runbook** – Abschnitt „Quellen und Archiv“: Schlüssel in `.env` (Voyage, DataForSEO, Jina, Firecrawl); Reihenfolge Quellenfindung je Revier → Review der Vorschläge (Ziel 20–40) → Wikivoyage-Lauf → Testcrawl je Quelle → Konverter-Vergleich starten, 50 Seiten bewerten, `report:converters`, Entscheidung in `config/fetch.json` (`decision.status "decided"`) und Deploy → zwei Revierführer als PDF hochladen, `pdf:compare`, Entscheidung `fetch.json` `pdf` → voller Crawl „Alle freigegebenen crawlen“ → Linkgraph-Vorschläge → `check:sources`; Budget-Stopp (Queue in `/jobs` fortsetzen); Quelle bei Beschwerde pausieren. `docs/pilot/m3-abnahme.md`: Checkliste aus Roadmap und Spec 05 (20–40 freigegebene Quellen, voller Crawl ohne undokumentierte Fehler, Konverter- und PDF-Entscheidung, Kosten je Quelle sichtbar, SERP-Aufrufe < 500).
- [ ] **Step 6: Gesamtprüfung** – `npm run lint && npm run typecheck && npx vitest run && npm run test:e2e && npm run build` → alles grün.
- [ ] **Step 7: Commit** `docs: M3 acceptance check and runbook`
- [ ] **Step 8: Übergabe an Christian (nicht vom Ausführenden zu erledigen)** – Läufe auf dem Server starten, Quellen freigeben, 50 Konverter-Seiten bewerten, Konverter und PDF-Extraktor in `config/fetch.json` entscheiden, PDFs der zwei Revierführer hochladen, vollen Crawl starten, `check:sources` grün, Offenen Punkt „Fetch-Konverter (M3)“ im Gesamtdesign abhaken.

---

## Bewusste Abweichungen und Entscheidungen dieses Plans

- **Vorläufiger Standard-Konverter `local`.** Kostenlos, eine Seitenanfrage mit eigenem User-Agent und robots-Prüfung, offline testbar; Jina und Firecrawl laden die Seite selbst nach. `config/fetch.json` trägt `decision.status "provisional"`; Christian entscheidet nach dem Vergleich, `check:sources` bleibt bis dahin rot. Ein späterer Wechsel des Konverters erzeugt einmalig je Seite eine neue Version (anderes Markdown), deshalb kommt der volle Crawl nach der Entscheidung.
- **Kein automatischer Crawl nach der Freigabe.** Die Quell-Spec verlangt die Reihenfolge „Konverter vergleichen, dann voller Crawl“; Freigabe setzt nur Status und Regeln, gecrawlt wird per „Testcrawl“, „Crawl“ oder „Alle freigegebenen crawlen“.
- **Ein Crawl ist ein Lauf mit wachsender Stufe.** `fetch.url` hängt entdeckte URLs per `extendStage` an die laufende Stufe, statt Tiefen als feste Stufen anzulegen; die Erweiterung geschieht vor dem Abschluss des entdeckenden Jobs, die Stufe kann also nicht zu früh enden.
- **Rohe Antwort zuerst, Konvertierung danach.** Jeder Abruf holt die Seite selbst (Status, ETag, Rohdatei, robots); auch bei Jina/Firecrawl. Das kostet beim Vergleich eine doppelte Last je Seite, hält aber 404-, 304- und Archiv-Regeln für alle Konverter gleich.
- **`current_version_id` an `documents`** (technische Spalte, nicht in Spec 02): nötig, weil `(document_id, content_hash)` eindeutig ist und eine Rückkehr zu einem früheren Inhalt (A → B → A) sonst keinen gültigen Stand hätte. Dazu `raw_hash`, `final_url`, `content_type`, `char_count`, `run_id` an `document_versions` und `text_hash`, `heading`, `word_count`, `embedding_model` an `chunks`.
- **`carried_from_chunk_id` zeigt immer auf den Ursprungs-Chunk**, aus dem extrahiert wurde, nicht auf die direkte Vorversion; Embeddings werden kopiert, Schindeln nur für Ursprungs-Chunks geschrieben.
- **Chunk-Grenzen an Überschriften (Ebene 1–3) ohne Überlappung**, Überlappung nur innerhalb eines Abschnitts und nur für Absätze ≤ 200 Wörter (`maxOverlapWords`); so bleibt eine lokale Änderung lokal und die harte Grenze 800 gilt auch mit Überlappung.
- **4xx außer 404/410/429 ist kein fehlgeschlagener Job**, sondern eine Frontier-Zeile `failed`; nur vorübergehende Fehler laufen über Wiederholung und `failed_job`. Sonst füllten gesperrte Einzelseiten die Review-Queue.
- **Rate-Limit-Wartezeit im Crawl bis 10 min** (`maxRateWaitMs 600000`), Crawl-delay über 60 s wird als 1 Anfrage je Minute behandelt: bei 8 parallelen Jobs je Domain wartet ein Job höchstens 8 min, unter der pg-boss-Ablaufzeit von 15 min.
- **SERP-Deckel je Lauf (`maxQueriesPerRun 240`)** statt eines globalen Zählers: zwei Revierläufe bleiben unter dem Pilotbudget von 500 Aufrufen; wiederverwendete Queries zählen mit (konservativ). Ort/Sprache je Template: de → Deutschland (2276), en → Vereinigtes Königreich (2826), el → Griechenland (2300) – vorläufige Werte in `config/discovery.json`.
- **Ignorierte Domains** (`navily.com` wegen Grundprinzip 9, dazu Suchmaschinen, soziale Netze, Buchungsportale, Wikipedia) stehen in `config/discovery.json`; ohne diese Liste würde die Review-Queue mit Portalen geflutet.
- **Gewichte für `dataset` (0,9) und `other` (0,3) und Vorgaben für `changeRate` je Typ** ergänzen Spec 05, die nur sechs Typen nennt.
- **PDF: Vergleich nur `pdftotext` gegen Claude.** Für LlamaParse oder Mistral OCR gibt es keinen Schlüssel; sie bleiben als Option im Bericht vermerkt. Standard `pdftotext -layout` mit seitenweisem Claude-Fallback für unlesbare Seiten; Tabellen bleiben als eingezäunte Textblöcke mit Spalten, statt fehleranfällig in Markdown-Tabellen übersetzt zu werden.
- **PDF-Upload als Server Action mit 100 MB** (`serverActions.bodySizeLimit`, `proxyClientMaxBodySize`); gekaufte Führer brauchen eine Quelle, dafür gibt es „Quelle anlegen“ (`origin manual`).
- **robots je Host und Lauf im Archiv** (`robots/<host>/<runId>.json`), nicht je registrierbarer Domain: Subdomains (z. B. `de.wikivoyage.org`) haben eigene robots.txt. `<meta name="robots" content="nofollow">` wird beim Linkfolgen beachtet.
- **Wikivoyage-Dokumente entstehen über Wikidata-Sitelinks** der Gazetteer-Objekte (`wbgetentities`), nicht über Suche oder Crawl; die Quelle folgt keinen Links (`maxDepth 0`). Damit ist die aus M1 verschobene Spec-03-Anforderung erfüllt.
- **`restricted_areas.source_id` bekommt den FK auf `sources`**, bleibt aber leer: EMODnet als Quelle mit Gewicht braucht erst die Konsolidierung (M5).
- **Täglicher Fetch (RSS, Sitemaps) bleibt in M8** wie in Spec 05; `change_rate` wird in M3 nur gepflegt.

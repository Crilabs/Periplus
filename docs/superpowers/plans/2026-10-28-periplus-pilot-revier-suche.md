# Pilot Revier-Suche – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Lab-Skript, das für GR-I misst, wie viele Referenz-Spots das Web als Ankerplatz beschreibt, wie gut sich
Beschreibungen verorten lassen und was Claude-Websuche gegenüber DataForSEO bringt – mit Protokoll `P1-revier-suche.md`.

**Architecture:** Ein CLI `scripts/lab/region-search/cli.ts` mit Unterbefehlen je Stufe (areas, search, fetch, assess,
extract, gazetteer, locate, compare), die über JSONL-Dateien im Scratchpad verkettet sind; jede Stufe ist wiederholbar
und überspringt, was schon da ist. Reine Logik (Anfragen, Koordinaten, Zitatprüfung, Verortung, Cluster, Kennzahlen)
liegt in eigenen Modulen mit Tests; Netz- und Modellaufrufe sind dünne Wrapper ohne Tests. Navily wird nur in
`compare` gelesen.

**Tech Stack:** TypeScript/tsx, vitest, vorhandene Adapter (`searchOrganic`, `httpCall`, `htmlToMarkdown`, `convertPdf`,
`createAnthropicClient` für `assess-page`), direkter `@anthropic-ai/sdk` (0.135) für Websuche, Extraktion und
Modell-Verortung, MCP `sql`/`gate_input` über `scripts/mcp-client.ts`.

**Spec:** `docs/superpowers/specs/2026-10-28-periplus-pilot-revier-suche-design.md`

## Global Constraints

- Navily nie als Eingabe: kein Spot-Name, keine Koordinate in Anfragen, Prompts, Verortung, Logs, Commits. Navily nur in
  `compare`, nur als Zählung. Protokoll und Befund enthalten nur Zählungen, Quoten, unsere URLs/Domains.
- Kostenobergrenze **40 €** über alle Stufen, persistiert in `<scratchpad>/pilot-revier/costs.json`; jede kostenpflichtige
  Stufe prüft vor jedem Aufruf. Erwartung ~22 €.
- Modelle: `claude-sonnet-5-5` für Websuche, Extraktion, Verortung; `assess-page` mit der Pipeline-Konfiguration.
- Jedes Zitat wörtlich, geprüft mit `locateQuote` (`lib/domain/research/text/quote.ts`); Nennung ohne gültiges
  `berth_quote` wird verworfen, Koordinate ohne gültiges Zitat gelöscht.
- `skipDomains` aus `config/research.json` für beide Suchwege; `tripadvisor.*` wird für `blocked_domains` in
  `tripadvisor.com`, `tripadvisor.de`, `tripadvisor.co.uk`, `tripadvisor.it`, `tripadvisor.fr`, `tripadvisor.com.gr` aufgelöst.
- Kein Produktionscode, keine Änderung an `config/`, `lib/`, `package.json`. Alles unter `scripts/lab/region-search/`,
  Prompt unter `scripts/lab/region-search/prompts/`. Aufruf:
  `npx tsx --env-file-if-exists=.env.local scripts/lab/region-search/cli.ts <befehl>`.
- Scratchpad-Wurzel: `/private/tmp/claude-501/-Users-christian-Code-periplus/f0b9bd5c-4e73-45b5-90c3-62a74845f3d4/scratchpad/pilot-revier`
  (Umgebungsvariable `PILOT_DIR` überschreibt).
- Zweig `pruefung/attika-2`; Commits je Task; Commit-Fußzeile `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. Zitat steht auf der Seite, aber mit anderem Whitespace/Markdown (`**`, Zeilenumbruch) → muss als gültig gelten
   (Task 6: Test mit `**Name**` und Zeilenumbruch im Markdown).
2. Koordinaten in den Formen `37°31'N 23°27'E`, `37° 31.5' N`, `37.5167, 23.45`, `37,5167° N` (griechisch) und
   `N37 31.500 E023 27.100` → parsen, mit Genauigkeit (Task 5: je ein Testfall; ein Jahresdatum `2024` oder Preis `37,50 €` darf nicht als Koordinate gelten).
3. `blocked_domains` mit Platzhalter → API-400; Auflösung muss getestet sein (Task 3: `resolveBlockedDomains`).
4. Zwei Gazetteer-Objekte gleichen Namens in GR-I → „mehrdeutig“, nie das erste nehmen (Task 7: Test).
5. Kostenobergrenze muss stufenübergreifend und vor dem Aufruf greifen, auch nach Neustart des Skripts (Task 1: Test
   mit persistiertem Stand 39,99 € + 0,02 € → Abbruch).
6. Protokoll darf keine Navily-Werte enthalten (Task 9: Test, dass der gerenderte Bericht keine Koordinatenmuster und
   keinen Spot-Namen aus dem synthetischen Testdatensatz enthält).

---

### Task 1: Gerüst, Ablage, Kostenzähler

**Files:**
- Create: `scripts/lab/region-search/store.ts`, `scripts/lab/region-search/costs.ts`, `scripts/lab/region-search/cli.ts`
- Test: `scripts/lab/region-search/__tests__/costs.test.ts`

**Interfaces:**
- Produces: `pilotDir(): string` (aus `PILOT_DIR` oder Scratchpad-Wurzel, legt an); `readJsonl<T>(name): Promise<T[]>`,
  `appendJsonl<T>(name, rows: T[]): Promise<void>`, `writeJson(name, value)`, `readJson<T>(name): Promise<T | null>`;
  `class CostLedger { static async open(dir, capEur = 40): Promise<CostLedger>; totalEur: number; async add(entry: { stage: string; service: string; units: number; costEur: number }): Promise<void>; assertRoom(costEur: number): void }`
  – `assertRoom` wirft `CostCapReached`, wenn `totalEur + costEur > capEur`; `add` persistiert sofort nach `costs.json`.
- `cli.ts`: `main(argv)` verteilt auf Unterbefehle (zunächst nur `status`: druckt `totalEur` und Zeilenzahlen der JSONL-Dateien).

- [ ] **Step 1: Test schreiben** – `costs.test.ts`: (a) `open` auf leerem Verzeichnis → `totalEur` 0; (b) `add` zweimal, neu `open` → Summe persistiert; (c) Stand 39,99 → `assertRoom(0.02)` wirft `CostCapReached`, `assertRoom(0.01)` nicht. Verzeichnis: `mkdtemp`.
- [ ] **Step 2: Test laufen lassen** – `npx vitest run scripts/lab/region-search` → FAIL (Modul fehlt).
- [ ] **Step 3: `store.ts`, `costs.ts`, `cli.ts` schreiben** wie in Interfaces; JSONL eine Zeile je Objekt.
- [ ] **Step 4: Test laufen lassen** → PASS; `npx tsx --env-file-if-exists=.env.local scripts/lab/region-search/cli.ts status` druckt `0.00 EUR`.
- [ ] **Step 5: Commit** – `git add scripts/lab/region-search docs/superpowers/specs/2026-10-28-periplus-pilot-revier-suche-design.md docs/superpowers/plans/2026-10-28-periplus-pilot-revier-suche.md` ; `git commit -m "lab(pilot): region-search scaffold, store and cost ledger; spec and plan"`.

### Task 2: Gebiete und Anfragen

**Files:**
- Create: `scripts/lab/region-search/areas.ts`, `scripts/lab/region-search/mcp.ts`
- Test: `scripts/lab/region-search/__tests__/areas.test.ts`

**Interfaces:**
- `mcp.ts`: `mcpSql(query: string): Promise<{ columns: string[]; rows: unknown[][] }>` über `callMcpTool` (`PERIPLUS_MCP_URL`/`TOKEN`), packt `nicht_vertrauenswuerdig` aus; `mcpTool(name, args): Promise<unknown>`.
- `areas.ts`: `type Area = { key: string; names: { en: string; de: string; el: string } }`;
  `QUERY_TEMPLATES: Array<{ template: string; lang: "en" | "de" | "el" }>` (die 8 aus Spec 5A);
  `buildQueries(areas: Area[], templates = QUERY_TEMPLATES): Array<{ area: string; lang: string; keyword: string }>` – `{area}` durch den Namen der Sprache ersetzt (fehlt `de`/`el`, Englisch nehmen), Duplikate entfernt;
  `loadAreasFromGazetteer(): Promise<Area[]>` – `sql`: `geo_objects` von GR-I mit `type in ('island','gulf','archipelago','coast_section')` und Namen aus `geo_names` (`lang in ('en','de','el')`), `island` nur ≥ 5 km² (`ST_Area(geom::geography) >= 5e6`); dazu die festen Küstenabschnitte aus `AREAS_MANUAL` (Attika-Westküste „Vouliagmeni Sounion“, Attika-Ostküste „Lavrio Rafina“, „Methana“), wenn das Gazetteer sie nicht liefert. Ergebnis nach `areas.json`, Unterbefehl `areas` schreibt es und druckt die Liste (Christian prüft die Liste vor der Suche).

- [ ] **Step 1: Test** – `areas.test.ts`: 2 Gebiete × 8 Vorlagen = 16 Anfragen; Gebiet ohne `el` nutzt den englischen Namen; gleiche Keywords nur einmal; kein Keyword enthält `undefined`.
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren** (`mcp.ts` ohne Test: dünner Wrapper).
- [ ] **Step 4: PASS prüfen**; `cli.ts areas` ausführen, Liste ins Protokoll-Entwurf notieren (Scratchpad `notes.md`).
- [ ] **Step 5: Commit** – `lab(pilot): areas from gazetteer and query templates`.

### Task 3: Suchweg D (DataForSEO) und Domain-Filter

**Files:**
- Create: `scripts/lab/region-search/domains.ts`, `scripts/lab/region-search/search-dataforseo.ts`
- Test: `scripts/lab/region-search/__tests__/domains.test.ts`

**Interfaces:**
- `domains.ts`: `isSkippedDomain(domain: string, patterns: string[]): boolean` (Muster wie `config/research.json` `skipDomains`: exakt oder `name.*`; Subdomains zählen);
  `resolveBlockedDomains(patterns: string[]): string[]` (Platzhalter nach der Liste in Global Constraints, sonst unverändert);
  `registrableDomainOf(url: string): string` (Wrapper um die vorhandene Funktion `registrableDomain` aus `lib/domain/sources/…`, beim Bauen nachschlagen).
- `type Hit = { url: string; domain: string; engine: "d" | "c"; area: string; lang: string; keyword: string; rank: number; chosen?: boolean }` → `hits.jsonl`.
- `search-dataforseo.ts`: `runSearchD(db: Db, ledger: CostLedger): Promise<void>` – je Anfrage aus `buildQueries` einmal `searchOrganic(getTransport(), { keyword, languageCode, locationCode: research.locationCodes[lang] }, { db, stage: "lab.search" }, discovery.serp)`; vor dem Aufruf `assertRoom(serp.costPerQueryEur)`, danach `add`; fertige Keywords aus `queries-d.jsonl` überspringen; Hits ohne `isSkippedDomain` anhängen.

- [ ] **Step 1: Test** – `domains.test.ts`: `tripadvisor.de` und `www.tripadvisor.com` werden von `tripadvisor.*` übersprungen, `booking.com` von `booking.com`, `navily.com` und `www.navily.com` von `navily.com`, `expedia.com` nicht; `resolveBlockedDomains(["navily.com","tripadvisor.*"])` enthält `tripadvisor.com` und `tripadvisor.de`, keinen `*`.
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren**; `cli.ts search --engine d` verdrahten (DB aus `DATABASE_URL`, `createDb`).
- [ ] **Step 4: PASS prüfen**; Probelauf mit `--limit 2` Anfragen; `status` zeigt Kosten ≈ 0,007 €.
- [ ] **Step 5: Commit** – `lab(pilot): DataForSEO region search and domain filter`.

### Task 4: Suchweg C (Claude mit Websuche)

**Files:**
- Create: `scripts/lab/region-search/search-claude.ts`
- Test: `scripts/lab/region-search/__tests__/search-claude.test.ts`

**Interfaces:**
- `parseSearchMessage(message: Anthropic.Message): { queries: string[]; results: Array<{ url: string; title: string | null }>; chosen: string[] }` – `queries` aus `server_tool_use`-Blöcken (`input.query`), `results` aus `web_search_tool_result`-Blöcken (Fehlerobjekt statt Liste → leer), `chosen` aus dem letzten JSON-Codeblock im Text (`{"urls":[...]}`), ungültig → leer.
- `searchCostEur(usage: Anthropic.Usage): number` – Tokens zu Sonnet-5.5-Preisen (2 $/10 $ je MTok, Cache-Lesen 0,20 $) plus `usage.server_tool_use.web_search_requests` × 0,01 $, Kurs 0,92 €/$.
- `runSearchC(ledger: CostLedger, areas: Area[]): Promise<void>` – je Gebiet ein `client.messages.create` mit `model: "claude-sonnet-5-5"`, `max_tokens: 8000`, `tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 12, blocked_domains: resolveBlockedDomains(skipDomains) }]`, Systemtext: Auftrag aus Spec 5A (Seiten finden, die Ankerplätze in `{area}` für Segler beschreiben; Sprachen en/de/el; am Ende ein JSON-Block `{"urls":[…]}` mit den 10–25 tragendsten URLs; keine Inhalte wiedergeben). `assertRoom(0.60)` vor dem Aufruf, `add` mit `searchCostEur`; Hits: alle `results` mit `engine: "c"`, `chosen: true` für die URLs aus dem JSON; Gebiet fertig → `queries-c.jsonl` mit den gestellten Anfragen; fertige Gebiete überspringen.

- [ ] **Step 1: Test** – `search-claude.test.ts`: ein fabriziertes `Message`-Objekt mit einem `server_tool_use`, einem `web_search_tool_result` mit 2 Ergebnissen, einem Fehler-Resultat, und einem Text mit JSON-Block → 1 Anfrage, 2 Ergebnisse, `chosen` 1 URL; `searchCostEur` für 100k Eingabe, 2k Ausgabe, 8 Suchen ≈ 0,28 € (±0,01).
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren**; `cli.ts search --engine c [--area key]`.
- [ ] **Step 4: PASS prüfen**; Probelauf mit einem Gebiet; Anfragen und Kosten in `notes.md`.
- [ ] **Step 5: Commit** – `lab(pilot): Claude web search per area`.

### Task 5: Koordinaten

**Files:**
- Create: `scripts/lab/region-search/coords.ts`
- Test: `scripts/lab/region-search/__tests__/coords.test.ts`

**Interfaces:**
- `type Coord = { lat: number; lon: number; precisionM: number; text: string }`;
  `parseCoordinate(text: string): Coord | null` (ein Koordinatenpaar); `coordinatesIn(md: string): Coord[]` (alle Paare im Text, Reihenfolge wie im Text, Dubletten derselben Stelle entfernt).
- Genauigkeit: Grad/Minute ohne Dezimalen 900 m; eine Minuten-Dezimale 90 m; zwei 10 m; drei 1 m; Dezimalgrad je Nachkommastelle 10^(5−n) m (n=4 → 10 m); Sekunden 30 m.
- Plausibilität: lat 30–46, lon 15–30 (Mittelmeer-Ost; alles andere `null`).

- [ ] **Step 1: Test** – die fünf Formen aus Review Focus 2 → erwartete lat/lon (±0,0005) und `precisionM`; `2024`, `37,50 €`, `ISBN 978-3`, Telefonnummer → `null`/leer; Markdown mit zwei Paaren → zwei Treffer.
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren** (ein Regex je Form, dann Umrechnung).
- [ ] **Step 4: PASS prüfen.**
- [ ] **Step 5: Commit** – `lab(pilot): coordinate parsing`.

### Task 6: Abruf, Bewertung, Extraktion

**Files:**
- Create: `scripts/lab/region-search/fetch.ts`, `scripts/lab/region-search/assess.ts`, `scripts/lab/region-search/extract.ts`, `scripts/lab/region-search/prompts/extract-anchorages.md`
- Test: `scripts/lab/region-search/__tests__/extract.test.ts`

**Interfaces:**
- `fetch.ts`: `fetchToMarkdown(url: string, ctx: { db: Db }): Promise<{ markdown: string; title: string | null; finalUrl: string } | { error: string }>` – `httpCall(getTransport(), { service: "lab-fetch", operation: "page", url, timeoutMs: fetch.timeoutMs, ratePerMinute: 20, rateKey: registrableDomainOf(url), maxBodyBytes: fetch.maxRawBytes, okStatuses: [404, 410] }, ctx)`; HTML → `htmlToMarkdown(html, url, [])`; `application/pdf` → `convertPdf` (beim Bauen Signatur nachschlagen); robots: `robotsAllows` aus `lib/domain/sources`, falls exportiert, sonst Notiz im Protokoll. Ergebnis je URL als `pages/<sha1(url)>.md` plus Zeile in `pages.jsonl` `{ url, domain, file, title, chars, error? }`; vorhandene überspringen. Unterbefehl `fetch [--concurrency 4]`.
- `assess.ts`: `runAssess(db, ledger)` – je Seite ohne Zeile in `assessments.jsonl`: `createAnthropicClient(db).call(assessPageTask, { url, title, fetchedAt, publishedAt: null, text: firstWords(md, research.assessWords) }, { stage: "lab.assess" })`; `assertRoom(0.02)` vorher, `add(result.costEur)`; Zeile `{ url, page_kind, first_hand, generated, language, berths, costEur }`. `countingKinds = research.confirmation.countingPageKinds`.
- `extract.ts`: `type Mention = { url: string; domain: string; name: string; aliases: string[]; area: string | null; kind: "anchorage" | "mooring_field" | "port" | "marina" | "unknown"; coordinate: Coord | null; coordinateQuote: string | null; positionQuote: string | null; berthQuote: string; firstHand: boolean; pageKind: string }`;
  `extractionSchema` (zod) für die Modellantwort `{ mentions: Array<{ name, aliases, area, kind, coordinate_text, coordinate_quote, position_quote, berth_quote }> }`;
  `validateMentions(raw: ExtractionOutput, markdown: string, page: { url; domain; first_hand; page_kind }, quoteCfg: { minChars: number; maxChars: number }): { mentions: Mention[]; dropped: Array<{ name: string; reason: string }> }` – `berth_quote` mit `locateQuote` prüfen, sonst verwerfen; `coordinate_quote` prüfen und `parseCoordinate(coordinate_text)`, bei Fehler Koordinate `null`; `position_quote` prüfen, sonst `null`;
  `runExtract(ledger)` – je zählender Seite (`page_kind` in `countingKinds`, nicht `generated`) ohne Zeile in `mentions.jsonl`: direkter SDK-Aufruf `claude-sonnet-5-5`, `max_tokens: 16000`, `output_config: { effort: "medium", format: { type: "json_schema", schema: structuredOutputSchema(z.toJSONSchema(extractionSchema)) } }`, System aus `prompts/extract-anchorages.md` (Regeln aus Spec 5C: nur was die Seite sagt, jedes Feld mit wörtlichem Zitat, Koordinaten nur wörtlich, Badestrände ohne Liegeplatz-Aussage weglassen), Text = ganzes Markdown bis `extraction.maxUnitWords` Wörter; `assertRoom(0.05)`; Kosten aus `usage` wie Task 4 ohne Suchen. Zusätzlich `regexCoords.jsonl`: je Seite `coordinatesIn(md).length`.

- [ ] **Step 1: Test** – `extract.test.ts` für `validateMentions`: (a) Zitat mit `**Russian Bay**` und Zeilenumbruch im Markdown → gültig; (b) Zitat, das nicht im Text steht → verworfen mit Grund; (c) `coordinate_text` `37°31'N 23°27'E` mit gültigem Zitat → `coordinate` gesetzt; dasselbe mit Zitat, das nicht im Text steht → `coordinate` `null`, Nennung bleibt.
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren** (`fetch.ts`, `assess.ts`, `runExtract` ohne Test); Prompt schreiben.
- [ ] **Step 4: PASS prüfen**; `fetch --limit 5`, `assess --limit 5`, `extract --limit 2` als Probelauf; Kosten in `notes.md`.
- [ ] **Step 5: Commit** – `lab(pilot): fetch, assess and anchorage extraction with quote checks`.

### Task 7: Gazetteer und Verortung

**Files:**
- Create: `scripts/lab/region-search/gazetteer.ts`, `scripts/lab/region-search/locate.ts`, `scripts/lab/region-search/locate-model.ts`
- Test: `scripts/lab/region-search/__tests__/locate.test.ts`

**Interfaces:**
- `gazetteer.ts`: `type GazObject = { id: string; type: string; category: string | null; names: string[]; lon: number; lat: number; islandName: string | null }`;
  `loadGazetteer(): Promise<GazObject[]>` – `sql` seitenweise (`order by id limit 500 offset n`): Objekte von GR-I mit `type in ('bay','harbour','cape','settlement','island','islet','poi')` (`poi` nur `category = 'beach'`), `ST_X/ST_Y(centroid)`, `string_agg` der Namen (`geo_names`, alle Sprachen), `islandName` = Name des nächsten `island`-Vorfahren über `parent_id` (zwei Stufen); Ergebnis `gazetteer.json`. Unterbefehl `gazetteer`.
- `locate.ts`: `type Located = Mention & { method: "coordinate" | "gazetteer" | "model" | null; lon: number | null; lat: number | null; reason: string | null; gazId: string | null }`;
  `locateByGazetteer(m: Mention, gaz: GazObject[], affixes: NameAffixesConfig): { object: GazObject } | { reason: "no_match" | "ambiguous" }` – Kandidaten: `berthNameMatches({ name, island: area }, obj.names, affixes, obj.islandName ? [obj.islandName] : [])` für `name` und jede `alias`; mehrere Treffer, die > 300 m auseinanderliegen (`distanceM` aus `lib/domain/gazetteer/rings.ts`) → `ambiguous`; mehrere ≤ 300 m → das erste nach Typ-Rang `bay, harbour, poi, cape, settlement, island, islet`;
  `locateAll(mentions, gaz, affixes): Located[]` – Reihenfolge Koordinate (wenn `coordinate` im Plausibilitätsfenster) → Gazetteer → `null` mit Grund (`no_name`, `no_match`, `ambiguous`), `method: "model"` wird in Task 7b gesetzt.
- `locate-model.ts`: `locateByModel(ledger, unresolved: Located[], gaz: GazObject[]): Promise<Located[]>` – je Nennung mit `area`: Sonnet, `output_config.format` JSON `{ gazetteer_id: string | null }`, Eingabe: Nennung (name, aliases, area, position_quote) und die ≤ 80 Gazetteer-Objekte des Gebiets (Objekte, deren `islandName` oder Name das Gebiet enthält, sonst die 80 nächsten zum Gebietsmittel); `null` erlaubt; `assertRoom(0.01)`. Ergebnis `located.jsonl` mit `method: "model"`. Unterbefehl `locate [--model]`.

- [ ] **Step 1: Test** – `locate.test.ts` mit drei synthetischen Objekten (Phantasienamen, keine echten Ortsnamen): Name trifft genau eines → `gazetteer`; zwei gleichnamige 5 km auseinander → `ambiguous`; zwei gleichnamige 100 m auseinander (bay, settlement) → bay; Nennung mit Koordinate → `coordinate` unabhängig vom Namen; Name ohne Treffer → `no_match`.
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4: PASS prüfen**; `gazetteer` laufen lassen, Objektzahl je Typ in `notes.md`.
- [ ] **Step 5: Commit** – `lab(pilot): gazetteer export and localization (coordinate, name, model)`.

### Task 8: Cluster und unabhängige Quellen

**Files:**
- Create: `scripts/lab/region-search/cluster.ts`
- Test: `scripts/lab/region-search/__tests__/cluster.test.ts`

**Interfaces:**
- `type WebPlace = { id: number; lon: number; lat: number; mentions: Located[]; sourcesStrict: number; sourcesAll: number; methods: Record<string, number>; engines: { d: boolean; c: boolean } }`;
  `clusterLocated(located: Located[], radiusM = 300): WebPlace[]` – greedy: Nennung zum ersten Cluster, dessen Mittel ≤ `radiusM` entfernt ist, Mittel neu berechnen; Reihenfolge nach `method` (coordinate zuerst);
  `independentSources(mentions: Located[], copyMinSharedWords: number, strict: boolean): number` – Gruppen je `registrableDomainOf(url)`; zwei Gruppen verschmelzen, wenn `copiesSource(a.berthQuote, b.berthQuote, copyMinSharedWords)`; `strict` zählt nur Nennungen mit `firstHand || pageKind === "pilot_guide"`;
  `engines` aus `hits.jsonl` (welche Engine die URL geliefert hat; beide möglich).

- [ ] **Step 1: Test** – drei Nennungen, zwei 100 m auseinander, eine 2 km → zwei Cluster; Quellen: zwei Domains mit identischem 15-Wort-Zitat → 1; zwei Domains mit verschiedenen Zitaten → 2; `strict` mit einer `travel_guide`-Nennung → 1.
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4: PASS prüfen.**
- [ ] **Step 5: Commit** – `lab(pilot): web-place clustering and source independence`.

### Task 9: Abgleich und Bericht

**Files:**
- Create: `scripts/lab/region-search/compare.ts`, `scripts/lab/region-search/report.ts`
- Test: `scripts/lab/region-search/__tests__/compare.test.ts`

**Interfaces:**
- `compare.ts`: `type Denominator = { name: string; spots: NavilySpot[]; clusters: Array<{ lon: number; lat: number; members: number[] }> }`;
  `denominators(spots: NavilySpot[], gate: { tiles: { all: string[]; worked: string[] }; bufferM: number }, navilyCfg): Denominator[]` – „Kacheln GR-I“: `tileIdFor(lon, lat) ∈ tiles.all` und nicht `isExcludedSpot`; „Tor-Kacheln“: wie `evaluateGateInput` (`tileAreas(worked, bufferM).inside`, beim Bauen nachschlagen, ob exportiert; sonst `tileIdFor ∈ worked`); Spot-Cluster ≤ 300 m greedy wie Task 8;
  `type Metrics = { denominator: string; spots: number; clusters: number; covered1: Record<"150"|"300"|"600", number>; confirmedStrict300: number; confirmedAll300: number; clustersConfirmedStrict300: number; clustersConfirmedStrict300WithModel: number; byEngine: { dOnly: number; cOnly: number; both: number }; byMethod: Record<string, number>; coordMentions: { count: number; medianDistanceM: number | null; within150: number }; conflicts300: number; unresolved: Record<string, number>; unresolvedWithPosition: number }`
  (`unresolvedWithPosition`: unverortete Nennungen, die ein `positionQuote` haben – Spec 5D Punkt 3);
  `measure(places: WebPlace[], located: Located[], den: Denominator): Metrics` – „gedeckt“: nächster Web-Ort ≤ r; „bestätigt“: Web-Ort ≤ 300 m mit `sourcesStrict ≥ 2` (bzw. `sourcesAll`); `WithModel`: Web-Orte inkl. `method: "model"`, sonst ohne; `conflicts300`: Web-Orte mit `sourcesStrict ≥ 2` ohne Spot ≤ 300 m.
- `report.ts`: `renderReport(input: { metrics: Metrics[]; costs: CostLedger; counts: { queriesD; queriesC; hitsD; hitsC; pages; assessed; counting; mentions; dropped }; topDomains: Array<{ domain: string; pages: number; mentions: number }>; generatedAt: Date }): string` – Markdown mit den Tabellen aus Spec 5E, Entscheidungsregel aus Spec 6 angewandt (bindende Zahl: `clustersConfirmedStrict300 / clusters` des Nenners „Kacheln GR-I“), Abschnitt Kosten; keine Spot-Namen, keine Koordinaten der Spots.
- Unterbefehl `compare`: lädt `gate_input` über `mcpTool("gate_input", { subdivision: "GR-I" })`, Navily über `loadNavilySpots(NAVILY_SPOTS_PATH)`, schreibt `metrics.json`, Einzellisten `lists/*.tsv` ins Scratchpad und den Bericht nach `docs/pilot/neuausrichtung/attika-2/P1-revier-suche.md`.

- [ ] **Step 1: Test** – `compare.test.ts` mit synthetischen Spots (Phantasienamen, Koordinaten in der Nordsee) und Web-Orten: ein Spot mit Web-Ort 100 m (2 strikte Quellen) → `covered1[150]` 1, `confirmedStrict300` 1; Spot mit Web-Ort 500 m → nur `covered1[600]`; Web-Ort ohne Spot → `conflicts300` 1; `prohibited`-Spot zählt nicht; zwei Spots 100 m auseinander → ein Cluster; `renderReport` enthält keinen der Phantasienamen und kein Koordinatenmuster (`coordinatesIn(report).length === 0`).
- [ ] **Step 2: FAIL prüfen.**
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4: PASS prüfen.**
- [ ] **Step 5: Commit** – `lab(pilot): reference comparison and report`.

### Task 10: Durchführung und Protokoll

**Files:**
- Create: `docs/pilot/neuausrichtung/attika-2/P1-revier-suche.md` (aus `compare`, dann von Hand ergänzt: Vorgehen, Beobachtungen, Empfehlung)
- Modify: `docs/pilot/pruefung/befunde.md` (neue Befunde ab B36, falls welche entstehen)

- [ ] **Step 1: `areas`** – Liste prüfen (≈ 13 Gebiete), Abweichungen notieren.
- [ ] **Step 2: `search --engine d`** – Kosten erwartet ≤ 0,5 €; `status`.
- [ ] **Step 3: `search --engine c`** – Kosten erwartet ≤ 8 €; nach dem ersten Gebiet Anfragen und Kosten prüfen, dann alle.
- [ ] **Step 4: `fetch`** – Fehlerquote und Domains in `notes.md`.
- [ ] **Step 5: `assess`** – erwartet ≤ 10 €; `page_kind`-Verteilung notieren.
- [ ] **Step 6: `extract`** – erwartet ≤ 10 €; Verworfene nach Grund notieren.
- [ ] **Step 7: `gazetteer`, `locate`, `locate --model`** – Verteilung der Methoden notieren.
- [ ] **Step 8: `compare`** – Bericht erzeugt; Einzellisten im Scratchpad gegenlesen (Stichprobe 10 „bestätigte“ und 10 „Konflikte“ mit Luftbild-Plausibilität, Ergebnis nur als Zählung ins Protokoll).
- [ ] **Step 9: Protokoll fertigstellen** – Abschnitte: Vorgehen, Zahlen (aus dem Bericht), Beobachtungen (Suchanfragen von Claude, tragende Domains, Koordinaten-Genauigkeit), Entscheidungsregel angewandt, Empfehlung für T8; Befunde eintragen.
- [ ] **Step 10: Commit** – `docs(pruefung): P1 Revier-Suche – Ergebnis und Empfehlung`; Christian Bericht und Kostenstand melden.

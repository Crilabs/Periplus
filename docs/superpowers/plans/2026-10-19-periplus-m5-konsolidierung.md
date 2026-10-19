# Periplus M5 – Konsolidierung und Änderungen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stufe 8 für das Pilotgebiet als Job: aus Facts, Berechnungen, Review-Facts und Gazetteer je Geo-Objekt ein versioniertes Profil mit einer prüfbaren Regel je Attribut, Konfidenz und Herkunft je Attribut, Konflikten, Lückenliste, abgeleiteten Werten (Ruhe, POI-Bedeutung mit Spot-Zuordnung, Saisonhinweise, Profil-Konfidenz, Summary) und typisierten Änderungsereignissen mit `seq`-Cursor; Review `conflict` und `uncertain_change`; gezielte Quellenfindung für Orte mit weniger als zwei Dokumenten; Ort-Reiter „Profil“ (Herkunft je Attribut, Klick auf die Facts) und „Zeitachse“ (Versionsregler mit Diff, Ereignisse, Profil zum Datum).

**Architecture:** Eine Stufe `consolidation.geo` (ein Job je Geo-Objekt) lädt die Eingänge (`lib/domain/consolidation/inputs.ts`), wendet je Attribut die im Fact-Schema benannte Regel an (eine reine Funktion je Regelname in `lib/domain/consolidation/rules/`, Parameter in `config/consolidation/<version>.json`), bildet abgeleitete Werte und Lücken (`build.ts`), vergleicht mit dem gültigen Profil (`changes.ts`, rein) und schreibt unter einem Advisory-Lock nur bei Änderung eine neue Profilversion, Ereignisse und Review-Aufgaben (`store.ts`). Danach `consolidation.summary` (Summary je neuer Version, 15-Wörter-Prüfung gegen `text_shingles`) und `consolidation.followup` (Lauf `discovery.place` für dünn belegte Orte). Die drei Stufen hängen an jedem Text-Lauf (M4) und bilden den Lauf „Konsolidieren“ (Kachel, Revier, Geo-Objekte, Bewertung ohne Change-Feed). Externe Signale (Straßen aus Overpass, Wikidata-Sitelinks) kommen als Datensätze über `datasets.import` (M2), die Konsolidierung selbst ruft kein Netz außer dem Summary-Modell.

**Tech Stack:** wie M4 (Next.js 16.4.2, React 19.3, Drizzle 0.45, pg-boss 12, zod 4, Vitest 5, Playwright 1.64, `@anthropic-ai/sdk`), keine neuen npm-Abhängigkeiten.

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-07-konsolidierung-design.md` (primär), `…-02-datenmodell-design.md` (`profiles`, `change_events` mit `seq`, `profile_as_of` in `lib/domain/timeline.ts`, Review-Facts), `…-09-admin-ui-design.md` (Ort-Reiter „Profil“ und „Zeitachse“, Review `conflict`/`uncertain_change`, Karte „Orte nach Profil-Konfidenz“), `…-10-qualitaet-pilot-design.md` (Belegtreue sperrt die Konsolidierung, Bewertungslauf ohne Change-Feed), `…-08-liefervertrag-api-design.md` (nur Severity-Semantik, 15-Wörter-Regel, Bedeutungsradius), Gesamtdesign `…-periplus-design.md` (Roadmap M5, Abschnitt 4 Highlights als `poi`). Fachlich maßgebend: `.idea/datendienst-spec.md` (Stufe 8, „Zeitachse und Wiederholung“, „Änderungserkennung und Versionierung“, „Review und Freigabe“, Teil B Spot/Highlight). Baut auf den Plänen M2 (`facts`, `computations`, `latestComputations`, `canonicalJson`, Fact-Schema v1, `datasets.import`, Ruhe-Computation), M3 (`sources.weight`/`type`, `documents.status`/`last_checked_at`, `shingleHashes`, `text_shingles`, `DiscoveryQuery`, `runQuery`, `discovery.propose`) und M4 (Fact-Schema v2 mit Regelnamen, `activeExtractionRun`, `belegtreue`, `effectiveVersionMeta`, `levelFor`, `TEXT_RUN_STAGES`, `geoFacts`/`FactView`, `ModelClient`/`MockModel`) auf.

## Global Constraints

- Alle Global Constraints aus M0–M4 gelten weiter (Next 16.4.2, Next-Doku in `node_modules/next/dist/docs/` vor Routen, `proxy.ts`, `next.config.ts`; kein `console.*`; Englisch im Code, Deutsch in der UI; Tests gegen `db-test`, kein Netz, KI nur über `MockModel`; Route-Policy je Route; `external_calls` je Aufruf; Schwellen, Gewichte, Prompts in `config/`; Tests zählen nie DB-weit; Geo-Testdaten in `withRollback` oder außerhalb der Pilotbox 23,0–23,75° O × 37,0–38,0° N, Synthetik um 21,0° O / 35,2° N).
- „Jede Regel ist eine reine Funktion `(facts, context) → { value, confidence, origin, observedAt, factIds, conflict? }` in `lib/domain/consolidation/rules/`“; Regelname je Attribut aus dem Fact-Schema, Parameter in der Konsolidierungs-Konfiguration, Version als `rules_version`.
- Regeln: `shelter.<Sektor>` „Basis = berechneter Wert. Text-Facts korrigieren um höchstens eine Stufe (±0,3); widersprechen sich Texte, gilt der schlechtere Wert. Häfen/Marinas: Untergrenze 0,8, außer ein Text (Konfidenz ≥ 0,7) belegt eine offene Seite.“ – `swell_protection` „Text vor Berechnung, wenn ein Text-Fact ≥ 0,7 existiert; sonst berechnet.“ – `depth.*`, `seabed` „Bathymetrie; Text nur als Korrektur bei Konfidenz > 0,8. Bei Rasterkonfidenz < 0,4 und vorhandenem Text-Fact gilt der Text.“ – `holding` „Nur Text; Mehrheit gewichtet nach Quellengewicht × Konfidenz × Aktualität.“ – `services.*`, `mooring.buoys`, `highlight.*` „Jüngste Beobachtung gewinnt; bei gleichem Monat die stärkere Quelle. Zeitverlauf (2019 ja, 2024 nein) = Änderung, kein Konflikt.“ – `occupancy` „Verteilung je Monat …; Monat ohne Daten `unknown`.“ – `highlight.*` (Liste) „Vereinigung, sortiert nach Zahl unabhängiger Nennungen.“ – `prohibitions` „Jede Nennung gilt, bis eine jüngere Quelle vom Typ `authority` sie aufhebt.“ – Revier-Facts „Gewichteter Mittelwert (numerisch) bzw. Mehrheit (Enum).“ – Standard „jüngste Beobachtung mit Konfidenz ≥ 0,5, sonst gewichtete Mehrheit.“
- Aktualität `0,5 ^ (Alter in Jahren / 3)`; Unabhängigkeit: „mehrere Dokumente derselben Quelle zählen als eine Nennung; derselbe Text in zwei Versionen zählt einmal“.
- Konflikt: „zwei Werte, die sich nicht über die Zeit ordnen lassen (Beobachtungsdaten im selben Saisonjahr oder unbekannt) und deren Gewichtssummen sich um weniger als Faktor 1,5 unterscheiden“; Profil zeigt den höher gewichteten Wert mit Vermerk; Admin-Entscheidung „Wert A, Wert B, beide = saisonal, offen lassen“; Review-Fact geht „künftig mit Konfidenz 0,95“ ein.
- Konfidenz je Attribut: `computed` Basiswert aus M2, `text` = Fact-Konfidenz × Quellengewicht, „bestätigt durch zweite unabhängige Quelle +0,15, gedeckelt bei 0,95, abgewertet mit Aktualität“; Profil-Konfidenz = gewichteter Mittelwert über Schutz, Tiefe, Grund, Ausschluss.
- Abgeleitet: `popularity` 0–1 „logarithmisch normiert innerhalb des Reviers (Maximum des Reviers = 1)“; `quietness` 0–1 aus Siedlungs- und Straßenabstand, Belegung Juli/August, Text-Facts, Fährverkehr, Formel in Konfiguration; `importance` 1–5 „aus Zahl und Gewicht der Quellen, Wikidata-Sitelinks und Kategorie“, Bedeutungsradius „5/10/20/35/50 sm“, `spotIds` = „bestätigte Orte im Radius, nach Distanz“; `summary.de` „zwei bis vier Sätze … ausschließlich aus dem konsolidierten Profil (Werte, keine Zitate)“, nur bei geändertem Profil, 15-Wörter-Treffer → „mit Hinweis neu (max. 2×, sonst leer und Review)“.
- Ereignisse: `new_attribute` (vorher kein Wert), `changed` („gestützt durch ≥ 2 unabhängige Beobachtungen oder eine Quelle mit Gewicht > 0,8“), `uncertain` („Profil behält den alten Wert, Review-Aufgabe `uncertain_change`“), `expired` („älter als zwei Zyklen der Kachel; Wert bleibt, Konfidenz sinkt um eine Klasse, Vermerk“), `place_new`, `place_abandoned`, `geo_changed`. `severity` `safety` bei `exclude`, Schutzsektor „um > 0,2“, Tiefgang/Länge, `hazards`; `notable` bei Services, Highlights, Belegung; sonst `info`. `seq` ist der Cursor des Change-Feeds.
- „Neue Profilversion nur, wenn sich Werte oder Konfidenzklassen geändert haben; `valid_from` = Datum des Laufs.“ `profile_as_of(geo_object_id, date)` = „Profil mit größtem `valid_from <= date`“, genau einmal in `lib/domain/timeline.ts`.
- `profiles`, `change_events`, `profile_summaries` nur anfügend (`forbid_mutation('')`); eindeutig `(geo_object_id, version)`.
- Folgeaufträge: „Ort mit < 2 Dokumenten → gezielte Quellenfindung für diesen Ort (`discovery.place`, Kachel-Templates mit seinem Namen; Budget-gebunden). Konflikt ohne Zeitverlauf → Review-Aufgabe `conflict`.“
- Belegtreue „< 100 % sperrt die Konsolidierung des Laufs“; Bewertungslauf (Kennzeichen `evaluation`) „ohne Änderungsereignisse in den Change-Feed“.
- Eingänge: „alle Facts des Geo-Objekts aus dem aktiven Extraktionslauf je Dokumentversion“; Facts aus Dokumenten mit `status = gone` „zählen mit ihrem `observed_at` weiter, gelten aber ab dem Verschwinden nicht mehr als ‚aktuell bestätigt‘“.
- Abnahme M5: „jedes bestätigte Pilot-Geo-Objekt hat ein Profil; Lückenliste und Herkunft je Attribut in der UI; Profil zum Datum abrufbar“; Roadmap: „Profil jedes Orts in der UI mit Herkunft je Attribut; Zeitregler zeigt alten Stand“.

## Review Focus

1. **Wiederholte Konsolidierung ohne neue Eingänge** (zweiter Lauf am selben oder nächsten Tag, andere Eingangsreihenfolge, Gleitkomma-Rauschen aus gewichteten Mitteln, Aktualität ein Tag älter): keine neue Version, keine Ereignisse, keine neuen Aufgaben – sonst flutet der Change-Feed täglich. → Task 10 Test `shuffled inputs give the same content hash`, Task 12 Tests `a second consolidation creates nothing`, `one day later without new facts creates nothing`.
2. **Schwache Einzelquelle widerspricht** (ein Forum sagt „keine Taverne mehr“): Profil behält den alten Wert, genau ein `uncertain`-Ereignis und eine Aufgabe über beliebig viele Folgeläufe; nach „Verwerfen“ kein erneutes Aufkommen für dieselben Facts, nach einer zweiten unabhängigen Quelle `changed`. → Task 11 Tests, Task 12 Test `an uncertain change opens one task over three runs`, Task 13 Test `discard keeps the old value on the next run`.
3. **Derselbe Text zählt doppelt** (zwei Seiten derselben Quelle, alte und neue Extraktionsläufe nach Reprozessierung, Vergleichsläufe aus M4, übernommene Chunks): eine Nennung je Quelle, nur der aktive Extraktionslauf je Dokumentversion – sonst wird aus einer Quelle eine „Bestätigung“ und aus `uncertain` ein `changed`. → Task 7 Tests `facts of a non-active extraction run are ignored`, `two documents of one source share one source key`; Task 11 Test `two documents of one forum are still uncertain`.
4. **Schutz bei Häfen und dünnen Daten** (Marina ohne Text, Marina mit belegter offener Seite, Bucht ohne Berechnung, zwei widersprüchliche Texte): Untergrenze 0,8 nur ohne Beleg einer offenen Seite, Korrektur höchstens ±0,3, immer 8 Sektorwerte bei Häfen. → Task 4 Tests.
5. **Gleichzeitige Konsolidierung desselben Objekts** (Text-Lauf und manueller Lauf überlappen, Job-Wiederholung nach Absturz): keine doppelte Versionsnummer, keine doppelten Ereignisse, `seq` streng steigend. → Task 12 Test `two parallel consolidations write one version`.

---

## File Structure

```
lib/db/schema/profiles.ts                profiles, change_events, profile_summaries, evaluation_profiles,
                                         place_discovery_requests, road_lines, wikidata_sitelinks (+ Enums)
drizzle/00NN_*.sql                       generiert + handgeschrieben (Trigger, Indizes, seq)
lib/domain/timeline.ts                   + profileAsOf, latestProfile
config/consolidation/{v1.json,active.json}
config/prompts/summarize-profile/v1.md, config/models.json (+ summarize-profile), config/queues.json
config/geometry.json (rulesVersion), config/datasets.json (+ roads, sitelinks)
lib/config/{schemas,index}.ts            + consolidation
lib/domain/consolidation/
  types.ts                               ConsolidationInput, RuleResult, AttributeProvenance, ConflictNote, …
  weights.ts                             recency, inputWeight, attributeConfidence, confidenceClass, pickDiscrete
  rules/{shelter,swell-protection,bathymetry,holding,latest-observation,highlight,occupancy,
         prohibitions,area-weighted,default,computed-only,review-over-computed,index}.ts
  derived/{quietness,importance,season,confidence,popularity}.ts
  inputs.ts                              loadInputs, loadContext, loadDerivedInputs
  build.ts                               buildProfile
  changes.ts                             diffProfiles, severityFor
  store.ts                               consolidateGeo
  targets.ts                             consolidationTargets
  followup.ts                            thinPlaces, placeQueries
  summary.ts                             summaryInput, checkSummary
  format.ts                              formatProfileValue (UI und Summary)
lib/domain/documents/archive-copies.ts   findArchiveCopies (15-Wörter-Prüfung)
lib/domain/{profile-view,profile-timeline}.ts
lib/domain/review-decisions.ts, lib/domain/review-view.ts
lib/ai/tasks/summarize-profile.ts
lib/adapters/{overpass,wikidata}.ts      + buildRoadsQuery, wikidataSitelinks
lib/pipeline/datasets.ts                 + roads, sitelinks
lib/pipeline/geometry.ts                 Ruhe-Computation + Straßenabstand
lib/pipeline/consolidation/{geo,summary,followup,run}.ts
lib/pipeline/discovery.ts                + discovery.place
lib/pipeline/text/run.ts                 TEXT_RUN_STAGES + Konsolidierung
lib/jobs/{queues,stages,registry}.ts, lib/jobs/handlers/consolidation.ts
lib/domain/map-data.ts                   Orte: profileConfidence
app/(admin)/places/[id]/{page.tsx,profile-tab.tsx,timeline-tab.tsx,version-slider.tsx,actions.ts}
app/(admin)/geo/[id]/page.tsx, app/(admin)/tiles/[id]/{page.tsx,actions.ts}, app/(admin)/runs/[id]/page.tsx
app/(admin)/review/[id]/{page.tsx,actions.ts,profile-decision.tsx}
app/(admin)/_components/{labels.ts,map-view.tsx}
scripts/{check-profiles.ts,fixtures-record.ts}, package.json (check:profiles)
test/fixtures/consolidation/scenarios.ts, test/fixtures/http/{overpass-roads,wikidata-sitelinks}/**
docs/runbook.md, docs/pilot/m5-abnahme.md, e2e/profile.spec.ts
```

---

### Task 1: Profil-Schema und `profileAsOf`

**Files:**
- Create: `lib/db/schema/profiles.ts`, `lib/domain/consolidation/types.ts`, Migration (generiert) + `drizzle/00NN_profile_triggers.sql`
- Modify: `lib/db/schema/index.ts`, `lib/domain/timeline.ts`
- Test: `lib/db/__tests__/profile-schema.test.ts`, `lib/domain/__tests__/timeline.test.ts`

**Interfaces:**
- Consumes: `forbid_mutation()`, `geo_objects`, `runs`, `review_tasks`.
- Produces:
  - Enums `change_type` (`new_attribute, changed, uncertain, expired, place_new, place_abandoned, geo_changed`), `change_severity` (`info, notable, safety`), `summary_status` (`ok, rejected, empty`); TS `ChangeType`, `ChangeSeverity`, `SummaryStatus`.
  - `profiles` (nur anfügend): `id`, `geo_object_id → geo_objects not null`, `version int not null` (Check ≥ 1), `valid_from date not null`, `attributes jsonb not null`, `provenance jsonb not null`, `conflicts jsonb not null default '[]'`, `gaps jsonb not null default '[]'`, `sources_count int not null`, `documents_count int not null`, `confidence real` (Check 0–1), `content_hash text not null`, `fact_schema_version text not null`, `rules_version text not null`, `run_id → runs`, `created_at`; eindeutig `(geo_object_id, version)`; Index `(geo_object_id, valid_from desc, version desc)`.
  - `change_events` (nur anfügend): `id`, `seq bigserial unique not null`, `geo_object_id → geo_objects not null`, `profile_version int` (nullable), `type`, `attribute text`, `old_value jsonb`, `new_value jsonb`, `severity`, `details jsonb not null default '{}'`, `run_id → runs`, `created_at`; Index `(geo_object_id, seq)`.
  - `profile_summaries` (nur anfügend): `id`, `geo_object_id`, `profile_version int not null`, `text text` (null bei `empty`), `status`, `attempts int not null`, `model`, `prompt_version int`, `run_id`, `created_at`; partiell eindeutig `(geo_object_id, profile_version, prompt_version) where status = 'ok'` (eine leere Summary darf später neu erzeugt werden).
  - `evaluation_profiles` (Arbeitszustand): PK `(run_id, geo_object_id)`, `rules_version`, `fact_schema_version`, `attributes jsonb`, `provenance jsonb`, `content_hash`, `created_at`.
  - `place_discovery_requests` (Arbeitszustand): `id`, `geo_object_id`, `requested_at timestamptz`, `run_id`; Index `(geo_object_id, requested_at desc)`.
  - `road_lines` (Arbeitszustand): `id`, `area_key text not null`, `version text not null`, `highway text not null`, `geom geometry(LineString,4326) not null` (GIST). `wikidata_sitelinks` (Arbeitszustand): PK `wikidata_id`, `sitelinks int not null`, `fetched_at timestamptz not null`.
  - In `types.ts` (nur Typen): `InputOrigin = "computed" | "text" | "review" | "observed"`, `ProvenanceOrigin = InputOrigin | "gazetteer" | "derived"`, `RuleName = "shelter" | "swell_protection" | "bathymetry" | "holding" | "latest_observation" | "highlight" | "occupancy" | "prohibitions" | "area_weighted" | "default" | "computed_only" | "review_over_computed"`, `ConfidenceClass = "high" | "medium" | "low"`, `ConflictResolution = "seasonal" | "left_open"`, `ConflictSide = { value: unknown; weight: number; factIds: string[]; sourceKeys: string[]; observedFrom: string; observedTo: string }`, `ConflictNote = { attribute: string; key: string; a: ConflictSide; b: ConflictSide; resolution: ConflictResolution | null }`, `AttributeProvenance = { origin: ProvenanceOrigin; rule: RuleName | "identity" | "derived"; confidence: number; confidenceClass: ConfidenceClass; observedAt: string | null; lastConfirmedAt: string | null; factIds: string[]; sourceKeys: string[]; computationIds: string[]; poiIds: string[]; expired: boolean; onlyGoneSources: boolean; conflictKey: string | null; pending: { value: unknown; key: string; taskId: string } | null; observedMonths: number[] }`, `ProfileGap = { attribute: string; reason: string }`, `ProfileSnapshot = { version: number; validFrom: string; attributes: Record<string, unknown>; provenance: Record<string, AttributeProvenance>; conflicts: ConflictNote[]; gaps: ProfileGap[]; sourcesCount: number; documentsCount: number; confidence: number | null; contentHash: string; rulesVersion: string; factSchemaVersion: string }`.
  - In `timeline.ts`: `profileAsOf(db, geoObjectId: string, date: string): Promise<ProfileSnapshot | null>` – größtes `valid_from <= date`, bei gleichem Datum höchste `version`; `latestProfile(db, geoObjectId: string): Promise<ProfileSnapshot | null>` – höchste `version`.

- [ ] **Step 1: Failing tests**

```ts
it.each(["profiles", "change_events", "profile_summaries"])("%s rejects UPDATE and DELETE", …); // /append-only/
it("(geo_object_id, version) is unique for profiles", …);
it("seq increases with every change event", …);   // zwei Inserts → seq2 > seq1
// timeline.test.ts (withRollback, Geo-Objekt um 21,0° O / 35,2° N)
it("profileAsOf picks the largest valid_from on or before the date", async () => withRollback(async (tx) => {
  // Versionen 1 (2026-03-01), 2 (2026-06-01), 3 (2026-06-01), 4 (2026-09-01)
  expect((await profileAsOf(tx, id, "2026-02-28"))).toBeNull();
  expect((await profileAsOf(tx, id, "2026-03-01"))!.version).toBe(1);
  expect((await profileAsOf(tx, id, "2026-06-15"))!.version).toBe(3);
  expect((await latestProfile(tx, id))!.version).toBe(4);
}));
```

- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/profile-schema.test.ts lib/domain/__tests__/timeline.test.ts` → FAIL.
- [ ] **Step 3: Implementieren.** `npm run db:generate`; Trigger und GIST in der handgeschriebenen Migration (Muster `0006_geo_triggers.sql`, `--> statement-breakpoint`, Journal-Eintrag). `seq` als `bigserial("seq", { mode: "number" })`.
- [ ] **Step 4: Run** `npx vitest run lib/db lib/domain/__tests__/timeline.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(db): profiles, change events with seq cursor, profile_as_of`

### Task 2: Konsolidierungs-Konfiguration

**Files:**
- Create: `config/consolidation/v1.json`, `config/consolidation/active.json`
- Modify: `lib/config/schemas.ts`, `lib/config/index.ts`, `app/(admin)/settings/page.tsx`
- Test: `lib/config/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  - `ConsolidationConfig` (zod), Datei `v1.json`, `active.json` = `{ "version": "v1" }`; `getConsolidationConfig(version?: string): ConsolidationConfig & { version: string }` (unbekannt → Error); `AppConfig.consolidation` = aktive Version.
  - Werte v1:
    - `recency { halfLifeYears 3 }`, `precision 3` (Nachkommastellen aller berechneten Zahlen).
    - `weights { computed 1.0, review 1.0, observed 0.8, poi 0.6 }`, `poiConfidence 0.6`.
    - `confidence { secondSourceBonus 0.15, cap 0.95, review 0.95, classes [{ name "high", min 0.7 }, { name "medium", min 0.4 }, { name "low", min 0 }] }`.
    - `conflict { minRatio 1.5 }`, `change { minIndependent 2, strongWeight 0.8 }`, `expiry { cycles 2, defaultCycleDays 365 }`.
    - `rules { shelter { maxCorrection 0.3, harbourFloor 0.8, harbourKinds ["port", "marina"], openSideMinConfidence 0.7, openSideMaxValue 0.5, harbourDefaultConfidence 0.3 }, swell_protection { textMinConfidence 0.7 }, bathymetry { textMinConfidence 0.8, weakRasterConfidence 0.4 }, default { latestMinConfidence 0.5 }, highlight { maxNames 10, poiRadiusM 2000 } }`.
    - `profileConfidence { shelter 0.4, depth 0.25, seabed 0.2, exclude 0.15 }`.
    - `quietness { settlementFullM 2000, roadFullM 1000, ferryLaneRadiusM 2000, ferryLaneValue 0.3, occupancyMonths [7, 8], occupancy { empty 1, moderate 0.5, full 0 }, text { quiet 1, moderate 0.6, busy 0.3, noisy 0 }, ferryTraffic { none 1, low 0.8, moderate 0.5, high 0.2 }, weights { settlement 0.3, road 0.2, occupancy 0.2, text 0.2, ferry 0.1 } }`.
    - `importance { sitelinksPerPoint 10, maxSitelinkPoints 2, categoryBonus { food 0, supply 0, beach 0.5, nature 0.5, active 0.5, culture 1, town 1 }, thresholds [1, 2, 3.5, 5], radiusNm [5, 10, 20, 35, 50], maxSpotIds 50 }`.
    - `severity { safety ["exclude", "max_draft", "max_length", "hazards", "prohibitions", "restriction", "depth.*"], shelterDelta 0.2, notable ["services.*", "highlight.*", "occupancy", "mooring.buoys"] }`.
    - `gaps { ignore { anchorage ["contact", "prices", "capacity"], mooring_field ["contact"] } }`.
    - `followup { minDocuments 2, cooldownDays 90, maxPlacesPerRun 30 }`.
    - `summary { levels ["place", "poi"], sentences { place [2, 4], poi [1, 2] }, maxAttempts 3, lowConfidence 0.3 }`.
  - `/settings` zeigt aktive Regelversion und je Regel die Parameter (nur lesend).

- [ ] **Step 1: Failing tests**

```ts
it("the active rules version is v1 with the spec values", () => {
  const c = getConfig().consolidation;
  expect(c.version).toBe("v1");
  expect(c).toMatchObject({ recency: { halfLifeYears: 3 }, conflict: { minRatio: 1.5 }, confidence: { secondSourceBonus: 0.15, cap: 0.95 } });
  expect(c.rules.shelter).toMatchObject({ maxCorrection: 0.3, harbourFloor: 0.8, openSideMinConfidence: 0.7 });
  expect(c.importance.radiusNm).toEqual([5, 10, 20, 35, 50]);
});
it("quietness weights must be positive and importance thresholds ascending", …); // [2, 1, 3.5, 5] → Error
it("an unknown rules version throws", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/config` → FAIL. **Step 3:** implementieren (Leser wie `readJson`, Version = Dateiname). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(config): consolidation rules v1`

### Task 3: Gewichte, Konfidenz, diskrete Auswahl mit Konflikt

**Files:**
- Create: `lib/domain/consolidation/weights.ts`
- Test: `lib/domain/consolidation/__tests__/weights.test.ts`

**Interfaces:**
- Consumes: `types.ts` (Task 1), `ConsolidationConfig` (Task 2), `canonicalJson` (M2).
- Produces:
  - In `types.ts` ergänzt: `ConsolidationInput = { factId: string | null; attribute: string; value: unknown; origin: InputOrigin; confidence: number; observedAt: string; dateKnown: boolean; sourceKey: string; sourceWeight: number; sourceType: DocType | null; documentId: string | null; gone: boolean; lastConfirmedAt: string; computationId: string | null; poiId: string | null }`; `RuleContext = { attribute: string; level: FactLevel; place: { kind: PlaceKind; status: PlaceStatus } | null; today: string; cfg: ConsolidationConfig }`; `RuleResult = { value: unknown; origin: InputOrigin; confidence: number; observedAt: string | null; support: ConsolidationInput[]; conflict: Omit<ConflictNote, "resolution"> | null }`.
  - `recency(observedAt: string, today: string, halfLifeYears: number): number` – Alter = Tage / 365,25, nie > 1.
  - `inputWeight(i: ConsolidationInput, ctx: RuleContext): number` = `sourceWeight × confidence × (origin text|observed ? recency : 1)`.
  - `independentCount(inputs: ConsolidationInput[]): number` (verschiedene `sourceKey`).
  - `attributeConfidence(support: ConsolidationInput[], ctx: RuleContext): number` – Basis = Maximum je Eingang (`computed`: `confidence`; `review`: `cfg.confidence.review`; `text`/`observed`: `confidence × sourceWeight`); `+ secondSourceBonus` bei `independentCount ≥ 2`; Deckel `cap`; mal `recency` des jüngsten Text-/Beobachtungs-Eingangs (nur wenn der Wert aus Text/Beobachtung stammt); gerundet auf `precision`.
  - `confidenceClass(c: number, cfg): ConfidenceClass`; `lowerClass(c: ConfidenceClass): ConfidenceClass`; `classMidpoint(c: ConfidenceClass, cfg): number` (high 0,85, medium 0,55, low 0,2).
  - `valueGroups(inputs: ConsolidationInput[], ctx): Array<{ key: string; value: unknown; inputs: ConsolidationInput[]; weight: number; from: string; to: string; years: number[]; allDatesKnown: boolean }>` – Gruppen nach `canonicalJson(value)`, Gewicht = Summe der stärksten Eingabe je `sourceKey`, nach Gewicht absteigend, dann `key`.
  - `pickDiscrete(inputs: ConsolidationInput[], ctx): { group: ValueGroup; conflict: Omit<ConflictNote, "resolution"> | null }`:
    1. eine Gruppe → sie.
    2. jüngste Gruppe `W` (größtes `to`); alle Daten bekannt und `min(years(W)) > max(years(übrige))` → `W`, kein Konflikt (Zeitverlauf).
    3. sonst stärkste `T`, zweite `S`; `T.weight / S.weight < minRatio` → `T` mit Konflikt (`key` = erste 16 Hex von sha256 über sortierte Fact-IDs beider Gruppen, `a = T`, `b = S`); sonst `T`.
  - `roundTo(n: number, precision: number): number`.

- [ ] **Step 1: Failing tests**

```ts
const ctx = ruleCtx({ today: "2026-10-19" });
it("recency halves every three years", () => {
  expect(recency("2023-10-19", "2026-10-19", 3)).toBeCloseTo(0.5, 3);
  expect(recency("2027-01-01", "2026-10-19", 3)).toBe(1);
});
it("two documents of one source count once", () => {
  expect(independentCount([text({ sourceKey: "source:a" }), text({ sourceKey: "source:a" }), text({ sourceKey: "source:b" })])).toBe(2);
});
it("confidence: text 0.8 × weight 0.6, second source +0.15, cap 0.95", () => {
  expect(attributeConfidence([text({ confidence: 0.8, sourceWeight: 0.6, observedAt: "2026-10-19" })], ctx)).toBe(0.48);
  expect(attributeConfidence([text({ confidence: 0.8, sourceWeight: 0.6, sourceKey: "source:a", observedAt: "2026-10-19" }),
                              text({ confidence: 0.5, sourceWeight: 0.6, sourceKey: "source:b", observedAt: "2026-10-19" })], ctx)).toBe(0.63);
  expect(attributeConfidence([review(), text({ sourceKey: "source:b" })], ctx)).toBe(0.95);
});
it("a time course 2019 → 2024 picks 2024 without conflict", …);
it("same season year with weights 1.0 vs 0.7 is a conflict, 1.0 vs 0.6 is not", …);
it("an unknown date (dateKnown false) never counts as time course", …);
it("the conflict key does not depend on input order", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/consolidation/__tests__/weights.test.ts` → FAIL. **Step 3:** implementieren; Testhelfer `text()`, `computed()`, `review()`, `ruleCtx()` in `test/fixtures/consolidation/scenarios.ts`. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): weights, attribute confidence and discrete pick with conflicts`

### Task 4: Regeln mit Berechnungsbasis (`shelter`, `swell_protection`, `bathymetry`, `computed_only`, `review_over_computed`)

**Files:**
- Create: `lib/domain/consolidation/rules/{shelter,swell-protection,bathymetry,computed-only,review-over-computed}.ts`
- Test: `lib/domain/consolidation/rules/__tests__/computed-rules.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `type ConsolidationRule = (inputs: ConsolidationInput[], ctx: RuleContext) => RuleResult | null` und je Datei eine Regel:
  - `shelterRule`: Basis = jüngster `computed`-Eingang; `textValue` = Minimum aller Text-/Beobachtungswerte; Wert = Basis ohne Text, sonst `clamp(textValue, basis − maxCorrection, basis + maxCorrection)`, ohne Basis `textValue`; Herkunft `text`, sobald ein Text eingeht. Ort mit `kind ∈ harbourKinds`: Wert = `max(Wert, harbourFloor)`, außer ein Text mit Konfidenz ≥ `openSideMinConfidence` und Wert ≤ `openSideMaxValue`; Hafen ohne jeden Eingang → `harbourFloor` mit `harbourDefaultConfidence`, Herkunft `computed`, `support []`; sonst ohne Eingang `null`.
  - `swellProtectionRule`: Text mit Konfidenz ≥ `textMinConfidence` → der mit höchstem `inputWeight`; sonst jüngster `computed`; sonst Text mit höchstem Gewicht.
  - `bathymetryRule`: Text mit Konfidenz > `textMinConfidence` → höchstes Gewicht (Gleichstand: jüngstes `observedAt`); sonst `computed` mit Konfidenz ≥ `weakRasterConfidence` → computed; sonst vorhandener Text mit höchstem Gewicht; sonst computed; sonst `null`.
  - `computedOnlyRule`: jüngster `computed`. `reviewOverComputedRule`: jüngster `review`/`observed`, sonst jüngster `computed`.
  - Alle Zahlen gerundet auf `precision`; Konfidenz über `attributeConfidence(support)`.

- [ ] **Step 1: Failing tests** (Tabellentests, `today 2026-10-19`)

```ts
it.each([
  ["computed only", [c(0.6)], 0.6, "computed"],
  ["good text within one step", [c(0.6), t(0.9)], 0.9, "text"],
  ["poor text corrected by at most 0.3", [c(0.6), t(0.1)], 0.3, "text"],
  ["contradicting texts take the worse", [c(0.6), t(0.9), t(0.5, { sourceKey: "source:b" })], 0.5, "text"],
  ["no computation: text value", [t(0.5)], 0.5, "text"],
])("shelter: %s", (_n, inputs, value, origin) => expect(shelterRule(inputs, ctx)).toMatchObject({ value, origin }));
it("a marina keeps the 0.8 floor without proof of an open side", () => {
  expect(shelterRule([c(0.4)], marinaCtx)!.value).toBe(0.8);
  expect(shelterRule([c(0.4), t(0.1, { confidence: 0.6 })], marinaCtx)!.value).toBe(0.8);
});
it("a text with confidence 0.7 proving an open side lifts the floor", () => {
  expect(shelterRule([c(0.4), t(0.1, { confidence: 0.7 })], marinaCtx)!.value).toBe(0.1);
});
it("a marina without any input gets 0.8 with confidence 0.3", …);
it("swell: text 0.7 beats computation, text 0.6 does not", …);
it("two simultaneous contradicting depth texts at 0.6 keep the bathymetry", () => {
  expect(bathymetryRule([c(4.0, { confidence: 0.6 }), t(2.5, { confidence: 0.6 }), t(6.0, { confidence: 0.6, sourceKey: "source:b" })], depthCtx))
    .toMatchObject({ value: 4, origin: "computed" });
});
it("a depth text above 0.8 corrects; a weak raster (0.3) yields to any text", …);
it("review anchor beats computed anchor", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/consolidation/rules` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): shelter, swell, bathymetry and computed rules`

### Task 5: Diskrete Regeln (`latest_observation`, `highlight`, `holding`, `default`, `area_weighted`)

**Files:**
- Create: `lib/domain/consolidation/rules/{latest-observation,highlight,holding,default,area-weighted}.ts`
- Test: `lib/domain/consolidation/rules/__tests__/discrete-rules.test.ts`

**Interfaces:**
- Consumes: `pickDiscrete`, `valueGroups`, `attributeConfidence` (Task 3).
- Produces:
  - `latestObservationRule` = `pickDiscrete` über alle Eingänge; Wert der gewählten Gruppe; `observedAt` = `to` der Gruppe.
  - `highlightRule` (Wert `{ present: boolean; names: string[] }`): `present` über `pickDiscrete` auf `{ present }`; `names` = Vereinigung der Namen aller Eingänge mit `present = true`, sortiert nach Zahl unabhängiger `sourceKey` absteigend, dann Name; höchstens `maxNames`; bei `present = false` `names []`.
  - `holdingRule`: nur `text`/`review`; `pickDiscrete` ohne Zeitverlauf-Regel (Mehrheit nach Gewicht, Konflikt bei Faktor < 1,5).
  - `defaultRule`: Eingänge mit Konfidenz ≥ `latestMinConfidence` → `pickDiscrete`; keine → stärkste Gruppe aller Eingänge ohne Konflikt.
  - `areaWeightedRule`: Zahlen → gewichteter Mittelwert (`inputWeight`), gerundet; Strings → `pickDiscrete` ohne Zeitverlauf-Regel; Arrays → Vereinigung nach kanonischem Element, sortiert nach Nennungen.
  - `pickDiscrete` erhält dafür Option `{ timeCourse: boolean }` (Default `true`).

- [ ] **Step 1: Failing tests**

```ts
it("taverna 2019 yes, 2024 no → no, without conflict", () => {
  const r = highlightRule([t({ present: true, names: ["Nikos"] }, { observedAt: "2019-07-10", sourceKey: "source:a", sourceWeight: 0.6 }),
                           t({ present: false, names: [] }, { observedAt: "2024-07-10", sourceKey: "source:b", sourceWeight: 0.9 })], ctx)!;
  expect(r.value).toEqual({ present: false, names: [] }); expect(r.conflict).toBeNull();
});
it("same month: the stronger source wins", …);
it("water yes and no in the same season year with similar weight is a conflict showing the heavier value", …);
it("highlight names are united and sorted by independent mentions", () => {
  // Nikos von source:a, source:b; Maria von source:a → ["Nikos", "Maria"]
});
it("holding: weighted majority, texts only", …);
it("default: latest with confidence ≥ 0.5, else weighted majority", …);
it("area facts: numeric weighted mean 0.62, enum majority, arrays united", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): latest observation, highlight, holding, default and area rules`

### Task 6: `occupancy`, `prohibitions`, Regel-Register und generischer Review-Vorrang

**Files:**
- Create: `lib/domain/consolidation/rules/{occupancy,prohibitions,index}.ts`
- Test: `lib/domain/consolidation/rules/__tests__/rules-registry.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5, `getFactSchema` (M2/M4).
- Produces:
  - `occupancyRule`: Wert `Record<"1".."12", "empty" | "moderate" | "full" | "unknown">` mit allen 12 Monaten; je Monat gewichtete Mehrheit der Eingänge, die den Monat nennen; ohne Daten `unknown`.
  - `prohibitionsRule`: nur `computed` → jüngster computed Wert unverändert (M2-Attribut `restriction`). Sonst: Einträge `{ kind, months }` aller Eingänge; ein `kind` entfällt, wenn ein Eingang mit `sourceType = "authority"` und `observedAt` nach der jüngsten Nennung dieses `kind` ihn nicht enthält; Monate je `kind` vereinigt (`null` gewinnt = ganzjährig); sortiert nach `kind`.
  - `RULES: Record<RuleName, ConsolidationRule>`.
  - `applyRule(rule: RuleName, inputs: ConsolidationInput[], ctx: RuleContext): RuleResult | null` – leere Eingänge → Regel trotzdem (Hafen-Untergrenze), sonst: jüngster `review`-Eingang mit `observedAt ≥` allen übrigen → dessen Wert, Herkunft `review`, Konfidenz `cfg.confidence.review`, kein Konflikt; sonst `RULES[rule]`.

- [ ] **Step 1: Failing tests**

```ts
it("every rule name of fact schema v1 and v2 has an implementation", () => {
  for (const v of ["v1", "v2"]) for (const defs of Object.values(getFactSchema(v).levels)) for (const d of defs) expect(RULES[d.rule as RuleName]).toBeTypeOf("function");
});
it("occupancy fills 12 months, months without data are unknown", …);
it("an anchoring ban holds until a younger authority source omits it", () => {
  // forum 2022 [anchoring], authority 2024 [] → []; authority 2021 [] und forum 2022 [anchoring] → [anchoring]
});
it("a review decision newer than all facts wins with 0.95", …);
it("a text fact newer than the review decision goes through the rule again", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/domain/consolidation` → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): occupancy and prohibition rules, rule registry with review precedence`

### Task 7: Eingänge laden

**Files:**
- Create: `lib/domain/consolidation/inputs.ts`
- Test: `lib/domain/consolidation/__tests__/inputs.test.ts`

**Interfaces:**
- Consumes: `activeExtractionRun`, `effectiveVersionMeta`, `levelFor` (M4), `latestComputations` (M2), `facts`, `mentions`, `document_versions`, `documents`, `sources`, `places`, `geo_objects`, `tiles`, `review_tasks`, `review_decisions`, `displayNameSql`, Task 1–3.
- Produces:
  - `loadInputs(db, geoObjectId: string, opts: { cfg: ConsolidationConfig; schemaVersion: string }): Promise<{ inputs: ConsolidationInput[]; ignored: { inactiveRun: number; unknownAttribute: number } }>`:
    - Text-Facts über `mention_id`: nur `extraction_run_id = activeExtractionRun(version).id` (je verschiedene Version einmal ermittelt); `sourceKey "source:<sourceId>"`, `sourceWeight = sources.weight`, `sourceType = sources.type`, `dateKnown = basis ≠ "fetched" || fact.observed_at ≠ meta.observedAt`, `gone = documents.status = "gone"`, `lastConfirmedAt` = `gone ? observed_at : documents.last_checked_at::date`.
    - Computed: Facts der `latestComputations`, `sourceKey "computed:<kind>"`, `sourceWeight weights.computed`, `lastConfirmedAt` = Datum der Computation.
    - Review: Facts mit `review_decision_id`, `sourceKey "review"`, `sourceWeight weights.review`. Beobachtung: Facts mit `observation_id`, `sourceKey "observation:<id>"`, `weights.observed` (bis M8 leer).
    - Nur Ort (`levelFor = place`): gültige `poi`-Objekte mit `category` im Umkreis `rules.highlight.poiRadiusM` um `places.position` → Eingang `highlight.<category>` `{ present: true, names: [Anzeigename] }`, Herkunft `computed`, `sourceKey "poi:<id>"`, `sourceWeight weights.poi`, Konfidenz `poiConfidence`, `observedAt` = `valid_from`, `poiId`.
    - Attribute, die die Ebene im Schema nicht kennt → `ignored.unknownAttribute`.
  - `type ProfileContext = { level: FactLevel; place: { id: string; kind: PlaceKind; status: PlaceStatus; statusReason: string | null; position: LonLat; publicId: string | null } | null; identity: { name: string | null; parentId: string | null; geometryHash: string }; tileCycleDays: number; areaId: string | null; documentsCount: number; sourcesCount: number; computationGaps: Record<string, string>; resolutions: Map<string, ConflictResolution>; decidedUncertainKeys: Set<string>; openTasks: Map<string, { taskId: string; key: string }> /* nach "<kind>:<attribute>" */ }`
  - `loadContext(db, geoObjectId: string, cfg): Promise<ProfileContext | null>` – `null` bei Ebene `null`, ungültigem Objekt, Ort mit Status `rejected` oder `merged_into_id`; `geometryHash` = md5 von `ST_AsEWKB(ST_SnapToGrid(geom, 1e-6))`; `tileCycleDays` aus der Kachel des Orts bzw. des Zentroids, sonst `expiry.defaultCycleDays`; `documentsCount`/`sourcesCount` = verschiedene Dokumente/Quellen mit Erwähnungen des Objekts; `computationGaps` aus `outputs.gaps` der jüngsten Computations (Attribut → Grund); Auflösungen und Entscheidungen aus Aufgaben `conflict`/`uncertain_change` mit `subject_id "<geoObjectId>:<attribute>"` und `context.key`.

- [ ] **Step 1: Failing tests** (`withRollback`, Synthetik um 21,0° O / 35,2° N)

```ts
it("facts of a non-active extraction run are ignored", …);       // regulärer Lauf + späterer reprocess finished → nur reprocess; Vergleichslauf nie; ignored.inactiveRun zählt
it("two documents of one source share one source key", …);
it("a computed fact of an older computation is not loaded", …);
it("a gone document keeps observedAt; its lastConfirmedAt is the observation date, an active one its last check", …);
it("a review fact enters with weight 1 and its stored confidence", …);
it("a food poi 1.2 km away supports highlight.food, one 2.5 km away does not", …);
it("a rejected place has no context; an islet has level island", …);
it("documents and sources count distinct documents with mentions", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/consolidation/__tests__/inputs.test.ts` → FAIL. **Step 3:** implementieren (ein SQL für Text-Facts mit Join auf Version, Dokument, Quelle; aktive Läufe je Version vorab). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): load facts of active runs, computations, review facts and poi support`

### Task 8: Signale als Datensätze (Straßen, Wikidata-Sitelinks) und Straßenabstand

**Files:**
- Modify: `lib/adapters/overpass.ts` (`buildRoadsQuery`), `lib/adapters/wikidata.ts` (`wikidataSitelinks`), `lib/pipeline/datasets.ts`, `lib/pipeline/geometry.ts` (Ruhe-Computation), `config/datasets.json`, `config/geometry.json` (`rulesVersion` +1), `scripts/fixtures-record.ts`
- Test: `lib/adapters/__tests__/overpass.test.ts`, `lib/adapters/__tests__/wikidata.test.ts`, `lib/pipeline/__tests__/datasets.test.ts`, `lib/pipeline/__tests__/geometry.test.ts`, Fixtures `test/fixtures/http/{overpass-roads,wikidata-sitelinks}/**`

**Interfaces:**
- Consumes: `overpassQuery`, `wikidataQuery` (M1), `importSeabed`-Muster und `DATASET_KINDS` (M2), `getArchive()`.
- Produces:
  - `buildRoadsQuery(bbox: Bbox, timeoutSeconds: number): string` – `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"](<s>,<w>,<n>,<e>); out geom;`.
  - `wikidataSitelinks(transport, ids: string[], ctx): Promise<Map<string, number>>` – `SELECT ?item ?n WHERE { VALUES ?item { wd:Q… } ?item wikibase:sitelinks ?n }`, höchstens 200 IDs je Anfrage.
  - `DATASET_KINDS` + `"roads"`, `"sitelinks"`. `importRoads(db, { area }, deps): Promise<{ lines: number; version: string }>` – Box wie Seebodenimport, Rohantwort nach `datasets/overpass-roads/<areaKey>/<YYYY-MM-DD>.json`, Version = erste 12 Hex von sha256, Zeilen des Reviers in einer Transaktion ersetzen (Arbeitszustand). `importSitelinks(db, { area }, deps): Promise<{ fetched: number; reused: number }>` – gültige Objekte mit `wikidata_id` in den Kacheln des Reviers, deren Zeile älter als 30 Tage ist oder fehlt; Upsert.
  - Ruhe-Computation (M2 `quietness`): `inputs` + `roadsVersion`, `outputs` + `roadDistanceM` (nächste Straße bis 5000 m über `::geography`, sonst `null`); `config/geometry.json` `rulesVersion` erhöht.
  - `fixtures:record -- --area aegina-west --datasets roads,sitelinks`.

- [ ] **Step 1: Fixtures aufzeichnen** (≤ 2 Aufrufe je Dienst). Expected: Dateien unter `test/fixtures/http/overpass-roads/` und `…/wikidata-sitelinks/`.
- [ ] **Step 2: Failing tests**

```ts
it("the roads query asks for ways of the seven highway classes with geometry", …);
it("sitelinks are batched by 200 ids", …);                     // 450 IDs → 3 Anfragen
it("importRoads replaces the area's lines and keeps other areas", …);  // withRollback
it("sitelinks fetched within 30 days are reused without a call", …);
it("the quietness computation stores the road distance and changes once with the new roads version", …);
```

- [ ] **Step 3: Run** `npx vitest run lib/adapters lib/pipeline/__tests__/datasets.test.ts lib/pipeline/__tests__/geometry.test.ts` → FAIL. **Step 4:** implementieren. **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(datasets): roads and wikidata sitelinks for quietness and importance`

### Task 9: Abgeleitete Werte

**Files:**
- Create: `lib/domain/consolidation/derived/{quietness,importance,season,confidence,popularity}.ts`
- Modify: `lib/domain/consolidation/inputs.ts` (`loadDerivedInputs`)
- Test: `lib/domain/consolidation/derived/__tests__/derived.test.ts`, `lib/domain/consolidation/__tests__/derived-inputs.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 7, 8; `road_lines`, `wikidata_sitelinks`, `restricted_areas`, `latestProfile`.
- Produces:
  - `type QuietnessParts = { settlementDistanceM: number | null; roadDistanceM: number | null; occupancy: Array<"empty" | "moderate" | "full" | "unknown">; text: "quiet" | "moderate" | "busy" | "noisy" | null; ferry: number | null }`; `quietnessScore(p: QuietnessParts, cfg): { value: number | null; parts: Record<string, number> }` – Teilwerte `min(d / settlementFullM, 1)`, `min(d / roadFullM, 1)`, Mittel der bekannten Belegungsstufen, Textstufe, Fähre; fehlende Teile fallen weg, Gewichte werden neu normiert; kein Teil → `null`.
  - `importanceOf(i: { sources: Array<{ key: string; weight: number }>; sitelinks: number | null; category: PoiCategory }, cfg): { importance: 1 | 2 | 3 | 4 | 5; score: number; radiusNm: number }` – Score = Summe der Quellengewichte (je `key` einmal) + `min(sitelinks / sitelinksPerPoint, maxSitelinkPoints)` + `categoryBonus`; Bedeutung = 1 + Zahl der Schwellen ≤ Score.
  - `spotIdsWithin(candidates: Array<{ placeId: string; distanceNm: number }>, radiusNm: number, max: number): string[]` – ≤ Radius, nach Distanz, dann ID.
  - `seasonHints(results: Record<string, RuleResult | null>): Array<{ kind: string; months: number[] }>` – aus `season_notes` (je `kind` vereinigte Monate, sortiert); `observedMonths` je `highlight.*`/`services.*` = Monate der `observedAt` der stützenden Eingänge.
  - `profileConfidence(provenance: Record<string, AttributeProvenance>, cfg): number | null` – Gruppen `shelter` (Mittel `shelter.*`), `depth` (Mittel `depth.min/max/anchoring_*`), `seabed`, `exclude` (Konfidenz von `restriction`); fehlende Gruppen fallen weg, Gewichte neu normiert.
  - `popularity(n: number, maxInArea: number): number` = `log(1 + n) / log(1 + max)`, `max = 0` → 0; `popularityForArea(db, areaId: string): Promise<Map<string, number>>` über `sources_count` der jüngsten Profile der Orte im Revier.
  - `type DerivedInputs = { quietness: Omit<QuietnessParts, "occupancy" | "text"> | null; importance: { sources: Array<{ key: string; weight: number }>; sitelinks: number | null; category: PoiCategory; spotCandidates: Array<{ placeId: string; distanceNm: number }> } | null }`; `loadDerivedInputs(db, geoObjectId: string, ctx: ProfileContext, cfg): Promise<DerivedInputs>` – Ort: Abstände aus der jüngsten `quietness`-Computation, Fähre = `ferryLaneValue` bei `ferry_lane` im Umkreis `ferryLaneRadiusM`, sonst `ferryTraffic[latestProfile(Elternobjekt mit ferry_traffic).ferry_traffic]`, sonst `null`; POI: Quellen = unabhängige Quellen mit Erwähnungen des POI (Gewicht = `sources.weight`), Sitelinks, Kandidaten = bestätigte, gültige, nicht zusammengeführte Orte bis 50 sm, Distanz über `::geography` / 1852.

- [ ] **Step 1: Failing tests**

```ts
it("quietness renormalizes over known parts", () => {
  expect(quietnessScore({ settlementDistanceM: 2000, roadDistanceM: 500, occupancy: ["full", "moderate"], text: "quiet", ferry: null }, cfg).value).toBe(0.722);
  expect(quietnessScore({ settlementDistanceM: null, roadDistanceM: null, occupancy: ["unknown"], text: null, ferry: null }, cfg).value).toBeNull();
});
it.each([
  [{ sources: [], sitelinks: null, category: "food" }, 1, 5],
  [{ sources: [{ key: "a", weight: 1 }, { key: "b", weight: 1 }], sitelinks: null, category: "food" }, 3, 20],
  [{ sources: [...5 × 0.7], sitelinks: 60, category: "culture" }, 5, 50],
])("importance %#", (i, importance, radiusNm) => expect(importanceOf(i as never, cfg)).toMatchObject({ importance, radiusNm }));
it("spot ids inside the radius sorted by distance", …);
it("profile confidence weighs shelter, depth, seabed, exclusion and skips missing groups", …);
it("popularity is 1 for the area maximum and log-normalized below", () => expect(popularity(3, 15)).toBeCloseTo(0.5, 3));
// derived-inputs.test.ts (withRollback)
it("a poi gets confirmed places within 50 nm as candidates, a candidate place is not one", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/consolidation` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): quietness, poi importance with spot ids, season hints, profile confidence, popularity`

### Task 10: Profil bauen

**Files:**
- Create: `lib/domain/consolidation/build.ts`
- Test: `lib/domain/consolidation/__tests__/build.test.ts`

**Interfaces:**
- Consumes: Tasks 3–9, `getFactSchema`, `canonicalJson`.
- Produces:
  - `type BuiltProfile = Omit<ProfileSnapshot, "version" | "validFrom"> & { support: Record<string, { independent: number; maxWeight: number; factIds: string[] }> }`
  - `buildProfile(input: { inputs: ConsolidationInput[]; context: ProfileContext; derived: DerivedInputs; today: string; cfg: ConsolidationConfig; schemaVersion: string; rulesVersion: string }): BuiltProfile`:
    1. Eingänge sortieren nach (`attribute`, `observedAt`, `factId ?? poiId`), dann je Attribut der Ebene `applyRule(def.rule, …)`.
    2. Wert ≠ `null` → `attributes[key]`, Provenienz (Herkunft, Regel, Konfidenz, Klasse, `observedAt`, `lastConfirmedAt` = Maximum der stützenden Eingänge, Fact-, Computation-, POI-IDs, `onlyGoneSources`, `conflictKey`, `observedMonths`); Konflikt → `conflicts` mit `resolution` aus `context.resolutions`.
    3. Ablauf: Herkunft `text`/`observed` und `lastConfirmedAt < today − cycles × tileCycleDays` → `expired true`, Konfidenz = `classMidpoint(lowerClass(Klasse))`.
    4. Identität (Herkunft `gazetteer`, Regel `identity`, Konfidenz 1): `geo.name`, `geo.parent_id`, `geo.geometry_hash`; bei Orten `place.kind`, `place.status`, `place.position` (6 Stellen), `exclude` `{ excluded: status = "no_anchoring", reason: statusReason }`.
    5. Abgeleitet (Herkunft `derived`): Ort `derived.quietness` (Belegung aus `occupancy` für `occupancyMonths`, Text aus `quietness`), `derived.season`; POI `derived.importance`, `derived.radius_nm`, `derived.spot_ids`.
    6. Lücken: Attribute der Ebene ohne Wert, ohne `gaps.ignore[place.kind]`; Grund aus `computationGaps`, sonst `"no_facts"`.
    7. `confidence = profileConfidence`, `sourcesCount`/`documentsCount` aus dem Kontext.
    8. `contentHash` = sha256 von `canonicalJson({ attributes, classes: { [key]: confidenceClass }, conflicts: [{ key, resolution }], expired: [sortierte Schlüssel] })`.

- [ ] **Step 1: Failing tests**

```ts
it("a place profile has 8 shelter values, provenance per attribute and gaps with reasons", …); // anchor_area Lücke "no_anchor_area" aus computationGaps
it("shuffled inputs give the same content hash", () => {
  const base = buildProfile(scenario.inputs …);
  for (let seed = 1; seed <= 20; seed++) expect(buildProfile({ ...scenario, inputs: shuffle(scenario.inputs, seed) }).contentHash).toBe(base.contentHash);
});
it("a pending provenance or a changed fact id with the same value and class keeps the hash", …);
it("a text attribute last confirmed 61 days ago in a 30-day tile is expired one class lower", …);
it("computed attributes never expire", …);
it("a conflict carries the resolution of a decided task", …);
it("a poi profile has importance, radius and spot ids; a place has quietness", …);
it("an anchorage does not list contact as a gap", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/consolidation/__tests__/build.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): build profile with provenance, expiry, identity, derived values and gaps`

### Task 11: Änderungserkennung

**Files:**
- Create: `lib/domain/consolidation/changes.ts`
- Test: `lib/domain/consolidation/__tests__/changes.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 10.
- Produces:
  - `severityFor(attribute: string, oldValue: unknown, newValue: unknown, cfg): ChangeSeverity` – `shelter.*`: `safety` bei `|Δ| > shelterDelta`, sonst `info`; Muster aus `severity.safety`/`notable` (`*` = Präfix), sonst `info`.
  - `type EventDraft = { type: ChangeType; attribute: string | null; oldValue: unknown; newValue: unknown; severity: ChangeSeverity; details: Record<string, unknown> }`; `type TaskDraft = { kind: "conflict" | "uncertain_change"; attribute: string; key: string; context: Record<string, unknown>; priority: number; event: EventDraft | null }`.
  - `diffProfiles(prev: ProfileSnapshot | null, next: BuiltProfile, ctx: { cfg; level: FactLevel; context: ProfileContext }): { profile: BuiltProfile; events: EventDraft[]; tasks: TaskDraft[]; versionNeeded: boolean }`:
    - Ohne Vorgänger: keine Attribut-Ereignisse; Ort mit `place.status = confirmed` → `place_new`.
    - Je Fact-Schema-Attribut: vorher kein Wert → `new_attribute`; anderer Wert → gestützt (`support.independent ≥ minIndependent` oder `support.maxWeight > strongWeight`) → `changed`; sonst unsicher: Schlüssel = 16 Hex sha256 (`attribute`, neuer Wert, sortierte Fact-IDs); Schlüssel in `decidedUncertainKeys` → alter Wert, still; sonst alter Wert und alte Provenienz mit `pending`, `TaskDraft` `uncertain_change` (Kontext `{ key, attribute, oldValue, newValue, factIds, sources }`, Ereignis `uncertain`). Wert entfällt → keine Änderung (Wert bleibt, Ablauf regelt das Veralten).
    - `expired` neu wahr → Ereignis `expired` (Severity nach Attribut, `details.lastConfirmedAt`).
    - Identität: `geo.name`, `geo.parent_id`, `geo.geometry_hash`, `place.position` → `geo_changed` (`info`); `place.kind` → `changed` (`info`); `exclude` → `changed` (`safety`); `place.status` neu `confirmed` aus `null`/`candidate` → `place_new`, neu `abandoned` → `place_abandoned`.
    - Konflikte ohne Auflösung und ohne entschiedene Aufgabe mit gleichem Schlüssel → `TaskDraft` `conflict` (Kontext `{ key, attribute, a, b }`, `priority` 2 bei Severity `safety`, sonst 1, kein Ereignis).
    - `versionNeeded = prev === null || prev.contentHash !== profile.contentHash` (nach Rücksetzen unsicherer Werte neu berechnet).

- [ ] **Step 1: Failing tests**

```ts
it("taverna yes → no from a pilot guide (0.9) is changed and notable", …);
it("a single forum (0.4) saying no is uncertain: old value kept, one task draft with event", …);
it("two documents of one forum are still uncertain", …);
it("two independent forums make it changed", …);
it("a discarded uncertain key keeps the old value silently", …);
it("an unchanged profile needs no version and has no events", …);
it.each([
  ["shelter.N", 0.6, 0.35, "safety"], ["shelter.N", 0.6, 0.45, "info"], ["services.water", true, false, "notable"],
  ["exclude", { excluded: false, reason: null }, { excluded: true, reason: "military" }, "safety"],
  ["depth.min", 4, 2.5, "safety"], ["max_draft", 2.5, 2.0, "safety"], ["holding", "good", "poor", "info"],
])("severity of %s %j → %j is %s", (a, o, n, s) => expect(severityFor(a, o, n, cfg)).toBe(s));
it("first profile of a confirmed place emits only place_new", …);
it("a renamed object emits geo_changed, a newly abandoned place place_abandoned", …);
it("a conflict without resolution opens a conflict draft once", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): change detection with severity, uncertain and expired events`

### Task 12: `consolidateGeo` – Version, Ereignisse, Aufgaben

**Files:**
- Create: `lib/domain/consolidation/store.ts`
- Test: `lib/domain/consolidation/__tests__/store.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 7, 9–11, `createReviewTask`, `getConsolidationConfig`, `getConfig().factSchema`.
- Produces:
  - `consolidateGeo(db, geoObjectId: string, opts: { runId?: string; today?: string; mode?: "regular" | "evaluation"; rulesVersion?: string }): Promise<{ status: "created" | "unchanged" | "skipped" | "evaluated"; version: number | null; events: number; tasks: number }>` – eine Transaktion mit `pg_advisory_xact_lock(hashtext('profile:' || geoObjectId))`; `today` = `opts.today` ?? Datum von `runs.created_at` (UTC) ?? heute; Kontext `null` → `skipped`. Ablauf: laden, `buildProfile`, `latestProfile`, `diffProfiles`.
    - `regular`: `versionNeeded` → `profiles` (Version = vorherige + 1, `valid_from = today`, `run_id`); Ereignisse mit `profile_version` (neue oder bestehende Version); je `TaskDraft` `createReviewTask` (`subjectType "profile_attribute"`, `subjectId "<geoObjectId>:<attribute>"`, Kontext inkl. `key`, `geoObjectId`), Ereignis des Entwurfs nur bei `created: true`; die `taskId` eines unsicheren Werts steht in `pending`.
    - `evaluation`: Upsert `evaluation_profiles (runId, geoObjectId)` mit der Regelversion `opts.rulesVersion`; keine Profile, Ereignisse, Aufgaben.

- [ ] **Step 1: Failing tests** (`withRollback` außer dem Parallel-Test; Facts und Computations direkt eingefügt)

```ts
it("first consolidation writes version 1 with valid_from = run date", …);
it("a second consolidation creates nothing", …);                       // status unchanged, 0 Ereignisse, 0 Aufgaben
it("one day later without new facts creates nothing", …);
it("a new pilot guide fact creates version 2 and one changed event with old and new value", …);
it("an uncertain change opens one task over three runs", …);          // 1 Aufgabe, 1 Ereignis uncertain, Profil unverändert
it("an evaluation run writes no profile, no event and no task", …);
it("depth scenario: two contradicting 0.6 texts leave the profile and create no event", …);
it("two parallel consolidations write one version", async () => {
  // committed Synthetik-Objekt 21,0° O / 35,2° N mit eigener UUID; Promise.all([consolidateGeo, consolidateGeo]) → Versionen [1], Ereignisse je Objekt einmal
});
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/consolidation/__tests__/store.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): consolidateGeo writes versions only on change, events and review tasks`

### Task 13: Review `conflict` und `uncertain_change`

**Files:**
- Modify: `lib/domain/review-decisions.ts`, `lib/domain/review-view.ts`, `app/(admin)/review/[id]/page.tsx`, `app/(admin)/review/[id]/actions.ts`, `app/(admin)/_components/labels.ts`
- Create: `app/(admin)/review/[id]/profile-decision.tsx`
- Test: `lib/domain/__tests__/review-decisions.test.ts`, `app/(admin)/__tests__/review-profile.test.ts`

**Interfaces:**
- Consumes: `decideReviewTask`, `ALLOWED`, `validateFactValue`, `geoFacts`/`FactView`, `QuoteContext` (M4), `consolidateGeo` (Task 12).
- Produces:
  - `reviewDecisionSchema` + `{ action: "value_a" }`, `{ action: "value_b" }`, `{ action: "seasonal" }`, `{ action: "leave_open" }`, `{ action: "accept_change" }`, `{ action: "discard_change" }`; `ALLOWED["conflict/profile_attribute"] = ["value_a", "value_b", "seasonal", "leave_open"]`, `ALLOWED["uncertain_change/profile_attribute"] = ["accept_change", "discard_change"]`.
  - Wirkung: `value_a`/`value_b`/`accept_change` → Fact mit `review_decision_id`, Attribut und Wert aus dem Aufgaben-Kontext (`validateFactValue`), Konfidenz `cfg.confidence.review` (0,95), `observed_at` = Entscheidungsdatum, aktive Fact-Schema-Version; `seasonal` → Auflösung `seasonal`, `leave_open` → `left_open` (nur Entscheidung); `discard_change` → nur Entscheidung. Rückgabe `{ geoObjectId }`.
  - Server Action entscheidet über `decideReviewTask` (den Folgelauf hängt Task 16 an).
  - `ReviewSubject` + `{ type: "profile_attribute"; geoObjectId; attribute; label; current: { value; display; provenance }; a?/b?: { value; display; weight; observedFrom; observedTo; facts: FactView[] }; proposed?: { value; display; facts: FactView[] } }`.
  - Seite: Karte mit Objekt, Attribut mit Label, je Seite Wert, Zeitraum, Quellen mit Gewicht, Zitate mit `QuoteContext`; Knöpfe „Wert A“, „Wert B“, „Beide (saisonal)“, „Offen lassen“ bzw. „Übernehmen“, „Verwerfen“, Tastenkürzel 1–4 bzw. 1–2.

- [ ] **Step 1: Failing tests**

```ts
it("value_b writes one review fact with confidence 0.95 and the next consolidation shows it without conflict", …);
it("seasonal resolves the conflict marker; no new conflict task for the same key", …);
it("leave_open keeps the marker and opens no new task", …);
it("accept_change writes the proposed value; the next run emits changed", …);
it("discard keeps the old value on the next run", …);
it("a conflict action on an uncertain_change task is not allowed", …);  // DecisionNotAllowed
```

- [ ] **Step 2: Run** `npx vitest run lib/domain app` → FAIL. **Step 3:** implementieren; vor den Actions Next-Doku zu Server Actions lesen. **Step 4: Run** `npx vitest run lib/domain app && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(review): conflict and uncertain change decisions with review facts`

### Task 14: Summary je Profilversion

**Files:**
- Create: `lib/domain/documents/archive-copies.ts`, `lib/domain/consolidation/format.ts`, `lib/domain/consolidation/summary.ts`, `lib/ai/tasks/summarize-profile.ts`, `config/prompts/summarize-profile/v1.md`, `lib/pipeline/consolidation/summary.ts`
- Modify: `config/models.json`, `config/queues.json`, `lib/domain/review-decisions.ts` (`failed_job/profile_summary`)
- Test: `lib/domain/__tests__/archive-copies.test.ts`, `lib/domain/consolidation/__tests__/format.test.ts`, `lib/pipeline/__tests__/summary.test.ts`

**Interfaces:**
- Consumes: `shingleHashes`, `text_shingles` (M3), `ModelClient.call`, `MockModel`, `createReviewTask`, `FACT_ATTRIBUTE_LABELS`, Task 12.
- Produces:
  - `findArchiveCopies(db, text: string): Promise<{ shingles: number; hits: number }>` – `shingleHashes(text, 15)` gegen `text_shingles`.
  - `config/models.json` Task `summarize-profile`: `claude-sonnet-5-5`, Prompt v1, `effort low`, `maxTokens 600`.
  - Task `summarize-profile`: Eingabe `{ kind: "spot" | "highlight"; name: string; sentences: [number, number]; lowConfidence: boolean; facts: Array<{ label: string; value: string }>; avoid: boolean }`; Ausgabe `{ text: string }` (≤ 800 Zeichen). Prompt (englisch, `## system`/`## user`): deutsch schreiben, nur aus den gelisteten Werten, keine Zitate, keine Werte erfinden, Satzzahl einhalten, bei `lowConfidence` den Hinweis „wenig belegt“ aufnehmen, bei `avoid` „formuliere ganz eigenständig“.
  - `formatProfileValue(attribute: string, value: unknown): string` in `format.ts` – Schutz/Schwell/0–1-Werte mit Komma und zwei Stellen („0,62“), Tiefen „4,0 m“, bool „ja“/„nein“, `occupancy` „Jul voll, Aug voll“ (nur bekannte Monate), `highlight.*` „ja: Nikos, Maria“ bzw. „nein“, `seabed` „Sand 50 %, Seegras 50 %“, `exclude` „ausgeschlossen (Militär)“ bzw. „nein“, sonst kompaktes JSON.
  - `summaryInput(snapshot: ProfileSnapshot, ctx: { level; name; cfg }): SummarizeInput` – Werte mit Label und formatiertem Wert (`formatProfileValue`), ohne Identitäts- und Lückenfelder; `lowConfidence = confidence < summary.lowConfidence`.
  - `sentenceCount(text: string): number`; `checkSummary(db, text, range): Promise<"ok" | "copied" | "sentences">`.
  - Stufe `consolidation.summary` (Queue concurrency 2): Plan = Objekte mit in diesem Lauf neu angelegter Profilversion (bei `params.stagesOnly`: jüngste Version der Ziele) und Ebene in `summary.levels`, ohne Summary `ok` für (Version, Prompt-Version). Job: bis `maxAttempts` (3) Aufrufe, ab Versuch 2 `avoid true`; `ok` → `profile_summaries` `ok`; nach 3 Fehlversuchen `empty` und Aufgabe `failed_job` (`subjectType "profile_summary"`, `subjectId "<geoObjectId>:<version>"`); `ALLOWED["failed_job/profile_summary"] = ["ignore", "regenerate_summary"]` (Wirkung über `deps.regenerateSummary?: (geoObjectId: string) => Promise<void>` in `DecideDeps`; die Verdrahtung auf `startConsolidationRun` macht Task 16).

- [ ] **Step 1: Failing tests**

```ts
it.each([
  ["shelter.N", 0.62, "0,62"], ["depth.min", 4, "4,0 m"], ["services.water", true, "ja"],
  ["occupancy", { "7": "full", "8": "full", "1": "unknown" }, "Jul voll, Aug voll"],
  ["highlight.food", { present: true, names: ["Nikos", "Maria"] }, "ja: Nikos, Maria"],
  ["exclude", { excluded: true, reason: "military" }, "ausgeschlossen (Militär)"],
])("formats %s", (a, v, s) => expect(formatProfileValue(a, v)).toBe(s));
it("a 16-word sequence copied from a chunk is found, a 14-word one is not", …);  // withRollback, Chunk + text_shingles
it("the input lists labelled values and never a quote", …);
it("a copied first answer is regenerated with avoid and stored", …);  // MockModel: 1. Antwort kopiert, 2. eigen → ok, attempts 2
it("three failed attempts store an empty summary and open one failed_job task", …);
it("an unchanged profile gets no new summary", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): profile summaries with 15-word archive check`

### Task 15: Folgeaufträge – gezielte Quellenfindung je Ort

**Files:**
- Create: `lib/domain/consolidation/followup.ts`, `lib/pipeline/consolidation/followup.ts`
- Modify: `lib/pipeline/discovery.ts` (`discovery.place`, `startPlaceDiscoveryRun`), `lib/domain/discovery/queries.ts` (`level "place"`), `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`
- Test: `lib/domain/consolidation/__tests__/followup.test.ts`

**Interfaces:**
- Consumes: `DiscoveryConfig.templates.tile`, `runQuery`, `discovery.propose` (M3), `place_discovery_requests`, `startRun`, Task 7.
- Produces:
  - `DiscoveryQuery.level` + `"place"` (`serp_queries.level` ebenso).
  - `placeQueries(db, geoObjectId: string, cfg: DiscoveryConfig): Promise<DiscoveryQuery[]>` – je Kachel-Template der bevorzugte gültige Name des Objekts in der Template-Sprache (fehlt er, entfällt die Query), `scopeId = geoObjectId`, Priorität 1.
  - `thinPlaces(db, geoObjectIds: string[], cfg: ConsolidationConfig["followup"], now: Date): Promise<string[]>` – Orte (Status `candidate`/`confirmed`) mit `documentsCount < minDocuments` ohne Anfrage in den letzten `cooldownDays`, nach `documentsCount` aufsteigend, höchstens `maxPlacesPerRun`.
  - Stufe `consolidation.followup` (ein Job): Ziele des Laufs → `thinPlaces`; nicht leer → `place_discovery_requests` je Ort und `startPlaceDiscoveryRun(db, boss, { geoObjectIds, triggeredBy: "consolidation:<runId>" })` – Art `event`, Umfang `system`/`places`, Stufen `["discovery.place", "discovery.propose"]`; Stufe `discovery.place`: ein Job je Objekt, `runQuery` je Query mit `ctx.tileId` der Ortskachel (Budget `dataforseo` über `httpCall`). Bewertungsläufe planen nichts.

- [ ] **Step 1: Failing tests**

```ts
it("a confirmed place with one document gets tile templates with its names", …);   // de/en/el Namen → 3 Queries
it("a place with two documents or a recent request is not thin", …);
it("at most maxPlacesPerRun places, fewest documents first", …);
it("the followup stage starts one discovery run and records the requests", …);
it("an evaluation run plans no followup", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): targeted source discovery for places with fewer than two documents`

### Task 16: Läufe und Auslöser

**Files:**
- Create: `lib/domain/consolidation/targets.ts`, `lib/pipeline/consolidation/{geo,run}.ts`, `lib/jobs/handlers/consolidation.ts`
- Modify: `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`, `lib/pipeline/text/run.ts` (`TEXT_RUN_STAGES`), `app/(admin)/tiles/[id]/{page.tsx,actions.ts}`, `app/(admin)/places/[id]/actions.ts`, `app/(admin)/geo/[id]/page.tsx`, `app/(admin)/runs/[id]/page.tsx`, `app/(admin)/review/[id]/actions.ts`
- Test: `lib/pipeline/__tests__/consolidation-run.test.ts`, `app/(admin)/__tests__/review-profile.test.ts`

**Interfaces:**
- Consumes: Tasks 12, 14, 15, `belegtreue` (M4), `startRun`, `comparison_set`.
- Produces:
  - `CONSOLIDATION_STAGES = ["consolidation.geo", "consolidation.summary", "consolidation.followup"]`; Queue `consolidation.geo` (concurrency 4, retryLimit 2, 60 s, Backoff).
  - `type ConsolidationParams = { tileId?: string; areaKey?: string; geoObjectIds?: string[]; comparisonSetArea?: string; evaluation?: true; rulesVersion?: string; stagesOnly?: string[] }`.
  - `consolidationTargets(db, run: { id: string; params: Record<string, unknown> }): Promise<string[]>` – `geoObjectIds` direkt; `tileId` → gültige Objekte der Kachel (`tile_geo_objects`); `areaKey` → Objekte aller Küstenkacheln des Reviers; `comparisonSetArea` → Geo-Objekte der Orte im Vergleichssatz; sonst (Text-Lauf) → Objekte mit Facts aus Extraktionsläufen dieses Laufs ∪ Objekte mit Erwähnungen dieses Laufs; sortiert, dedupliziert.
  - `consolidationBlocked(db, runId: string): Promise<boolean>` – Lauf hat Extraktionsläufe und `belegtreue(runId).ratio < 1`.
  - Stufe `consolidation.geo`: blockiert → keine Jobs (Log `consolidation blocked by quote fidelity`); sonst ein Job je Ziel, Handler `consolidateGeo(db, id, { runId, mode: params.evaluation ? "evaluation" : "regular", rulesVersion })`.
  - `startConsolidationRun(db, boss, input: { scope: { tileId: string } | { areaKey: string } | { geoObjectIds: string[] } | { comparisonSetArea: string }; triggeredBy: string; evaluation?: true; rulesVersion?: string; stagesOnly?: string[] }): Promise<{ id: string }>` – Art `stage` (Bewertung `reprocess` mit `params.evaluation`), Umfang `tile`/`area`/`place` (genau ein Ort) / `system`; Stufen `CONSOLIDATION_STAGES`, Bewertung nur `["consolidation.geo"]`.
  - `TEXT_RUN_STAGES` (M4) + `CONSOLIDATION_STAGES`, damit auch `startReprocessRun` konsolidiert.
  - Review-Action (Task 13): nach `conflict`/`uncertain_change` → `startConsolidationRun(db, boss, { scope: { geoObjectIds: [geoObjectId] }, triggeredBy })`; `deps.regenerateSummary` → `startConsolidationRun(…, { scope: { geoObjectIds: [id] }, stagesOnly: ["consolidation.summary"] })`.
  - UI: Kachel-Seite „Konsolidieren“, Ort- und Geo-Seite „Profil neu berechnen“; Lauf-Seite zeigt bei `consolidationBlocked` „Konsolidierung gesperrt: Belegtreue unter 100 %“.

- [ ] **Step 1: Failing tests**

```ts
it("a text run consolidates exactly the objects it extracted facts for", …);  // Stufenfunktionen direkt, MockModel, withRollback
it("a text run with blocked quote fidelity consolidates nothing", …);
it("tile scope plans every valid object of the tile once", …);
it("an evaluation run over the comparison set writes evaluation profiles only", …);
it("the place action starts a place-scoped run", …);
it("deciding a conflict starts a consolidation run for the object", …);   // runs-Zeile mit params.geoObjectIds
```

- [ ] **Step 2: Run** `npx vitest run lib/pipeline/__tests__/consolidation-run.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/pipeline lib/jobs && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(consolidation): consolidation run, text run integration, quote fidelity gate`

### Task 17: Reiter „Profil“, Geo-Profil und Kartenfarbe

**Files:**
- Create: `lib/domain/profile-view.ts`, `app/(admin)/places/[id]/profile-tab.tsx`
- Modify: `app/(admin)/places/[id]/page.tsx`, `app/(admin)/geo/[id]/page.tsx`, `app/(admin)/_components/labels.ts`, `lib/domain/map-data.ts`, `app/(admin)/_components/map-view.tsx`
- Test: `lib/domain/__tests__/profile-view.test.ts`

**Interfaces:**
- Consumes: `latestProfile`, `profileAsOf`, `popularityForArea`, `formatProfileValue` (Task 14), `geoFacts`/`FactView`, `QuoteContext`, `FACT_ATTRIBUTE_LABELS`.
- Produces:
  - Labels: `ORIGIN_LABELS` (`computed` „Berechnet“, `text` „Text“, `review` „Review“, `observed` „Beobachtung“, `gazetteer` „Gazetteer“, `derived` „Abgeleitet“), `RULE_LABELS` (je Regel ein deutscher Satz aus der Spec, z. B. `shelter` „Berechnung, Text korrigiert um höchstens ±0,3, Häfen mind. 0,8“), `CONFIDENCE_CLASS_LABELS` (hoch/mittel/niedrig), `GAP_REASON_LABELS`.
  - `type ProfileRow = { attribute: string; label: string; value: unknown; display: string; origin: ProvenanceOrigin; rule: string; ruleLabel: string; confidence: number; confidenceClass: ConfidenceClass; observedAt: string | null; lastConfirmedAt: string | null; expired: boolean; conflict: ConflictNote | null; pending: AttributeProvenance["pending"]; factCount: number }`
  - `profileView(db, geoObjectId: string, opts?: { version?: number; asOf?: string }): Promise<{ snapshot: ProfileSnapshot; rows: ProfileRow[]; derived: Array<{ label: string; display: string }>; gaps: Array<{ attribute: string; label: string; reason: string }>; popularity: number | null; summary: { text: string | null; status: SummaryStatus } | null; versions: number } | null>` – Zeilen in Fact-Schema-Reihenfolge, Identität im Kopf.
  - `profileAttributeFacts(db, geoObjectId: string, version: number, attribute: string): Promise<{ row: ProfileRow; facts: FactView[]; computations: Array<{ id: string; kind: string; createdAt: Date }>; pois: Array<{ id: string; name: string }> }>` – genau die Facts aus `provenance.factIds`.
  - Reiter „Profil“ (`?tab=profile&attr=<key>`): Kopf mit Version, `valid_from`, Regelversion, Profil-Konfidenz, Beliebtheit, Quellen/Dokumente, Summary; Tabelle Attribut | Wert | Konfidenz (Klasse) | Herkunft | Regel | beobachtet | bestätigt; Konfliktmarker (beide Werte, Link zur Aufgabe), „abgelaufen“, „Änderung in Prüfung“; Klick auf eine Zeile öffnet die Facts mit Zitat (`QuoteContext`), Computations und POIs; Abschnitt „Lücken“ mit Grund. Geo-Seite: Abschnitt „Profil“ mit derselben Tabelle (Komponente wiederverwendet).
  - Karte: Ebene `places` erhält `profileConfidence` (jüngstes Profil, `null` ohne Profil); Farbe stufig nach Klasse, grau ohne Profil.

- [ ] **Step 1: Failing tests**

```ts
it("profileView lists rows in schema order with provenance and gaps", …);        // withRollback
it("profileAttributeFacts returns exactly the provenance facts with quote context", …);
it("an older version is shown with ?version", …);
it("map places carry the latest profile confidence", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; vor den Seiten Next-Doku zu `searchParams` und Cache Components lesen. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): place profile tab with provenance per attribute and facts on click`

### Task 18: Reiter „Zeitachse“

**Files:**
- Create: `lib/domain/profile-timeline.ts`, `app/(admin)/places/[id]/timeline-tab.tsx`, `app/(admin)/places/[id]/version-slider.tsx`
- Modify: `app/(admin)/places/[id]/page.tsx`, `app/(admin)/_components/labels.ts`
- Test: `lib/domain/__tests__/profile-timeline.test.ts`

**Interfaces:**
- Consumes: `profileAsOf`, `latestProfile`, `formatProfileValue`, Task 1.
- Produces:
  - `diffVersions(a: ProfileSnapshot, b: ProfileSnapshot): Array<{ attribute: string; kind: "added" | "removed" | "changed" | "class"; before: unknown; after: unknown; classBefore: ConfidenceClass | null; classAfter: ConfidenceClass | null }>` – Attribute sortiert; `class` = gleicher Wert, andere Konfidenzklasse.
  - `profileTimeline(db, geoObjectId: string): Promise<{ versions: Array<{ version: number; validFrom: string; createdAt: Date; runId: string | null; events: number }>; events: Array<{ seq: number; type: ChangeType; attribute: string | null; oldValue: unknown; newValue: unknown; severity: ChangeSeverity; profileVersion: number | null; createdAt: Date }> }>` – Ereignisse nach `seq` absteigend.
  - Labels `CHANGE_TYPE_LABELS` (`new_attribute` „Neu“, `changed` „Geändert“, `uncertain` „Unsicher“, `expired` „Abgelaufen“, `place_new` „Ort neu“, `place_abandoned` „Ort aufgegeben“, `geo_changed` „Gazetteer geändert“), `SEVERITY_LABELS` (`info` „Info“, `notable` „Bemerkenswert“, `safety` „Sicherheit“).
  - Reiter „Zeitachse“ (`?tab=timeline&v=<n>&asOf=YYYY-MM-DD`): `<VersionSlider>` (Client-Komponente, `input type="range"` 1…n, setzt `v` per `router.replace`), Datumsfeld „Stand zum“ → `profileAsOf` → Version; Profiltabelle des gewählten Stands (Task 17), Diff zur Vorversion (vorher/nachher formatiert, Klassenwechsel), Ereignisliste mit Severity-Farbe, `seq`, Typ, Attribut, alt → neu, Version.

- [ ] **Step 1: Failing tests**

```ts
it("diffVersions reports added, removed, changed and class-only changes", …);
it("the timeline lists versions with event counts and events newest first", …);  // withRollback
it("asOf before the first version yields no profile", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): place timeline with version slider, diff and change events`

### Task 19: Abnahme-Prüfung, Runbook, Übergabe

**Files:**
- Create: `scripts/check-profiles.ts`, `docs/pilot/m5-abnahme.md`, `e2e/profile.spec.ts`
- Modify: `package.json` (`check:profiles`), `docs/runbook.md`, `e2e/global-setup.ts` (Synthetik-Ort mit zwei Profilversionen)
- Test: `scripts/__tests__/check-profiles.test.ts`

**Interfaces:**
- Consumes: alle vorigen Tasks.
- Produces:
  - `checkProfiles(db, areaKey: string, cfg = getConfig()): Promise<{ objects: number; withProfile: number; missing: Array<{ geoObjectId: string; name: string | null; level: FactLevel }>; withoutProvenance: string[]; openConflicts: number; openUncertain: number; summaries: { ok: number; empty: number }; asOfCheck: boolean }>` – Objekte = bestätigte Orte und gültige Objekte der Ebenen `area`, `island`, `cape_strait`, `poi` in den Kacheln des Reviers; `withoutProvenance` = Profile mit einem Attribut ohne Provenienz oder Regel; `asOfCheck` = für ein Objekt mit ≥ 2 Versionen liefert `profileAsOf(valid_from(v2) − 1 Tag)` Version 1 (ohne solches Objekt `true`).
  - CLI `npm run check:profiles -- --area saronic` – Ausgabe, Exit 1 bei `missing` oder `withoutProvenance` nicht leer oder `asOfCheck false`.
  - e2e: Login → Ort-Seite des Synthetik-Orts → Reiter „Profil“ zeigt `shelter.N` mit Herkunft „Text“ → Klick zeigt ein Fact mit `<mark data-kind="quote">` → Reiter „Zeitachse“, Regler auf Version 1 → alter Wert sichtbar.

- [ ] **Step 1: Failing test** – `check-profiles.test.ts`: `a confirmed place without profile is missing` und `an area whose objects all have profiles with provenance passes`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Runbook** – Abschnitt „Konsolidierung“: „Datensätze laden“ mit `roads,sitelinks` je Revier → „Geometrie“ erneut (Straßenabstand, nur `quietness` entsteht neu) → „Konsolidieren“ je Revier (oder automatisch nach jedem Text-Lauf) → Review `conflict`/`uncertain_change` → `check:profiles`. Regeln ändern: neue Datei `config/consolidation/v2.json`, Bewertungslauf über den Vergleichssatz (`startConsolidationRun({ scope: { comparisonSetArea }, evaluation: true, rulesVersion: "v2" })`), dann `active.json` umstellen und deployen. Gesperrte Konsolidierung (Belegtreue < 100 %). `docs/pilot/m5-abnahme.md`: Checkliste aus Roadmap und Spec 07 (Profil je bestätigtem Objekt, Herkunft je Attribut und Lückenliste in der UI, Profil zum Datum, Zeitregler zeigt alten Stand, Szenario-Tests grün, offene Konflikte/Unsicherheiten gezählt).
- [ ] **Step 6: Gesamtprüfung** – `npm run lint && npm run typecheck && npx vitest run && npm run test:e2e && npm run build` → alles grün.
- [ ] **Step 7: Commit** `docs: M5 acceptance check, runbook and profile e2e`
- [ ] **Step 8: Übergabe an Christian (nicht vom Ausführenden zu erledigen)** – auf dem Server `roads,sitelinks` laden, Geometrie und Konsolidierung für beide Reviere starten, Review-Aufgaben abarbeiten, `check:profiles` für `saronic` und `argolic` grün, Abnahme-Checkliste abhaken.

---

## Bewusste Abweichungen und Entscheidungen dieses Plans

- **Regelversionen als Ordner `config/consolidation/<version>.json` mit `active.json`** statt einer Datei `config/consolidation.json`: so können eine aktive und eine Kandidaten-Version nebeneinander bestehen, wie es die Regression aus Spec 10 verlangt. Umschalten in M5 per Deploy; der bewusste Aktivieren-Klick auf `/quality` kommt mit M7.
- **Regelzuordnung aus dem Fact-Schema** (`AttributeDef.rule`, M2/M4), Parameter aus der Konsolidierungs-Konfiguration: ein Test stellt sicher, dass jeder dort genannte Regelname eine Implementierung hat. Dazu `computed_only` und `review_over_computed` aus M2.
- **Generischer Review-Vorrang:** ein Review-Fact, der jünger ist als alle übrigen Eingänge, gilt mit 0,95 ohne Regel und ohne Konflikt; spätere Facts laufen wieder durch die Regel. Ohne diesen Vorrang würde eine Konflikt-Entscheidung beim nächsten Lauf denselben Konflikt erneut erzeugen.
- **Konflikt-Schlüssel und Auflösungen:** Schlüssel = Hash der Fact-IDs beider Seiten; „Beide (saisonal)“ und „Offen lassen“ schreiben keinen Fact, sondern lösen den Vermerk über die entschiedene Aufgabe auf; neue Facts ergeben einen neuen Schlüssel und damit eine neue Aufgabe. Gleiches Muster für `uncertain_change` „Verwerfen“.
- **„Aktuell bestätigt“ und Ablauf:** `lastConfirmedAt` eines Text-Facts ist das letzte Prüfdatum seines Dokuments (die Quelle sagt es noch), bei verschwundenen Dokumenten das Beobachtungsdatum. „Älter als zwei Zyklen“ misst dieses Datum gegen `2 × cycle_days` der Kachel. Ein Messen am `observed_at` hätte bei Pilot-Zyklen von 30 Tagen fast jeden Text-Wert sofort ablaufen lassen. Berechnete und Review-Werte laufen nicht ab.
- **Ablauf senkt die Konfidenz auf die Mitte der nächstniedrigeren Klasse** (hoch 0,85 → 0,55, mittel → 0,2); Klassen hoch ≥ 0,7, mittel ≥ 0,4.
- **Erste Profilversion ohne Attribut-Ereignisse:** nur `place_new` für bestätigte Orte. Sonst würde der erste Lauf je Objekt Dutzende `new_attribute`-Ereignisse in den Feed schreiben; `new_attribute` gilt ab Version 2.
- **`geo_changed` wird bei der Konsolidierung erkannt** (Name, Eltern, Geometrie-Hash und Ortsposition als Identitätsfelder im Profil) statt im Gazetteer-Lauf; der Gazetteer bleibt unverändert, das Ereignis erscheint mit dem nächsten Konsolidierungslauf.
- **Inhalts-Hash statt Feldvergleich für „neue Version“:** Werte, Konfidenzklassen, Konflikt-Schlüssel mit Auflösung und Ablauf-Markierungen. Konfliktvermerke zählen mit, damit eine Auflösung sichtbar wird. Zahlen werden auf 3 Stellen gerundet und Eingänge vorher sortiert, damit Gleitkomma-Reihenfolge keine Versionen erzeugt.
- **`gaps` als `jsonb` mit Grund** statt `text[]` (Spec 02), damit begründete Lücken aus M2 (`no_anchor_area`, `no_bathymetry` …) bis in die UI tragen; Ortsart-spezifische Ausnahmen (Kontakt, Preise bei Ankerplätzen) in der Konfiguration.
- **Severity ergänzt um Tiefe und Verbote** (`depth.*`, `prohibitions`, `restriction` → `safety`), weil Spec 10 im Revisit-Szenario genau das erwartet; Spec 07 nennt sie nicht ausdrücklich. Muster in der Konfiguration.
- **`popularity` wird beim Lesen berechnet** (`popularityForArea` aus `sources_count` der jüngsten Profile) statt gespeichert: eine Normierung auf das Revier-Maximum würde bei jeder neuen Quelle eines Orts für alle Orte des Reviers neue Versionen erzeugen. Gespeichert ist die Zahl unabhängiger Quellen; M6 nutzt dieselbe Funktion.
- **Highlights am Ort:** gültige POIs einer Kategorie im 2-km-Umkreis gehen als berechneter Eingang in `highlight.<Kategorie>` ein (Gesamtdesign Abschnitt 4: Kategorie-Facts am Ort werden aus den POIs abgeleitet). `highlightIds` des Spots bildet M6 als Umkehrung der `spotIds` der POI-Profile.
- **Signale als Datensätze:** Straßen (Overpass) und Wikidata-Sitelinks laufen über `datasets.import` (M2), damit die Konsolidierung kein Netz braucht. Der Straßenabstand ergänzt die M2-Ruhe-Computation (`rulesVersion` erhöht), wie M2 angekündigt hat.
- **Saisonhinweise ohne Schließungs-Schluss:** aus `season_notes`-Facts je Art vereinigt und je Attribut die beobachteten Monate in der Provenienz; aus „im Juli gesehen“ wird nicht „im Mai geschlossen“ gefolgert.
- **Summary synchron je Objekt** (`model.call`, bis 3 Versuche) statt über die Batch-API: höchstens einige hundert Aufrufe je Lauf, und die Wiederholung mit Hinweis braucht das Ergebnis der Prüfung sofort. Eigene, nur anfügende Tabelle `profile_summaries`, weil Profile unveränderlich sind. Eine dreimal abgelehnte Summary bleibt leer und öffnet eine `failed_job`-Aufgabe mit „Neu erzeugen“/„Ignorieren“ – keine neue Review-Art.
- **Beobachtungen (`observations`) bleiben ohne Tabelle bis M8:** die Lader und Regeln behandeln Herkunft `observed` bereits (Gewicht 0,8 in der Konfiguration), Tests konstruieren solche Eingänge direkt.
- **Bewertungslauf** schreibt in `evaluation_profiles` (Arbeitszustand) und erzeugt weder Profile, Ereignisse, Aufgaben, Summaries noch Folgeaufträge; Vergleich alt/neu und Aktivieren kommen mit M7.
- **Belegtreue-Sperre zweifach:** Facts gesperrter Extraktionsläufe sind nie aktiv (M4), zusätzlich plant `consolidation.geo` in einem Lauf mit Belegtreue < 100 % keine Jobs, und die Lauf-Seite zeigt den Grund.
- **`valid_from` = Datum des Laufbeginns (UTC)**, damit alle Jobs eines Laufs über Mitternacht dasselbe Datum tragen; mehrere Versionen am selben Tag sind erlaubt, `profile_as_of` nimmt dann die höchste.
- **Gezielte Quellenfindung** mit Abklingzeit 90 Tage je Ort und höchstens 30 Orten je Lauf; Budget-Grenze über `httpCall` (`dataforseo`). Neue Quellen gehen wie in M3 über `source_approval`; der Weg bis zur erneuten Konsolidierung bleibt manuell bis M8.
- **`observedAsOf`-Rekonstruktion** (Spec 07, M8) ist nicht Teil von M5; `buildProfile` ist rein und kann dafür später mit gefilterten Eingängen aufgerufen werden.
- **Karte:** Orte werden nach Profil-Konfidenz eingefärbt; die Kachelfärbung nach Profilalter folgt mit dem Scheduler (M8), wenn Zyklen tatsächlich laufen.

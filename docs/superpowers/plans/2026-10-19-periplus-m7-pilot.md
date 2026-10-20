# Periplus M7 – Pilot-Abnahme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das Werkzeug für die Pilot-Abnahme: Kennzahlen je Revier, Kachel und Messung in `quality_snapshots` mit Dashboard `/quality`; Navily-Abgleich als Assistent (Vorschläge je Attribut aus einer lokalen Datei zur Laufzeit, Bestätigung per Klick auf `/quality/compare`, CLI-Erstdurchgang mit `--accept-proposals`), nur Ergebnisse in `comparison_results`, Abweichungen als Review `comparison_deviation`; Regression mit Bewertungslauf und bewusstem Aktivieren; simulierter Revisit (Sim-Klon, Szenario, Fetch-Adapter `simulated`, Verifikation, `asOf` über die API) plus Revisit-Integrationstest in der CI; Kostenbericht mit Mittelmeer-Hochrechnung, Pilotbericht und Abnahme-Checkliste. Die echten Pilotläufe führt Christian danach aus.

**Architecture:** Fachlogik in `lib/domain/quality/` (Vergleichswerte, Ergebnisse, Navily-Assistent, Kennzahlen, Snapshots, Regression, Berichte) und `lib/domain/revisit/` (Szenario, Leitplanken, Verifikation). Messen ist eine Run-Stufe `quality.measure` (ein Job je Revier) auf der vorhandenen Run-Mechanik; ein Messlauf trägt Bezeichnung und Zeitfenster und ist der `run_id` seiner Snapshot-Zeilen. Der Navily-Abgleich liest die Datei nur zur Laufzeit (Seite, CLI) und schreibt ausschließlich Ergebnis-Enums mit dem Hash des **eigenen** Werts; dadurch gilt ein altes Ergebnis automatisch weiter, solange sich der eigene Wert nicht ändert (Regression). Der Revisit ist ein Lauf der Art `revisit` (Fetch- und Text-Stufen inkl. Konsolidierung); in der Sim-Umgebung ersetzt der Adapter `lib/adapters/fetch/simulated.ts` jeden Netzabruf, die Datenbank muss `periplus_sim` heißen und das Archiv schreibt unter einem eigenen Präfix.

**Tech Stack:** wie M6 (Next.js 16.4.2, React 19.3, Drizzle 0.45, pg-boss 12, zod 4, Vitest 5, Playwright 1.64, `@aws-sdk/client-s3`, `ajv@^8`), keine neuen npm-Abhängigkeiten; Shell-Werkzeuge `pg_dump`/`pg_restore`/`psql` aus dem Postgres-Container.

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-10-qualitaet-pilot-design.md` (primär), `…-09-admin-ui-design.md` (`/quality`, `/quality/compare`, Review `comparison_deviation`, Bearbeitungszeit), `…-08-liefervertrag-api-design.md` (`GET /spots/{id}?asOf=`, Abnehmer), `…-07-konsolidierung-design.md` (Ereignistypen, Severity, Bewertungslauf), Gesamtdesign `…-periplus-design.md` (Roadmap M7, Gates, Anti-Ziele). Fachlich maßgebend: `.idea/datendienst-spec.md` („Qualitätsmetriken“, „Pilot Saronischer Golf“ mit Erfolgskriterien und simuliertem Revisit, Grundprinzip 9). Baut auf M1 (`comparison_set`, `lib/domain/comparison.ts`, `/quality`, `decideReviewTask`, `createReviewTask`, `review_decisions.duration_ms`, `check:gazetteer`), M2 (`SECTORS`, `canonicalJson`, `loadNavilySpots`/`comparePlace`/`compare:navily` in `lib/domain/quality/navily-sample.ts`), M3 (`FetchUrlDeps`, `fetchUrl`, `storeFetched`, `markChecked`, `markGone`, `normalizeText`, `FETCH_RUN_STAGES`, `Transport`), M4 (`belegtreue`, `activeExtractionRun`, `routes`/`route_stops`, `stripAffix`, `MockModel`, `startReprocessRun`), M5 (`profiles`, `change_events.seq`, `latestProfile`, `evaluation_profiles`, `consolidateGeo`, `startConsolidationRun`, `TEXT_RUN_STAGES` inkl. Konsolidierung, `getConsolidationConfig`) und M6 (`buildDelivery`, `spotAsOf`, `delivered_objects`, `consumePackage`/`delivery:consume`) auf.

## Global Constraints

- Alle Global Constraints aus M0–M6 gelten weiter (Next 16.4.2; vor Code an Routen, `proxy.ts`, `next.config.ts` die Next-Doku in `node_modules/next/dist/docs/` lesen; kein `console.*`; Englisch im Code, Deutsch in der UI; Tests gegen `db-test` und Test-Bucket, kein Netz, KI nur `MockModel`; Route-Policy für jede Route; Tests zählen nie DB-weit; Geo-Testdaten in `withRollback` oder außerhalb der Pilotbox 23,0–23,75° O × 37,0–38,0° N; Schwellen, Gewichte, Budgets in `config/`).
- Kennzahlen (Spec 10, Berechnung verbatim): „Abdeckung: Anteil der Orte im Vergleichssatz mit `status = confirmed`“ · „Mehrbefund: Anteil bestätigter Orte mit Erwähnungen aus ≥ 2 Dokumenten verschiedener Quellen“ · „Fact-Präzision: Über `comparison_results` der aktuellen Profile: (`match` + `deviation_confirmed_own`) / (alle verglichenen Attribute ohne `not_at_navily`)“ · „Belegtreue: Anteil Facts mit `quote_verified = true` unter allen Text-Facts des Laufs; < 100 % sperrt die Konsolidierung des Laufs“ · „Schutz-Konfidenz: Anteil Orte, bei denen jeder der 8 Sektoren mindestens einen Text-Fact hat, der bestätigt (Abweichung ≤ 0,2) oder korrigiert“ · „Routen-Rekonstruktion: Anteil Routen, deren Stopps alle einem bestätigten Ort zugeordnet sind“ · „Kosten je Ort: Summe `external_calls` des Laufs / bestätigte Orte im Umfang“ · „Review-Aufwand: Summe der Bearbeitungszeiten der im Lauf entstandenen Review-Aufgaben, je 100 Orte“. Zusatz: „Anteil Orte mit Highlight-Fact, Anteil Orte mit Beobachtung < 18 Monate“.
- Zielwerte Pilot/Vollbetrieb (Quell-Spec): Abdeckung 85 %/95 %, Mehrbefund 70 %/85 %, Fact-Präzision 90 %/95 %, Belegtreue 100 %/100 %, Schutz-Konfidenz 60 %/80 %, Routen-Rekonstruktion 70 %/90 %, Kosten je Ort „unter 2 €“/„unter 0,50 €“; Review „unter 30 Minuten Review je 100 Orte und Lauf“ (Vollbetrieb), Pilot: „Review-Aufwand für den zweiten Lauf unter 60 Minuten“.
- Snapshots: „gespeichert in `quality_snapshots` (run_id, scope, metric, value, details jsonb), angezeigt auf `/quality`“; „Berechnung je Kachel, Revier und Lauf in `lib/domain/quality/metrics.ts`“.
- Vergleichssatz: „im Pilot 50 Orte, je weiterem Revier 20–30“. `comparison_results` „(nur anfügend): (place_id, attribute, profile_version, result: `match`, `deviation`, `not_at_navily`, `deviation_confirmed_own`, `deviation_confirmed_navily`, `unclear`; checked_by, checked_at). **Gespeichert wird nur das Ergebnis, nie ein Navily-Wert** … es gibt keine Spalte, in die ein Navily-Wert passen würde.“ Vergleichsattribute: „Existenz, Position, Schutz je Sektor, Tiefe, Grund, Bojen, Versorgung, Taverne“. „Jede Abweichung erzeugt eine Review-Aufgabe `comparison_deviation`“ mit den Entscheidungen „Eigener Wert stimmt, Navily stimmt (eigener Wert falsch), Unklar“.
- Navily-Datei: nur zur Laufzeit von `NAVILY_SPOTS_PATH` bzw. `--navily <pfad>` gelesen; weder Repo, DB, Review-Kontext, Log noch Bericht enthalten Navily-Namen, -IDs, -URLs, -Koordinaten oder -Werte (auch nicht `rating`). Testdaten sind synthetisch (`test/fixtures/navily/sample.json` aus M2).
- Regression: „Für Attribute, deren Wert sich gegenüber dem zuletzt geprüften Profil nicht geändert hat, gilt das alte Ergebnis weiter; geänderte Werte gehen zur erneuten Prüfung. Übereinstimmung und Abdeckung dürfen nicht sinken; sonst wird die neue Konfiguration nicht aktiv geschaltet (`/quality` zeigt den Vergleich alt/neu, Aktivieren ist ein bewusster Klick).“ Bewertungslauf „`reprocess` mit Kennzeichen `evaluation`, ohne Änderungsereignisse in den Change-Feed“.
- Simulierter Revisit: Klon in „eine Datenbank `periplus_sim` (pg_dump/restore, Skript `scripts/sim/clone.sh`), eigener Worker-Prozess gegen diese Datenbank und ein eigener S3-Präfix“; „Szenario-Datei `test/revisit/scenario.json`: 10 Änderungen mit erwarteten Ereignissen“; Adapter `simulated` „liefert für die Szenario-URLs die veränderten Inhalte (Versionen mit `simulated = true`), alle anderen URLs wie aufgezeichnet“; „`scripts/sim/verify.ts` … 10 von 10 erwartet, 0 zusätzliche“; „`GET /spots/{id}?asOf=<Datum vor Revisit>` in der Sim-Umgebung liefert die alte Version“; CI: „kleinem Fixture-Revier (eine Kachel, 3 Orte, 5 Dokumente)“.
- Kostenbericht: „`docs/pilot/2026-xx-kostenbericht.md`: Kosten je Stufe, je Ort, Annahmen für Ortszahl je Revier, Zahl der Reviere 60–100“. Kachelgröße: „Orte je Kachel, Ziel 10–40“.
- Nur anfügend (`forbid_mutation('')`): `comparison_results`, `quality_snapshots`, `config_activations`.
- Sim-Leitplanke: Ein Prozess mit `PERIPLUS_SIMULATION` läuft nur gegen eine Datenbank namens `periplus_sim` oder `*_test` und nur mit gesetztem `S3_WRITE_PREFIX`.

## Review Focus

1. **Simulation trifft die echte Zeitachse** (falsche `DATABASE_URL` in `.env.sim`, mitgeklonte pg-boss-Jobs der Produktion laufen im Sim-Worker an, Sim schreibt ins Archiv der Produktion): erwartet Abbruch vor dem ersten Schreibzugriff, Archiv-Schreiben nur unter dem Präfix, Lesen alter Versionen weiter möglich, Sim-Klon ohne Jobs. → Task 11 Tests `assertSimulationTarget refuses periplus and accepts periplus_sim`, `writes go under the prefix, reads fall back to the unprefixed key`, `the worker refuses to start a simulation without write prefix`; Task 13 Test `revisit preflight fails on queued pg-boss jobs`; Task 15 `clone-test.sh` Fall `pgboss jobs are removed after restore`.
2. **Szenario passt nicht mehr zum Archiv** (Text wurde seit dem Entwurf neu gecrawlt, typografische Anführungszeichen, doppelte URL, Edit trifft zweimal): erwartet lauter Abbruch vor dem Lauf mit URL und Suchtext, nie ein stilles „unverändert“, das in der Verifikation als „fehlendes Ereignis“ endet. → Task 12 Tests `an edit whose text is missing fails with url and text`, `an edit matching twice is rejected`, `preflight rejects duplicate urls and unknown documents`.
3. **`asOf` am selben Tag** (Paket vor dem Revisit und Paket danach am selben UTC-Tag gebaut, Profile mit gleichem `valid_from`): `asOf=<Vortag>` liefert dann entweder nichts oder schon die neue Version. Erwartet: die Verifikation erkennt das und meldet den Grund statt „bestanden“ oder eines rätselhaften 404. → Task 13 Tests `asOf check reports a same-day previous delivery`, `asOf check passes when the API returns the older profile version`.
4. **Navily-Zuordnung in engen Häfen und mit anderer Schreibweise** (Marina und Ankerbucht 300 m neben einem Navily-Hafen, „Ormos Vathy“ gegen „Vathi“, gleichnamiger Spot 1,5 km entfernt, Spot ohne `prot`): ein Navily-Spot gehört höchstens einem Ort, Art-Verträglichkeit entscheidet bei Gleichstand, fehlende Navily-Angaben ergeben `not_at_navily` statt `deviation`. → Task 3 Tests `one navily spot is matched to at most one place, marina before bay`, `"Ormos Vathy" matches Vathi 400 m away`, `a same-named spot 1.5 km away is no match`, `missing prot proposes not_at_navily for all sectors`.
5. **Wertrauschen bei der Regression** (Schutz 0,6 → 0,6000001 nach neuer Regelversion, Position um 2 m verschoben, Grund-Anteile in anderer Reihenfolge): alte Ergebnisse müssen weiter gelten, sonst müsste der Admin nach jedem Bewertungslauf alle ~800 Attribute neu prüfen; ein echter Klassenwechsel (geschützt → offen) muss dagegen zur Prüfung. → Task 2 Tests `float noise and seabed order keep the value hash`, `crossing the protected threshold changes the hash`; Task 10 Test `an attribute with an unchanged value hash carries the old result`.

---

## File Structure

```
lib/db/schema/quality.ts                  comparison_results, quality_snapshots, config_activations (+ Enums)
drizzle/00NN_*.sql                        generiert + Trigger (forbid_mutation), Checks
config/quality.json                       Zielwerte, Schwellen, Navily-Abgleich, Hochrechnung
lib/config/{schemas,index}.ts             + quality
lib/env.ts                                + NAVILY_SPOTS_PATH, S3_WRITE_PREFIX, PERIPLUS_SIMULATION (optional)
lib/adapters/s3.ts                        writePrefix (Schreiben mit Präfix, Lesen mit Rückfall)
lib/adapters/fetch/simulated.ts           SimulatedFetcher, simulatedTransport
lib/domain/quality/
  comparison-values.ts                    COMPARISON_ATTRIBUTES, comparisonValues, loadComparisonSubjects
  comparison-results.ts                   recordComparisonResults, latestComparisonResults
  trigram.ts                              trigramSimilarity (pg_trgm-Semantik)
  navily-sample.ts                        (M2) NavilySpot um name/kind/type/water/shop erweitert
  navily-assistant.ts                     matchPlacesToSpots, proposeResults, navilyCoverage, loadNavilyFromEnv
  navily-run.ts                           runNavilyComparison (CLI-Kern)
  metrics.ts                              eine Funktion je Kennzahl
  snapshot.ts                             computeQualitySnapshot, Lesefunktionen, metricStatus
  dashboard.ts                            qualityDashboard
  regression.ts                           startEvaluation, compareEvaluation, activateCandidate, activeRulesVersion
  reports.ts                              costReport, extrapolate, renderCostReport, renderPilotReport
lib/domain/revisit/
  guard.ts                                assertSimulationTarget, databaseNameOf
  scenario.ts                             Szenario-Schema, applyEdit, preflightScenario
  verify.ts                               verifyRevisit, checkAsOf
lib/domain/review-decisions.ts            + comparison_deviation
lib/pipeline/quality.ts                   Stufe quality.measure, startMeasurement
lib/pipeline/revisit.ts                   REVISIT_STAGES, startRevisitRun
lib/pipeline/fetch/url.ts                 FetchUrlDeps.simulated
lib/pipeline/consolidation/run.ts         Regelversion aus Aktivierung, Bewertungs-Kandidat
lib/domain/consolidation/{inputs,store}.ts  Extraktions-Kandidat im Bewertungsmodus
lib/pipeline/text/run.ts                  Bewertungs-Textlauf
lib/jobs/{queues,stages,registry}.ts, lib/jobs/handlers/{quality,fetch}.ts, worker/index.ts, config/queues.json
app/(admin)/quality/{page.tsx,actions.ts}             Dashboard, Messen, Regression
app/(admin)/quality/compare/{page.tsx,actions.ts,compare-place.tsx}
app/(admin)/review/[id]/{page.tsx,comparison-decision.tsx}
app/(admin)/settings/page.tsx             wirksame Regelversion, Freigabestatus Extraktion
lib/security/route-policy.ts              + /quality/compare
scripts/compare-navily.ts                 + --accept-proposals, --coverage
scripts/sim/{clone.sh,revisit.ts,verify.ts,draft-scenario.ts}, scripts/sim/__tests__/clone-test.sh
scripts/{report-costs.ts,report-pilot.ts}
test/revisit/fixture/{area.ts,fake-model.ts,scenario.json,documents/d1.md…d5.md}
lib/pipeline/__tests__/revisit-run.test.ts
.env.sim.example, package.json, docs/runbook.md, docs/pilot/m7-abnahme.md
```

---

### Task 1: Schema und Konfiguration der Qualitätsmessung

**Files:**
- Create: `lib/db/schema/quality.ts`, `config/quality.json`, Migration (generiert) + `drizzle/00NN_quality_triggers.sql`
- Modify: `lib/db/schema/index.ts`, `lib/config/schemas.ts`, `lib/config/index.ts`
- Test: `lib/db/__tests__/quality-schema.test.ts`, `lib/config/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `forbid_mutation()`, `places`, `runs`, `review_tasks`.
- Produces:
  - Enums `comparison_result` (`match, deviation, not_at_navily, deviation_confirmed_own, deviation_confirmed_navily, unclear`), `comparison_method` (`manual, proposal_confirmed, proposal_auto, review`); TS `ComparisonResultValue`, `ComparisonMethod`.
  - `comparison_results` (nur anfügend): `id`, `place_id → places not null`, `attribute text not null` (Check: in `COMPARISON_ATTRIBUTES`, als SQL-`in`-Liste in der Migration), `profile_version int` (nullable), `evaluation_run_id → runs` (nullable), `value_hash text not null` (Check `~ '^[0-9a-f]{16}$'`), `result comparison_result not null`, `method comparison_method not null`, `checked_by text not null` (Check Länge ≤ 120), `checked_at timestamptz not null default now()`, `review_task_id → review_tasks` (nullable), `created_at`; Index `(place_id, attribute, value_hash, checked_at desc)`.
  - `quality_snapshots` (nur anfügend): `id`, `run_id → runs not null`, `scope_type text not null` (Check `in ('area','tile')`), `scope_id text not null`, `metric text not null` (Check in `METRIC_KEYS`), `value double precision` (nullable = nicht berechenbar), `details jsonb not null default '{}'`, `created_at`; eindeutig `(run_id, scope_type, scope_id, metric)`; Index `(scope_type, scope_id, metric, created_at desc)`.
  - `config_activations` (nur anfügend): `id`, `kind text not null` (Check `in ('consolidation_rules','extraction')`), `version text not null`, `evaluation_run_id → runs not null`, `comparison jsonb not null`, `activated_by text not null`, `activated_at timestamptz not null default now()`.
  - `COMPARISON_ATTRIBUTES = ["existence","position","shelter.N","shelter.NE","shelter.E","shelter.SE","shelter.S","shelter.SW","shelter.W","shelter.NW","depth","seabed","mooring.buoys","services.water","highlight.supply","highlight.food"] as const`, `type ComparisonAttribute` (in `lib/db/schema/quality.ts`, Task 2 re-exportiert).
  - `METRIC_KEYS = ["coverage","coverage_navily","multi_source","fact_precision","quote_fidelity","shelter_confidence","route_reconstruction","cost_per_place","review_minutes","review_minutes_per_100","highlight_share","recent_observation_share","places_per_tile"] as const`, `type MetricKey` (in `lib/db/schema/quality.ts` exportiert).
  - `QualityConfig` (zod), `getConfig().quality`; `config/quality.json`:
    ```json
    {
      "targets": {
        "coverage": { "pilot": 0.85, "full": 0.95, "direction": "min" },
        "coverage_navily": { "pilot": 0.85, "full": 0.95, "direction": "min" },
        "multi_source": { "pilot": 0.70, "full": 0.85, "direction": "min" },
        "fact_precision": { "pilot": 0.90, "full": 0.95, "direction": "min" },
        "quote_fidelity": { "pilot": 1.0, "full": 1.0, "direction": "min" },
        "shelter_confidence": { "pilot": 0.60, "full": 0.80, "direction": "min" },
        "route_reconstruction": { "pilot": 0.70, "full": 0.90, "direction": "min" },
        "cost_per_place": { "pilot": 2.0, "full": 0.5, "direction": "max" },
        "review_minutes_per_100": { "pilot": null, "full": 30, "direction": "max" }
      },
      "secondRunReviewMinutesMax": 60,
      "reviewDurationCapMinutes": 10,
      "recentObservationMonths": 18,
      "shelterConfirmTolerance": 0.2,
      "placesPerTile": { "min": 10, "max": 40 },
      "comparisonSet": { "pilotSize": 50, "perAreaMin": 20, "perAreaMax": 30 },
      "navily": { "maxRadiusM": 1000, "nameStrongMin": 0.8, "nameMin": 0.4, "nameRadiusM": 500, "nearRadiusM": 150,
                  "positionToleranceM": 150, "protectedThreshold": 0.5, "seabedShareMin": 0.3, "depthStepM": 0.5,
                  "proposalVersion": "navily-assistant/1" },
      "extrapolation": { "areasMin": 60, "areasMax": 100, "placesPerArea": null }
    }
    ```

- [ ] **Step 1: Failing tests**

```ts
it("comparison_results has no column that could hold a Navily value", async () => {
  const cols = await columnsOf(db, "comparison_results");            // information_schema.columns: name → data_type
  expect(Object.keys(cols).sort()).toEqual(["attribute","checked_at","checked_by","created_at","evaluation_run_id",
    "id","method","place_id","profile_version","result","review_task_id","value_hash"]);
  expect(Object.values(cols)).not.toContain("jsonb");
  expect(Object.values(cols)).not.toContain("numeric");
  expect(Object.values(cols)).not.toContain("double precision");
});
it("value_hash and attribute are constrained", …);       // "rating" → check violation; "abc" als Hash → check violation
it.each(["comparison_results", "quality_snapshots", "config_activations"])("%s rejects UPDATE and DELETE", …); // /append-only/
it("one snapshot row per run, scope and metric", …);      // zweiter Insert gleicher Schlüssel → unique violation
// config.test.ts
it("quality config loads pilot targets", () => {
  const q = getConfig().quality;
  expect(q.targets.coverage.pilot).toBe(0.85);
  expect(q.targets.cost_per_place).toEqual({ pilot: 2.0, full: 0.5, direction: "max" });
  expect(q.secondRunReviewMinutesMax).toBe(60);
  expect(q.placesPerTile).toEqual({ min: 10, max: 40 });
});
```

- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/quality-schema.test.ts lib/config` → FAIL.
- [ ] **Step 3: Implementieren.** `npm run db:generate`; Trigger und Checks in der handgeschriebenen Migration (Muster der bisherigen Trigger-Migrationen, `--> statement-breakpoint`, Journal-Eintrag). `/settings` zeigt die Zielwerte aus `config/quality.json`.
- [ ] **Step 4: Run** `npx vitest run lib/db lib/config` → PASS.
- [ ] **Step 5: Commit** `feat(quality): comparison results, quality snapshots and config activations schema`

### Task 2: Vergleichswerte, Ergebnisse und Review `comparison_deviation`

**Files:**
- Create: `lib/domain/quality/comparison-values.ts`, `lib/domain/quality/comparison-results.ts`, `app/(admin)/review/[id]/comparison-decision.tsx`
- Modify: `lib/domain/review-decisions.ts`, `lib/domain/review-view.ts`, `app/(admin)/review/[id]/page.tsx`, `app/(admin)/_components/labels.ts`
- Test: `lib/domain/quality/__tests__/comparison-values.test.ts`, `lib/domain/quality/__tests__/comparison-results.test.ts`

**Interfaces:**
- Consumes: Task 1, `SECTORS`/`Sector`, `canonicalJson` (M2), `latestProfile` (M5), `evaluation_profiles` (M5), `comparison_set`, `displayNameSql`, `createReviewTask`, `decideReviewTask`.
- Produces:
  - `COMPARISON_ATTRIBUTES`/`ComparisonAttribute` aus Task 1 re-exportiert. Abbildung Spec → Schlüssel: Versorgung = `services.water` + `highlight.supply`, Taverne = `highlight.food`, Tiefe = `depth`. `COMPARISON_ATTRIBUTE_LABELS` (deutsch) in `labels.ts`.
  - `type ComparisonSubject = { placeId: string; publicId: string | null; name: string | null; names: string[]; kind: PlaceKind; status: PlaceStatus; position: LonLat; anchorPosition: LonLat | null; attributes: Record<string, unknown>; profileVersion: number | null }`
  - `type ComparisonValue = { value: unknown; display: string; hash: string }`
  - `comparisonValues(s: ComparisonSubject, cfg: QualityConfig["navily"]): Record<ComparisonAttribute, ComparisonValue>` – rein. Normalisierter Vergleichswert (nur er geht in den Hash): `existence` = `status === "confirmed"`; `position` = `anchorPosition ?? position` auf 4 Nachkommastellen; `shelter.X` = `{ protected: v >= protectedThreshold }` (`null` ohne Wert), Anzeige „0,6 (geschützt)“; `depth` = `depth.anchoring_min ?? depth.min` auf `depthStepM` gerundet; `seabed` = sortierte Typen mit Anteil ≥ `seabedShareMin`; `mooring.buoys`, `highlight.supply`, `highlight.food` = `present`; `services.water` = Boolean. `hash` = erste 16 Hex von `sha256(canonicalJson({ attribute, value }))`.
  - `loadComparisonSubjects(db, areaKey: string, opts?: { evaluationRunId?: string }): Promise<ComparisonSubject[]>` – Orte des Vergleichssatzes des Reviers; Attribute aus `latestProfile` bzw. `evaluation_profiles(runId, geoObjectId)` (dann `profileVersion null`); `names` = alle gültigen Namen (alle Sprachen).
  - `recordComparisonResults(db, input: { placeId: string; entries: Array<{ attribute: ComparisonAttribute; result: "match" | "deviation" | "not_at_navily"; valueHash: string; profileVersion: number | null }>; evaluationRunId?: string; method: ComparisonMethod; checkedBy: string; display?: Partial<Record<ComparisonAttribute, string>>; now?: Date }): Promise<{ written: number; tasks: number }>` – eine Transaktion; Eintrag, dessen jüngstes Ergebnis für `(placeId, attribute, valueHash)` schon dasselbe `result` hat → übersprungen; je geschriebenem `deviation` `createReviewTask` (`kind comparison_deviation`, `subjectType "comparison"`, `subjectId "<placeId>:<attribute>:<valueHash>"`, Kontext genau `{ placeId, attribute, valueHash, profileVersion, evaluationRunId, resultId, ownDisplay }`), `review_task_id` bleibt am Ergebnis leer (Ergebnis zuerst geschrieben).
  - `latestComparisonResults(db, placeIds: string[]): Promise<Map<string /* "<placeId>|<attribute>|<hash>" */, { result: ComparisonResultValue; method: ComparisonMethod; checkedBy: string; checkedAt: Date }>>` – jüngstes Ergebnis je Schlüssel (Übernahme alter Ergebnisse geschieht allein über den gleichen Hash).
  - Review: `reviewDecisionSchema` + `{ action: "own_correct" }`, `{ action: "navily_correct" }`, `{ action: "unclear" }`; `ALLOWED["comparison_deviation/comparison"] = ["own_correct","navily_correct","unclear"]`; Wirkung in derselben Transaktion: neues Ergebnis `deviation_confirmed_own` / `deviation_confirmed_navily` / `unclear` mit gleichem `place_id`, `attribute`, `value_hash`, `profile_version`, `evaluation_run_id`, `method review`, `checked_by` = Entscheider, `review_task_id` = Aufgabe. Review-Seite: Ort mit Karte, Attribut, eigener Wert (`ownDisplay`), Hinweis „In der Navily-App prüfen – Navily-Werte werden nicht gespeichert.“, drei Knöpfe, Tastenkürzel wie die übrigen Arten.

- [ ] **Step 1: Failing tests**

```ts
// comparison-values.test.ts (rein)
it("float noise and seabed order keep the value hash", () => {
  const a = comparisonValues(subject({ "shelter.N": 0.6, seabed: { sand: 0.6, weed: 0.4 } }), cfg);
  const b = comparisonValues(subject({ "shelter.N": 0.6000001, seabed: { weed: 0.4, sand: 0.6 } }), cfg);
  expect(b["shelter.N"].hash).toBe(a["shelter.N"].hash);
  expect(b.seabed.hash).toBe(a.seabed.hash);
});
it("crossing the protected threshold changes the hash", …);           // 0.55 → 0.45
it("a 2 m position shift keeps the hash, 30 m changes it", …);
it("the admin anchor position wins over the place position", …);
it("missing attributes give value null and display '–'", …);
// comparison-results.test.ts (withRollback, Synthetik um 21,0° O / 35,2° N)
it("a deviation opens one comparison_deviation task whose context holds no navily value", async () => {
  // context keys exactly placeId, attribute, valueHash, profileVersion, evaluationRunId, resultId, ownDisplay
});
it("recording the same result again writes nothing", …);
it("own_correct appends deviation_confirmed_own with method review and the task id", …);
it("latestComparisonResults returns the newest result per place, attribute and hash", …);
it("loadComparisonSubjects reads evaluation profiles for an evaluation run", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/quality` → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npx vitest run lib/domain` → PASS.
- [ ] **Step 5: Commit** `feat(quality): comparison values with stable hashes, results and deviation review`

### Task 3: Navily-Assistent

**Files:**
- Create: `lib/domain/quality/trigram.ts`, `lib/domain/quality/navily-assistant.ts`
- Modify: `lib/domain/quality/navily-sample.ts` (zod-Schema der Datei), `test/fixtures/navily/sample.json` (synthetische Spots für die Fälle unten)
- Test: `lib/domain/quality/__tests__/trigram.test.ts`, `lib/domain/quality/__tests__/navily-assistant.test.ts`

**Interfaces:**
- Consumes: `NavilySpot`, `loadNavilySpots` (M2), `normalizeName`, `transliterateElot743` (M1), `stripAffix` + `config/name-affixes.json` (M4), Task 2.
- Produces:
  - `NavilySpot` erweitert um `name: string | null; kind: "mooring" | "port" | null; type: string | null; water: boolean | null; shop: boolean | null` (übrige Felder der Datei werden weiter verworfen).
  - `trigramSimilarity(a: string, b: string): number` – Semantik von pg_trgm (Kleinschreibung, Wörter mit zwei führenden und einem folgenden Leerzeichen, Trigramm-Mengen, |A∩B| / |A∪B|).
  - `nameSimilarity(ownNames: string[], spotName: string | null, affixes): number` – Maximum über alle eigenen Namen; beide Seiten `normalizeName`, griechisch transliteriert, Affix per `stripAffix` entfernt (Kern, wenn vorhanden).
  - `type NavilyMatch = { placeId: string; spotIndex: number | null; distanceM: number | null; nameSimilarity: number | null }` (`spotIndex` = Index in der geladenen Liste, nur zur Laufzeit).
  - `matchPlacesToSpots(places: Array<Pick<ComparisonSubject, "placeId" | "kind" | "position" | "names">>, spots: NavilySpot[], cfg: QualityConfig["navily"], affixes): NavilyMatch[]` – Kandidaten je Ort: Spot ≤ `maxRadiusM` und (`sim ≥ nameStrongMin` oder `sim ≥ nameMin` und `d ≤ nameRadiusM` oder `d ≤ nearRadiusM`). Global gierig nach (Name-Ähnlichkeit absteigend, Art-Verträglichkeit — `marina`/`port` ↔ Navily `port`, sonst ↔ `mooring` —, Distanz aufsteigend); jeder Spot höchstens einmal.
  - `proposeResults(values: Record<ComparisonAttribute, ComparisonValue>, own: { position: LonLat }, spot: NavilySpot | null, cfg): Record<ComparisonAttribute, "match" | "deviation" | "not_at_navily">` – rein. Ohne Spot: `existence deviation`, alles andere `not_at_navily`. Mit Spot: `existence match`; `position` match bei Distanz ≤ `positionToleranceM`; `shelter.X`: `prot null` → `not_at_navily`, sonst geschützt ⇔ Sektor in `prot` (Kleinbuchstaben); `seabed`: `seabeds null`/leer → `not_at_navily`, Navily `algae` = `weed`, Übereinstimmung bei nicht leerer Schnittmenge, eigener Wert `null` → `deviation`; `mooring.buoys`: nur bei Navily-`type = "buoy"` vergleichbar (sonst `not_at_navily`); `services.water` gegen `water`, `highlight.supply` gegen `shop` (`null` → `not_at_navily`); `depth`, `highlight.food` immer `not_at_navily` (Navily führt keine Tiefe, keine Taverne). Eigener Wert `null` bei vorhandener Navily-Angabe → `deviation`.
  - `navilyCoverage(places: Array<Pick<ComparisonSubject, "placeId" | "kind" | "position" | "names">>, spots: NavilySpot[], inArea: (p: LonLat) => boolean, cfg, affixes): { spots: number; matched: number; ratio: number | null; unmatchedSpotIndexes: number[] }` – Spots im Revier gegen alle bestätigten Orte des Reviers (nicht nur den Satz).
  - `loadNavilyFromEnv(): Promise<NavilySpot[] | null>` – `getEnv().NAVILY_SPOTS_PATH` fehlt → `null`; Datei fehlt/kaputt → Error mit Pfad.

- [ ] **Step 1: Failing tests**

```ts
it("trigram similarity follows pg_trgm", () => {
  expect(trigramSimilarity("vathi", "vathi")).toBe(1);
  expect(trigramSimilarity("porto cheli", "porto heli")).toBeCloseTo(0.64, 1);   // Wert aus Ruling T7-R1
});
it("'Ormos Vathy' matches Vathi 400 m away", …);
it("a same-named spot 1.5 km away is no match", …);
it("one navily spot is matched to at most one place, marina before bay", …);  // Navily kind port, Marina 250 m, Bucht 200 m
it("a nameless spot 120 m away matches by distance alone", …);
it("missing prot proposes not_at_navily for all sectors", …);
it("algae matches own weed; own seabed missing is a deviation", …);
it("depth and highlight.food are always not_at_navily", …);
it("an unmatched place proposes existence deviation and nothing else", …);
it("coverage counts only spots inside the area against all confirmed places", …);
it("proposals carry results only", () => {
  const p = proposeResults(values, own, spots[0], cfg);
  expect(JSON.stringify(p)).not.toMatch(/NAVILY-ONLY-NAME|987654321|navily\.com/);
  for (const r of Object.values(p)) expect(["match", "deviation", "not_at_navily"]).toContain(r);
});
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/quality` → FAIL. **Step 3: Implementieren.** **Step 4: Run** → PASS (auch die M2-Tests von `navily-sample`).
- [ ] **Step 5: Commit** `feat(quality): navily assistant matching by distance and name, per-attribute proposals`

### Task 4: Seite `/quality/compare`

**Files:**
- Create: `app/(admin)/quality/compare/page.tsx`, `app/(admin)/quality/compare/actions.ts`, `app/(admin)/quality/compare/compare-place.tsx`
- Modify: `lib/security/route-policy.ts` (`"/quality/compare": { kind: "admin" }`), `app/(admin)/quality/page.tsx` (Link)
- Test: `app/(admin)/__tests__/quality-compare-actions.test.ts`, Route-Policy-Test (vorhanden)

**Interfaces:**
- Consumes: Tasks 2–3, `requireAdmin`, `getConfig().areas`, `comparisonOverview` (M1).
- Produces:
  - Seite `/quality/compare?area=<key>&place=<placeId>&filter=open|all&evaluation=<runId>` (Lesen über `lib/domain`, Navily nur über `loadNavilyFromEnv`): Kopf mit Satzgröße „n von 50“, Fortschritt „geprüfte Attribute / alle“, Navily-Status („Navily-Datei geladen: n Spots (nur zur Laufzeit, nichts wird gespeichert)“ bzw. „NAVILY_SPOTS_PATH nicht gesetzt – Vergleich nur von Hand“), Ortsliste mit offenen Attributen; je Ort Tabelle Attribut | eigener Wert | Navily (Laufzeit) | Vorschlag | gespeichertes Ergebnis (inkl. „übernommen“ bei gleichem Hash) | Knöpfe „stimmt“ / „weicht ab“ / „bei Navily nicht vorhanden“; Knopf „Alle Vorschläge übernehmen“; Abschnitt „Navily-Orte ohne Periplus-Ort (n)“ (Laufzeitliste mit Name und Abstand zum nächsten Ort, Hinweis „wird nicht gespeichert“). `filter=open` = Orte mit mindestens einem Attribut ohne Ergebnis für den aktuellen Hash.
  - `recordComparisonAction(input: { placeId: string; areaKey: string; attribute: ComparisonAttribute; result: "match" | "deviation" | "not_at_navily"; valueHash: string; evaluationRunId?: string }): Promise<void>` – zod; berechnet die aktuellen Werte serverseitig; `valueHash` ≠ aktueller Hash → `StaleComparison` (Seite neu laden), nichts geschrieben; Methode `manual`, `checkedBy` = Admin-E-Mail.
  - `acceptProposalsAction(input: { placeId: string; areaKey: string; evaluationRunId?: string }): Promise<{ written: number; tasks: number }>` – Vorschläge serverseitig neu berechnet (nie vom Client übernommen), Methode `proposal_confirmed`; ohne Navily-Datei → Error „Navily-Datei nicht geladen“.

- [ ] **Step 1: Failing tests** (withRollback, `NAVILY_SPOTS_PATH` auf `test/fixtures/navily/sample.json`, `requireAdmin` gemockt wie in den M1-Action-Tests)

```ts
it("acceptProposalsAction writes one result per attribute with method proposal_confirmed", async () => {
  const r = await acceptProposalsAction({ placeId, areaKey });
  expect(r.written).toBe(16);
  expect(rows.every((x) => x.method === "proposal_confirmed" && x.checkedBy === "admin@example.invalid")).toBe(true);
});
it("a second accept writes nothing", …);
it("a deviation proposal opens one review task", …);
it("a stale value hash is rejected and writes nothing", …);
it("accepting without a navily file fails with a clear message", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren** (Next-Doku zu Server Actions und `searchParams` lesen). **Step 4: Run** `npx vitest run app lib/security && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): comparison page with runtime navily proposals and one-click confirmation`

### Task 5: CLI `compare:navily` mit Ergebnis-Schreiben und Abdeckung

**Files:**
- Create: `lib/domain/quality/navily-run.ts`
- Modify: `scripts/compare-navily.ts`
- Test: `lib/domain/quality/__tests__/navily-run.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3; M2 `renderReport` bleibt. (`--coverage` ergänzt Task 8, weil es einen Messlauf braucht.)
- Produces:
  - `runNavilyComparison(db, input: { areaKey: string; spots: NavilySpot[]; acceptProposals: boolean; now?: Date }): Promise<{ places: number; matched: number; written: number; tasks: number; coverage: { spots: number; matched: number; ratio: number | null } }>` – ohne `acceptProposals` schreibt es nichts; mit: je Ort des Satzes `recordComparisonResults` mit Methode `proposal_auto`, `checkedBy = cfg.navily.proposalVersion` („navily-assistant/1“, maschinell erkennbar); `coverage` wird immer berechnet und ausgegeben.
  - CLI `npm run compare:navily -- --area saronic [--navily <pfad>] [--accept-proposals] [--out <datei>]` – Pfad sonst aus `NAVILY_SPOTS_PATH`; schreibt weiter den M2-Bericht (jetzt mit Abschnitt „Ergebnisse geschrieben: n, Review-Aufgaben: n“); ohne `--accept-proposals` Hinweis „Nur Bericht – Ergebnisse mit --accept-proposals schreiben“.

- [ ] **Step 1: Failing tests** (withRollback, synthetisches Revier mit 3 Satz-Orten)

```ts
it("without acceptProposals nothing is written", …);
it("with acceptProposals every set place gets 16 results by navily-assistant/1", async () => {
  const r = await runNavilyComparison(tx, { areaKey, spots, acceptProposals: true, writeCoverage: false });
  expect(r.written).toBe(48);
  expect(new Set(rows.map((x) => `${x.method}|${x.checkedBy}`))).toEqual(new Set(["proposal_auto|navily-assistant/1"]));
});
it("a rerun writes nothing new", …);
it("no navily name, id or url appears in any written row", async () => {
  // comparison_results, quality_snapshots.details, review_tasks.context als Text → kein "NAVILY-ONLY-NAME", "987654321", "navily.com"
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(quality): compare:navily writes machine-proposed results and navily coverage on request`

### Task 6: Kennzahlen I – Abdeckung, Mehrbefund, Präzision, Belegtreue, Schutz, Routen

**Files:**
- Create: `lib/domain/quality/metrics.ts`
- Test: `lib/domain/quality/__tests__/metrics.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2, `comparison_set`, `places`, `tiles`, `mentions`, `document_versions`, `documents`, `facts`, `activeExtractionRun`, `belegtreue` (M4), `latestComputations` (M2), `routes`, `route_stops`, `runs`.
- Produces:
  - `type QualityScope = { areaKey: string; tileId?: string }`, `type MeasureWindow = { from: Date; to: Date }`, `type MetricResult = { metric: MetricKey; value: number | null; details: Record<string, unknown> }`.
  - Orte im Umfang = bestätigte, gültige Orte in Kacheln mit `area_id` des Reviers (bzw. der Kachel).
  - `coverageMetric(db, scope): Promise<MetricResult>` – Satz-Orte im Umfang mit `status = confirmed` / Satz-Orte im Umfang; `details { set, confirmed }`; leerer Satz → `null`.
  - `multiSourceMetric(db, scope)` – Orte mit Erwähnungen aus ≥ 2 Dokumenten verschiedener Quellen; `details { places, multi }`.
  - `factPrecisionMetric(db, scope, opts?: { evaluationRunId?: string }): Promise<MetricResult>` – über `loadComparisonSubjects` + `comparisonValues` + `latestComparisonResults` (Schlüssel mit aktuellem Hash): Zähler `match + deviation_confirmed_own`, Nenner alle Ergebnisse ohne `not_at_navily` (also inkl. `deviation`, `deviation_confirmed_navily`, `unclear`); `details { compared, correct, notAtNavily, pending, byAttribute: Record<ComparisonAttribute, { compared; correct }> }`, `pending` = Attribute ohne Ergebnis zum aktuellen Hash; Nenner 0 → `null`.
  - `quoteFidelityMetric(db, window): Promise<MetricResult>` – Summe von `belegtreue(runId)` über Läufe mit `created_at` im Fenster und einer Stufe aus `TEXT_RUN_STAGES`; `details { facts, verified, runs }`; ohne Text-Facts → `null`.
  - `shelterConfidenceMetric(db, scope, cfg: QualityConfig): Promise<MetricResult>` – Ort zählt, wenn jeder der 8 `shelter.<Sektor>` mindestens einen Text-Fact aus dem aktiven Extraktionslauf hat (bestätigt: |Text − Berechnung| ≤ `shelterConfirmTolerance`, sonst korrigiert); `details { places, complete, confirmed, corrected, bySector }`.
  - `routeReconstructionMetric(db, scope): Promise<MetricResult>` – Routen aktiver Extraktionsläufe mit mindestens einem Stopp im Umfang; vollständig = jeder Stopp hat `geo_object_id` eines bestätigten Orts; `details { routes, complete, openStops }`.

- [ ] **Step 1: Failing tests** (withRollback, je Kennzahl konstruierte Daten mit erwartetem Wert; synthetisches Revier um 21,0° O / 35,2° N)

```ts
it("coverage: 4 of 5 set places confirmed is 0.8", …);
it("multi_source: two documents of one source do not count, two sources do", …);   // 3 Orte → 1/3
it("fact_precision: 7 match + 2 confirmed own of 10 compared and 3 not_at_navily is 0.9", async () => {
  expect((await factPrecisionMetric(tx, { areaKey })).value).toBeCloseTo(0.9);
});
it("fact_precision ignores results for an old value hash and counts them as pending", …);
it("quote_fidelity over two text runs is verified / facts", …);   // 199/200 → 0.995
it("shelter_confidence counts a place only with text facts in all 8 sectors", …); // 2 Orte, einer mit 7 Sektoren → 0.5
it("route_reconstruction: one of two routes fully on confirmed places is 0.5", …);
it("a tile scope counts only places of that tile", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/quality/__tests__/metrics.test.ts` → FAIL. **Step 3: Implementieren.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(quality): coverage, multi-source, precision, fidelity, shelter and route metrics`

### Task 7: Kennzahlen II – Kosten, Review-Aufwand, Zusatzkennzahlen, Orte je Kachel

**Files:**
- Modify: `lib/domain/quality/metrics.ts`
- Test: `lib/domain/quality/__tests__/metrics-ops.test.ts`

**Interfaces:**
- Consumes: Task 6, `external_calls`, `runs`, `review_tasks`, `review_decisions`, `latestProfile`, `getConfig().areas`.
- Produces:
  - `costPerPlaceMetric(db, scope, window): Promise<MetricResult>` – Kosten des Reviers im Fenster (`external_calls.at`): direkt = `tile_id` in den Kacheln des Umfangs oder Lauf mit Umfang Kachel/Revier/Ort im Umfang; geteilt = Aufrufe ohne solche Zuordnung (Quellen-, System-, Text-Läufe), verteilt nach Anteil der bestätigten Orte des Reviers an allen bestätigten Orten der konfigurierten Reviere; Wert = (direkt + Anteil geteilt) / bestätigte Orte; `details { costEur, directEur, sharedEur, places, byStage, byService }`; 0 Orte → `null`.
  - `reviewEffortMetrics(db, window, cfg: QualityConfig): Promise<[MetricResult, MetricResult]>` – Aufgaben mit `created_at` im Fenster (alle Reviere); je Entscheidung `min(duration_ms, reviewDurationCapMinutes × 60 000)`, ohne `duration_ms` = 0; `review_minutes` (Summe, `details { tasks, decided, open, withoutDuration, capped, byKind }`) und `review_minutes_per_100` (= Minuten / bestätigte Orte aller Reviere × 100).
  - `highlightShareMetric(db, scope)` – Orte, deren jüngstes Profil ein `highlight.*` mit `present = true` hat.
  - `recentObservationShareMetric(db, scope, opts: { today: string; months: number })` – Orte, deren Profil-Provenienz ein `observedAt` innerhalb von `months` vor `today` hat (Herkunft `text`, `observed` oder `review`).
  - `placesPerTileMetric(db, areaKey, cfg)` – Wert = Median der Orte je Küstenkachel; `details { tiles: Array<{ tileId; places }>, min, max, median, inTarget, target: { min: 10, max: 40 } }`.

- [ ] **Step 1: Failing tests** (withRollback)

```ts
it("cost per place adds the place share of shared costs", async () => {
  // Revier X (3 Orte) direkt 3,00 €; Revier Y (1 Ort, eigener Testschlüssel) direkt 0; geteilt 4,00 € → X: (3 + 3) / 3 = 2,0
  expect((await costPerPlaceMetric(tx, { areaKey: X }, window)).value).toBeCloseTo(2.0);
});
it("calls outside the window do not count", …);
it("a decision open for 9 hours counts the cap of 10 minutes", async () => {
  const [minutes] = await reviewEffortMetrics(tx, window, cfg);
  expect(minutes.value).toBe(10 + 2);   // zweite Entscheidung 2 min
  expect(minutes.details.capped).toBe(1);
});
it("decisions without duration count zero and are reported", …);
it("review_minutes_per_100 relates to confirmed places", …);
it("highlight share counts present highlights only", …);
it("an observation 19 months old is not recent", …);
it("places per tile reports median and tiles outside 10–40", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(quality): cost per place, review effort, highlight and recency shares, places per tile`

### Task 8: Messlauf `quality.measure` und Snapshots

**Files:**
- Create: `lib/domain/quality/snapshot.ts`, `lib/pipeline/quality.ts`, `lib/jobs/handlers/quality.ts`
- Modify: `lib/jobs/{queues,stages,registry}.ts`, `config/queues.json`, `lib/domain/quality/navily-run.ts`, `scripts/compare-navily.ts` (`--coverage`)
- Test: `lib/domain/quality/__tests__/snapshot.test.ts`, `lib/pipeline/__tests__/quality.test.ts`, `lib/domain/quality/__tests__/navily-run.test.ts`

**Interfaces:**
- Consumes: Tasks 6–7, `createRun`, `enqueueStage`, `recordJobOutcome`.
- Produces:
  - `computeQualitySnapshot(db, input: { runId: string; areaKey: string; window: MeasureWindow; today: string; cfg?: QualityConfig }): Promise<{ rows: number; skipped: boolean }>` – gibt es schon Zeilen für `runId` → `skipped` (Wiederholung schreibt nichts doppelt); sonst eine Transaktion: Revier-Zeilen für alle `METRIC_KEYS` außer `coverage_navily` (kommt aus Task 5), Kachel-Zeilen für `coverage, multi_source, fact_precision, shelter_confidence, cost_per_place, highlight_share, recent_observation_share`.
  - `type MeasurementView = { runId: string; label: string; from: Date; to: Date; createdAt: Date; metrics: Partial<Record<MetricKey, { value: number | null; details: Record<string, unknown> }>> }`
  - `latestMeasurement(db, areaKey): Promise<MeasurementView | null>`, `listMeasurements(db, areaKey, limit: number): Promise<MeasurementView[]>`, `measurementByLabel(db, areaKey, label: string): Promise<MeasurementView | null>`, `tileSnapshots(db, runId): Promise<Array<{ tileId: string; metrics: Partial<Record<MetricKey, number | null>> }>>`.
  - `metricStatus(metric: MetricKey, value: number | null, cfg: QualityConfig, level: "pilot" | "full"): "met" | "missed" | "no_target" | "no_value"` – `direction min`: `value ≥ target`; `max`: `value < target` (Spec „unter 2 €“).
  - `QUALITY_MEASURE_STAGE = "quality.measure"`; Plan: ein Job `{ key: areaKey, areaKey }`; Queue `quality.measure` (concurrency 1, retryLimit 2, 60 s, Backoff).
  - `runNavilyComparison` erhält `writeCoverage?: boolean` und liefert `snapshotRunId: string | null`: Zeile `coverage_navily` (Wert `ratio`, `details { spots, matched }` – nur Zählwerte) zum jüngsten Messlauf des Reviers (`latestMeasurement`); ohne Messlauf → Error „Erst messen (/quality)“; besteht die Zeile schon → nichts. CLI-Flag `--coverage`.
  - `startMeasurement(db, boss, input: { areaKey: string; label: string; from?: Date; to?: Date; triggeredBy: string }): Promise<{ id: string }>` – Art `stage`, Umfang `area`, `params { areaKey, label, from, to }`; `from` Standard = `to` der vorigen Messung des Reviers, sonst `created_at` des ältesten Laufs; `to` Standard = jetzt; `label` 1–40 Zeichen, eindeutig je Revier (sonst Error „Bezeichnung schon vergeben“).

- [ ] **Step 1: Failing tests**

```ts
it("a measurement writes area rows for 12 metrics and tile rows for 7", …);
it("a retried job writes nothing twice", …);
it("from defaults to the previous measurement's to", …);
it("a duplicate label is rejected", …);
it("coverage_navily needs a measurement run and is written once", …);   // navily-run.test.ts
it.each([
  ["coverage", 0.85, "pilot", "met"], ["coverage", 0.849, "pilot", "missed"],
  ["cost_per_place", 2.0, "pilot", "missed"], ["cost_per_place", 1.99, "pilot", "met"],
  ["review_minutes_per_100", 25, "pilot", "no_target"], ["highlight_share", 0.4, "pilot", "no_target"],
  ["quote_fidelity", null, "pilot", "no_value"],
])("metricStatus %s %s %s → %s", (m, v, l, s) => expect(metricStatus(m, v, cfg, l)).toBe(s));
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npx vitest run lib/domain lib/pipeline lib/jobs` → PASS.
- [ ] **Step 5: Commit** `feat(quality): measurement run writing area and tile snapshots`

### Task 9: Qualitätsdashboard `/quality`

**Files:**
- Create: `lib/domain/quality/dashboard.ts`
- Modify: `app/(admin)/quality/page.tsx`, `app/(admin)/quality/actions.ts`, `app/(admin)/_components/labels.ts` (`METRIC_LABELS`)
- Test: `lib/domain/quality/__tests__/dashboard.test.ts`, `app/(admin)/__tests__/quality-actions.test.ts`

**Interfaces:**
- Consumes: Task 8, `comparisonOverview` (M1).
- Produces:
  - `qualityDashboard(db, areaKey: string, cfg = getConfig().quality): Promise<{ latest: MeasurementView | null; history: MeasurementView[]; tiles: Array<{ tileId: string; metrics: Partial<Record<MetricKey, number | null>> }>; rows: Array<{ metric: MetricKey; value: number | null; pilot: number | null; full: number | null; statusPilot: ReturnType<typeof metricStatus>; statusFull: ReturnType<typeof metricStatus> }>; comparison: { setSize: number; target: number; checked: number; pending: number } }>` – `history` = letzte 10 Messungen, ältere zuerst.
  - Seite `/quality?area=`: Abschnitt „Kennzahlen“ (Tabelle Kennzahl | Wert | Ziel Pilot | Ziel Vollbetrieb | Status, Prozent bzw. € / Minuten, „—“ ohne Wert, Tooltip mit `details` als Zahlen), „Verlauf“ (eine Spalte je Messung mit Bezeichnung), „Kacheln“ (Kachel-Tabelle, Orte je Kachel mit Markierung außerhalb 10–40), „Review-Aufwand“ (Minuten gesamt, je 100 Orte, Hinweis „Pilot: zweiter Lauf unter 60 Minuten“), Formular „Messen“ (Bezeichnung, optional von/bis) → Lauf-Seite, Link „Navily-Abgleich“, bestehende Vergleichssatz-Pflege (M1) darunter.
  - `startMeasurementAction(input: { areaKey: string; label: string; from?: string; to?: string }): Promise<void>` – zod, `requireAdmin`, `startMeasurement`, Redirect auf `/runs/<id>`.

- [ ] **Step 1: Failing tests**

```ts
it("the dashboard shows the latest measurement against pilot and full targets", …);  // coverage 0.9 → statusPilot met, statusFull missed
it("history lists the last measurements oldest first", …);
it("startMeasurementAction rejects an unknown area and an empty label", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npx vitest run lib app && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): quality dashboard with targets, history, tiles and measurement`

### Task 10: Regression – Bewertung, Vergleich alt/neu, Aktivieren

**Files:**
- Create: `lib/domain/quality/regression.ts`
- Modify: `lib/pipeline/consolidation/run.ts`, `lib/domain/consolidation/inputs.ts`, `lib/domain/consolidation/store.ts`, `lib/pipeline/text/run.ts`, `app/(admin)/quality/{page.tsx,actions.ts}`, `app/(admin)/settings/page.tsx`
- Test: `lib/domain/quality/__tests__/regression.test.ts`, `lib/pipeline/__tests__/consolidation-run.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 6, `startConsolidationRun`, `consolidateGeo`, `loadInputs`, `activeExtractionRun`, `evaluation_profiles` (M5), `startReprocessRun`/`TextRunParams` (M4), `getConsolidationConfig`, `config_activations`.
- Produces:
  - `type EvaluationCandidate = { rulesVersion?: string; extraction?: { model: string; promptVersion: number } }` (mindestens eins).
  - `startEvaluation(db, boss, input: { areaKey: string; candidate: EvaluationCandidate; triggeredBy: string }): Promise<{ id: string }>` – nur Regeln → `startConsolidationRun({ scope: { comparisonSetArea: areaKey }, evaluation: true, rulesVersion })`; mit Extraktion → Lauf `reprocess` mit `params { evaluation: true, comparisonSetArea, candidate }`: Text-Stufen über die aktuellen Versionen der Dokumente mit Erwähnungen von Satz-Orten, Extraktion mit Kandidaten-Modell und -Prompt (Zweck `reprocess`, daher unter der aktiven Konfiguration nie aktiv), danach nur `consolidation.geo` im Bewertungsmodus.
  - `consolidateGeo` Option `extraction?: { model: string; promptVersion: number }` → `loadInputs` ermittelt den aktiven Extraktionslauf mit einer Konfiguration, in der nur Modell und Prompt-Version der Extraktion ersetzt sind; nur mit `mode: "evaluation"` erlaubt (sonst Error).
  - `activeRulesVersion(db): Promise<string>` – jüngste `config_activations`-Zeile `consolidation_rules`, deren Version als Datei existiert; sonst `getConsolidationConfig().version` (`active.json`). `startConsolidationRun` setzt `params.rulesVersion = input.rulesVersion ?? await activeRulesVersion(db)`; der Handler von `consolidation.geo` reicht sie an `consolidateGeo`.
  - `type RegressionComparison = { evaluationRunId: string; areaKey: string; candidate: EvaluationCandidate; old: { precision: number | null; coverage: number | null; compared: number }; next: { precision: number | null; coverage: number | null; compared: number }; changed: Array<{ placeId: string; attribute: ComparisonAttribute; oldDisplay: string; newDisplay: string; checked: boolean }>; pending: number; passes: boolean; reasons: string[] }`
  - `compareEvaluation(db, evaluationRunId: string): Promise<RegressionComparison>` – alt = aktuelle Profile, neu = `evaluation_profiles` des Laufs (beide über `factPrecisionMetric`/`coverageMetric`); unveränderter Hash → altes Ergebnis gilt; geänderter Hash ohne Ergebnis zum neuen Hash → `pending`; `passes = pending === 0 && next.precision ≥ old.precision && next.coverage ≥ old.coverage` (`null` gilt als 0); `reasons` deutsch („3 geänderte Werte ungeprüft“, „Präzision sinkt von 92,0 % auf 89,5 %“).
  - `activateCandidate(db, input: { evaluationRunId: string; activatedBy: string }): Promise<void>` – `compareEvaluation`; nicht `passes` → `RegressionGateClosed` (mit `reasons`); sonst Zeile `config_activations` (`kind` `consolidation_rules` bzw. `extraction`, `version` = Regelversion bzw. `"<model>@p<promptVersion>"`, `comparison` = alt/neu-Zahlen). Für `extraction` wirkt die Aktivierung als Freigabe; wirksam wird sie per Deploy von `config/models.json` (`/settings` zeigt „freigegeben“ bzw. „ohne Freigabe“ für die laufende Extraktionskonfiguration).
  - `/quality` Abschnitt „Regression“: Formular „Bewertung starten“ (Regelversion aus `config/consolidation/*.json`, optional Modell + Prompt-Version), je Bewertungslauf Vergleich alt/neu, Liste geänderter Werte mit Link `/quality/compare?evaluation=<runId>&place=…`, Knopf „Aktivieren“ nur bei `passes`, sonst Gründe. Actions `startEvaluationAction`, `activateCandidateAction`.

- [ ] **Step 1: Failing tests** (withRollback, Satz mit 2 Orten, Bewertungsprofile direkt eingefügt)

```ts
it("an attribute with an unchanged value hash carries the old result", async () => {
  const c = await compareEvaluation(tx, runId);
  expect(c.pending).toBe(0);
  expect(c.next.precision).toBe(c.old.precision);
});
it("a changed value is pending and blocks activation", async () => {
  await expect(activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
});
it("a checked changed value with lower precision blocks activation with a reason", …);
it("activation writes one row and activeRulesVersion returns the candidate", …);
it("a consolidation run without explicit version uses the activated rules version", …);
it("an activated version without config file falls back to active.json", …);
it("an extraction candidate evaluation uses facts of the candidate extraction runs only", …);
it("the extraction override is refused outside evaluation mode", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npx vitest run lib app` → PASS.
- [ ] **Step 5: Commit** `feat(quality): regression gate with carried results, old/new comparison and deliberate activation`

### Task 11: Simulations-Leitplanken und Archiv-Schreibpräfix

**Files:**
- Create: `lib/domain/revisit/guard.ts`
- Modify: `lib/env.ts`, `lib/adapters/s3.ts`, `worker/index.ts`, `.env.example`
- Test: `lib/domain/revisit/__tests__/guard.test.ts`, `lib/adapters/__tests__/s3.test.ts`, `worker/__tests__/startup.test.ts` (bzw. vorhandener Worker-Starttest)

**Interfaces:**
- Produces:
  - Env (optional): `NAVILY_SPOTS_PATH`, `S3_WRITE_PREFIX` (Regex `^[a-z0-9][a-z0-9/_-]*/$`), `PERIPLUS_SIMULATION` (Pfad zur Szenario-Datei).
  - `databaseNameOf(url: string): string`; `assertSimulationTarget(databaseUrl: string): void` – erlaubt `periplus_sim` und Namen auf `_test`; sonst `SimulationTargetError` mit Datenbankname (ohne Passwort).
  - `createArchive(opts: ArchiveOptions & { writePrefix?: string })`: `put` schreibt `writePrefix + key`; `get`/`exists` lesen zuerst `writePrefix + key`, dann `key`; `getArchive` übergibt `S3_WRITE_PREFIX`.
  - Worker-Start: `PERIPLUS_SIMULATION` gesetzt → `assertSimulationTarget(DATABASE_URL)` und `S3_WRITE_PREFIX` Pflicht, sonst Abbruch mit deutscher Meldung vor dem Registrieren der Queues; Log `simulation active` mit Szenario-Pfad und Präfix.

- [ ] **Step 1: Failing tests**

```ts
it("assertSimulationTarget refuses periplus and accepts periplus_sim", () => {
  expect(() => assertSimulationTarget("postgres://u:secret@h:5432/periplus")).toThrow(/periplus/);
  expect(() => assertSimulationTarget("postgres://u:secret@h:5432/periplus")).not.toThrow(/secret/);
  expect(() => assertSimulationTarget("postgres://u:p@h/periplus_sim")).not.toThrow();
  expect(() => assertSimulationTarget("postgres://u:p@h/periplus_test")).not.toThrow();
});
it("writes go under the prefix, reads fall back to the unprefixed key", …);   // Test-Bucket: key "a/x" ohne Präfix vorhanden; Archiv mit Präfix liest ihn, schreibt "sim/t1/a/y"
it("the worker refuses to start a simulation without write prefix", …);
it("an invalid S3_WRITE_PREFIX is rejected by the env schema", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npx vitest run lib worker` → PASS.
- [ ] **Step 5: Commit** `feat(sim): simulation guard and archive write prefix`

### Task 12: Szenario und Fetch-Adapter `simulated`

**Files:**
- Create: `lib/domain/revisit/scenario.ts`, `lib/adapters/fetch/simulated.ts`
- Modify: `lib/pipeline/fetch/url.ts`, `lib/jobs/handlers/fetch.ts`
- Test: `lib/domain/revisit/__tests__/scenario.test.ts`, `lib/pipeline/__tests__/fetch-simulated.test.ts`

**Interfaces:**
- Consumes: Task 11, `FetchUrlDeps`, `fetchUrl`, `storeFetched`, `markChecked`, `markGone`, `normalizeUrl`, `normalizeText` (M3), `Archive`.
- Produces:
  - Szenario (zod, `revisitScenarioSchema`): `{ name: string; entries: ScenarioEntry[] }`, `ScenarioEntry = { id: string; url: string; edit: ScenarioEdit; expect: { document: "new_version" | "gone" | "unchanged"; events: ExpectedEvent[] }; note?: string }`, `ScenarioEdit = { op: "replace"; from: string; to: string } | { op: "delete"; text: string } | { op: "append"; text: string } | { op: "gone" } | { op: "touch" }`, `ExpectedEvent = { subject: string /* sp_/rg_/ar_/hl_ */; attribute: string | null /* "depth.*" erlaubt */; type: ChangeType; severity: ChangeSeverity }`. IDs und URLs (normalisiert) eindeutig.
  - `loadScenario(path: string): Promise<RevisitScenario>`.
  - `applyEdit(markdown: string, edit: ScenarioEdit, url: string): string` – `replace`/`delete`: Suchtext muss genau einmal vorkommen (Vergleich nach Whitespace-Normalisierung, Ersetzung im Original); keinmal → `ScenarioEditNotApplicable` mit URL und Suchtext, mehrmals → `ScenarioEditAmbiguous`; `append` hängt einen Absatz an; `touch` ändert nur Leerraum am Ende (gleicher normalisierter Hash).
  - `preflightScenario(db, archive, scenario): Promise<Array<{ entryId: string; documentId: string | null; ok: boolean; error?: string }>>` – jede URL ist ein bekanntes, aktives Dokument mit aktueller Version, jedes Edit wendet sich auf deren Markdown an.
  - `type SimulatedResponse = { status: 304 } | { status: 404 } | { status: 200; markdown: string }`; `type SimulatedFetcher = { respond(urlNormalized: string, current: { markdown: string } | null): SimulatedResponse }`; `createSimulatedFetcher(scenario: RevisitScenario): SimulatedFetcher` – Szenario-URL: `gone` → 404 (bei jedem Abruf), sonst 200 mit `applyEdit(current)`; jede andere URL → 304.
  - `simulatedTransport: Transport` – `…/robots.txt` → 404 (nach RFC 9309 alles erlaubt), jede andere Anfrage → `SimulationNetworkError` (kein Netz in der Simulation).
  - `FetchUrlDeps.simulated?: SimulatedFetcher` – in `fetchUrl` vor Schritt 2: 304 → `markChecked` (`not_modified`); 404 → `markGone`; 200 → `storeFetched` mit `converter "simulated"`, `simulated: true`, `rawExt "md"`, `contentType "text/markdown"`, `docType` des Dokuments, ohne Link-Entdeckung. Der Fetch-Handler baut `deps.simulated` und `transport = simulatedTransport`, wenn `PERIPLUS_SIMULATION` gesetzt ist (Szenario einmal je Prozess geladen).

- [ ] **Step 1: Failing tests**

```ts
it("an edit whose text is missing fails with url and text", () => {
  expect(() => applyEdit("Die Taverne ist offen.", { op: "delete", text: "Taverne Kostas" }, "https://x.test.invalid/a"))
    .toThrow(/x\.test\.invalid\/a.*Taverne Kostas/s);
});
it("an edit matching twice is rejected", …);
it("replace tolerates line breaks inside the search text", …);
it("touch keeps the normalized content hash", …);
it("preflight rejects duplicate urls and unknown documents", …);
// fetch-simulated.test.ts (withRollback, Test-Archiv, keine Netz-Transport-Funktion außer simulatedTransport)
it("a scenario url gets a simulated version with converter simulated", …);   // document_versions.simulated true
it("a non-scenario url is not modified and makes no request", …);
it("a gone entry marks the document gone after two fetches", …);           // 1. missing, 2. gone
it("a touched page stays unchanged", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npx vitest run lib` → PASS.
- [ ] **Step 5: Commit** `feat(sim): revisit scenario and simulated fetch adapter`

### Task 13: Revisit-Lauf und Verifikation

**Files:**
- Create: `lib/pipeline/revisit.ts`, `lib/domain/revisit/verify.ts`, `scripts/sim/revisit.ts`, `scripts/sim/verify.ts`
- Modify: `package.json` (`sim:revisit`, `sim:verify`), `app/(admin)/tiles/[id]/actions.ts` bzw. Lauf-Formular (Knopf „Revisit für Revier“)
- Test: `lib/domain/revisit/__tests__/verify.test.ts`, `lib/pipeline/__tests__/revisit.test.ts`, `scripts/__tests__/sim-verify.test.ts`

**Interfaces:**
- Consumes: Tasks 11–12, `FETCH_RUN_STAGES` (inkl. `embed.chunks`), `TEXT_RUN_STAGES` (inkl. Konsolidierung), `createRun`, `change_events`, `places.public_id`, `geo_objects.public_id`, `documents`, `document_versions.simulated`, `deliveries`, `consumePackage`-Stil (nur API).
- Produces:
  - `REVISIT_STAGES = [...FETCH_RUN_STAGES, ...TEXT_RUN_STAGES]`; `startRevisitRun(db, boss, input: { areaKey: string; triggeredBy: string }): Promise<{ id: string }>` – Art `revisit`, Umfang `area`, `params { sourceIds: "approved", areaKey, pending: true }`; derselbe Lauf dient dem echten zweiten Durchgang (ohne Simulation).
  - `type RevisitVerification = { fromSeq: number; entries: Array<{ id: string; url: string; document: { expected: string; actual: "new_version" | "gone" | "unchanged" }; events: { expected: number; matched: number }; ok: boolean }>; expected: number; correct: number; unexpected: Array<{ seq: number; subject: string | null; attribute: string | null; type: ChangeType; severity: ChangeSeverity }>; passes: boolean }`
  - `verifyRevisit(db, scenario: RevisitScenario, opts: { fromSeq: number; areaKey: string }): Promise<RevisitVerification>` – Ereignisse mit `seq > fromSeq` von Geo-Objekten im Revier (Orte der Revierkacheln, POIs, Regionen, Revier); Abgleich je Erwartung: gleiches Subjekt (öffentliche ID), Attribut gleich oder Präfix bei `.*`, gleicher Typ und Severity; jedes Ereignis erfüllt höchstens eine Erwartung, alles Übrige ist `unexpected`; Dokument: `gone` bei `status gone`, `new_version` bei einer Version mit `simulated = true` und `run_id` eines Laufs der Art `revisit`, sonst `unchanged`; `passes = correct === entries.length && unexpected.length === 0`.
  - `checkAsOf(input: { baseUrl: string; key: string; spotId: string; asOf: string; expectBefore: { dataVersion: number }; fetch?: typeof fetch }): Promise<{ ok: boolean; status: number; dataVersion: number | null; reason?: string }>` – `GET /api/v1/spots/{id}?asOf=`; ok, wenn 200 und `dataVersion` = `expectBefore.dataVersion`.
  - `asOfPlan(db, areaKey: string): Promise<{ asOf: string; before: { dataVersion: number; generatedAt: Date }; after: { dataVersion: number; generatedAt: Date } } | { reason: string }>` – jüngste gültige Lieferung vor und nach dem ersten Revisit-Lauf; gleicher UTC-Tag → `{ reason: "Paket vor dem Revisit am selben Tag gebaut – asOf kann die Stände nicht trennen" }`; keine Lieferung nach dem Revisit → `{ reason: "Nach dem Revisit kein Paket gebaut" }`; sonst `asOf` = Tag vor `after.generatedAt`.
  - Tabelle `sim_meta` existiert nur in der Sim-Datenbank (Task 15 legt sie an): `(cloned_at timestamptz, source_db text, from_seq bigint)`; `readSimMeta(db): Promise<{ clonedAt: Date; sourceDb: string; fromSeq: number } | null>`.
  - `foreignJobs(db): Promise<number>` (in `scripts/sim/revisit.ts` exportiert) – Zahl der pg-boss-Jobs im Status `created`/`retry`/`active`, die zu keinem Lauf mit `triggered_by` der Simulation gehören.
  - CLI `npm run sim:revisit -- --area saronic --scenario test/revisit/scenario.json` – `assertSimulationTarget`, `readSimMeta` (fehlt → Abbruch „keine Sim-Datenbank – scripts/sim/clone.sh“), `foreignJobs > 0` → Abbruch, `preflightScenario` (Fehler → Abbruch mit Liste), gültige Lieferung des Reviers vorhanden (sonst „erst Paket bauen“), dann `startRevisitRun`, Status alle 5 s bis `finished`/`failed`, Ausgabe Lauf-ID; zweiter Aufruf = zweiter Abruf (für `gone`).
  - CLI `npm run sim:verify -- --area saronic --scenario … [--base-url … --key pk_… --spot sp_…] [--out <json>]` – `verifyRevisit` mit `fromSeq` aus `sim_meta`, bei `--base-url` zusätzlich `asOfPlan` + `checkAsOf`; Tabelle je Eintrag, Liste der zusätzlichen Ereignisse; JSON nach `--out`; Exit 0 nur bei `passes` und (ohne `--base-url` oder) `asOf ok`.

- [ ] **Step 1: Failing tests**

```ts
// verify.test.ts (withRollback; Ereignisse direkt eingefügt)
it("all expected events and documents give 2 of 2 correct and pass", …);
it("an extra event is unexpected and fails", …);
it("a wrong severity is not correct", …);
it("depth.* matches depth.min but not draft", …);
it("a duplicate event for the same expectation counts as unexpected", …);
it("asOf check reports a same-day previous delivery", async () => {
  expect(await asOfPlan(tx, areaKey)).toEqual({ reason: expect.stringMatching(/selben Tag/) });
});
it("asOf check passes when the API returns the older profile version", …);   // fetch-Stub: 200 { dataVersion: 1 }
// revisit.test.ts
it("startRevisitRun creates a revisit run over fetch and text stages for the area", …);
it("revisit preflight fails on queued pg-boss jobs", …);   // Hilfsfunktion foreignJobs(db) aus scripts/sim/revisit.ts
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npx vitest run lib scripts` → PASS.
- [ ] **Step 5: Commit** `feat(sim): revisit run, change-feed verification against the scenario, asOf check via API`

### Task 14: Revisit-Integrationstest mit Fixture-Revier (CI)

**Files:**
- Create: `test/revisit/fixture/area.ts`, `test/revisit/fixture/fake-model.ts`, `test/revisit/fixture/scenario.json`, `test/revisit/fixture/documents/d1.md` … `d5.md`, `lib/pipeline/__tests__/revisit-run.test.ts`
- Test: `lib/pipeline/__tests__/revisit-run.test.ts`

**Interfaces:**
- Consumes: Tasks 12–13, `recordComputation` (M2), `storeFetched` (M3), Stufenfunktionen von `TEXT_RUN_STAGES` direkt wie in `text-run.test.ts` (M4), `MockModel`, `consolidateGeo` mit `today` (M5), `buildDelivery`/`spotAsOf` (M6), `withRollback`, `testArchive()`.
- Produces:
  - `seedRevisitArea(tx): Promise<RevisitFixture>` – Synthetik um 21,5° O / 35,6° N (außerhalb der Pilotbox): ein Revier (`ar_` fest), **eine** Kachel, Landpolygon mit Bucht, **3 bestätigte Orte** mit festen `sp_`-IDs – A (Ankerplatz), B (Ankerplatz, Tiefen-Computation mit Konfidenz 0,3, damit Text gilt), M (Marina) – je 8 berechnete Schutz-Facts und Tiefe; vier freigegebene Quellen `*.test.invalid`: S1 `pilot_guide` 0,9, S2 `authority` 0,9, S3 `trip_report` 0,6, S4 `forum` 0,4; **5 Dokumente** d1 (S1, A: Taverne), d2 (S1, B: Ankertiefe), d3 (S3, A: Törnbericht), d4 (S2, M: Verbote), d5 (S4, B: Bojen), erste Versionen über `storeFetched` aus `documents/*.md` mit `fetchedAt 2026-05-01`.
  - `createRevisitFakeModel(): MockModel` – Klassifikation nach Quellentyp; Extraktion regelbasiert mit wörtlichen Zitaten aus dem Einheitentext: „Die Taverne (\w+) ist im Sommer geöffnet.“ → `highlight.food { present: true, names: [$1] }`, „Die Taverne (\w+) hat geschlossen.“ → `{ present: false, names: [$1] }`, „Ankertiefe (\d+) m“ → `depth.min`, „Bojen sind ausgelegt.“ / „Die Bojen wurden entfernt.“ → `mooring.buoys { present }`, „Swimming is prohibited …“ / „Anchoring is prohibited …“ → `prohibitions`.
  - `test/revisit/fixture/scenario.json` (5 Einträge, je Dokument einer): e1 d1 `replace` „ist im Sommer geöffnet.“ → „hat geschlossen.“ ⇒ `new_version`, `[{ A, "highlight.food", changed, notable }]`; e2 d2 `replace` „Ankertiefe 4 m“ → „Ankertiefe 2 m“ ⇒ `[{ B, "depth.*", changed, safety }]`; e3 d3 `gone` ⇒ `gone`, `[]`; e4 d4 `append` „Anchoring is prohibited in the harbour basin.“ ⇒ `[{ M, "prohibitions", changed, safety }]` (M hat vorher ein Badeverbot); e5 d5 `replace` „Bojen sind ausgelegt.“ → „Die Bojen wurden entfernt.“ ⇒ `[{ B, "mooring.buoys", uncertain, notable }]`.

- [ ] **Step 1: Failing test**

```ts
it("the simulated revisit shows exactly the scenario's changes and the old spot stays readable", async () => {
  await withRollback(async (tx) => {
    const fx = await seedRevisitArea(tx);
    await textAndConsolidate(tx, fx, { today: "2026-05-01" });          // Lauf 1
    await buildDelivery(tx, archive, fx.areaId, { now: new Date("2026-05-01T08:00:00Z") });
    const fromSeq = await maxSeq(tx);
    for (const day of ["2026-06-01", "2026-06-08"]) {                   // zwei Abrufe: 404 zweimal
      await simulatedFetchAll(tx, fx, scenario, day);                     // fetchUrl mit deps.simulated
      await textAndConsolidate(tx, fx, { today: day });
    }
    const v = await verifyRevisit(tx, scenario, { fromSeq, areaKey: fx.areaKey });
    expect(v.correct).toBe(5);
    expect(v.unexpected).toEqual([]);
    expect(v.passes).toBe(true);
    await buildDelivery(tx, archive, fx.areaId, { now: new Date("2026-06-08T08:00:00Z") });
    expect((await spotAsOf(tx, archive, fx.publicIds.A, "2026-05-15"))!.dataVersion).toBe(1);
    expect((await spotAsOf(tx, archive, fx.publicIds.A, "2026-06-09"))!.dataVersion).toBe(2);
  });
});
it("a second revisit without further changes adds no change event", …);
it("a scenario expecting a wrong type fails verification with one missing and one unexpected", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/pipeline/__tests__/revisit-run.test.ts` → FAIL (Fixture fehlt).
- [ ] **Step 3: Implementieren** (Fixture-Dokumente, Fake-Modell, Helfer im Test). Weicht ein erwarteter Typ wegen einer M5-Regel ab, wird die **Fixture** (Gewichte, Vorwerte) angepasst, nicht die Erwartung – die Erwartungen sind die aus Spec 10.
- [ ] **Step 4: Run** `npx vitest run` (gesamt, die CI führt den Test im Projekt `default` aus) → PASS.
- [ ] **Step 5: Commit** `test(sim): revisit integration test on a one-tile fixture area`

### Task 15: Sim-Klon, Sim-Prozesse, Szenario-Entwurf

**Files:**
- Create: `scripts/sim/clone.sh`, `scripts/sim/__tests__/clone-test.sh`, `scripts/sim/draft-scenario.ts`, `.env.sim.example`
- Modify: `package.json` (`sim:clone`, `sim:worker`, `sim:draft-scenario`, `test:ops` führt beide Shell-Tests aus), `.gitignore` (`.env.sim`)
- Test: `scripts/sim/__tests__/clone-test.sh`, `scripts/__tests__/draft-scenario.test.ts`

**Interfaces:**
- Consumes: Tasks 12–13, `facts`, `mentions`, `chunks`, `documents`, `sources`, `profiles`.
- Produces:
  - `scripts/sim/clone.sh [--compose-file docker/compose.dev.yml] [--service db] [--source-db periplus] [--force]` – Ziel immer `periplus_sim` (fest, nicht wählbar); Quelle = Ziel → Abbruch; `periplus_sim` existiert ohne `--force` → Abbruch; Ablauf über `docker compose -f <file> exec -T <service>`: `pg_dump -Fc <source>` → `dropdb --if-exists periplus_sim` → `createdb periplus_sim` → `pg_restore --no-owner -d periplus_sim` → in `periplus_sim`: alle Zeilen der Job-Tabellen im Schema `pgboss` löschen (Queue-Definitionen bleiben), `create table sim_meta (cloned_at timestamptz, source_db text, from_seq bigint)` mit `from_seq = coalesce(max(change_events.seq), 0)`; Ausgabe des nächsten Schritts. Server: `--compose-file docker/compose.prod.yml --service postgres` (Runbook).
  - `clone-test.sh` – gefälschtes `docker` auf `PATH` (Muster `scripts/deploy/__tests__/deploy-test.sh`): Fälle `source equals target is refused`, `existing sim db without --force is refused`, `pgboss jobs are removed after restore` (Log enthält den Lösch-Befehl nach `pg_restore`), `sim_meta is written with from_seq`.
  - `.env.sim.example`: `DATABASE_URL=postgres://periplus:periplus@localhost:5433/periplus_sim`, `S3_WRITE_PREFIX=sim/<YYYYMMDD>/`, `PERIPLUS_SIMULATION=test/revisit/scenario.json`, übrige Werte wie `.env.local`; `"sim:worker": "tsx --env-file=.env.sim worker/index.ts"`; Web der Sim-Umgebung per Runbook (`DATABASE_URL=… S3_WRITE_PREFIX=… npx next dev -p 3001`).
  - `draftScenario(db, input: { areaKey: string; seed: number }): Promise<{ scenario: RevisitScenario; gaps: string[] }>` – schlägt 10 Einträge aus dem Archiv vor, je mit wörtlichem Satz der aktuellen Version als Suchtext und der Erwartung nach den Regeln aus M5: 2 × Taverne verneint (Quelle Gewicht > 0,8, Satz mit `highlight.food`-Zitat) ⇒ `changed highlight.food notable`; 1 × Taverne-Satz gestrichen, Ort hat eine zweite Quelle ⇒ `new_version`, `[]`; 2 × Tiefe geändert an Orten mit Raster-Konfidenz < 0,4 ⇒ `changed depth.* safety`; 2 × `gone` (Dokumente, deren Facts andere Quellen stützen) ⇒ `gone`, `[]`; 1 × Ankerverbot an `authority`-Quelle angehängt ⇒ `changed` bzw. `new_attribute prohibitions safety` (je nach Vorwert); 1 × Forum widerspricht `mooring.buoys` ⇒ `uncertain notable`; 1 × `touch` ⇒ `unchanged`, `[]`; fehlt eine Kategorie im Archiv → `gaps`. CLI `npm run sim:draft-scenario -- --area saronic --out test/revisit/scenario.json` (nur gegen `periplus_sim`), danach von Hand prüfen.

- [ ] **Step 1: Failing tests** – `clone-test.sh` (vier Fälle oben); `draft-scenario.test.ts` (withRollback, Fixture aus Task 14): `the draft quotes sentences that occur once in the current version`, `a missing category is reported as gap`, `the draft passes preflightScenario`.
- [ ] **Step 2: Run** `bash scripts/sim/__tests__/clone-test.sh && npx vitest run scripts` → FAIL. **Step 3: Implementieren.** **Step 4: Run** `npm run test:ops && npx vitest run scripts` → PASS.
- [ ] **Step 5: Commit** `feat(sim): sim database clone, sim worker env and scenario draft`

### Task 16: Kostenbericht, Mittelmeer-Hochrechnung, Pilotbericht

**Files:**
- Create: `lib/domain/quality/reports.ts`, `scripts/report-costs.ts`, `scripts/report-pilot.ts`
- Modify: `package.json` (`report:costs`, `report:pilot`)
- Test: `lib/domain/quality/__tests__/reports.test.ts`

**Interfaces:**
- Consumes: Tasks 7–8, 13, `spendBreakdown` (M0), `getConfig().areas` (`cycleDays`), `QualityConfig.extrapolation`.
- Produces:
  - `type CostReport = { areaKey: string; first: { label: string; window: MeasureWindow; costEur: number; places: number; perPlace: number | null; byStage: Record<string, number>; byService: Record<string, number> }; second: (same) | null; assumptions: { placesPerArea: number; placesPerAreaSource: "pilot" | "config"; areasMin: number; areasMax: number; cycleDays: number; revisitsPerYear: number }; extrapolation: Extrapolation }`
  - `extrapolate(input: { perPlaceFirst: number; perPlaceRevisit: number | null; placesPerArea: number; areasMin: number; areasMax: number; revisitsPerYear: number }): Extrapolation` mit `Extrapolation = { initialMin: number; initialMax: number; yearlyMin: number | null; yearlyMax: number | null }` – `initial = perPlaceFirst × placesPerArea × areas`; `yearly = perPlaceRevisit × placesPerArea × areas × revisitsPerYear`.
  - `costReport(db, input: { areaKey: string; firstLabel: string; secondLabel?: string }): Promise<CostReport>` – aus den Snapshots `cost_per_place` (Details) der Messungen; `placesPerArea` = Konfiguration oder bestätigte Orte des Pilotreviers; `revisitsPerYear = 365 / cycleDays` des Reviers.
  - `renderCostReport(r: CostReport): string` – Markdown mit Abschnitten „Kosten je Stufe“, „Kosten je Dienst“, „Kosten je Ort und Lauf“, „Annahmen“ (Ortszahl je Revier mit Herkunft, Zahl der Reviere 60–100, Zyklus), „Hochrechnung Mittelmeer“ (Erstlauf und Jahr, jeweils min–max); Beträge in EUR mit zwei Nachkommastellen, deutsche Zahlformatierung.
  - `renderPilotReport(input: { areaKey: string; first: MeasurementView; second: MeasurementView | null; targets: QualityConfig; revisit: RevisitVerification | null; asOf: { ok: boolean; reason?: string } | null; consumer: { ok: boolean; dataVersion: number } | null; tiles: { median: number; min: number; max: number; outside: string[] } }): string` – Markdown: Erfolgskriterien als Checkliste mit Ist-Werten (abgehakt nur bei Erfüllung), Kennzahlen-Tabelle mit Pilot-/Vollbetriebsziel und Status, Revisit „n von 10 korrekt, k zusätzliche“, Review-Aufwand zweiter Lauf vs. 60 min, Kachelgröße mit Platzhalter „Entscheidung: …“ für Christian, Verweis auf den Kostenbericht.
  - CLI `npm run report:costs -- --area saronic --first "Lauf 1" [--second "Lauf 2"]` → `docs/pilot/<YYYY-MM-DD>-kostenbericht.md`; `npm run report:pilot -- --area saronic --first "Lauf 1" --second "Lauf 2" [--revisit <json aus sim:verify>] [--consumer-ok --data-version n]` → `docs/pilot/<YYYY-MM-DD>-pilotbericht.md`.

- [ ] **Step 1: Failing tests**

```ts
it("extrapolates 1.20 €/place, 120 places, 60–100 areas", () => {
  expect(extrapolate({ perPlaceFirst: 1.2, perPlaceRevisit: 0.3, placesPerArea: 120, areasMin: 60, areasMax: 100, revisitsPerYear: 12 }))
    .toEqual({ initialMin: 8640, initialMax: 14400, yearlyMin: 25920, yearlyMax: 43200 });
});
it("without a second run the yearly figures are null", …);
it("the cost report names stages, assumptions and 60–100 areas", () => {
  const md = renderCostReport(report);
  for (const s of ["Kosten je Stufe", "Annahmen", "60–100", "8.640,00 €"]) expect(md).toContain(s);
});
it("the pilot report ticks only met criteria", …);   // Abdeckung 0,86 → [x]; Revisit 9/10 → [ ]
it("costReport takes places per area from the pilot when config is null", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(quality): cost report with mediterranean extrapolation and pilot report`

### Task 17: Abnahme-Checkliste, Runbook, Gesamtprüfung, Übergabe

**Files:**
- Create: `docs/pilot/m7-abnahme.md`
- Modify: `docs/runbook.md`
- Test: keiner neu (Gesamtprüfung)

- [ ] **Step 1: `docs/pilot/m7-abnahme.md`** – Tabelle je Erfolgskriterium (Spec 10, „Pilot-Abnahme“) → Nachweis:
  | Kriterium | Nachweis |
  | --- | --- |
  | Alle Pilot-Zielwerte der Kennzahlen erreicht | `/quality?area=saronic` Messung „Lauf 1“ und „Lauf 2“ alle „erreicht“; Navily-Abdeckung per `npm run compare:navily -- --area saronic --coverage`; Präzision nach Abarbeiten von `/quality/compare` und Review `comparison_deviation` |
  | Gazetteer der Pilotkacheln vollständig (de, en, el) | `npm run check:gazetteer -- --area saronic` und `--area argolic` Exit 0 |
  | Simulierter Revisit: 10 von 10, keine falschen | `scripts/sim/clone.sh` → `sim:draft-scenario` → Szenario prüfen und einchecken → `sim:worker` → `sim:revisit` (zweimal) → Paket bauen in der Sim-Umgebung → `sim:verify --out docs/pilot/<datum>-revisit.json` Exit 0 |
  | Profil zum Stand vor dem Revisit per API | `sim:verify --base-url http://localhost:3001 --key pk_… --spot sp_…` meldet „asOf ok“ |
  | Review-Aufwand zweiter Lauf < 60 min | echter zweiter Lauf („Revisit für Revier“) in Produktion, Messung „Lauf 2“, Kennzahl `review_minutes` < 60 |
  | Kosten je Ort und Lauf dokumentiert, Hochrechnung | `npm run report:costs -- --area saronic --first "Lauf 1" --second "Lauf 2"` → `docs/pilot/<datum>-kostenbericht.md` |
  | Abnehmer liest das Paket ohne Nachbearbeitung, validiert gegen das JSON-Schema | `npm run delivery:consume -- --base-url … --key … --area saronic` Exit 0 (M6) |
  | Kachelgröße bewertet, Entscheidung dokumentiert | `places_per_tile` auf `/quality` → Entscheidung im Pilotbericht |
  | Pilotbericht | `npm run report:pilot …` → `docs/pilot/<datum>-pilotbericht.md`; erst danach M8 |
- [ ] **Step 2: Runbook** – Abschnitte „Qualität messen“ (Messlauf mit Bezeichnung „Lauf 1“/„Lauf 2“, Fenster, Dashboard), „Navily-Abgleich“ (Datei lokal bzw. auf dem Server außerhalb des Repos ablegen, `NAVILY_SPOTS_PATH`, Erstdurchgang `compare:navily --accept-proposals`, danach `/quality/compare` und Review; nie Navily-Werte eintragen), „Regression“ (neue Regelversion → Bewertung → geänderte Werte prüfen → Aktivieren; Prompt/Modell → Bewertung → Freigabe → Deploy von `config/models.json`), „Simulierter Revisit“ lokal (Compose-Dienst `db`) und auf dem Server (`docker/compose.prod.yml`, Dienst `postgres`), mit dem Hinweis: Revisit frühestens am Tag nach dem letzten Paketbau, sonst trennt `asOf` die Stände nicht; Sim-Datenbank und Präfix `sim/<datum>/` danach löschen (`dropdb periplus_sim`, Präfix im Bucket).
- [ ] **Step 3: Gesamtprüfung** – `npm run lint && npm run typecheck && npm run test:ops && npx vitest run && npm run test:e2e && npm run build` → alles grün.
- [ ] **Step 4: Commit** `docs: M7 acceptance checklist and runbook for quality, comparison and simulated revisit`
- [ ] **Step 5: Übergabe an Christian (nicht vom Ausführenden zu erledigen)** – voller Pilotlauf (M1–M6) für `saronic`/`argolic`, Messung „Lauf 1“; Navily-Erstdurchgang und Abweichungs-Review; Sim-Klon, Szenario entwerfen/prüfen/einchecken, simulierten Revisit ausführen und verifizieren; echter zweiter Lauf, Messung „Lauf 2“; Kosten- und Pilotbericht erzeugen, Kachelgröße entscheiden, Checkliste abhaken.

---

## Bewusste Abweichungen und Entscheidungen

- **Ergebnisse hängen am Hash des eigenen Werts** (`value_hash`, 16 Hex) statt allein an `profile_version`: so „gilt das alte Ergebnis weiter“, solange der normalisierte Vergleichswert gleich bleibt – über Profilversionen und Bewertungsläufe hinweg; `profile_version` bleibt zur Nachvollziehbarkeit. Normalisiert wird auf die Vergleichsklasse (Schutz geschützt/offen ab 0,5, Tiefe auf 0,5 m, Position auf 4 Nachkommastellen), damit Gleitkomma-Rauschen keine Nachprüfung erzwingt. Der Hash enthält nur eigene Werte; zusätzlich `method`, `evaluation_run_id` und `review_task_id` – keine dieser Spalten kann einen Navily-Wert aufnehmen (Schema-Test).
- **Vergleichsattribute als 16 Schlüssel:** Schutz je Sektor einzeln, „Versorgung“ als `services.water` + `highlight.supply`, „Taverne“ als `highlight.food`. Navily führt weder Tiefe noch Taverne; der Assistent schlägt dafür immer `not_at_navily` vor, von Hand lassen sie sich in der Navily-App trotzdem prüfen.
- **Navily-Assistent statt reiner Handarbeit:** Spec 10 sieht vor, dass der Admin jeden Wert in der Navily-App nachschlägt. Der Assistent liest die lokale Datei zur Laufzeit und schlägt je Attribut ein Ergebnis vor; gespeichert wird nur das bestätigte Ergebnis (`proposal_confirmed`) bzw. beim CLI-Erstdurchgang `proposal_auto` mit `checked_by "navily-assistant/1"`, damit maschinelle Ergebnisse jederzeit erkennbar sind. Jede Abweichung geht wie vorgesehen ins Review.
- **Zwei Abdeckungs-Kennzahlen:** `coverage` nach Spec 10 (Satz-Orte mit `status = confirmed`) ist durch die M1-Regel „nur bestätigte Orte in den Satz“ fast immer 100 % und misst nur spätere Verwerfungen. Die Quell-Spec meint „Orte des Navily-Vergleichssatzes, die als bestätigter Ort vorliegen“; das misst `coverage_navily` zur Laufzeit gegen die Datei und speichert nur Zählwerte. Abnahme-Kennzahl ist `coverage_navily`.
- **Unpassende Navily-Spots werden nicht gespeichert:** Navily-Orte ohne Periplus-Ort erscheinen nur zur Laufzeit auf `/quality/compare` (Hinweis „wird nicht gespeichert“); eine Übernahme als Ortskandidat würde Navily-Koordinaten speichern (Grundprinzip 9). Ein Satz-Ort ohne Navily-Treffer bekommt den Vorschlag „Existenz weicht ab“.
- **Messung als eigener Lauf mit Zeitfenster:** Ein Pilot-„Lauf“ besteht aus vielen Läufen (Gazetteer, Geometrie, Crawl, Text, Konsolidierung). Der Messlauf `quality.measure` trägt Bezeichnung und Fenster und ist der `run_id` der Snapshots; Kosten und Review-Aufwand gelten für das Fenster. Kosten ohne Kachel- oder Revierbezug (Quellen-, Text-Läufe) werden nach Anteil bestätigter Orte auf die Reviere verteilt.
- **Review-Aufwand über alle Reviere, mit Deckel:** `review_tasks` kennen weder Lauf noch Revier; der Aufwand zählt Aufgaben, die im Messfenster entstanden sind, über alle Reviere (im Pilot identisch). Eine Bearbeitungszeit zählt höchstens 10 Minuten (`reviewDurationCapMinutes`), damit ein offen gelassener Tab die Kennzahl nicht verfälscht; gedeckelte Fälle stehen in den Details.
- **Aktivieren per Klick wirkt sofort nur für Regelversionen:** Die wirksame Regelversion kommt aus `config_activations` (Rückfall `active.json`). Prompt-, Modell- und Schema-Wechsel werden genauso bewertet und per Klick freigegeben, wirksam aber erst per Deploy von `config/models.json` bzw. Fact-Schema, weil diese Werte synchron aus der Konfiguration gelesen werden; `/settings` zeigt, ob die laufende Extraktionskonfiguration freigegeben ist.
- **Ein gestrichener Satz ist keine Profiländerung:** M5 legt fest „Wert entfällt → keine Änderung (Wert bleibt, Ablauf regelt das Veralten)“. Das Spec-10-Beispiel „Satz zur Taverne gestrichen → `changed`“ wird deshalb im Szenario als **verneinender** Satz („Die Taverne … hat geschlossen.“) abgebildet; eine reine Streichung steht zusätzlich im Szenario mit der Erwartung „neue Dokumentversion, kein Ereignis“ – das prüft „nichts anderes“. Die Szenario-Erwartungen umfassen darum Dokumentebene und Ereignisse.
- **„404 zweimal“ heißt zwei Abrufe:** Der Revisit wird in der Simulation zweimal ausgeführt (zweiter Abruf ohne weitere Änderungen); damit prüft der zweite Durchgang zugleich, dass ein Revisit ohne Änderungen keine Ereignisse erzeugt.
- **Der Simulations-Adapter ersetzt jeden Netzabruf:** Szenario-URLs liefern das bearbeitete Markdown der aktuellen Archivversion, alle anderen URLs 304 („wie aufgezeichnet“ = unverändert, ohne Abruf), robots.txt gilt als 404. So kostet die Simulation nur die Modellaufrufe der geänderten Chunks und kann keine fremde Seite abrufen.
- **Archiv mit Schreibpräfix statt eigenem Bucket:** Der Klon verweist auf die Archivschlüssel der Produktion; der Sim-Prozess liest sie weiter, schreibt aber nur unter `S3_WRITE_PREFIX`. Die Produktionsdaten bleiben unberührt, Aufräumen = Präfix löschen.
- **`from_seq` in `sim_meta`:** Der Klon hält die Grenze „vor dem Revisit“ in der Sim-Datenbank fest; die Verifikation braucht keine manuell notierte Zahl. `sim_meta` gibt es nur dort, nicht in den Migrationen.
- **CI-Fixture mit 5 statt 10 Änderungen:** Das Fixture-Revier hat laut Spec 5 Dokumente, also je Dokument eine Änderung; die 10 Änderungen des Piloten stehen in `test/revisit/scenario.json`, die `sim:draft-scenario` aus dem echten Archiv vorschlägt und Christian prüft und eincheckt (echte URLs sind vor dem Crawl unbekannt).
- **`asOf` über das Paketarchiv (M6):** Vor dem Revisit muss ein Paket gebaut sein, nach dem Revisit ein weiteres, an verschiedenen Tagen; die Verifikation prüft das und nennt den Grund, statt still zu scheitern.
- **Routen-Rekonstruktion nur als Kennzahl:** Stopps ohne Ort werden nicht von Hand zugeordnet (`route_stops` sind nur anfügend); fehlende Orte schließt der normale Weg über Ortskandidaten, danach zählt die nächste Messung.
- **Kein e2e-Test für `/quality/compare`:** Die Wirkung liegt in den Server Actions und ist dort getestet; die Playwright-Liste aus Spec 09 bleibt unverändert.

# Periplus N5 – Liefervertrag 4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den Liefervertrag auf den neuen Stand umstellen: Pakete je Landesteil und je Umkreis enthalten bestätigte Liegeplätze mit Kernwerten, freien Fakten (eigene Worte, ohne Quellen), Anlandestellen, Erreichbarem an Land und Ortsbild – gebaut aus `berth_states`, ohne Change-Feed, ohne Zusammenfassungen, ohne Highlights.

**Architecture:** Vertrag 4.0 baut auf der Hülle von 3.0 auf (Spec 18: `scope`, `coverage`). `contract/v2/` bleibt das Verzeichnis der aktuellen Version (Repo-Konvention), 3.0 wird als `contract/v3_0/` eingefroren. Die Spot-Abbildung liest `berth_states` statt Profile; Erreichbares an Land steht je Spot in `nearby` (Design 7.3), `highlights.json` und `changes.json` entfallen. Die Umkreis-Zusammensetzung (Spec 18) bleibt; die Änderungs-Endpunkte antworten „neu laden“. API `/api/v4` ersetzt `/api/v3`.

**Tech Stack:** TypeScript, zod 4 (Vertrag, JSON-Schemas), Drizzle/PostGIS, S3-Archiv, Next.js 16 Route Handlers.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (5.7, 5.9, 6 „Mindestinhalt“, 7.1, 7.3), Spec 18 (`…-18-umkreis-lieferung-design.md`), Teil-Spec 08.

## Global Constraints

- Branch `feat/n5-vertrag-4` von `main` (enthält #20–#27).
- Sicherheit zuerst: geliefert wird ein Liegeplatz mit Status `confirmed` nur mit `berth_states`-Zeile und Mindestinhalt (Art, Position, Ankerposition – bei `port`/`marina` die Hafenposition –, Schutz je Sektor); sonst ausgelassen mit Warnung. Plätze mit Status `no_anchoring` werden wie in 3.0 als `exclude.excluded = true` geliefert (Warnung an die App), ohne Stand.
- **Nicht im Vertrag 4.0:** Quellen, URLs, Domains, Zitate, Versionen (`profileVersion`), Change-Feed, Zusammenfassungen (`summary`), Highlights (`highlights.json`, `highlightIds`, `highlightLevels`). Die Prüfungen `foreign_content` und `verbatim_text` bleiben und prüfen jetzt Fakten-Aussagen und Anlandebeschreibungen.
- Kernwerte behalten die Feldformen von 3.0, wo 3.0 ein Feld hat (App-Kompatibilität). `popularity` bleibt wie in Spec 18 berechnet.
- Vertrag 3.0 bleibt als `contract/v3_0/` reproduzierbar und unter `contract/schema/3.0/` veröffentlicht; Pakete 3.0 werden nicht mehr gebaut. Produktion hat keine Abnehmer und keine Daten (geprüft 25.10.2026), `/api/v3` darf entfallen.
- Werte in `config/delivery.json`; Code englisch, Oberfläche deutsch; grün nach jeder Aufgabe (`vitest` der berührten Bereiche plus `contract`, `tsc`, `lint`, `build` bei UI/Routen); vor Routen-Code Next-16-Doku lesen; Commit-Trailer wie bisher.
- Geteilte DBs (dev 5433, test 5434) nie von Hand ändern; Navily-Regel gilt.

## Entscheidungen (Rulings vor Beginn)

- **E1 `nearby` im Spot, keine eigene Datei** (Design 7.3): `nearby[]` = `{ id, category, name, names?, position, distanceM, access }`. Die Dinge an Land sind POIs mit bestehender öffentlicher ID `hl_` (Migration 0048); ein Ding ohne öffentliche ID wird ausgelassen (Warnung). Kein neues Präfix.
- **E2 Fakt-IDs** `fc_` + Crockford-Base32 der `berth_facts`-UUID des Repräsentanten (deterministisch, eindeutig, keine Tabelle). Ändert die Bündelung den Repräsentanten, ändert sich die ID – ohne Change-Feed unkritisch.
- **E3 Fakt-Bezug:** `subject: { kind: "spot" } | { kind: "landside", id: hl_… | null, name: string | null }`. Ein Landfakt wird dem `nearby`-Eintrag zugeordnet, dessen Name (normalisiert, alle Namen des Objekts) zu `subjectName` passt; sonst `id: null` mit `name` (Design 5.7: Koordinaten werden nicht geraten).
- **E4 Versionsfelder:** `profileVersion`/`validFrom` entfallen im Spot; neu `asOf: isoDate | null` (Datum von `berth_states.updated_at`, `null` bei ausgeschlossenen Plätzen ohne Stand). Manifest-Kachel `profilesAsOf` → `statesAsOf`.
- **E5 `services.shop`/`services.taverna`** kommen aus `nearby` (zu Fuß erreichbares `supply`/`bakery` bzw. `food` → `yes`, sonst `unknown`); die übrigen Services aus den Kernwerten.
- **E6 Lücken:** neu `gaps: string[]` im Spot (Kernwert-Schlüssel ohne Wert, aus `berth_states.gaps`), damit die App Lücken ausweisen kann (Design 6).
- **E7 Regionen** bleiben (`regions.json`) ohne `summary` und `sources`; Wetterpunkte und Küste unverändert.
- **E8 API:** `/api/v4/**` ersetzt `/api/v3/**` (Verzeichnis umbenennen, Routen-Politik anpassen); Schema-Abruf `/api/v4/schema/<version>/<datei>` liefert alle veröffentlichten Versionen. `…/changes` (Landesteil und Umkreis) antwortet immer `200 { "invalidSince": true, "reason": "reload" }` – Form im Vertrag als `changesResponseSchema` festgehalten.

## Review Focus

- Ein Fakt, dessen Aussage 15 Wörter wörtlich aus einem archivierten Dokument übernimmt → Paket abgelehnt (`verbatim_text`) (Test Task 3).
- Ein bestätigter Platz ohne Schutz im Stand → nicht geliefert, Warnung; ein bestätigter Platz ohne `berth_states`-Zeile → nicht geliefert, Warnung (Test Task 2).
- Ein Platz wird zwischen zwei Paketen zurückgenommen (Status nicht mehr `confirmed`) → fehlt im neuen Paket; das Umkreis-Paket aus zwei Landesteilen nimmt je Landesteil das aktuelle Paket (Test Task 4).
- Sicherheitsfakt (`safety: true`) erscheint im Paket mit Markierung; ein Landfakt ist nie Sicherheitsfakt eines Spots ohne Markierung (Test Task 2).
- Keine URL, kein Domainname und keine Quelle irgendwo im Paket (Prüfung `foreign_content` über alle Texte; Test Task 3).

---

### Task 1: Vertrag 4.0 (Schemas)

**Files:** `contract/v3_0/` (eingefrorene Kopie von `contract/v2/` mit 3.0, Muster wie `contract/v2_3/`), `contract/v2/{spot,manifest,common,index}.ts` (4.0), `contract/v2/highlight.ts` und `contract/v2/changes.ts` entfernen (in `v3_0` bleiben sie), `contract/index.ts` (`SCHEMA_VERSION = "4.0"`, Kommentar), `contract/schema/4.0/` (erzeugt mit `npm run contract:generate`), `contract/schema/published.ts`, `config/delivery.json` (`schemaVersion`), Tests `contract/__tests__`.

**Interfaces (Produces):**
- `CONTRACT_FILES` 4.0 = `manifest.json`, `spots.json`, `regions.json`, `weather-points.json`, `coast.geojson`.
- `spotSchema` 4.0 = 3.0 ohne `summary`, `highlightIds`, `highlightLevels`, `sources`, `profileVersion`, `validFrom`; mit `asOf: isoDate.nullable()`, `gaps: z.array(z.string().min(1))`, und
  - `facts: z.array(factSchema)`, `factSchema = { id: publicId("fc"), subject: discriminatedUnion("kind", [{kind:"spot"}, {kind:"landside", id: publicId("hl").nullable(), name: z.string().min(1).nullable()}]), text: z.string().min(1), observedAt: isoDate.nullable(), tone: enum(["positive","negative","neutral"]).nullable(), safety: z.boolean(), mentions: count }`
  - `landingPoints: z.array(discriminatedUnion("kind", [{ kind: enum(["harbour","pier","slipway","beach","shore"]), position: latLon }, { kind: literal("text"), description: z.string().min(1) }]))`
  - `nearby: z.array({ id: publicId("hl"), category: highlightCategory ∪ "bakery" ∪ "transport" (eigenes Enum `nearbyCategory`), name: z.string().min(1), names: optional wie Spot-Namen, position: latLon, distanceM: count, access: enum(["foot","transport"]) })`
- `regionSchema` 4.0 ohne `summary`, `sources`.
- `manifestSchema` 4.0: `schemaVersion: literal("4.0")`, Kachel `statesAsOf` statt `profilesAsOf`, `objectCounts` ohne `highlights` und `changes`.
- `changesResponseSchema = z.strictObject({ invalidSince: z.literal(true), reason: z.literal("reload") })`.
- Typen `Fact`, `LandingPoint`, `NearbyEntry`, `SpotBody` (= `Spot` ohne `asOf`).

- [ ] Steps: Tests (gültiges Beispielpaket 4.0; Spot ohne `facts` ungültig; `nearby.id` mit Präfix `sp` ungültig; Fakt mit `subject.kind = "landside"` und `id: null, name: null` ungültig per `refine`; 3.0-Beispiel validiert weiter gegen `contract/v3_0`), fail, implement + JSON-Schemas erzeugen, pass, commit `feat(contract): contract 4.0 with facts, landing points and things on land (N5)`.

### Task 2: Laden und Abbildung aus dem Stand

**Files:** `lib/domain/delivery/load.ts` (je Spot `state: BerthStateRow | null` statt `profile`/`summary`/`sources`; POIs für `nearby` laden: öffentliche ID, Kategorie, Namen, Position), `lib/domain/delivery/types.ts`, `lib/domain/delivery/map-spot.ts` (`mapSpot` liest den Stand; `SPOT_FIELDS` angepasst), neu `lib/domain/delivery/map-facts.ts` (`factPublicId(uuid): string`, `mapFacts`, `mapLandingPoints`, `mapNearby`), `map-region.ts` (ohne Summary/Sources); Tests.

**Interfaces:**
- Consumes: `berth_states` (`lib/db/schema/research-state.ts`: `core` je v4-Schlüssel `{ value, confidence, origin, observedAt, factIds }`, `facts`, `landing`, `nearby`, `gaps`, `updatedAt`), Task 1 Typen.
- Kernwerte → 3.0-Feldformen: dieselben Regeln wie heute in `mapSpot`, nur liest es `core[key].value` statt `profile.attributes[key]` und Herkunft/Konfidenz aus `core[key]` statt `profile.provenance[key]` (Origin `computed|text|rule` → bestehendes `ORIGIN`-Vokabular, `rule` wie `computed`). `provenance` im Spot bleibt (Herkunft, Konfidenz, Datum – keine Quelle).
- `MappedSpot` wie heute (`ok` mit Spot | `omitted` mit Grund); neue Gründe `no_state`, `incomplete_core` (fehlt Schutz oder Ankerposition bei `anchorage`/`mooringField`).
- E2, E3, E5, E6 umsetzen.

- [ ] Steps: Tests (vollständiger Stand → gültiger Spot nach `spotSchema`; Stand ohne Schutz → `omitted incomplete_core`; kein Stand → `omitted no_state`; `no_anchoring` → ausgeschlossen geliefert; Sicherheitsfakt markiert; Landfakt mit passendem `nearby`-Namen → `subject.id` gesetzt, ohne → `id: null, name`; `factPublicId` deterministisch und gültig nach `publicId("fc")`; `shop` aus `nearby`), fail, implement, pass, commit `feat(delivery): spots from berth states (N5)`.

### Task 3: Paketbau und Prüfungen

**Files:** `lib/domain/delivery/{build,validate,serialize,archive,types,snapshot,draft,view}.ts`, `map-highlight.ts` und `changes.ts` entfernen bzw. vom Paketbau lösen (die Dateien selbst löscht N6; hier nur nicht mehr aufrufen, wenn das Löschen den Rückbau vorwegnimmt), `lib/domain/delivery/versioning.ts` (Datenversion steigt nur bei Inhaltsänderung, wie bisher, Hash ohne Highlights); Tests.

**Interfaces:** Paket je Landesteil: `manifest.json`, `spots.json`, `regions.json`, `weather-points.json`, `coast.geojson`, Bilder. Prüfungen: Schema, Referenzen (Spot → Region, Fakt-`subject.id` → `nearby` desselben Spots), `spot_duplicates`, `spot_location`, `foreign_content` (verbotene Domains und jede URL in Fakten-, Anlande- und Namenstexten), `verbatim_text` (Fakten-Aussagen und Anlandebeschreibungen gegen die archivierten Dokumente der zugrunde liegenden `berth_facts`, Schwelle wie bisher in `config/delivery.json`). Prüfungen, die nur Highlights oder Changes betrafen, entfallen. Ein Paket einer älteren Vertragsversion gilt nie als „unverändert“.

- [ ] Steps: Tests (Review Focus 1, 5; gültiges Paket; zweiter Bau ohne Änderung → „unverändert“; Fakt-Referenz ins Leere → abgelehnt), fail, implement, pass, commit `feat(delivery): subdivision packages in contract 4.0 (N5)`.

### Task 4: Umkreis und API

**Files:** `lib/domain/delivery/radius/*` (Zusammensetzung ohne `highlights.json`, `RADIUS_BUILD_REVISION` erhöhen, `changes` → E8), `app/api/v3/**` → `app/api/v4/**`, `lib/security/route-policy.ts`, `scripts/delivery-consume.ts` (`/api/v4`), `docs/runbook.md` (Abschnitte Lieferung, Umkreis, Abnehmer-Prüfung auf 4.0); Tests.

- [ ] Steps: Tests (Review Focus 3; Umkreis-Paket aus zwei Landesteilen gültig nach 4.0; `changes` → `invalidSince`; `/api/v3/...` → 404), fail, implement (Next-16-Doku zu Route Handlers lesen), pass, build, commit `feat(api): contract 4.0 under /api/v4, radius packages from 4.0 (N5)`.

### Task 5: Oberfläche

**Files:** `app/(admin)/deliveries/**` (Bericht, Detail, Umkreis-Vorschau ohne Highlights/Changes, mit Zahl der Fakten und Dinge an Land), Reiter „Lieferung“ der Ortsseite (zeigt das 4.0-Objekt aus dem Stand und die Vorschau); Tests; `npm run build`.

- [ ] Steps: Tests, fail, implement, pass, build, commit `feat(admin): deliveries and spot preview in contract 4.0 (N5)`.

### Task 6: Probe

- [ ] Nach dem Recherche-Lauf GR-I (Folgekette fertig): Paket GR-I in dev bauen, Bericht prüfen, `delivery:consume` gegen die lokale API, Umkreis-Vorschau für eine Marina mit 7 Tagen; Stichprobe von 10 Spots (Fakten in eigenen Worten, keine Quelle, Anlandestellen plausibel); `docs/pilot/neuausrichtung/n5-lieferung.md`.

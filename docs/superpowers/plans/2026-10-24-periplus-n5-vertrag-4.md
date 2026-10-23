# Periplus N5 – Liefervertrag 4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den Liefervertrag auf den neuen Stand umstellen: Pakete je Landesteil und je Umkreis enthalten bestätigte Liegeplätze mit Kernwerten, freien Fakten (eigene Worte, ohne Quellen), Anlandestellen, Erreichbarem an Land und Ortsbild – gebaut aus `berth_states`, ohne Change-Feed, ohne Zusammenfassungen, ohne Highlight-Stufen.

**Architecture:** Vertrag 4.0 baut auf der Hülle von 3.0 (Spec 18: `scope`, `coverage`) auf. `contract/v2/` bleibt das Verzeichnis der aktuellen Version (Repo-Konvention), 3.0 wird als `contract/v3_0/` eingefroren. Die Spot-Abbildung liest `berth_states` statt Profile; `highlights.json` wird durch `landside.json` (Dinge an Land) ersetzt, `changes.json` entfällt. Die Umkreis-Zusammensetzung (Spec 18) setzt die neuen Dateien zusammen; die Änderungs-Endpunkte antworten „neu laden“. API `/api/v4` ersetzt `/api/v3` (wie 3.0 `/api/v2` ersetzt hat).

**Tech Stack:** TypeScript, zod 4 (Vertrag, JSON-Schemas), Drizzle/PostGIS, S3-Archiv, Next.js 16 Route Handlers.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (5.9, 7.3), Spec 18 (`…-18-umkreis-lieferung-design.md`), Teil-Spec 08.

## Global Constraints

- **Voraussetzung:** PR #20 (Umkreis-Lieferung, Vertrag 3.0) und die Kette #21–#26 sind auf `main`; Branch `feat/n5-vertrag-4` von `main`.
- Nur `confirmed` Liegeplätze mit `berth_states`-Zeile werden geliefert; fehlt der Stand, wird der Platz ausgelassen (Warnung im Bericht).
- **Nicht im Vertrag:** Quellen, URLs, Domains, Zitate, Versionen, Change-Feed, Zusammenfassungen, `highlightLevels`. Die Prüfung `foreign_content`/`verbatim_text` bleibt und prüft jetzt die Fakten-Aussagen.
- `popularity` bleibt bis zur Entscheidung in Task 2 (Design 7.3); Vorgabe: bleibt, berechnet wie in Spec 18.
- Kernwerte behalten die Feldformen von 3.0, wo 3.0 ein Feld hat (App-Kompatibilität); neu: `facts`, `landingPoints`, `nearby`.
- Vertrag 3.0 bleibt als `contract/v3_0/` reproduzierbar, sein Schema unter `contract/schema/3.0/` abrufbar; Pakete 3.0 werden nicht mehr gebaut.
- Code englisch, Oberfläche deutsch; grün nach jeder Aufgabe (`vitest`, `tsc`, `lint`, `build` bei UI/Routen); vor Routen-Code Next-16-Doku lesen; Commit-Trailer wie bisher.

## Review Focus

- Ein Fakt, dessen Aussage 15 Wörter aus einem archivierten Dokument übernimmt → Paket abgelehnt (`verbatim_text`) (Test Task 3).
- Ein Ding an Land in `nearby`, das nicht in `landside.json` steht → Paket abgelehnt (Referenzprüfung) (Test Task 3).
- Ein Platz wird zwischen zwei Paketen zurückgenommen → fehlt im neuen Paket; Umkreis-Paket mit beiden Versionen nimmt die neuere (Test Task 4).
- Umkreis-Änderungen seit einem 3.0-Paket → Antwort „neu laden“ (`invalid_since`) (Test Task 4).
- Sicherheitsfakt (`safety: true`) erscheint im Paket mit Markierung (Test Task 2).

---

### Task 1: Vertrag 4.0 (Schemas)

**Files:** `contract/v3_0/` (eingefrorene Kopie von `contract/v2/` 3.0), `contract/v2/*` (4.0), `contract/schema/4.0/` (erzeugt), `contract/index.ts`, Tests `contract/__tests__`.

**Interfaces:** `SCHEMA_VERSION = "4.0"`. `spotSchema` 4.0 = 3.0 ohne `summary`, ohne Highlight-Felder (`highlightLevels`, `highlightIds` o. ä.), mit:
- `facts: Array<{ id: publicId("fc"), subject: { kind: "spot" } | { kind: "landside", id: publicId("ls") | null, name: string | null }, text: string (en), observedAt: isoDate | null, tone: "positive"|"negative"|"neutral", safety: boolean, mentions: count }>`
- `landingPoints: Array<{ kind: "harbour"|"pier"|"slipway"|"beach"|"shore", lat, lon } | { kind: "text", description: string }>` (Beschreibung eigene Worte? → nein: Anlandehinweise sind Modell-Beschreibungen aus Task N2; prüfen und wie Fakten behandeln)
- `nearby: Array<{ id: publicId("ls"), distanceM: count, access: "foot"|"transport" }>`
- `landside.json`: `landside: Array<{ id: publicId("ls"), category, name, names?, position: latLon }>`; `highlights.json` entfällt, `changes.json` entfällt aus `CONTRACT_FILES`.
- `manifest`: `profilesAsOf` → `statesAsOf`; `objectCounts` mit `landside` statt `highlights`.

- [ ] Steps: Schema-Tests (Beispielpaket gültig; Spot ohne `facts` ungültig; `nearby`-ID-Präfix), fail, implement + JSON-Schemas erzeugen, pass, commit `feat(contract): contract 4.0 with facts, landing points and things on land (N5)`.

### Task 2: Abbildung aus dem Stand

**Files:** `lib/domain/delivery/map-spot.ts` (neu: `mapSpotFromState`), `lib/domain/delivery/map-landside.ts`, `lib/domain/delivery/load.ts` (Stand laden statt Profil), öffentliche IDs `fc_` (je `berth_facts`-ID stabil, Tabelle oder deterministische Ableitung — Builder entscheidet und dokumentiert, „einmal vergeben, nie wiederverwendet“) und `ls_` (Dinge an Land; bestehende `hl_`-IDs der POIs weiterverwenden, wenn vorhanden?) ; Tests.

**Interfaces:** Kernwerte aus `berth_states.core` in die 3.0-Feldformen (Schutz-Sektoren, Tiefe, Grund, Halt, Liegearten, Services, Gebühren, Belegung/Saison, Verbote, Gefahren, Grenzen, Kontakt, `berthable`); Herkunft `source` aus `origin`; fehlende Pflichtfelder nach Design 6 (Mindestinhalt: Art, Position, Ankerposition, Schutz je Wind) → Platz nicht geliefert, Warnung.

- [ ] Steps: Tests (vollständiger Stand → gültiger Spot; Stand ohne Schutz → ausgelassen; Sicherheitsfakt markiert; Landfakt mit `subjectName` ohne Objekt → `subject.id: null`), fail, implement, pass, commit `feat(delivery): spots from berth states (N5)`.

### Task 3: Paketbau und Prüfungen

**Files:** `lib/domain/delivery/build.ts`, `validate.ts`, `serialize.ts`, `archive.ts`, `types.ts`; Tests.

**Interfaces:** Paket je Landesteil mit `manifest.json`, `spots.json`, `landside.json`, `regions.json`, `weather-points.json`, `coast.geojson`, Bildern. Prüfungen: Schema, Referenzen (`nearby` → `landside`), `spot_duplicates`, `spot_location`, `foreign_content` (verbotene Domains in Texten), `verbatim_text` (Fakten-Aussagen und Anlandebeschreibungen gegen das Archiv, 15 Wörter), Mindestinhalt; Prüfungen, die nur 3.0 betrafen (Highlights, Changes), entfallen.

- [ ] Steps: Tests (Review Focus 1–2; gültiges Paket; Datenversion steigt nur bei Änderung), fail, implement, pass, commit `feat(delivery): subdivision packages in contract 4.0 (N5)`.

### Task 4: Umkreis und API

**Files:** `lib/domain/delivery/radius/*` (Zusammensetzung mit `landside.json`, Änderungen → `invalid_since`), `app/api/v4/**` (ersetzt `app/api/v3/**`), `lib/security/route-policy.ts`, Skript `delivery:consume`; Tests.

- [ ] Steps: Tests (Review Focus 3–4; Umkreis-Paket aus zwei Landesteilen; v3-Pfade antworten 410 oder sind entfernt — Entscheidung im Bericht), fail, implement (Next-16-Doku lesen), pass, build, commit `feat(api): contract 4.0 under /api/v4, radius packages from 4.0 (N5)`.

### Task 5: Oberfläche

**Files:** `app/(admin)/deliveries/**`, Reiter „Lieferung“ der Ortsseite (zeigt das 4.0-Objekt und die Vorschau aus dem Stand); Tests; `npm run build`.

- [ ] Steps: Tests, fail, implement, pass, build, commit `feat(admin): deliveries and spot preview in contract 4.0 (N5)`.

### Task 6: Probe

- [ ] Paket GR-I bauen, Bericht prüfen, `delivery:consume` gegen die Dev-API, Umkreis-Vorschau für eine Marina mit 7 Tagen; `docs/pilot/neuausrichtung/n5-lieferung.md`.

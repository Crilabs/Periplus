# Periplus N3 – Navily-Test als Freigabe-Tor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Bestätigungsregel gegen die Navily-Referenz des Saronischen Golfs prüfen: je Schwelle N = 2…5 Korrektheit und Zahl bestätigter Plätze, Konflikte (bestätigt, aber nicht bei Navily) als Review-Aufgabe für einen Menschen, Fehlliste mit Grund; erst bei 100 % Korrektheit wird die Erfassung freigegeben.

**Architecture:** Ein reines Bewertungsmodul `lib/domain/research/gate.ts` rechnet aus den gespeicherten Belegen (N2) für jede Schwelle die Urteile neu (`decideBerth` mit überschriebenem `minIndependentSources`, ohne DB-Schreiben), gleicht die bestätigten Plätze mit den Navily-Spots ab (`matchPlacesToSpots` aus `lib/domain/quality/navily-assistant.ts`) und ordnet jeden nicht bestätigten Navily-Spot einem Grund zu. Ein CLI `scripts/research-gate.ts` schreibt Kennzahlen ins Repo (`docs/pilot/neuausrichtung/n3-tor.md`, nur Zahlen) und Einzellisten nur lokal. Konflikte werden Review-Aufgaben `research_conflict`; die Entscheidung „kein Liegeplatz“ setzt den Platz auf `rejected` und zählt als Fehler. Die gewählte Schwelle wird in `config/research.json` eingetragen; ein Schalter `gate.released` sperrt Recherche-Läufe außerhalb des Testlandesteils, solange das Tor nicht bestanden ist.

**Tech Stack:** TypeScript, Drizzle + PostgreSQL 17, zod 4, Vitest gegen `db-test`.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (Abschnitt 6 „Freigabe und Mensch im Ablauf“)

## Global Constraints

- Branch `feat/n3-navily-tor` von `feat/n2-extraktion`. Task 0 schließt einen Befund der N2-Gesamtprüfung; er muss vor jedem Tor-Lauf erledigt sein.
- **Navily nie ins Repo:** keine Namen, IDs, URLs, Koordinaten oder Werte aus der Navily-Datei in eingecheckten Dateien, Tests (synthetische Spots) oder Logs; die Datei wird nur zur Laufzeit über `NAVILY_SPOTS_PATH` bzw. `--navily` gelesen (Grundprinzip 9, Modulkommentar in `navily-assistant.ts`). Einzellisten nur unter `--out-dir` außerhalb des Repos (Standard Scratchpad/`/tmp`).
- Navily ist nie Datenquelle: kein Wert aus Navily fließt in Plätze, Fakten oder Status; nur die Entscheidung eines Menschen über einen Konflikt ändert einen Status.
- Schwellen und Abgleichsparameter in `config/research.json` (`gate`) und den bestehenden `config/quality.json` (`navily`); kein Wert im Code.
- Korrekt heißt: ein bestätigter Platz hat einen Navily-Spot passender Art (Abgleich wie `matchPlacesToSpots`), oder ein Mensch hat seinen Konflikt mit „Liegeplatz“ entschieden. Fehler heißt: Navily-Spot der falschen Art bzw. Entscheidung „kein Liegeplatz“. Offener Konflikt = Tor nicht bestanden (noch nicht entschieden).
- Geteilte Dev-/Test-DB: nur `withRollback` in Tests und `npm run db:migrate`.
- Code englisch, Oberfläche und Berichte deutsch.
- Nach jeder Aufgabe grün: `npx vitest run <betroffene Dateien>`, `npx tsc --noEmit`, `npm run lint`.
- Commits enden mit `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- Ein bestätigter Platz liegt 400 m neben einem Navily-Spot passender Art mit anderem Namen → zählt als korrekt nur nach den bestehenden Abgleichsregeln (`nearRadiusM`), sonst Konflikt (Test Task 2).
- Zwei bestätigte Plätze teilen sich einen Navily-Spot → einer korrekt, der andere Konflikt, nicht beide korrekt (Test Task 2).
- Navily-Spot ohne Kandidat in der Nähe → Grund „kein Kandidat“, nicht „zu wenige Quellen“ (Test Task 2).
- Schwelle 5 bestätigt nichts → Korrektheit „n/a“, nicht 100 % (Test Task 2).
- Ein Konflikt, den ein Mensch mit „kein Liegeplatz“ entscheidet, setzt `rejected` und bleibt bei jeder späteren Recherche `rejected` (Test Task 3).

---

### Task 0: Einheiten nur für Seiten, die den Liegeplatz nennen (Rest aus N2)

**Files:** Modify `lib/domain/research/assign.ts` (`unitsForPlaces`), `config/research.json` (Vorlage `Törn {island} Ankerbucht` entfernen; `confirmation.copyMinSharedWords: 12`), `lib/config/schemas.ts` (Vorlage braucht wieder `{name}`; neuer Schlüssel), `lib/domain/research/confirmation.ts` (Abschrift-Erkennung nutzt `copyMinSharedWords` statt `extraction.maxSharedWords`); Tests `lib/domain/research/__tests__/assign.test.ts`, `confirmation.test.ts`, `lib/config/__tests__/research-config.test.ts`

**Interfaces:** `unitsForPlaces` gibt einem gesuchten Platz eine Einheit nur, wenn die aktive Bewertung der Seite einen Liegeplatz nennt, der per `berthNameMatches` zu ihm passt, oder ein Name des Platzes (normalisiert, ganze Wörter wie `unitText`) im Markdown der Version vorkommt; sonst keine Einheit (eine bereits angelegte `pending`-Einheit wird `skipped` mit Grund „Liegeplatz auf der Seite nicht genannt“). Routen-verknüpfte Seiten bleiben wie bisher.

- [ ] Step 1: Tests — Trefferseite von Y, die Y weder in der Bewertung noch im Text nennt → keine Einheit; nennt Y nur im Text → Einheit; Vorlage ohne `{name}` wird vom Schema abgelehnt; zwei Quellen, die 9 gleiche Wörter teilen → 2 Quellen (unter 12), 13 gleiche Wörter → 1 Quelle.
- [ ] Step 2–4: fail, implement, pass
- [ ] Step 5: Commit `fix(research): units only for pages that name the berth; own copy threshold (N3)`

### Task 1: Urteile je Schwelle

**Files:** Create `lib/domain/research/gate.ts`; Modify `lib/domain/research/confirmation.ts` (Belege eines Landesteils in einem Zug laden: `loadEvidenceForPlaces(db, placeIds, cfg)` exportieren, falls noch intern); Test `lib/domain/research/__tests__/gate.test.ts`

**Interfaces:**
- Produces: `verdictsByThreshold(db: Db, subdivisionKey: string, thresholds: number[], cfg: AppConfig): Promise<Map<number, Map<string, Verdict>>>` — Kandidaten des Landesteils (`researchCandidates`), Belege einmal laden, je Schwelle `decideBerth(kind, evidence, { ...cfg.research.confirmation, minIndependentSources: n })`; schreibt nichts. Plätze mit Status `rejected`, `no_anchoring`, `abandoned` oder von einem Admin gesetztem Status werden mit ihrem Status übernommen, nicht neu entschieden (gleiche Regel wie `applyBerthVerdicts`).

- [ ] Step 1: Tests — zwei Domains: bei N=2 bestätigt, bei N=3 nicht; drei Domains: bis N=3 bestätigt; Behördenverbot: bei jeder Schwelle `no_anchoring`; nichts wird in `places` oder `review_decisions` geschrieben.
- [ ] Step 2–4: fail, implement, pass
- [ ] Step 5: Commit `feat(research): verdicts per confirmation threshold without writing (N3)`

### Task 2: Abgleich mit Navily, Fehlliste

**Files:** Create `lib/domain/research/gate-navily.ts`; Modify `config/research.json` (`"gate": { "subdivision": "GR-I", "thresholds": [2, 3, 4, 5], "released": false, "chosenThreshold": null }`), `lib/config/schemas.ts`; Test `lib/domain/research/__tests__/gate-navily.test.ts` (nur synthetische Spots)

**Interfaces:**
- Consumes: `matchPlacesToSpots`, `coverageOfMatches` (`navily-assistant.ts`), `subdivisionTilePredicate` (`navily-compare.ts`), `NavilySpot`.
- Produces:
  - `type GateRow = { threshold: number; confirmed: number; correct: number; wrongKind: number; conflicts: number; decidedNotBerth: number; correctness: number | null }` (`correctness = correct / confirmed`, null bei 0)
  - `type MissReason = "no_candidate" | "unnamed_candidate" | "no_hits" | "too_few_sources" | "negative" | "restricted" | "rejected"`
  - `evaluateGate(input: { places: Array<MatchPlace & { verdicts: Map<number, Verdict>; hasNames: boolean; hasHits: boolean; status: PlaceStatus }>; spots: NavilySpot[]; decisions: Map<string, "berth" | "not_berth"> }, cfg): { rows: GateRow[]; misses: Map<number, Array<{ spotIndex: number; reason: MissReason; placeId: string | null }>>; conflicts: Map<number, string[]> }` (rein; je Schwelle eigener Abgleich nur der bei dieser Schwelle bestätigten Plätze; für Fehlliste wird jeder nicht zugeordnete Spot mit allen Kandidaten abgeglichen, um den nächsten Kandidaten und seinen Grund zu finden).

- [ ] Step 1: Tests für alle fünf Review-Focus-Punkte, die `evaluateGate` betreffen, plus: Spot mit Kandidat ohne Namen → `unnamed_candidate`; Kandidat mit Namen ohne Treffer → `no_hits`; Kandidat mit einer Quelle → `too_few_sources`; Kandidat mit Negativbeleg → `negative`.
- [ ] Step 2–4: fail, implement, pass
- [ ] Step 5: Commit `feat(research): gate evaluation against the reference with a miss list (N3)`

### Task 3: Konflikte als Review-Aufgabe

**Files:** Modify Review-Arten (`lib/domain/review.ts`, `app/(admin)/review/kinds.ts` u. a. nach bestehendem Muster), Migration für eine neue Aufgabenart, falls die Art ein Enum ist; Create `lib/domain/research/gate-conflicts.ts`; Seite der Aufgabe (deutsch): Platz auf Karte und Luftbild-Link wie bei Ortsbild-Prüfung, Belege (Signale mit Zitat und Domain), Knöpfe „Liegeplatz“ / „Kein Liegeplatz“; Test `lib/domain/research/__tests__/gate-conflicts.test.ts`, `app/(admin)/__tests__/review-research-conflict.test.ts`

**Interfaces:**
- Produces: `syncConflictTasks(db: Db, conflictPlaceIds: string[], threshold: number): Promise<{ created: number; open: number }>` (eine offene Aufgabe je Platz, keine Dubletten; Aufgaben nicht mehr konfliktbehafteter Plätze werden mit Grund geschlossen); Entscheidung „Kein Liegeplatz“ → `setPlaceStatusByAdmin(…, "rejected")` mit Grund „Kein Liegeplatz laut Prüfung (Navily-Test)“; „Liegeplatz“ → Entscheidung gespeichert, Status bleibt. `gateDecisions(db, placeIds): Promise<Map<string, "berth" | "not_berth">>`.
- Die Aufgabe nennt Navily nicht mit Werten; sie sagt nur „nicht in der Referenz“.

- [ ] Step 1: Tests: Sync legt je Konflikt genau eine Aufgabe an, zweiter Sync keine; Entscheidung „Kein Liegeplatz“ → `rejected`; danach bestätigt `applyBerthVerdicts` den Platz nicht wieder (Review Focus); UI-Test der Knöpfe.
- [ ] Step 2–4: fail, implement, pass (vor Seitencode Next-16-Doku lesen); `npm run build`
- [ ] Step 5: Commit `feat(research): conflicts with the reference become review tasks (N3)`

### Task 4: CLI, Bericht, Tor-Schalter

**Files:** Create `scripts/research-gate.ts`, `package.json` Skript `research:gate`; Modify `lib/pipeline/research-run.ts` (Start außerhalb `gate.subdivision` nur mit `gate.released = true`, sonst `RunScopeNotReady("research_gate_closed")` mit deutschem Label); Test `scripts/__tests__/research-gate.test.ts`, `lib/pipeline/__tests__/research-run.test.ts`

**Interfaces:**
- `research-gate.ts --subdivision <key> [--navily <path>] [--out-dir <dir>] [--sync-conflicts]`: lädt Spots (nur Laufzeit), rechnet Task 1+2 mit Entscheidungen aus Task 3, schreibt `docs/pilot/neuausrichtung/n3-tor.md` (Tabelle je Schwelle: bestätigt, korrekt, falsche Art, Konflikte offen/entschieden, Korrektheit; Fehlliste nur als Zählung je Grund; Hinweis auf gewählte Schwelle: kleinste mit Korrektheit 100 % ohne offene Konflikte) und nach `--out-dir` die Einzellisten (CSV: Platz-ID, Grund, Abstand – keine Navily-Werte außer Spot-Index); `--sync-conflicts` legt die Konflikt-Aufgaben für die kleinste Schwelle mit Konflikten an. Exit 0 immer; Ausgabe sagt „Tor bestanden bei N=…“ oder „Tor nicht bestanden: …“.

- [ ] Step 1: Tests mit synthetischer Spot-Datei in `os.tmpdir()`: Bericht enthält keine Spot-Namen/Koordinaten (Prüfung per Regex auf die synthetischen Werte); Konflikt-Sync; Tor-Schalter sperrt `GR-J`, erlaubt `GR-I`.
- [ ] Step 2–4: fail, implement, pass
- [ ] Step 5: Commit `feat(research): gate CLI, report and release switch (N3)`

### Task 5: Tor-Lauf (Messung und Entscheidung, kein Code)

- [ ] Step 1: Recherche-Lauf `GR-I` mit diesem Code (inkl. Extraktion, Routen, Entdeckung, Bestätigung); zweiter Lauf, damit entdeckte Seiten extrahiert werden. Messwerte wie N2 Task 8 (Einheiten, Fakten/Signale je Einheit, verworfen nach Grund, Routenstopps, Status-Wechsel, Kosten je Kandidat) in `docs/pilot/neuausrichtung/n3-tor.md` mit aufnehmen.
- [ ] Step 2: `npm run research:gate -- --subdivision GR-I --sync-conflicts --out-dir <scratchpad>`; Bericht committen.
- [ ] Step 3: Konflikte entscheiden (Mensch bzw. Christian), dann erneut auswerten.
- [ ] Step 4: Bei 100 %: `gate.chosenThreshold` und `confirmation.minIndependentSources` setzen, `gate.released = true`, committen. Sonst: Befunde aus der Fehlliste und den Fehlern in `docs/pilot/neuausrichtung/n3-tor.md` festhalten, Regel/Prompts nachschärfen (eigener Plan), Tor bleibt zu.

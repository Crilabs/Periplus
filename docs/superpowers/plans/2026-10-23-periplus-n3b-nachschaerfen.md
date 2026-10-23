# Periplus N3b – Nachschärfen nach dem ersten Tor-Lauf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Befunde des ersten Tor-Laufs (`docs/pilot/neuausrichtung/n3-befunde.md`) beheben, damit der Navily-Test eine belastbare Aussage liefert: Tor nur über bearbeitete Kacheln und mit Mindestzahl, „kein Platz“ nur als dauerhafter Negativbeleg, Marina-Websites als Belegquelle, danach ganzen Landesteil GR-I aufbauen und erneut messen.

**Architecture:** Kleine Änderungen an Tor-Auswertung (`gate-report.ts`, `gate-navily.ts`), Extraktions-Prompt (`extract-berth` v2) und Bestätigungsregel (`confirmation.ts`), Recherche-Treffer aus `place_websites` (`research.search`), dann ein Betriebsschritt (Seed, Geometrie, Recherche, Tor) ohne Code.

**Tech Stack:** wie N3.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (5.3, 5.6, 6)

## Global Constraints

- Branch `feat/n3b-nachschaerfen` von `feat/n3-navily-tor`.
- Sicherheit zuerst bleibt: keine Änderung darf eine Bestätigung ohne zwei unabhängige zählende Quellen bzw. offizielle Seite plus eine Quelle ermöglichen.
- Navily-Regel, geteilte DB-Regeln, Code englisch, Oberfläche deutsch, grün nach jeder Aufgabe, Commit-Trailer wie bisher.
- Werte in `config/research.json`.

## Review Focus

- Kachel ohne Seed-Lauf zählt nicht zur Fehlliste und nicht zu den Spots des Tors (Test Task 1).
- Tor mit 100 % bei weniger als `gate.minConfirmed` bestätigten Plätzen → „nicht bestanden: zu wenige bestätigte Plätze“ (Test Task 1).
- Marina mit Seite „Marina oft voll im August“ → kein Negativbeleg; Bucht mit „Fischzucht hat die Bucht belegt, kein Ankern mehr möglich“ → `no_space` bleibt Negativbeleg (Task 2, Prompt-Test mit MockModel nur für die Regel; Prompt-Wortlaut im Review).
- Marina-Website, die keine Gastplätze nennt → kein `listed_as_berth`, keine Bestätigung allein durch die eigene Website (Test Task 3).

---

### Task 1: Tor nur über bearbeitete Kacheln, Mindestzahl

**Files:** `lib/domain/research/gate-report.ts`, `lib/domain/research/gate-navily.ts` (falls nötig), `config/research.json` (`gate.minConfirmed: 25`), `lib/config/schemas.ts`; Tests `scripts/__tests__/research-gate.test.ts`, `lib/domain/research/__tests__/gate-navily.test.ts`.

**Interfaces:** Bearbeitete Kacheln = Kacheln des Landesteils mit mindestens einem `places`-Eintrag (`places.tile_id`) oder einem abgeschlossenen `seed.tile`-Job (prüfen, was zuverlässiger ist; Entscheidung im Bericht). Spots zählen nur, wenn sie in einer bearbeiteten Kachel liegen (Puffer wie bisher nur für den Abgleich). Bericht nennt „bearbeitete Kacheln: n von m“. `gateOutcome`: bestanden nur, wenn zusätzlich `confirmed ≥ gate.minConfirmed`; sonst „nicht bestanden: zu wenige bestätigte Plätze (n von mindestens 25)“.

- [ ] Steps: Tests (Review Focus 1 und 2), fail, implement, pass, commit `fix(research): gate measures built tiles only and needs a minimum sample (N3b)`.

### Task 2: „Kein Platz“ nur dauerhaft

**Files:** `config/prompts/extract-berth/v2.md` (Kopie von v1 mit geschärfter Definition), `config/models.json` (`extract-berth.promptVersion: 2`), `lib/domain/research/confirmation.ts`, `config/research.json` (`confirmation.harbourIgnoredNegativeKinds: ["no_space"]`), Schema; Tests `confirmation.test.ts`.

**Interfaces:** Prompt v2: `no_space` nur, wenn der Text sagt, dass der Platz dauerhaft nicht mehr zum Liegen genutzt werden kann (zugebaut, Fischzucht, Bojen entfernt und Ankern verboten, nur noch Dauerlieger); „oft voll“, „in der Saison früh kommen“, „wenig Platz“ sind kein Signal (gehören als freier Fakt mit Tendenz negativ in `facts`). `decideBerth`: für `marina`/`port` zählen Negativsignale aus `harbourIgnoredNegativeKinds` nicht. Die Versionserhöhung führt zur Neu-Extraktion aller Einheiten beim nächsten Lauf (gewollt).

- [ ] Steps: Tests (Marina mit `no_space` → nicht gesperrt; Bucht mit `no_space` → gesperrt wie bisher), fail, implement, pass, commit `fix(research): "no space" only as a permanent negative; harbours ignore it (N3b)`.

### Task 3: Marina-Websites als Belegquelle

**Files:** `lib/pipeline/research/search.ts` bzw. `lib/domain/research/hits.ts`, ggf. Migration (wenn `research_hits.serp_query_id`/`serp_result_id` nicht null sein dürfen: nullable machen und `origin` `serp|place_website` ergänzen); `lib/domain/research/assign.ts` (Website-Seiten gelten als Seiten des Platzes, auch ohne Namensnennung, weil sie die offizielle Seite des Platzes sind); Tests.

**Interfaces:** `research.search` legt für jede gebundene Website des Platzes (`place_websites.bound = true`, jüngster Eintrag) einen Treffer `purpose = positive`, `rank = 0`, `origin = place_website` an; Holen, Bewertung und Extraktion laufen wie für Suchtreffer. Die Bestätigungsregel unverändert: eine offizielle Seite allein bestätigt nicht (es braucht eine weitere unabhängige Quelle).

- [ ] Steps: Tests (Website wird Treffer; Website mit Gastplätzen + ein Törnbericht → Marina bestätigt; Website allein → nicht), fail, implement, pass, commit `feat(research): bound marina websites become research pages (N3b)`.

### Task 4: GR-I aufbauen und erneut messen (Betrieb, kein Code)

- [ ] Seed für alle Kacheln von GR-I (`startSeedRun` je Landesteil), Geometrie-Lauf für GR-I (`startGeometryRun`), auf Speicher achten (Befunde B4/B5/B16: bei Abstürzen abbrechen und in `docs/pilot/pruefung/befunde.md` festhalten).
- [ ] Recherche-Lauf GR-I mit diesem Code; zweiter Lauf für entdeckte Seiten.
- [ ] `npm run research:gate -- --subdivision GR-I --sync-conflicts --out-dir <scratchpad>`; Bericht committen; Befunde und Entscheidung in `docs/pilot/neuausrichtung/n3b-tor.md`.

# Periplus – Kernwerte im Navily-Tor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das Navily-Tor prüft neben Lage, Art und „ist ein Liegeplatz“ auch die Kernwerte jedes bestätigten Liegeplatzes gegen Navily (Design 6.1: „Lage, Art, Kernwerte, soweit vorhanden“) und liest dafür nur noch den neuen Stand (`berth_states`, `places`), nicht mehr die alten Profile.

**Architecture:** Das Tor (`lib/domain/research/gate-report.ts`, `gate-navily.ts`) übernimmt die vorhandene Vergleichsmechanik der Qualitätsseite (`comparisonValues` in `lib/domain/quality/comparison-values.ts`, `proposeResults` in `lib/domain/quality/navily-assistant.ts`), füttert sie aber aus `berth_states.core` statt aus Profilen. Abweichungen werden je Attribut gezählt und berichtet; eine sicherheitsrelevante Abweichung (Schutz behauptet, wo Navily offen sagt) ist ein Tor-Fehler und bricht die 100 %. Position und Ankerposition kommen aus `places`.

**Tech Stack:** wie N3/N3b.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (6), Plan N3/N3b (Tor), Spec 10/12 (Navily-Vergleich).

## Global Constraints

- Branch `feat/tor-kernwerte` von `main`.
- Navily-Regel: keine Navily-Namen, IDs, URLs, Koordinaten oder Werte in eingecheckten Dateien, Tests oder Logs; der eingecheckte Bericht enthält nur Zahlen; Tests nur mit synthetischen Spots.
- Schwellen in `config/research.json` (`gate`), nicht im Code.
- Geteilte DBs nie von Hand ändern; Code englisch, Oberfläche deutsch; grün nach jeder Aufgabe; Commit-Trailer wie bisher.

## Entscheidungen

- **K1 (Claude, änderbar):** Tor-Fehler `shelter`, wenn wir einen Sektor mit Wert ≥ `gate.shelterErrorMin` (Start 0,7) als geschützt liefern, Navily für den Spot eine Schutzliste hat und den Sektor nicht nennt. Werte zwischen `quality.navily.protectedThreshold` und `shelterErrorMin` zählen als Abweichung, nicht als Fehler – die berechnete Schutzzahl ist grob, ein klar behaupteter Schutz gegen eine offene Seite ist die gefährliche Lage (Crew erwartet Schutz, liegt offen).
- **K2:** Alle anderen Kernwerte (Grund, Wasser, Bojen, Versorgung) werden je Attribut als Übereinstimmung/Abweichung/„bei Navily nicht vorhanden“ gezählt und berichtet, brechen das Tor aber nicht; sie steuern das Nachschärfen.
- **K3:** `highlight.supply` aus `berth_states.nearby` (zu Fuß erreichbares `supply` oder `bakery`), wie Vertrag 4.0 (`services.shop`).
- **K4:** Fehlt ein eigener Kernwert, wo Navily einen hat, ist das eine Lücke (eigene Zählung), keine Abweichung.

## Review Focus

- Bestätigter Platz mit Schutz N = 0,9, Navily-Schutzliste ohne N → Tor-Fehler `shelter`, Tor nicht bestanden (Test Task 1).
- Schutz N = 0,6 gegen dieselbe Liste → Abweichung gezählt, kein Fehler (Test Task 1).
- Navily ohne Schutzliste → kein Schutzvergleich, kein Fehler (Test Task 1).
- Bestätigter Platz ohne `berth_states`-Zeile → Kernwerte als „kein Stand“ gezählt, kein Absturz (Test Task 1).
- Kein Import von `latestProfiles` mehr im Tor (Test/grep in Task 1).

---

### Task 1: Kernwerte im Tor

**Files:** `lib/domain/research/gate-report.ts` (Positionen aus `places.position`/`places.anchor_position`; Kernwerte aus `berth_states`), `lib/domain/research/gate-navily.ts` (`GateErrorKind` + `"shelter"`; Kernwert-Auswertung je Treffer), `lib/domain/quality/comparison-values.ts` (eine reine Funktion `attributesFromState(core, nearby, cfg)` → `Record<string, unknown>` im Format, das `comparisonValues` liest – ohne die Qualitätsseite umzubauen), `config/research.json` + Schema (`gate.shelterErrorMin: 0.7`), `scripts/research-gate.ts` (Bericht: Tabelle je Attribut mit Übereinstimmung/Abweichung/Lücke/nicht bei Navily, Fehlerart `shelter` mit deutscher Bezeichnung); Tests `lib/domain/research/__tests__/gate-navily.test.ts`, `scripts/__tests__/research-gate.test.ts`.

**Interfaces:**
- `GateMeasurement` + `coreAgreement: Record<ComparisonAttribute, { match: number; deviation: number; gap: number; notAtNavily: number; noState: number }>` (über die bestätigten Plätze mit Navily-Treffer beim gelieferten Schwellwert).
- `GateErrorKind = "wrong_kind" | "position" | "not_berth" | "shelter"`; `gateOutcome` unverändert in der Logik (jeder Fehler bricht das Tor).
- Ausgeschlossen aus dem Kernwert-Vergleich: `existence`, `position` (prüft das Tor schon), `depth` und `highlight.food` (Navily hat sie nicht).

- [ ] Steps: Tests (Review Focus 1–5; Bericht enthält die Tabelle, keine Navily-Werte), fail, implement, pass, `npx tsc --noEmit`, `npm run lint`, commit `feat(research): the gate compares core values against Navily (shelter claims break it)`.

### Task 2: Pläne nachziehen

- [ ] `docs/superpowers/plans/2026-10-24-periplus-n6-rueckbau.md` Task 2: Punkt „Tor (`gate-report.ts`)“ streichen (erledigt hier); übrig bleibt die Qualitätsseite (`navily-compare.ts`, `comparison-values.ts` `loadComparisonSubjects`) auf `berth_states`. Review Focus „Das Navily-Tor misst Kernwerte gegen `berth_states`“ bleibt als Prüfpunkt, mit Verweis auf diesen Plan.
- [ ] `docs/pilot/neuausrichtung/n3-tor.md` bzw. Runbook-Abschnitt zum Tor: neue Fehlerart und Kernwert-Tabelle in zwei Sätzen.
- [ ] commit `docs: gate core values (plan, runbook)`.

### Task 3: Navily-Arten und Mindestabdeckung (Prüfplan Attika 2, T4 Step 0)

Übernommen aus `docs/superpowers/plans/2026-10-25-periplus-testlauf-attika-2.md` (Branch `pruefung/attika-2`), A5 und A9, entschieden von Christian am 25.10.2026.

**Files:** `config/quality.json` (`navily.excludedTypes: ["prohibited", "dry-berthing"]`, `navily.prohibitedTypes: ["prohibited"]`), `config/research.json` (`gate.minCoverage: 0.5`), `lib/config/schemas.ts`, `lib/domain/research/gate-navily.ts`, `lib/domain/research/gate-report.ts`; Tests `lib/domain/research/__tests__/gate-navily.test.ts`, `scripts/__tests__/research-gate.test.ts`.

**Interfaces:**
- `GateErrorKind` + `"prohibited"`: ein bestätigter Platz, der einem Spot mit `type` in `prohibitedTypes` zugeordnet ist, ist ein Fehler (nie „korrekt“).
- Ein Abgleich auf einen Spot mit `type` in `excludedTypes` außerhalb `prohibitedTypes` (z. B. `dry-berthing`) ist ein Konflikt, kein Treffer.
- Spots mit `type` in `excludedTypes` zählen nicht zum Nenner der Abdeckung und erscheinen nicht in der Fehlliste.
- Abdeckung je Schwelle = korrekt zugeordnete Spots / Spots (ohne ausgeschlossene Arten) in bearbeiteten Kacheln; `gateOutcome` „bestanden“ verlangt zusätzlich `coverage ≥ gate.minCoverage`, sonst „nicht bestanden: Abdeckung n % (mindestens 50 %)“; der Bericht nennt die Abdeckung je Schwelle.

- [ ] Steps: Tests (bestätigte Bucht 50 m neben synthetischem `prohibited`-Spot → Fehler `prohibited`, Korrektheit < 100 %; Marina neben `dry-berthing`-Spot → Konflikt; `prohibited`-Spot ohne Platz → nicht in der Fehlliste; 100 % korrekt bei 40 % Abdeckung → nicht bestanden; 100 % korrekt bei 50 % Abdeckung und ≥ 25 bestätigt → bestanden; Spots außerhalb bearbeiteter Kacheln zählen nicht), fail, implement, pass, tsc, lint, commit `feat(research): gate needs a minimum coverage of the reference; prohibited spots are errors`.

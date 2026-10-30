# Übergabe: Pilot P2 „Verortung mehrfach beschriebener Ankerplätze“

Stand 31.10.2026, 00:45. Für eine frische Claude-Code-Session. Vorgänger: `P1-revier-suche.md` (Revier-Suche,
Zahlen nach Korrektur B40), Spec `docs/superpowers/specs/2026-10-28-periplus-pilot-revier-suche-design.md`.

## Auftrag

Entwurf → Plan → Umsetzung eines zweiten Messpilots. Frage: **Lassen sich die Ankerplätze, die mindestens zwei
unabhängige Berichte oder Revierführer beschreiben, zu 80 % sicher verorten?** Arbeitsweise wie bei P1:
`superpowers:brainstorming` nach Christians Regeln (Repo lesen, Entwurf mit markierten Annahmen vorlegen, echte
Entscheidungen gebündelt in **einer** AskUserQuestion-Runde, höchstens vier Fragen, Freigabe vor dem Bauen), dann
`superpowers:writing-plans`, Umsetzung inline (`superpowers:executing-plans`) mit TDD und einem frischen Reviewer am
Ende. Lab-Code nur unter `scripts/lab/region-search/` (gern als Erweiterung der P1-Kommandos), keine Änderung an
`lib/`, `config/`, `package.json`. Kostenobergrenze vorschlagen (Richtwert 20 €), vor jedem Volllauf 10 % messen (B36).

## Zieldefinition (Christian, 31.10.)

- **Nenner:** benannte Plätze in GR-I, die auf ≥ 2 unabhängigen zählenden Seiten (Törnbericht, Revierführer, Forum,
  Marina, Behörde; registrierbare Domain, Kopien verschmolzen) als Liegeplatz genannt sind. Nicht mehr die Spot-Zahl
  der Referenz. P1-Schätzung mit grober Namensnormierung: 281 Namen, davon 93 mit ≥ 2 verorteten Domains, 42 teilweise
  verortet, 146 nie (darunter Fremdreviere ohne Gebietsangabe). Nach Abzug der Fremdreviere realistisch 80–150 echte
  Plätze.
- **Ziel:** 80 % davon „sicher“ verortet. Sicher = mindestens zwei unabhängige **Belegpfade** treffen sich innerhalb
  150 m, und die Geometrie widerspricht nicht (Wasser 3–12 m, Schutzsektoren passen zu „geschützt bei …“). Zwei
  Aufrufe desselben Modells sind kein zweiter Beleg (gleiches Trainingswissen, gleiche Fehlerneigung); zwei
  verschiedene Modelle sind eine Konsistenzprobe.
- **Referenz nur als Positionsprobe:** Für verortete Plätze mit gleichnamigem Referenz-Spot wird gemessen, ob die
  Position ≤ 300 m (und ≤ 150 m) vom Spot liegt. Zahl der Referenz-Spots ist keine Kennzahl mehr. Alle
  Navily-Regeln gelten unverändert (unten).

## Verortungspfade (Reihenfolge nach Ausbeute pro Euro)

1. **Koordinate im Text** (vorhanden: `coords.ts`, 112 Nennungen, Median 125 m zur Referenz).
2. **Name im Gazetteer** (vorhanden: `locate.ts`). Offen: Wortstamm-Abgleich (`stemName` aus PR #47 – prüfen, ob er
   inzwischen in `main` ist und der Zweig ihn nach einem Merge bekäme), englische und deutsche Seglernamen als
   Aliasse aus den Nennungen selbst (B37; „Russian Bay“ ist nach B40 verortet, weil OSM den Namen führt), Dubletten
   im Gazetteer (zwei Buchten gleichen Namens auf einer Insel → mehrdeutig, B42), mehrere Häfen eines Orts (Lavrio).
3. **Kandidaten der Pipeline als Anker:** 1.916 Plätze in den 56 Kacheln (775 in den 34 eigenen Kacheln von GR-I) mit
   Position und Ankerposition; per MCP `sql` lesbar (`places` ⋈ `tiles` ⋈ `subdivisions`, Namen über `geo_names`).
   Das Modell wählt den Kandidaten oder sagt „keiner, neue Position“. Das ist die Zusammenführung von Weg A
   (Gerüst) und Weg B (Revier-Seiten); sie fehlt bisher.
4. **Modell aus Lagehinweisen + Umgebung als Text:** 1.120 Nennungen tragen ein Lagezitat (`positionQuote`), 269
   der 604 unverorteten GR-I-nahen („just west of town“, „on the northeast coast“, „south of the disembarkation quay
   of Ayios Nikolaos“). Eingabe: Hinweise, Seiten-Gebiet, Umgebungsobjekte im Umkreis (Inseln, Kaps, Strände,
   Kapellen, Kais, Kandidaten) mit Peilung, Abstand, Tiefe, Schutz. Ausgabe: Position, verwendete Hinweise als
   Zitate, Konfidenz. Passt zu „kein Fakt ohne Zitat oder Berechnungs-Eingangsdaten“. Kostenrahmen: ~300 Nennungen ×
   2 Aufrufe × ~3 Cent.
5. **Modell mit Kartenbild** (Frage Christians, 31.10.): Kartenausschnitt (OSM-Kacheln, Attribution; oder das offene
   Luftbild des griechischen Katasters) mit den Hinweisen übergeben, das Modell zeigt auf Pixel, wir rechnen
   Web-Mercator-Pixel in Koordinaten um. Vorab mit 20 bekannten Plätzen messen: Pixelgenauigkeit heutiger
   Bildmodelle liegt eher bei Dutzenden Pixeln (bei Zoom 15 ≈ 4 m/Pixel, also 100–200 m), robuster ist ein Bild mit
   nummerierten Markern (Kandidaten, Buchten, Strände), aus denen das Modell wählt, oder ein grober Pixel, der auf
   das nächste Wasser-Kandidatenobjekt gerastet wird. Nur Zählwerte berichten; nie Referenzpunkte ins Bild.

## Ausgangsdaten

- **Pilotverzeichnis (dauerhaft, außerhalb des Repos):**
  `/Users/christian/.claude/projects/-Users-christian-Code-periplus/lab-data/pilot-revier` (45 MB). Für die
  Lab-CLI: `PILOT_DIR=<dieser Pfad>`. Inhalt: `hits.jsonl` (2.856 URLs mit Suchweg), `pages/` + `pages.jsonl`
  (2.553 Seiten als Markdown), `assessments.jsonl`, `extract.jsonl`, `mentions.jsonl` (2.627 Nennungen mit Zitaten,
  Lagezitat, Gebiet), `gazetteer.json` (GR-I + GR-J, Objekte mit Namen, Typ, Mittelpunkt, Insel), `areas.json`,
  `located.json` (Stand nach B40; `located-run1.json`, `located-run2.json` frühere Stände), `metrics.json`,
  `report.md`, `costs.json` (49,65 € von 50 €; neue Obergrenze setzen, sonst wirft `assertRoom`), `lists/` (je Spot
  und je Konflikt; enthält Referenznamen, **nie ins Repo**).
- **Lab-CLI:** `PILOT_DIR=… PILOT_CAP_EUR=… npx tsx --env-file-if-exists=.env.local scripts/lab/region-search/cli.ts
  <status|areas|search|fetch|assess|extract|gazetteer|locate|compare>`; `locate --model` für den Modellpass.
  Tests: `npx vitest run scripts/lab/region-search` (50 Tests). `.env.local` (Symlink auf den Haupt-Checkout) trägt
  `PERIPLUS_MCP_URL`, `PERIPLUS_MCP_TOKEN`, `NAVILY_SPOTS_PATH`, Anthropic- und DataForSEO-Schlüssel; das
  Anthropic-Guthaben des lokalen Schlüssels ist endlich (P1 stand einmal still).
- **Produktion (nur lesen, MCP `sql`):** GR-I = 34 Kacheln, 775 Plätze (698 Ankerplatz-Kandidaten, 10 bestätigt,
  16 Sperrfläche; 35 Marina-Kandidaten, 8 bestätigt; 7 Hafen-Kandidaten). `gate_input` liefert `{version, input}`
  mit `tiles.all` (56-Kachel-Rahmen) und `tiles.worked` (31).

## Harte Regeln (unverändert aus P1)

- Navily-Referenz nie als Eingabe in Suche, Prompts, Verortung, Bilder; nie in Commits, Protokollen, Logs, Tickets,
  MCP-Argumenten; nur Zählwerte und Quoten. `data/navily` ist gitignored und wird in keine Ausgabe gelesen.
- Keine Schreibzugriffe auf Produktion; MCP-Startwerkzeuge nur nach Schätzung ohne `confirm` und Christians Ja.
- Kostenobergrenze vor jedem bezahlten Aufruf (`CostLedger.assertRoom`); Modellaufrufe im Lab-Skript direkt.
- Branch `pruefung/attika-2` (Worktree `.claude/worktrees/attika-2`), PR #48 nach `main` ist offen und nimmt neue
  Commits auf. Push und weitere PRs nur nach Rückfrage. Nie bloßes `git stash` (geteilt zwischen Worktrees).
  Commit-Fußzeile `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Befunde fortlaufend in `docs/pilot/pruefung/befunde.md` (nächste Nummer **B44**); Protokoll
  `docs/pilot/neuausrichtung/attika-2/P2-verortung.md`.

## Offene Befunde, die P2 berühren

B37 (Exonyme, Wortstamm), B38 (Revier-Zuordnung je Nennung; 1.166 Fremdrevier-Nennungen, 216 ohne Gebiet),
B39 (Hafen- und Ortsobjekte sind Polygon-Mittelpunkte), B40 (Inselfilter, behoben), B41 (Hafenregel „offizielle
Seite“), B42 (Dubletten im Gazetteer und unter bestätigten Plätzen), B43 (Google-Weiterleitungs-URLs).

## Entscheidungen, die bei Christian liegen (T8, nicht in P2 vorwegnehmen)

Nenner des Tors (Spot-Zahl, Bucht-Cluster oder mehrfach beschriebene Plätze), eine Lieferstufe „berechnet,
unbestätigt“ unterhalb von „bestätigt“, die Hafenregel B41, eine Lizenzanfrage an ADAC/PiNCAMP für Marina-Daten
(ADAC Skipper: Nutzung nur Seite für Seite, keine Übernahme; für Ankerplätze in Griechenland ohnehin leer).

## Für die Entwurfsrunde (höchstens vier Fragen, mit Empfehlung)

1. Kostenobergrenze P2 (Empfehlung 20 €, Pfad 4 zuerst mit 10 % des Umfangs).
2. Pfad 5 (Kartenbild) mitmessen oder auf eine 20-Plätze-Probe begrenzen (Empfehlung: Probe).
3. Kandidaten aus Produktion (MCP `sql`, nur lesen) als Pfad 3 nutzen (Empfehlung: ja).
4. Modelle für Pfad 4: ein Modell mit zwei Prompts oder zwei Modelle (Empfehlung: Sonnet 5.5 und Opus 5.5, je ein
   Aufruf, Konsistenz als Kennzahl).

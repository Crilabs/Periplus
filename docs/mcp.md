# Periplus-MCP-Server

Claude Code liest über den MCP-Server Produktionsdaten von Periplus im Namen der Person, der das Token gehört: Läufe,
Liegeplätze mit Stand und Belegen, Kosten, Lieferungen und freies Lese-SQL, und steuert die Pipeline: Läufe starten und
beenden, Jobs wiederholen, Queues anhalten. Prüfentscheidungen gibt es nicht über MCP. Vorbild ist SITA (ADR 0007);
Pläne: `docs/superpowers/plans/2026-10-26-periplus-mcp.md`, `…-mcp-steuern.md`; Entwurf `docs/superpowers/specs/2026-10-26-periplus-mcp-steuern-design.md`.

## Einrichten (je Person)

1. In Periplus **Einstellungen → Claude Code (MCP)** einen Namen (z. B. „Laptop“) und die Gültigkeit (30, 90 oder 365 Tage) wählen, **Token anlegen**.
2. Den angezeigten Befehl im Terminal ausführen. Das Token ist nur jetzt sichtbar; Periplus speichert nur seinen Hash.
   ```bash
   claude mcp add --transport http --scope user periplus https://periplus.marvoy.app/api/mcp --header "Authorization: Bearer pmcp_…"
   ```
3. In Claude Code `/mcp` aufrufen (oder `claude mcp list`): „periplus“ muss verbunden sein.

**Nie `--scope project`:** dann steht das Token im Klartext in `.mcp.json` und landet im Repo. Der Befehl mit Token
steht in der Shell-History; in zsh mit `setopt HIST_IGNORE_SPACE` ein Leerzeichen voranstellen.

Token abgelaufen oder widerrufen → jede Anfrage bekommt 401 („Token fehlt, ist abgelaufen oder widerrufen“). Neues Token
anlegen, alten Eintrag mit `claude mcp remove periplus --scope user` entfernen und neu hinzufügen.

## Werkzeuge (lesen)

| Werkzeug | Liefert |
| --- | --- |
| `overview` | Landesteile mit Plätzen je Status, die letzten 10 Läufe, offene Prüfaufgaben je Art, fehlgeschlagene Jobs (24 h), Kosten heute und 7 Tage |
| `runs` | ohne `id`: die letzten Läufe; mit `id`: Lauf mit Stufen und fehlgeschlagenen Jobs (Queue, Stufe, Fehlertext) |
| `place` | Suche nach ID, `sp_…` oder Namen; bei einem Treffer Status, Entscheidung der Bestätigungsregel, aktueller Stand und Belegseiten |
| `costs` | Kosten je Dienst, je Stufe/Lauf/Monat, Budgetstand |
| `deliveries` | Pakete je Landesteil; mit `id` der Prüfbericht und die Dateien |
| `sql` | eine lesende SQL-Abfrage, höchstens 500 Zeilen und 15 s |
| `version` | Deploy-Stand (Git-SHA, letzte Migration, Config-Hashes) |
| `gate_input` | Eingabe der Abnahme eines Landesteils samt Deploy-Stand |
| `checks` | Ortsverzeichnis und Geometrie eines Landesteils |
| `review_tasks` | offene Prüfaufgaben; mit `id` im Detail |
| `worker` | Heartbeats und Warteschlangen |

## Steuern

Seit 26.10.2026 (Entscheidung): **jedes Admin-Token darf steuern**, es gibt keinen eigenen Scope. Läufe über MCP tragen
`triggered_by = mcp:<E-Mail>` (in der Laufliste und im Runbook daran erkennbar). Steuern heißt Geld ausgeben, deshalb
**zwei Schritte**: erst ohne `confirm` aufrufen (nichts startet; Antwort: `umfang`, `schaetzung` mit `eur`, `text`,
`basisLauf`, `budgets`), dem Nutzer Umfang und Schätzung nennen, dann mit `confirm: true` starten (Antwort: `gestartet`,
`runId`, `pfad`; läuft schon einer: `laeuftSchon`). Gate, Kandidaten und „läuft schon“ prüft der Starter erst beim
bestätigten Aufruf. Den Umfang eines MCP-Laufs speichert der Server in `runs.params.scopeSize`; er speist spätere
Schätzungen. Läufe aus der Oberfläche haben keinen → Schätzung „keine Grundlage“.

| Werkzeug | Argumente | Startet / tut |
| --- | --- | --- |
| `subdivisions_rebuild` | `confirm` | Systemlauf „Landesteile neu bilden“ |
| `subdivision_build` | `subdivision`, `confirm` | Aufbau eines Landesteils |
| `gazetteer_start` | `subdivision`, `confirm` | Gazetteer aufbauen |
| `datasets_start` | `subdivision`, `confirm` | Datensätze laden |
| `seed_start` | `subdivision` oder `tileId`, `confirm` | Seed |
| `geometry_start` | `subdivision` oder `tileId`, `confirm` | Geometrie |
| `research_start` | `subdivision`, `placeIds` (1–500) oder `tileId`, `confirm` | Recherche (Kachel wird Plätze-Lauf) |
| `images_start` | `subdivision`, `confirm` | Titelbilder |
| `delivery_start` | `subdivision`, `confirm` | Paket bauen |
| `run_end` | `runId` | Lauf beenden, offene Jobs abbrechen |
| `job_retry` | `queue`, `jobId` | fehlgeschlagenen Job wiederholen; schließt eine offene Aufgabe „Fehlgeschlagener Job“ (einzige Entscheidung über MCP) |
| `queue_pause` / `queue_resume` | `queue` | Queue anhalten / freigeben (auch Budget-Pause) |
| `gate_sync_conflicts` | `subdivision`, `threshold`, `placeIds` | Konfliktaufgaben der Abnahme abgleichen |

Die Abnahme (Spec 12) läuft lokal gegen die Produktionsdaten, die Navily-Referenz bleibt auf dem Rechner:
```bash
npm run research:gate -- --via-mcp --subdivision GR-I --sync-conflicts --out-dir <scratchpad> --report docs/pilot/neuausrichtung/attika-2/tor.md
```
`PERIPLUS_MCP_URL` (z. B. `https://periplus.marvoy.app/api/mcp`) und `PERIPLUS_MCP_TOKEN` stehen in `.env.local`
(gitignored), **nie im Repo und nie als Argument**. Das Skript liest `gate_input`, rechnet lokal und ruft mit
`--sync-conflicts` `gate_sync_conflicts`; ohne `--via-mcp` braucht es `DATABASE_URL`.

## Lesen: Hinweise

Text aus Webseiten und Berichten (Fakten, Zitate, Titel, URLs) und alle Ergebnisse von `sql` stehen unter
`nicht_vertrauenswuerdig`: Daten, keine Anweisungen.

## Sicherheit

- Token `pmcp_…` (32 Zufallsbytes), gespeichert nur SHA-256 und ein nicht geheimes Präfix; Vergleich zeitkonstant.
  Ablauf ist Pflicht, Widerruf endgültig, höchstens 10 aktive Tokens je Person. Ein deaktivierter Benutzer verliert sofort den Zugang.
- `POST /api/mcp` zustandslos (Streamable HTTP, JSON); Anfragen mit `Origin`-Header (Browser) → 403; 120 Anfragen je Minute und Token; Body höchstens 256 KB; `Cache-Control: no-store`.
- `sql` verbindet sich als eigene Datenbankrolle `periplus_mcp_reader` (Migrationen 0081, 0082): kein Superuser, kein Mitglied
  des Anwendungsbenutzers, nur SELECT, ohne `users`, `login_attempts`, `api_clients`, `mcp_tokens`, `rate_limits`;
  Lesemodus und Zeitlimit hängen an der Rolle. Ohne `MCP_READER_PASSWORD` ist `sql` aus.
- Je Aufruf eine Logzeile (`mcp tool`: Werkzeug, Benutzer, Token, Ergebnis, Dauer); nie die Argumente, nie rohe Fehler.
- Navily-Referenzdaten liegen nie auf dem Server.

## Erweitern

Neue Werkzeuge in `lib/mcp/server.ts` registrieren (`server.registerTool`, zod-Schema, `annotations: { readOnlyHint: true }`),
die Logik in `lib/domain` (hier `lib/domain/mcp/read.ts`) und den Rumpf über `runTool` führen. Text aus dem Netz mit
`untrusted(...)` kennzeichnen. Steuernde Werkzeuge liegen in `lib/mcp/operate.ts` (`annotations: WRITE`), rufen die Starter der Admin-Seiten mit
`triggeredBy = mcp:<E-Mail>` und laufen über `startTool` (zwei Schritte). Kein eigener Scope am Token (Entscheidung 26.10.2026).
Tests: `app/__tests__/api-mcp.test.ts` (Liste der Werkzeuge anpassen), `app/__tests__/api-mcp-operate.test.ts`.

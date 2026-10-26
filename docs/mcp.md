# Periplus-MCP-Server

Claude Code liest über den MCP-Server Produktionsdaten von Periplus im Namen der Person, der das Token gehört: Läufe,
Liegeplätze mit Stand und Belegen, Kosten, Lieferungen und freies Lese-SQL. Der Server **schreibt nichts**. Vorbild ist
SITA (ADR 0007); Plan: `docs/superpowers/plans/2026-10-26-periplus-mcp.md`.

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

## Werkzeuge

| Werkzeug | Liefert |
| --- | --- |
| `overview` | Landesteile mit Plätzen je Status, die letzten 10 Läufe, offene Prüfaufgaben je Art, fehlgeschlagene Jobs (24 h), Kosten heute und 7 Tage |
| `runs` | ohne `id`: die letzten Läufe; mit `id`: Lauf mit Stufen und fehlgeschlagenen Jobs (Queue, Stufe, Fehlertext) |
| `place` | Suche nach ID, `sp_…` oder Namen; bei einem Treffer Status, Entscheidung der Bestätigungsregel, aktueller Stand und Belegseiten |
| `costs` | Kosten je Dienst, je Stufe/Lauf/Monat, Budgetstand |
| `deliveries` | Pakete je Landesteil; mit `id` der Prüfbericht und die Dateien |
| `sql` | eine lesende SQL-Abfrage, höchstens 500 Zeilen und 15 s |

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
`untrusted(...)` kennzeichnen. Schreibende Werkzeuge brauchen eine eigene Entscheidung (eigener Scope am Token, Prüfung je Aufruf).
Test: `app/__tests__/api-mcp.test.ts` (Liste der Werkzeuge anpassen).

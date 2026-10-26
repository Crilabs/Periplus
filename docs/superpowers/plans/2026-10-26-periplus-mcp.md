# Periplus – MCP-Server (lesend, je Benutzer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ein MCP-Server in der Periplus-App, über den Claude Code mit dem persönlichen Token eines Admin-Benutzers Produktionsdaten liest und auswertet (Läufe, Orte und Stand, Kosten, Lieferungen, freies Lese-SQL). Grundlage für die Erweiterung in einer anderen Session (Prüfplan Attika 2).

**Architecture:** Wie SITA (`/Users/christian/Code/SITA`, ADR 0007): zustandsloses Streamable HTTP unter `POST /api/mcp` (`WebStandardStreamableHTTPServerTransport`, JSON-Antworten, pro Anfrage neuer Server), persönliche Tokens `pmcp_…` je Benutzer (nur SHA-256 gespeichert, Präfix-Suche, `timingSafeEqual`, Pflicht-Ablauf, Widerruf, höchstens 10 aktive), Verwaltung unter „Einstellungen → Claude Code (MCP)“ mit einmal sichtbarem Token und `claude mcp add`-Befehl. Tools nur lesend; freies SQL läuft in einer `READ ONLY`-Transaktion unter der Rolle `periplus_mcp_reader` (nur SELECT, ohne Benutzer-, Sitzungs- und Schlüsseltabellen) mit Zeit- und Zeilenlimit.

**Tech Stack:** Next.js 16 Route Handler, `@modelcontextprotocol/sdk` 1.32.1, zod 4, Drizzle/Postgres.

**Spec:** Entscheidungen Christian 26.10.2026: Route in der App, freies Lese-SQL über Nur-Lese-Rolle, Zugang per Token mit Scope; Einrichtung je Benutzer wie SITA.

## Global Constraints

- Nur lesend. Kein Tool schreibt in die Datenbank, in S3 oder in Queues. Ausnahme: `mcp_tokens.last_used_at` höchstens einmal je Minute.
- Freitext aus dem Netz (Fakten, Zitate, Seitentitel, URLs) steht in Ausgaben unter `nicht_vertrauenswuerdig` mit Hinweis; die Server-Anweisungen wiederholen die Regel.
- Navily-Daten liegen nie auf dem Server; kein Tool liest eine Navily-Datei.
- Werkzeug-Argumente und rohe Fehler werden nie geloggt oder an den Client gegeben; je Aufruf eine Logzeile (Tool, Benutzer, Token, Ergebnis, Dauer).
- Ursprung-Header (Browser) → 403; Body höchstens 256 KB; `Cache-Control: no-store`; 120 Anfragen je Minute und Token (Postgres-Token-Bucket `takeToken`).
- Alle 401 mit gleichem Text; ein deaktivierter Benutzer verliert sofort den Zugang.
- Code englisch, Oberfläche deutsch; vor Routen-Code Next-16-Doku lesen.

## Tasks

1. **Tokens:** Tabelle `mcp_tokens` (Migration 0081), `lib/domain/mcp-tokens.ts` (erzeugen mit Zeilensperre und Obergrenze, auflisten und widerrufen nur eigene, auflösen), Tests.
2. **Nur-Lese-Rolle:** in Migration 0081 `periplus_mcp_reader` (NOLOGIN, SELECT auf alle Tabellen außer `users`, `login_attempts`, `api_clients`, `mcp_tokens`, `rate_limit_buckets`; Default-Privileges für neue Tabellen), Mitgliedschaft des Anwendungsbenutzers; Tests (SELECT auf `users` verweigert, Schreiben verweigert).
3. **Route und Server:** `app/api/mcp/route.ts`, `lib/mcp/{handler,auth,server,result}.ts`, Routen-Politik `kind: "mcp"`; Tests (initialize, 401-Varianten, Origin 403, GET 405, Ratenlimit).
4. **Tools:** `overview`, `runs` (Liste/Detail mit Stufen und Fehlern), `place` (Status, Stand, Belege, Bilder), `costs`, `deliveries`, `sql`; je Tool ein Test.
5. **Oberfläche und Doku:** Abschnitt „Claude Code (MCP)“ in `/settings` (anlegen mit Name und Gültigkeit, einmalige Anzeige mit Befehl, Liste mit Widerruf), `docs/mcp.md`, Runbook-Abschnitt.

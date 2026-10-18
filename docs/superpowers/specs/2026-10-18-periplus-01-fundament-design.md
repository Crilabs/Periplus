# Periplus 01 – Fundament und Betrieb

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilensteine: M0, Ausbau in M8 · Quell-Spec: Abschnitte „Service-Betrieb“, „Technologie und externe Dienste“

## Zweck

Alles, worauf die Pipeline-Stufen aufsetzen: lauffähiges Repo, Datenbank mit Erweiterungen, Worker mit Queue, Archiv, Anmeldung, Kostenerfassung, Modell-Schnittstelle, Deploy und Backup. Nach M0 kann jede Stufe als Job-Handler hinzugefügt werden, ohne die Infrastruktur anzufassen.

## Umfang M0

1. Repo-Grundlage auf dem vorhandenen Next-16-Gerüst: ESLint mit `--max-warnings 0` und `no-console`, TypeScript strict, Vitest, `CLAUDE.md`, `README.md`, `.env.example`.
2. Docker Compose für Entwicklung (`docker/compose.dev.yml`: `db`, `db-test`, `s3` mit SeaweedFS; vorhanden) und Produktion (`docker/compose.prod.yml`: caddy, web, worker, postgres). Das Archiv liegt in Produktion in Hetzner Object Storage (verwaltet, S3-kompatibel), nicht auf dem Server.
3. Postgres-Image `docker/postgres/Dockerfile` (vorhanden): `FROM postgres:17-bookworm` plus `postgresql-17-postgis-3` (PostGIS 3.6 inkl. Raster und `raster2pgsql`) und `postgresql-17-pgvector`; `postgis/postgis` hat keine arm64-Images. Init-SQL legt `postgis`, `postgis_raster`, `vector`, `pg_trgm`, `unaccent` an.
4. Drizzle: Client in `lib/db/client.ts` (ein Pool je Prozess, lazy), Schema in `lib/db/schema/`, Migrationen in `drizzle/` mit drizzle-kit; Migrationen laufen im Deploy als einmaliger Container vor dem Neustart von web und worker. Migrationen sind vorwärts gerichtet.
5. Worker `worker/index.ts`: startet pg-boss, registriert Handler je Queue aus `lib/pipeline/*`, fährt bei SIGTERM sauber herunter. M0 liefert eine Queue `system.ping` als Nachweis.
6. Läufe und Kosten: Tabellen `runs`, `external_calls` (Teil-Spec 02) und `lib/pipeline/runs.ts`.
7. Archiv: `lib/adapters/s3.ts` mit `putObject`, `getObject`, `exists`; `ensureBucket()` legt den Bucket `periplus-archive` beim ersten Zugriff an; Versionierung im Bucket aus (die Zeitachse liegt in den Schlüsseln, siehe 05).
8. Modell-Adapter `lib/ai/` (siehe unten), in M0 nur mit `MockModel` und einem echten Aufruf im Smoke-Test.
9. Anmeldung und Proxy (siehe unten).
10. Health: `/healthz` (Prozess lebt), `/readyz` (Datenbank und S3 antworten). Der Worker schreibt alle 30 s einen Herzschlag in `worker_heartbeats`; die Job-Übersicht zeigt ihn.
11. CI/CD und Server (siehe unten).
12. Admin-Shell mit Navigation und leerer Karte (Teil-Spec 09).

## Anmeldung und Zugriff

- **Admins:** Tabelle `users` (id, email, password_hash argon2id, created_at, last_login_at, disabled_at). Anlage und Passwortwechsel nur über `npm run user:create` / `user:password` (CLI, auch per `docker compose exec web`). Kein Self-Service, keine E-Mail.
- **Sitzung:** JWT (jose, HS256, Schlüssel `SESSION_SECRET`) im httpOnly-, Secure-, SameSite=Lax-Cookie, Laufzeit 12 h gleitend, absolut 7 Tage. Login-Versuche je IP und E-Mail begrenzt (10 je 15 min).
- **API-Clients:** Tabelle `api_clients` (id, name, key_hash SHA-256, scopes[], rate_limit_per_min, omit_quotes bool, created_at, revoked_at). Schlüssel `pk_<32 Byte base62>` wird einmal angezeigt (`npm run apikey:create`). Vergleich konstantzeitig. Scopes: `delivery:read`, `reports:write`, später `partner`.
- **`proxy.ts` mit Default-Deny:** eine Funktion `decideAccess(path, method, credentials)` in `lib/security/access.ts`. Öffentlich: `/healthz`, `/readyz`, `/login`, statische Assets. `/api/v1/*` nur mit gültigem API-Schlüssel und passendem Scope (sonst 401/403, ohne Details). Alles andere nur mit Admin-Sitzung (sonst Redirect auf `/login`). Eine Routen-Tabelle `lib/security/route-policy.ts` listet jede Route mit Art (`public`, `admin`, `api:<scope>`); ein Test liest `app/` und schlägt fehl, wenn eine Route fehlt. (Muster aus Contexta, bewusst übernommen.)
- Server Actions prüfen die Sitzung zusätzlich selbst (`requireAdmin()`).

## Queue und Jobs

- pg-boss im Schema `pgboss`. Eine Queue je Stufe und Job-Art: `gazetteer.build`, `seed.tile`, `geometry.place`, `discovery.area`, `discovery.tile`, `fetch.source`, `fetch.url`, `mentions.batch`, `mentions.disambiguate`, `extraction.mention`, `consolidation.geo`, `delivery.build`, `system.ping`. Die Liste wächst mit den Teil-Specs.
- **Job-Payload** immer mit `runId` (wenn Teil eines Laufs) und fachlichem Schlüssel; `singletonKey` = fachlicher Schlüssel, damit doppelt angelegte Jobs nicht doppelt laufen.
- **Wiederholung:** 3 Versuche, Backoff exponentiell ab 60 s. Danach `failed` und eine Review-Aufgabe `failed_job` (Teil-Spec 09). Ein fehlgeschlagener Job blockiert keinen anderen.
- **Nebenläufigkeit** je Queue in `config/queues.json` (z. B. `fetch.url`: 8, aber je Domain über Rate-Limit begrenzt; `extraction.mention`: über Batch, siehe unten).
- **Rate-Limits je externer Domain/Dienst:** Token-Bucket in Postgres (`rate_limits`-Tabelle mit `SELECT … FOR UPDATE`), damit mehrere Worker-Container sich teilen.
- **Budgets:** `config/budgets.json` je Dienst (`anthropic`, `voyage`, `dataforseo`, `firecrawl`, `jina`) Tagesbudget in EUR. Vor jedem Aufruf prüft der Adapter die Tagessumme aus `external_calls`; bei ≥ 100 % wirft er `BudgetExceeded`, der Worker stoppt die betroffene Queue (pg-boss `offWork`) bis Mitternacht UTC oder bis ein Admin sie in der UI freigibt. Bei ≥ 80 % entsteht ein Alarm (M8; in M0 nur Anzeige).
- **Scheduler:** in M0 bis M7 gibt es nur manuelle Auslöser aus der UI („Lauf starten“ je Kachel/Block, „Stufe neu ausführen“). Der automatische Scheduler (M8) läuft im Worker über pg-boss `schedule` (Cron) und plant Läufe nach Quell-Spec „Zeitachse und Wiederholung“.

## Läufe

Ein `Run` ist ein Durchlauf einer oder mehrerer Stufen für einen Umfang (Kachel, Kachelblock, Revier, Ort, Quelle). Felder: Art (`full`, `stage`, `revisit`, `event`, `reprocess`), Umfang, Stufen, Auslöser (Admin-ID oder `scheduler`), Status, Start/Ende, Kostensumme (aus `external_calls`), Ergebniszahlen je Stufe (JSON). Stufen innerhalb eines Laufs laufen in Reihenfolge: ein Lauf legt die Jobs der nächsten Stufe erst an, wenn alle Jobs der vorigen fertig oder endgültig fehlgeschlagen sind (`lib/pipeline/runs.ts`, Fortschritt per Zähler in `run_stages`).

## Modell-Schnittstelle (`lib/ai/`)

- `ModelClient` mit zwei Wegen: `call(task, input)` synchron und `submitBatch(task, inputs)` / `collectBatch(batchId)` über die Message Batches API. Batch-Ergebnisse holt ein wiederkehrender Job `ai.batch.poll` ab und verteilt sie an die Handler.
- **Task-Definition** in `config/prompts/<task>/v<N>.md` (Systemprompt mit Platzhaltern) plus `lib/ai/tasks/<task>.ts` (zod-Schema der Ausgabe, Modell-Schlüssel aus `config/models.json`). Aktive Version je Task in `config/models.json`.
- Jede Antwort wird gegen das zod-Schema geprüft; ungültig = Fehler (zählt als Versuch).
- Jeder Aufruf schreibt `external_calls` (Tokens ein/aus, Cache, Kosten) und gibt `{ model, promptVersion, schemaVersion }` zurück, die der Aufrufer am Ergebnis speichert.
- Modell-IDs aus `config/models.json`, Startwerte: Disambiguierung `claude-haiku-5-5`, Extraktion im Vergleich `claude-sonnet-5-5` und `claude-opus-5-5`, Freitext (Summaries) `claude-sonnet-5-5`. Preise je Modell ebenfalls dort (vor Projektstart aktuell prüfen, Quell-Spec).
- Tests nutzen `MockModel` mit aufgezeichneten Antworten; kein Test ruft die API.

## Logging

pino, JSON in Produktion, `pino-pretty` lokal. `createLogger(module)`; jede Zeile eines Jobs trägt `jobId`, `runId`, `queue`; jede Zeile einer Anfrage `traceId`. Nie geloggt: Passwörter, Schlüssel, Cookies, ganze Dokumentinhalte. Fehlerdienst wird nicht eingebunden; Fehler sind über Job-Status und Logs sichtbar (`docker compose logs`). Ab M8 Alarme (siehe unten).

## Server und Deploy

- **Server:** Hetzner Cloud, Ubuntu 24.04, Docker Engine + Compose-Plugin, Firewall nur 22/80/443, SSH nur mit Schlüssel, unattended-upgrades. Einrichtung als Skript `scripts/server/bootstrap.sh` und Schritte im `docs/runbook.md`.
- **Compose prod:** `caddy` (TLS automatisch, Reverse Proxy auf `web:3000`), `web` und `worker` aus GHCR-Images mit Tag = Git-SHA, `postgres` mit Volume. Archiv in Hetzner Object Storage (Bucket in derselben Region wie der Server). `.env` auf dem Server (chmod 600), nie im Repo.
- **Worker-Image** basiert auf dem Playwright-Image (Chromium für den JS-Fallback-Crawler), Web-Image auf `node:22-slim` mit Next `output: "standalone"`.
- **CI (GitHub Actions):** bei jedem PR und Push: lint, typecheck, Vitest mit Service-Container aus dem eigenen Postgres-Image, Build. Bei Push auf `main`: Images bauen und nach GHCR, danach Deploy per SSH: `docker compose pull`, `docker compose run --rm migrate`, `docker compose up -d`, Prüfung `/readyz`; schlägt sie fehl, zurück auf das vorige Image-Tag (Tag steht in `.deployed-tag`).
- **Backups:** täglich `pg_dump -Fc` und `restic` in eine Hetzner Storage Box (7 täglich, 4 wöchentlich, 12 monatlich); das Archiv-Bucket wird täglich per `rclone sync` (nur hinzufügen, nie löschen) in die Storage Box gespiegelt (Quell-Spec: „Archiv wird gespiegelt“). Ein Wiederherstellungstest gehört zur Abnahme von M0 und steht im Runbook.

## Monitoring (M8)

Dashboard-Kennzahlen siehe Teil-Spec 09. Alarme per E-Mail (SMTP aus `.env`) oder Pushover/ntfy (Entscheidung beim Bau von M8): Fehlerrate einer Queue > 10 % über 1 h, Budget > 80 %, Worker-Herzschlag älter als 5 min, `/readyz` rot (externer Uptime-Check, z. B. Hetzner-eigener oder Uptime Kuma auf dem Server).

## Konfiguration

`config/` ist versioniert und wird beim Start mit zod validiert (`lib/config/`); ein ungültiger Wert verhindert den Start. Dateien aus dieser Teil-Spec: `queues.json`, `budgets.json`, `models.json`, `prompts/`. Geheimnisse ausschließlich in `.env`: `DATABASE_URL`, `SESSION_SECRET`, `S3_*`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `CONTACT_EMAIL` (User-Agent).

## Tests und Abnahme

- Tests laufen gegen `postgres-test` (Datenbank-Name muss auf `_test` enden, sonst bricht das Setup ab); globales Setup migriert. Jeder Test arbeitet mit eigenen IDs statt Tabellen zu leeren.
- Abnahme M0: siehe Gesamtdesign, Tabelle Roadmap.

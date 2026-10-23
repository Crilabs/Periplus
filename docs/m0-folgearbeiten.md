# M0 – Folgearbeiten

Offene Punkte aus dem Abschluss-Review von M0 (Branch `feat/m0-fundament`). Sie sind bewusst nicht in M0 umgesetzt.
Die Spalte „Fällig“ sagt, was vorher erledigt sein muss:

- **vor M1**: bevor bezahlte, mehrstufige Pipelines (KI, externe APIs) laufen
- **vor Compose-Änderung**: bevor `docker/compose.prod.yml` oder `docker/Caddyfile` nach dem Bootstrap zum ersten Mal geändert werden

## 1. Stufenwechsel-Fehler wird dem letzten Job angelastet (vor M1) – erledigt

**Erledigt in M1:** Task 1 (`ab77395`, `6cf217e`, `337f9e9`, Nacharbeit `59a5df6`): Stufenwechsel als eigener Job `run.advance`.

**Wo:** `lib/jobs/worker.ts` – `settle()` (Z. 52–56) wird in `runJob()` (Z. 82) in derselben Transaktion wie das Job-Ergebnis aufgerufen; `settle()` ruft `recordJobOutcome()` (`lib/domain/runs.ts` Z. 100–124) und `enqueueStage()` auf.

**Problem:** Scheitert der Übergang zur nächsten Stufe (z. B. Planung der Folgestufe wirft), rollt die Transaktion zurück, der *letzte Job der Stufe* gilt als fehlgeschlagen und wird erneut ausgeführt – bei bezahlten Stufen doppelte Kosten, nach drei Versuchen ein falscher `failed_job`.

**Vorschlag:** Ergebnis erfassen und Lauf fortschalten trennen. Der Job schreibt nur sein Ergebnis; der Stufenwechsel läuft als eigener Job `run.advance` (singletonKey `runId:stage`), oder er wird im `catch` behandelt: Lauf auf `failed` setzen und einen Review-Task anlegen, statt den Job scheitern zu lassen.

## 2. Job-Ergebnis nicht idempotent je Job (vor M1) – erledigt

**Erledigt in M1:** Task 1 (`ab77395`): Tabelle `job_outcomes`, Zähler nur beim tatsächlichen Insert.

**Wo:** `lib/domain/runs.ts` `recordJobOutcome()` (Z. 107–111) erhöht `done`/`failed` ohne Bezug auf den Job.

**Problem:** Wird derselbe Job zweimal abgeschlossen (z. B. Wiederholung nach Timeout, nachdem die Transaktion schon committet war), zählt er doppelt; die Stufe kann zu früh als fertig gelten.

**Vorschlag:** Tabelle `job_outcomes(run_id, stage, key, outcome)` mit Unique-Index auf `(run_id, stage, key)`; `insert … on conflict do nothing returning`, den Zähler nur bei tatsächlichem Insert erhöhen.

## 3. Compose-Datei und Caddyfile auf dem Server werden nie aktualisiert (vor Compose-Änderung)

**Wo:** `scripts/deploy/deploy.sh` (Z. 12 nutzt die vorhandene `docker/compose.prod.yml` auf dem Server), `scripts/server/bootstrap.sh` (kopiert die Dateien einmalig), `.github/workflows/ci.yml` (Deploy-Job).

**Problem:** Änderungen an `docker/compose.prod.yml` (z. B. das neue `stop_grace_period: 60s`) oder `docker/Caddyfile` kommen nach dem Bootstrap nie auf dem Server an.

**Seit dem geteilten Server:** `docker/Caddyfile` ist ein Site-Block im Caddy des Servers (`/etc/caddy/periplus.caddy`, gehört root). Der Benutzer `periplus` kann ihn nicht ändern; er bleibt manuell (Runbook 5b). Der Vorschlag betrifft nur noch `compose.prod.yml`.

**Vorschlag:** Der Deploy-Job kopiert `docker/compose.prod.yml` und `docker/Caddyfile` pro Commit (z. B. nach `releases/<sha>/`), verlinkt sie als aktuelle Version und behält die vorherige für den Rollback; `deploy.sh` nutzt bei Rollback die Dateien des Ziel-Commits.

## 4. Kein Weg zum Sperren von Zugängen (vor M1) – erledigt

**Erledigt in M1:** Task 2 (`ea51a92`): `user:disable`, `apikey:revoke`, Prüfung in `requireAdmin()`, Runbook-Abschnitte.

**Wo:** `scripts/user.ts`, `scripts/apikey.ts`, `lib/security/require-admin.ts` (`requireAdmin()` Z. 7), `docs/runbook.md`.

**Problem:** Ein Benutzer oder API-Schlüssel lässt sich nicht deaktivieren; laufende Sessions bleiben bis zu 7 Tage gültig.

**Vorschlag:** CLI `user:disable` und `apikey:revoke`; Spalte `disabled_at` an Benutzern, Prüfung in `requireAdmin()` (eine DB-Abfrage je Request) und in der API-Schlüssel-Prüfung; Runbook-Abschnitt „SESSION_SECRET rotieren“ (meldet alle Sessions ab).

## 5. Lücken gegenüber Spec 09 (Admin-Oberfläche) (vor M1) – erledigt

**Erledigt in M1:** Task 3 (`f4c2f4c`): Polling, Kostenaufschlüsselung, fehlgeschlagene Jobs mit „Erneut“; Task 19 (`08e57c6`, `8ab1cdc`): Prüfliste `failed_job` in der Review-Queue.

- **Fehlgeschlagene Jobs auf der Laufseite** (`app/(admin)/runs/[id]/page.tsx`): Liste der fehlgeschlagenen Jobs mit Fehlertext und Schaltfläche „Erneut“ (pg-boss `retry`).
- **Polling alle 5 s** auf Übersicht, Läufe und Jobs (`app/(admin)/page.tsx`, `app/(admin)/runs/**`, `app/(admin)/jobs/page.tsx`), z. B. per Client-Komponente mit `router.refresh()`.
- **Kostenaufschlüsselung** nach Stufe, Lauf und Monat (`app/(admin)/costs/page.tsx`, `lib/domain/costs.ts`).
- **Prüfliste `failed_job`**: Liste der offenen `failed_job`-Review-Tasks mit Kontext (Queue, Key, Fehler) und Erledigen-Aktion.

## 6. Kleinere Punkte

| Punkt | Wo | Vorschlag | Fällig |
| --- | --- | --- | --- |
| Übersicht bei frischer Installation ohne `pgboss`-Schema | `lib/domain/queues-view.ts` `jobsFromDb()`, `lib/domain/overview.ts` | Fehlt das Schema (`to_regclass('pgboss.job') is null`), Nullen liefern statt Fehler | vor M1 – erledigt (Task 3, `f4c2f4c`) |
| Images nur für amd64 | `.github/workflows/ci.yml` (build-push-action ohne `platforms`) | Server muss x86 sein (Hetzner CX/CPX/CCX, kein CAX); im Runbook festhalten oder `platforms: linux/amd64,linux/arm64` | vor Server-Wechsel |
| Postgres-Image hängt am App-Tag | `docker/compose.prod.yml` (`periplus-postgres:${IMAGE_TAG}`), `.github/workflows/ci.yml` Z. 84–92 | Eigener `POSTGRES_TAG`, damit ein App-Deploy die DB nicht neu startet | vor Compose-Änderung |
| Budget-Aufschub setzt `retryCount` zurück | `lib/jobs/worker.ts` `deferForBudget()` (Z. 58–66) | Versuchszähler im Job-Datensatz mitführen (`attempt`) und bei der Wiederaufnahme berücksichtigen | vor M1 – erledigt (Task 1, `ab77395`) |
| Kein `error`-Listener am Pool | `lib/db/client.ts` Z. 11 | `pool.on("error", …)` mit Log, sonst beendet ein abgebrochener Idle-Client den Prozess | vor M1 – erledigt (Task 2, `ea51a92`) |
| Keine Maximallänge für Passwörter | `lib/security/password.ts` Z. 10 | Obergrenze (z. B. 1024 Zeichen) gegen teure Argon2-Läufe mit Riesen-Eingaben | vor M1 – erledigt (Task 2, `ea51a92`) |
| `createLogger` auf Modulebene | `lib/ai/anthropic.ts` Z. 11 | Logger erst beim ersten Aufruf erzeugen, damit der Import keine Env liest | vor M1 – erledigt (Task 2, `ea51a92`) |


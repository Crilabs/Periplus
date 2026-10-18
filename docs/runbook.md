# Periplus Runbook

Betrieb des Produktivsystems (Hetzner-Server, Docker Compose, Caddy). Alle Pfade auf dem Server liegen unter `/opt/periplus`.

Auf dem Server vor manuellen Compose-Befehlen immer:

```bash
cd /opt/periplus
export IMAGE_TAG=$(cat .deployed-tag)
alias dc='docker compose --env-file .env -f docker/compose.prod.yml'
```

## Einrichtung (einmalig, manuell)

### 1. Server (Mensch)
1. Hetzner-Cloud-Server mit Ubuntu 24.04 anlegen, eigenen SSH-Key hinterlegen.
2. SSH-Schlüsselpaar für den Deploy-Benutzer erzeugen: `ssh-keygen -t ed25519 -f deploy_key -N ""` (privater Schlüssel wird GitHub-Secret `DEPLOY_SSH_KEY`).
3. Repo (oder nur `docker/` und `scripts/`) auf den Server kopieren, z. B. `scp -r docker scripts deploy_key.pub root@<host>:/root/periplus-src/`, dann:
   `sudo bash /root/periplus-src/scripts/server/bootstrap.sh /root/periplus-src/deploy_key.pub`
4. Bootstrap installiert Docker, legt Benutzer `deploy` an, öffnet ufw (22/80/443), schaltet SSH-Passwort-Login ab (Drop-in `/etc/ssh/sshd_config.d/00-periplus.conf`, vor `50-cloud-init.conf` gelesen; der Bootstrap bricht ab, wenn `sshd -T` nicht `passwordauthentication no` meldet), aktiviert unattended-upgrades, legt `/opt/periplus` mit `compose.prod.yml`, `Caddyfile` und einer `.env`-Vorlage (chmod 600) an und richtet den Backup-Cron (02:30 UTC) ein.
5. `known_hosts`-Eintrag für das Secret ermitteln: `ssh-keyscan -t ed25519 <host>`.

### 2. Hetzner Object Storage (Mensch)
- Bucket `periplus-archive` in der Hetzner-Console anlegen und S3-Zugangsschlüssel erzeugen (Schlüssel brauchen Zugriff auf den Bucket).
- Der Worker ruft beim Start `ensureBucket()` auf (idempotent). Haben die Schlüssel kein Recht zum Anlegen, muss der Bucket vorher existieren.
- Endpoint, Region und Schlüssel in `/opt/periplus/.env` eintragen (`S3_*`).

### 3. Storage Box (Mensch)
- Storage Box bestellen, SSH-Zugang aktivieren (Port 23). Eigenen Schlüssel für Backups erzeugen und in der Box hinterlegen; privaten Schlüssel als `/home/deploy/.ssh/id_storagebox` (chmod 600) auf den Server legen.
- Als `deploy` einmal verbinden, damit der Host-Key bekannt ist: `ssh -p 23 -i ~/.ssh/id_storagebox <user>@<host>`. restic und rclone prüfen den Host-Key gegen `/home/deploy/.ssh/known_hosts`; ohne diesen Eintrag schlägt das Backup fehl.
- `~/.ssh/config` von `deploy`: `Host <storagebox-host>` mit `Port 23` und `IdentityFile ~/.ssh/id_storagebox`, damit restic über sftp verbindet.
- In `.env` setzen: `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` (sicher aufbewahren, ohne ihn sind Backups unbrauchbar), `STORAGEBOX_HOST`, `STORAGEBOX_USER`. Repository einmalig initialisieren: `set -a; . ./.env; set +a; restic init`.

### 4. DNS (Mensch)
A-Record (und AAAA falls vorhanden) der Domain auf die Server-IP. `PERIPLUS_DOMAIN` in `.env` setzen. Caddy holt das Zertifikat automatisch.

### 5. GitHub-Secrets (Mensch)
Im Repo `Crilabs/Periplus` unter Settings, Secrets and variables, Actions:
- `DEPLOY_HOST`: Hostname oder IP des Servers
- `DEPLOY_SSH_KEY`: privater Schlüssel von `deploy_key`
- `DEPLOY_KNOWN_HOSTS`: Ausgabe von `ssh-keyscan`

Die Images liegen in `ghcr.io/crilabs/periplus-{web,worker,postgres}`. Der Deploy-Job pusht sie mit dem Workflow-Token, meldet den Server damit aber **nicht** an (das Token darf schreiben und verfällt nach dem Job).

### 5a. Registry-Login auf dem Server (Mensch, einmalig)
Der Server zieht die Images mit einem eigenen, dauerhaften Nur-Lese-Zugang:
1. Auf GitHub ein Token anlegen, das nur Pakete lesen darf: Classic PAT mit ausschließlich `read:packages` (oder fine-grained Token mit Packages: Read für die Organisation `crilabs`). Ablaufdatum setzen und im Kalender vormerken.
2. Auf dem Server als `deploy` (nicht als root, sonst landet der Login in `/root/.docker`) einmalig anmelden:
   ```bash
   sudo -iu deploy
   read -rs TOKEN   # Token einfügen, Enter
   echo "$TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
   unset TOKEN
   ```
   Der Login liegt danach in `/home/deploy/.docker/config.json` und gilt für automatische Deploys, manuelle Rollbacks und `restore-check.sh`.
3. Läuft das Token ab, schlagen Deploys beim `pull` fehl (automatischer Rollback, Exit 1). Dann neues Token anlegen und Schritt 2 wiederholen.

### 6. `.env` ausfüllen
Alle Werte in `/opt/periplus/.env` setzen. `SESSION_SECRET`: `openssl rand -base64 48`. `POSTGRES_PASSWORD` und das Passwort in `DATABASE_URL` müssen übereinstimmen. Werte ohne Anführungszeichen schreiben.

## Erstes Deployment
Auf `main` mergen: der Job `deploy` baut und pusht die drei Images mit dem Tag des Commits und führt `scripts/deploy/deploy.sh <sha>` auf dem Server aus (pull, Migration, Neustart von web/worker/caddy, Warten auf `/readyz` bis 60 s, bei Fehler automatischer Rollback auf den vorigen Tag). Danach `https://<domain>/readyz` aufrufen: erwartet `{"status":"ok"}`.

## Ersten Admin anlegen
Das Web-Image ist standalone (`node server.js`, kein tsx). Deshalb über den Worker-Container. Das Passwort wird von stdin gelesen:

```bash
dc run --rm worker node --import tsx scripts/user.ts create <email>
# Passwort setzen/ändern:
dc run --rm worker node --import tsx scripts/user.ts password <email>
```

Für Eingabe per Pipe `-T` ergänzen: `printf '%s\n' "$PW" | dc run --rm -T worker node --import tsx scripts/user.ts create <email>`.

## API-Key anlegen
```bash
dc run --rm worker node --import tsx scripts/apikey.ts create <name> --scope <scope>
```
Der Schlüssel wird einmalig ausgegeben. Zugelassene Scopes siehe `scripts/apikey.ts`.

Prüfung des Anthropic-Schlüssels auf einem Entwicklungsrechner: `npm run smoke:ai`.

## Zugang sperren
Nutzer sperren (bestehende Sitzungen werden beim nächsten Aufruf abgewiesen, keine Passwortabfrage):
```bash
dc run --rm worker node --import tsx scripts/user.ts disable <email>
```
API-Key sperren (nach Name; wirkt sofort):
```bash
dc run --rm worker node --import tsx scripts/apikey.ts revoke <name>
```
Unbekannte E-Mail bzw. unbekannter oder bereits gesperrter Name endet mit Fehler.

## SESSION_SECRET rotieren
`SESSION_SECRET` in `.env` ersetzen (mindestens 32 Zeichen, z. B. `openssl rand -base64 48`) und web neu starten. Das meldet alle Sitzungen ab; alle Admins müssen sich neu anmelden.

## Logs
```bash
dc logs -f worker
dc logs -f web
dc logs -f caddy
```
Backup-Log: `/opt/periplus/backup.log`.

## Rollback
Eine frühere Version erneut ausrollen:
```bash
bash /opt/periplus/scripts/deploy/deploy.sh <previous sha>
```
(oder aus Actions heraus per Re-Run). Das funktioniert jederzeit, auch lange nach dem Deploy-Job, weil der Server mit seinem eigenen Nur-Lese-Login (Abschnitt 5a) zieht; die Images müssen in ghcr.io noch vorhanden sein. Der aktuell ausgerollte Tag steht in `.deployed-tag`; ein fehlgeschlagener Deploy (pull, Migration, Start oder `/readyz`) überschreibt ihn nicht und rollt automatisch auf ihn zurück. Migrationen werden nicht zurückgedreht; sie müssen zur Vorversion abwärtskompatibel bleiben. Falls `deploy.sh` nicht auf dem Server liegt: `ssh deploy@<host> bash -s <sha> < scripts/deploy/deploy.sh`.

## Backup und Restore
- Automatisch täglich 02:30 UTC: `scripts/ops/backup.sh` (pg_dump per restic, Aufbewahrung 7 täglich / 4 wöchentlich / 12 monatlich, Archiv-Bucket per `rclone copy` auf die Storage Box; es wird nie gelöscht).
- Manuell: `/opt/periplus/scripts/ops/backup.sh`.
- Restore-Prüfung: `/opt/periplus/scripts/ops/restore-check.sh` stellt den letzten Dump in einem Wegwerf-Container wieder her und zählt `users`; Exit 0 bedeutet Erfolg. Regelmäßig (monatlich) ausführen.
- Echter Restore: `restic dump latest /periplus.dump | dc exec -T postgres pg_restore -U periplus -d periplus --clean --if-exists --no-owner`; vorher web und worker stoppen.

Ergebnis der letzten Prüfung (nach Abnahme eintragen): _Datum: offen, restore-check: offen_

## Hinweise
- Caddy darf **kein** `trusted_proxies` setzen. Das Login-Rate-Limit nutzt den ersten `X-Forwarded-For`-Eintrag; das ist nur korrekt, solange Caddy diesen Header mit der echten Client-Adresse überschreibt.
- Compose-Layout auf dem Server: `.env` neben `docker/`; `compose.prod.yml` liest `../.env`.

## Reviere (`config/areas/*.json`)
- Je Revier eine Datei; `key` muss dem Dateinamen entsprechen. Die Datei wird beim Start mit zod geprüft (Namen `de`, `en`, `el` Pflicht).
- **Entwurf:** Die Polygone von `saronic` und `argolic` sowie die Küstenabschnitte von `saronic` (Methana, Ermioni, Porto Cheli, Epidavros) sind grobe Entwürfe. Vor der Abnahme M1 in geojson.io nachzeichnen und die Koordinaten in die Dateien übernehmen (Task 23).

## Offene Checkliste (nicht automatisiert, Abnahme M0)
1. Branch pushen, Pull Request öffnen; Job `check` in GitHub Actions grün (`gh pr checks --watch`).
2. Menschliche Schritte oben erledigen (Server, Bucket, Storage Box, DNS, Secrets); nach Merge Job `deploy` grün; `https://<domain>/readyz` liefert `{"status":"ok"}`.
3. Abnahme auf dem Server:
   - Admin-Login funktioniert.
   - Ein Ping-Lauf unter „Läufe“ startet, endet und erscheint mit seinen Stufenzahlen auf der Übersicht.
   - `scripts/ops/backup.sh` läuft; `scripts/ops/restore-check.sh` endet mit Exit 0; Ergebnis mit Datum oben eintragen.

## Landpolygone
OSM-Landpolygone (Küstenlinie) bestimmen, welche Kacheln Küste haben und welche Orte küstennah liegen. Sie werden je Revier auf dessen Box (Revier-Polygon ∪ `tileBbox`, erweitert um `landBufferKm`) zugeschnitten importiert.
1. Herunterladen und entpacken: `https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip` (enthält `land-polygons-split-4326/land_polygons.shp`).
2. Je Revier importieren:
   ```bash
   npm run import:land-polygons -- --shp <pfad>/land_polygons.shp --area saronic [--version 2026-10-18]
   ```
   `--version` (Standard: heutiges Datum) benennt den Datenstand. Ein erneuter Import ersetzt alle Polygone in der Box des Reviers; Polygone außerhalb bleiben.
3. Auf dem Server mit gemountetem Verzeichnis (hier `/data/land`):
   ```bash
   docker compose run --rm -v /data/land:/data/land:ro web npm run import:land-polygons -- --shp /data/land/land_polygons.shp --area saronic
   ```

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

## Gazetteer und Seed
Reihenfolge je Revier (Pilot: `saronic`, danach `argolic`):
1. **Landpolygone importieren** (Abschnitt „Landpolygone“ unten), je Revier einmal. Ohne sie ist keine Kachel „Küste“.
2. **Läufe → „Gazetteer aufbauen“** (Revier wählen). `tiles.ensure` synchronisiert jedes Mal alle Reviere aus `config/areas`; die Reihenfolge der Reviere ist deshalb egal. Danach Stufen OSM, Wikidata, GeoNames, Hierarchie.
3. **Läufe → „Seed für Revier“**: legt aus den Geo-Objekten Ortskandidaten an und öffnet je Kandidat eine Prüfaufgabe.
4. **Review**: Ortskandidaten, unsichere Paare und „Küstenkachel ohne Revier“ abarbeiten, bis die Queue leer ist. Fehlgeschlagene Jobs stehen dort ebenfalls.
5. **Abnahme-Prüfung**: `npm run check:gazetteer -- --area saronic` (auf dem Server: `dc run --rm worker node --import tsx scripts/check-gazetteer.ts --area saronic`). Ausgabe: Kacheln mit Küste, offene Kandidatenaufgaben, Objekte ohne Namen in de/en/el. Exit 1, solange Namen fehlen. Der Prüfbereich ist die `tileBbox` des Reviers. Checkliste: `docs/pilot/m1-abnahme.md`.

Aufnahme neuer Testdaten (Entwicklung): `npm run fixtures:record -- --area saronic [--land <pfad>/land_polygons.shp] [--cache <dir>]` ruft die echten Dienste auf und schreibt die Fixtures nach `test/fixtures`. Es schreibt nur in eine Wegwerf-Datenbank, deren Name auf `_scratch` endet (`DATABASE_URL` darauf setzen); jede andere Datenbank wird abgelehnt.

Deploy: Solange `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` und `DEPLOY_HOST` (Abschnitt 5) und der Server fehlen, schlägt der CI-Job `deploy` fehl; der Job `check` ist davon unabhängig.

## Geometrie und Ausschlüsse
Reihenfolge je Revier (Pilot: `saronic`, danach `argolic`), nach Gazetteer und Seed:
1. **Landpolygone neu importieren** (Abschnitt „Landpolygone“): `landBufferKm` ist seit M2 55 km, weil die Fetch-Strahlen bis 50 km reichen; ein Import aus M1 (10 km) reicht nicht. Je Revier einmal.
2. **Läufe → „Datensätze laden“** (Revier wählen): Bathymetrie (EMODnet DTM, je Küstenkachel), Meeresboden (EMODnet Seabed, WFS), Ausschlussflächen (EMODnet Human Activities, Kabel aus OSM), Straßen (Overpass), Schiffsdichte (nur Ablage). Rohdaten liegen in S3 unter `datasets/<name>/<version>/…`; ein unveränderter Re-Import erzeugt keine neue Version.
3. **Läufe → „Geometrie für Revier“**: ein Job je Ort (Kandidat, bestätigt, `no_anchoring`). Der Start wird abgelehnt, solange Bathymetrie oder Landpolygone für eine Küstenkachel fehlen (Meldung nennt die Kacheln). Einzelne Orte: Ort-Detail, Reiter „Geometrie“.
4. **Abnahme-Prüfung**: `npm run check:geometry -- --area saronic` (auf dem Server: `dc run --rm worker node --import tsx scripts/check-geometry.ts --area saronic`). Ausgabe: Orte, vollständige Orte, Orte mit begründeter Tiefenlücke (`no_bathymetry`, `no_anchor_area`; zählen als vollständig) und Orte mit fehlenden Werten (8 × `shelter.*`, `opening_bearing`, `depth`). Exit 1, solange ein Ort Werte vermisst.
5. **Stichprobe gegen Navily**: Vergleichssatz (Seite „Qualität“) muss mindestens 20 Orte mit Geometrie enthalten. Die Navily-Datei bleibt lokal bzw. nur für den Lauf auf dem Server; sie wird nie eingecheckt oder gespeichert, der Bericht enthält keine Navily-Werte.
   ```bash
   # lokal gegen eine Datenbank mit den Ergebnissen
   NAVILY_SPOTS_PATH=<pfad>/navily-spots.json npm run compare:navily -- --area saronic
   # auf dem Server: Datei nur für den Lauf hochladen, Bericht in ein gemountetes Verzeichnis
   scp navily-spots.json <server>:/tmp/navily/
   dc run --rm -v /tmp/navily:/data/navily:ro -v /tmp/pilot:/out -e NAVILY_SPOTS_PATH=/data/navily/navily-spots.json \
     worker node --import tsx scripts/compare-navily.ts --area saronic --out /out/<datum>-m2-stichprobe.md
   rm -r /tmp/navily   # danach sofort löschen
   ```
   Den Bericht nach `docs/pilot/` holen und einchecken. Exit 1, wenn weniger als `minPlaces` (`config/quality.json`) Orte mit Geometrie verglichen wurden. Laufzeit und Kosten stehen im Bericht (letzter beendeter Geometrie-Lauf, Kosten der Datensatz-Importe).

Neu rechnen:
- **Neue Datensatzversion** (erneutes „Datensätze laden“ mit geänderten Daten, neuer Landpolygon-Import) oder **geänderte `config/geometry.json`** (dabei immer `rulesVersion` erhöhen, sonst gelten die alten Zeilen weiter): „Geometrie für Revier“ erneut starten. Nur Rechnungen mit geänderten Eingängen schreiben neue `computations`-Zeilen und Facts; Unverändertes bleibt stehen.
- Nach einer Änderung der Rechenlogik den Golden-Test lokal neu erzeugen und die Abweichungen prüfen: `UPDATE_GOLDEN=1 npx vitest run lib/pipeline/__tests__/geometry-golden.test.ts` (unter CI abgelehnt), dann `git diff test/fixtures/geometry/golden.json`.

Ankerverbots-Gebiete pflegen:
- Militär, Kabel, Schießgebiete und Aquakultur schließen immer aus (`noAnchoringKinds` in `config/gazetteer.json`). Natura-2000-Gebiete schließen nur aus, wenn ihr Gebietscode (`sitecode`, z. B. `GR2540001`) in `config/restrictions.json` unter `protectedAreaAnchoringBan` steht; die WFS-Daten sagen nicht, wo Ankern verboten ist.
- Nach einer Änderung: deployen, dann „Geometrie für Revier“ erneut starten. Ein Kandidat wird `no_anchoring`; für einen bestätigten Ort entsteht eine Prüfaufgabe „Ortskandidat“. Eine Rücknahme (Gebiet entfernt) geschieht nicht automatisch, sondern per Review-Entscheidung.

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

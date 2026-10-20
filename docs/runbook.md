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

### 5b. Caddy (Grenzen am Rand)
`docker/Caddyfile` begrenzt Anfragekörper: 101 MiB nur auf einer Quellen-Seite (PDF-Upload, die App selbst nimmt bis 100 MiB), sonst 1 MB (Login, Formulare, API); größere Anfragen beantwortet Caddy mit 413, bevor der Web-Server sie puffert. Die Datei kommt nur beim Bootstrap auf den Server (`docs/m0-folgearbeiten.md` §3): nach einer Änderung `docker/Caddyfile` nach `/opt/periplus/docker/Caddyfile` kopieren und `dc restart caddy`.

### 6. `.env` ausfüllen
Alle Werte in `/opt/periplus/.env` setzen. `SESSION_SECRET`: `openssl rand -base64 48`. `POSTGRES_PASSWORD` und das Passwort in `DATABASE_URL` müssen übereinstimmen. Werte ohne Anführungszeichen schreiben.

## Erstes Deployment
Auf `main` mergen: der Job `deploy` baut und pusht die drei Images mit dem Tag des Commits und führt `scripts/deploy/deploy.sh <sha>` auf dem Server aus (pull, Migration, Neustart von web/worker/caddy mit `up --wait`, Warten auf `/readyz` und auf die Bereit-Marke des Workers bis 60 s, bei Fehler automatischer Rollback auf den vorigen Tag). Die Bereit-Marke `/tmp/periplus-worker-ready` schreibt der Worker, wenn seine Startprüfungen bestanden sind (Umgebung, Embedding-Dimension, Bucket, Queues), und erneuert sie mit jedem Heartbeat; ein Worker, der beim Start scheitert und in der Neustartschleife hängt, lässt den Deploy deshalb scheitern. Der Compose-Healthcheck des Workers prüft dieselbe Marke; er wirkt auf dem Server erst, wenn dort `docker/compose.prod.yml` aktualisiert ist (`docs/m0-folgearbeiten.md` §3), die Prüfung in `deploy.sh` wirkt sofort. Danach `https://<domain>/readyz` aufrufen: erwartet `{"status":"ok"}`.

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
(oder aus Actions heraus per Re-Run). Das funktioniert jederzeit, auch lange nach dem Deploy-Job, weil der Server mit seinem eigenen Nur-Lese-Login (Abschnitt 5a) zieht; die Images müssen in ghcr.io noch vorhanden sein. Der aktuell ausgerollte Tag steht in `.deployed-tag`; ein fehlgeschlagener Deploy (pull, Migration, Start, `/readyz` oder Worker nicht bereit) überschreibt ihn nicht und rollt automatisch auf ihn zurück. Migrationen werden nicht zurückgedreht; sie müssen zur Vorversion abwärtskompatibel bleiben. Falls `deploy.sh` nicht auf dem Server liegt: `ssh deploy@<host> bash -s <sha> < scripts/deploy/deploy.sh`.

Rollback auf eine Version vor fb5278c (Worker ohne Bereitschaftsmarker): `deploy.sh` wartet auf den Marker `/tmp/periplus-worker-ready`, den ein älterer Worker nie schreibt, und meldet ihn als „nicht bereit“ (und `up --wait` wartet vergeblich auf die Healthcheck des neuen `compose.prod.yml`). Eine solche Version nicht mit `deploy.sh` ausrollen, sondern von Hand (Vorspann oben, `dc`-Alias): `export IMAGE_TAG=<sha>`, `dc pull`, `dc up -d web worker caddy` (ohne `--wait`; die Healthcheck des Workers bleibt „unhealthy“, das stoppt ihn nicht), dann `dc logs -f worker` und `/readyz` prüfen und `<sha>` in `.deployed-tag` schreiben. Solange der Server nicht live ist, betrifft das nur das Übergangsfenster (Wave-2-Review M-3, geparkt).

## Backup und Restore
- Automatisch täglich 02:30 UTC: `scripts/ops/backup.sh` (pg_dump per restic, Aufbewahrung 7 täglich / 4 wöchentlich / 12 monatlich, Archiv-Bucket per `rclone copy` auf die Storage Box; es wird nie gelöscht).
- Manuell: `/opt/periplus/scripts/ops/backup.sh`.
- Restore-Prüfung: `/opt/periplus/scripts/ops/restore-check.sh` stellt den letzten Dump in einem Wegwerf-Container wieder her und zählt `users`; Exit 0 bedeutet Erfolg. Regelmäßig (monatlich) ausführen.
- Echter Restore: `restic dump latest /periplus.dump | dc exec -T postgres pg_restore -U periplus -d periplus --clean --if-exists --no-owner`; vorher web und worker stoppen.
- Restore in einen **neuen** Postgres-Cluster (leeres Volume, neuer Server): Transaktions-IDs gelten nur in dem Cluster, der sie vergeben hat. Die wiederhergestellten Zeilen tragen die alten Werte (`change_events.xact_id`, `deliveries.change_snapshot`), der neue Cluster zählt aber von vorn. Ohne Ausgleich bekämen die Ereignisse nach dem Restore im nächsten Paket keine Schwere (sie sähen „schon geliefert“ aus), und der Änderungs-Feed hielte die alten Ereignisse zurück. Deshalb den Zähler vor dem Start von web und worker über die alten Werte schieben (jede Schleifenrunde verbraucht eine ID; bei einigen Millionen dauert das Minuten):
  ```bash
  dc exec -T postgres psql -U periplus -d periplus <<'SQL'
  DO $$
  DECLARE target bigint := greatest(
      coalesce((select max(xact_id::text::bigint) from change_events), 0),
      coalesce((select max(pg_snapshot_xmax(change_snapshot)::text::bigint) from deliveries), 0)) + 1000;
  BEGIN
    WHILE pg_current_xact_id()::text::bigint < target LOOP COMMIT; END LOOP;
  END $$;
  SQL
  ```
  Ein Paketbau, dessen Vorgänger-Snapshot vor dem eigenen liegt, bricht mit „transaction ids went back“ ab, statt ein Paket mit falschen Schweregraden zu liefern; nach dem Schritt oben „Paket bauen“ wiederholen. Ein Restore in den laufenden Cluster (Befehl darüber) braucht das nicht.

Ergebnis der letzten Prüfung (nach Abnahme eintragen): _Datum: offen, restore-check: offen_

## Hinweise
- Caddy darf **kein** `trusted_proxies` setzen. Das Login-Rate-Limit nutzt den ersten `X-Forwarded-For`-Eintrag; das ist nur korrekt, solange Caddy diesen Header mit der echten Client-Adresse überschreibt.
- Compose-Layout auf dem Server: `.env` neben `docker/`; `compose.prod.yml` liest `../.env`.
- `PERIPLUS_RENDERER` (Standard `playwright`): Der Worker rendert Seiten mit `render: auto`/`always` in Headless-Chromium. `PERIPLUS_RENDERER=off` in `.env` schaltet das Rendern ab (z. B. wenn Chromium abstürzt oder zu viel Speicher braucht); Seiten werden dann nur aus dem HTTP-Text konvertiert. Danach `dc up -d worker`.

## Reviere (`config/areas/*.json`)
- Je Revier eine Datei; `key` muss dem Dateinamen entsprechen. Die Datei wird beim Start mit zod geprüft (Namen `de`, `en`, `el` Pflicht).
- **Entwurf:** Die Polygone von `saronic` und `argolic` sowie die Küstenabschnitte von `saronic` (Methana, Ermioni, Porto Cheli, Epidavros) sind grobe Entwürfe. Vor der Abnahme M1 in geojson.io nachzeichnen und die Koordinaten in die Dateien übernehmen (Task 23).
- Ein Revier (Datei) oder Küstenabschnitt, der aus der Konfiguration verschwindet oder einen neuen `key` bekommt, wird beim nächsten `tiles.ensure` (Gazetteer-Lauf) beendet: das nächste Paket meldet den Abschnitt als `removed`, `GET /areas` listet das Revier nicht mehr. Ein umbenannter Abschnitt bekommt eine neue `rg_`-ID. Kommt derselbe `key` zurück, lebt dasselbe Objekt mit seiner alten ID wieder auf.

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
3. **Läufe → „Geometrie für Revier“**: zuerst die Stufe `geometry.detect_bays`, ein Job je Küstenkachel: sie sucht unbenannte Buchten (Parameter `bays` in `config/geometry.json`; Küste alle 50 m, Prüfpunkt 400 m vor der Küste, ≥ 180° Land in 1,5 km, Ankerfläche ≥ 5.000 m², Treffer unter 300 m zusammengefasst) und legt für jede neue Bucht (kein Ort jeden Status und keine Bucht oder kein Hafen in 500 m) ein berechnetes Geo-Objekt ohne Namen, einen Ortskandidaten und eine Prüfaufgabe „Ortskandidat“ mit dem Hilfsnamen „Bucht bei …“ an (nur Anzeige, nie bestätigt ohne Review; Ruling M7-P13). Danach ein Job je Ort (Kandidat, bestätigt, `no_anchoring`), die neuen Buchten eingeschlossen. Eine bestätigte unbenannte Bucht wird erst geliefert, wenn sie über einen Namenskandidaten („Name zuordnen“) einen Namen hat. Der Start wird abgelehnt, solange Bathymetrie oder Landpolygone für eine Küstenkachel fehlen (Meldung nennt die Kacheln). Einzelne Orte: Ort-Detail, Reiter „Geometrie“. Seit M5 hängt jeder Geometrie-Lauf die Konsolidierungsstufen `consolidation.geo` und `consolidation.summary` an (ohne die Folgestufe `consolidation.followup`) und konsolidiert danach die Objekte seiner Orte (Revier: alle Objekte der Küstenkacheln): ein neuer Ausschluss, ein berechneter Schutz oder ein berechnetes Verbot steht so im selben Lauf im Profil und im Änderungs-Feed. Eine bezahlte Quellenfindung (DataForSEO) startet ein Geometrie-Lauf nie; dafür gibt es Konsolidierungs- und Textläufe (siehe „Konsolidierung“).
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
- **Neuer Name aus Texten** (Review-Aufgabe „Neuer Name: …“, Entscheidung „Ort anlegen“): Der Ort entsteht bestätigt, aber ohne Geometrie; Geometrie und Ausschluss-Prüfung bekommt er erst im nächsten Lauf „Geometrie für Revier“ seines Reviers (liegt er in einem Ausschlussgebiet, entsteht dann eine Prüfaufgabe „Ortskandidat“).
- Nach einer Änderung der Rechenlogik den Golden-Test lokal neu erzeugen und die Abweichungen prüfen: `UPDATE_GOLDEN=1 npx vitest run lib/pipeline/__tests__/geometry-golden.test.ts` (unter CI abgelehnt), dann `git diff test/fixtures/geometry/golden.json`.

Ankerverbots-Gebiete pflegen:
- Militär, Kabel, Schießgebiete und Aquakultur schließen immer aus (`noAnchoringKinds` in `config/gazetteer.json`). Natura-2000-Gebiete schließen nur aus, wenn ihr Gebietscode (`sitecode`, z. B. `GR2540001`) in `config/restrictions.json` unter `protectedAreaAnchoringBan` steht; die WFS-Daten sagen nicht, wo Ankern verboten ist.
- Nach einer Änderung: deployen, dann „Geometrie für Revier“ erneut starten. Ein Kandidat wird `no_anchoring`; für einen bestätigten Ort entsteht eine Prüfaufgabe „Ortskandidat“ mit Hinweis „liegt in einem Sperrgebiet mit Ankerverbot“ (Art, Anteil, Datensatz-Referenz und Quelle jedes Gebiets; „Trotz Sperrgebiet bestätigen“ oder „Kein Ankerplatz“). Die Entscheidung gilt je Gebiet: ein später geladenes weiteres Gebiet über demselben Ort fragt erneut. Hat ein Geometrie-Lauf ein weiteres Gebiet gefunden, während die Aufgabe offen war, legt „Trotz Sperrgebiet bestätigen“ sofort die nächste Aufgabe für dieses Gebiet an; ein danach geladenes Gebiet fragt erst nach dem nächsten „Geometrie für Revier“ (deshalb nach jedem Laden von Gebieten die Geometrie neu starten). Eine Rücknahme (Gebiet entfernt) geschieht nicht automatisch, sondern per Review-Entscheidung. Der Geometrie-Lauf konsolidiert danach selbst (Ausschluss und berechnete Verbote im Profil); jede Entscheidung über einen Ortskandidaten („Bestätigen“, „Zusammenlegen“, „Ablehnen“, „Kein Ankerplatz“) startet nach dem Commit einen Konsolidierungslauf für das Objekt. Startet einer nicht (Meldung „Der Folgelauf konnte nicht gestartet werden“), „Profil neu berechnen“ auf der Ort-Seite.

Status eines Orts ohne Prüfaufgabe ändern: Ort-Seite → Kopf → **„Bestätigen“**, **„Verwerfen“** oder **„Kein Ankerplatz“** (bei einem bestätigten Ort mit Rückfrage). Gedacht für einen bestätigten Ort, der sich als kein Ankerplatz herausstellt (Abgleich, Törnbericht, Besuch), und für einen Kandidaten, dessen Aufgabe hinfällig wurde. Die Entscheidung wird als Review-Aufgabe `place_status` festgehalten; danach startet ein Konsolidierungslauf. „Kein Ankerplatz“ liefert den Ort im nächsten Paket als ausgeschlossen, „Verwerfen“ meldet ihn als entfernt. Hat der Ort eine offene Prüfaufgabe, fehlen die Knöpfe: dort entscheiden („Offene Prüfung“ im Kopf). Verschwindet ein Ort durch ein Zusammenlegen der Geo-Objekte (Gazetteer, „Gleiches Objekt“), werden seine offenen Aufgaben als hinfällig geschlossen; Migration 0052 schließt solche, die vorher offen geblieben sind.

## Landpolygone
OSM-Landpolygone (Küstenlinie) bestimmen, welche Kacheln Küste haben und welche Orte küstennah liegen. Sie werden je Revier auf dessen Box (Revier-Polygon ∪ `tileBbox`, erweitert um `landBufferKm`) zugeschnitten importiert.
1. Herunterladen und entpacken: `https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip` (enthält `land-polygons-split-4326/land_polygons.shp`).
2. Je Revier importieren:
   ```bash
   npm run import:land-polygons -- --shp <pfad>/land_polygons.shp --area saronic [--version 2026-10-18]
   ```
   `--version` (Standard: heutiges Datum) benennt den Datenstand. Ein erneuter Import ersetzt alle Polygone in der Box des Reviers; Polygone außerhalb bleiben.
3. Auf dem Server mit gemountetem Verzeichnis (hier `/data/land`), über den Worker-Container (das Web-Image ist standalone, ohne `scripts/` und tsx) und mit dem `dc`-Alias vom Anfang dieses Runbooks:
   ```bash
   dc run --rm -v /data/land:/data/land:ro worker node --import tsx scripts/import-land-polygons.ts --shp /data/land/land_polygons.shp --area saronic
   ```

## Quellen und Archiv
Quellenfindung, Freigabe, Crawl, Archiv und Embeddings (M3). Checkliste der Abnahme: `docs/pilot/m3-abnahme.md`.

### Schlüssel und Schalter in `.env`
- `VOYAGE_API_KEY` (Embeddings), `DATAFORSEO_LOGIN` und `DATAFORSEO_PASSWORD` (SERP), `JINA_API_KEY` und `FIRECRAWL_API_KEY` (Konverter), `ANTHROPIC_API_KEY` (PDF-Seiten, die `pdftotext` nicht lesen kann). Ohne Schlüssel scheitert nur der jeweilige Dienst; die Tagesbudgets stehen in `config/budgets.json`.
- **Voyage braucht eine hinterlegte Zahlungsmethode**: ohne sie gelten 3 Anfragen und 10 000 Token je Minute; `embed.chunks`-Jobs bekommen dann 429, scheitern nach drei Versuchen (etwa 3 Minuten) und erscheinen je Job unter „Prüfen“. Vor dem vollen Crawl im Voyage-Dashboard eintragen; danach die Aufgaben entscheiden und „Einbettungen nachholen“.
- **Abgelehnter Jina- oder Firecrawl-Schlüssel** (falsch, abgelaufen, kein Guthaben): die `fetch.url`-Jobs der Quellen mit diesem Konverter scheitern nach drei Versuchen und erscheinen unter „Prüfen“; die Seiten bleiben offen. Schlüssel erneuern, deployen, Jobs dort „Erneut versuchen“ oder die Quelle neu crawlen.
- `PERIPLUS_RENDERER` (`playwright` Standard, `off`): siehe „Hinweise“ oben. Der Renderer startet Chromium mit dem Proxy `http://127.0.0.1:9` (toter Port): jede Anfrage, die nicht über die geprüfte Weiterleitung des Workers läuft (WebRTC, Worker-WebSockets), stirbt dort. Zusätzlich sollte die Server-Firewall ausgehende Verbindungen des Workers in private Netze (RFC 1918, 169.254/16, 100.64/10, ::1, fc00::/7) sperren (Verteidigung in der Tiefe; die Adressprüfung im Code bleibt die erste Linie).

### Worker-Image: Chromium und Poppler
`docker/worker.Dockerfile` baut auf `mcr.microsoft.com/playwright:v1.64.1-noble` (Chromium passend zu `playwright@1.64`) und installiert `poppler-utils` (`pdftotext`). Das Web-Image hat beides nicht: Rendern und PDF-Umwandlung laufen nur im Worker, Server Actions reihen dafür Jobs ein. Prüfen nach einem Deploy:
```bash
dc exec worker pdftotext -v
dc exec worker node -e "require('playwright').chromium.launch().then(b => b.close()).then(() => console.log('chromium ok'))"
```
Wird `playwright` in `package.json` angehoben, muss das Basis-Image dieselbe Version tragen.

### Reihenfolge im Pilot
1. **Quellenfindung je Revier** (Quellen → „Quellenfindung“, Revier wählen): SERP-Suchen (höchstens 240 je Lauf, `config/discovery.json`), danach Vorschläge mit Prüfaufgabe „Quellenfreigabe“.
2. **Vorschläge prüfen** (Prüfen → Quellenfreigabe): Typ, Gewicht, Änderungsrate und Crawl-Regeln setzen, freigeben oder ablehnen. Ziel: 20–40 freigegebene Quellen.
3. **Wikivoyage** (Quellen → „Wikivoyage“, je Revier): legt die Whitelist-Quelle an und archiviert die Artikel der Gazetteer-Objekte.
4. **Testcrawl je Quelle** (Quelle → „Testcrawl 10 Seiten“): Archiv und Dokumentansicht stichprobenartig ansehen, Crawl-Regeln (`allow`, `deny`, `boilerplateSelectors`, `render`) nachschärfen.
5. **Konverter-Vergleich** (Navigation „Konverter“ → „Vergleich starten“): wählt 50 Seiten der 10 freigegebenen Quellen mit den meisten HTML-Dokumenten und wandelt jede mit Jina, Firecrawl und lokal um (Kosten etwa 0,24 € für Firecrawl und 0,01 € für Jina je 50 Seiten). Antwortet Jina oder Firecrawl vorübergehend mit 429/5xx, wiederholt der Job nur diese Umwandlung (bis zu dreimal). Jede Seite in drei Spalten bewerten (Hauptinhalt vollständig, Boilerplate entfernt, Tabellen) und je Spalte „Speichern“. „Vergleich starten“ erneut wandelt nur fehlende oder fehlgeschlagene Umwandlungen um; Bewertetes bleibt.
6. **Bericht und Entscheidung**: `npm run report:converters` schreibt `docs/pilot/m3-konverter-vergleich.md` (auf dem Server: `dc run --rm -v /tmp/pilot:/out worker node --import tsx scripts/converter-report.ts --out /out/m3-konverter-vergleich.md`, Datei nach `docs/pilot/` holen). Entscheidung in `config/fetch.json`: `defaultConverter`, Ausnahmen in `converterBySource` (registrierbare Domain → Konverter), `decision.status` auf `"decided"` und `decision.note` mit Begründung; einchecken und deployen. Ein Wechsel des Konverters erzeugt beim nächsten Crawl je Seite einmal eine neue Version, deshalb kommt der volle Crawl erst danach.
7. **PDF-Revierführer**: die zwei gekauften Führer je als PDF an ihrer Quelle hochladen (Quelle → „PDF hochladen“; fehlt die Quelle, „Neue Quelle“ mit Typ „Revierführer“). Lokal `npm run pdf:compare -- <führer>.pdf --model-pages <von>-<bis>` schreibt `docs/pilot/m3-pdf-vergleich.md`; Prüflisten ausfüllen und `config/fetch.json` `pdf` entscheiden (`modelFallback`, `unreadableMinChars`, `maxModelPagesPerDocument`), einchecken, deployen.
8. **Voller Crawl**: Quellen → „Alle freigegebenen crawlen“. Quellen, die gerade ein anderer Lauf abruft, werden übersprungen und genannt.
9. **Linkgraph-Vorschläge** (Quellen → „Linkgraph-Vorschläge“): neue Domains, auf die mindestens zwei freigegebene Quellen verlinken; wie Schritt 2 prüfen.
10. **Abnahme-Prüfung**: `npm run check:sources` (auf dem Server: `dc run --rm worker node --import tsx scripts/check-sources.ts`). Ausgabe: freigegebene Quellen (Soll 20–40), je Quelle Dokumente, Versionen, offene und fehlgeschlagene Frontier-URLs und Kosten, offene fehlgeschlagene Jobs der Queues `fetch.*` und `embed.chunks`, Konverter-Entscheidung, PDF-Extraktor. Exit 1, solange die Zahl außerhalb 20–40 liegt, eine freigegebene Quelle kein Dokument hat (noch nicht gecrawlt), ein solcher Job offen ist oder die Konverter-Entscheidung vorläufig ist. Die Kosten je Quelle sind hier die Summe seit Beginn (mit Konverter-Vergleich), in `/sources` die der letzten 30 Tage.

### Budget-Stopp
Erreicht ein Dienst sein Tagesbudget (`config/budgets.json`), pausiert der Worker die betroffene Queue bis zum nächsten Tag (UTC) und stellt den Job zurück, ohne ihn als Fehlversuch zu zählen. Unter „Jobs“ steht die Queue auf „Pausiert“ mit dem Grund („Budget Anthropic erreicht, bis … 00:00 UTC“; eine Pause von Hand steht als „von Hand (<wer>)“). Nach einer Budget-Erhöhung (Deploy) oder am Folgetag dort „Fortsetzen“ (bei einem Budget-Stopp mit Rückfrage); der Lauf macht dort weiter, wo er stand.

### Quelle pausieren und fortsetzen
- **Beschwerde eines Betreibers** oder offensichtliche Fehlfunktion: Quelle öffnen → „Pausieren“. Laufende Jobs der Quelle prüfen vor jedem Abruf erneut, ob sie freigegeben ist, und überspringen ihre Seiten (sie bleiben „offen“ für später). Hochgeladene PDFs bleiben bei pausierten Quellen möglich.
- Fehlgeschlagener Job einer Quelle unter „Prüfen“: Entscheidung „Quelle pausieren“.
- Ein ausdrückliches Crawl-Verbot in robots.txt pausiert die Quelle automatisch („robots.txt verbietet das Crawlen“).
- **Fortsetzen**: Quelle öffnen → „Fortsetzen“, danach „Crawlen“.
- **Quelle beenden** (endgültig, z. B. eine Quelle, deren Inhalte nicht geliefert werden dürfen): Quelle öffnen → „Quelle beenden …“ → „Quelle beenden“ (nur freigegebene oder pausierte Quellen). Setzt `valid_to` auf heute (UTC); das Archiv bleibt, die Quelle wird nie mehr gecrawlt oder fortgesetzt, und ihre Facts zählen in keiner Konsolidierung mehr. Ein Text-Wert, der nur auf Facts beendeter (oder abgelehnter) Quellen beruht, fällt mit der nächsten Konsolidierung weg, statt bis zum Ablauf stehen zu bleiben; gibt es einen anderen Wert, ersetzt er ihn. Nach dem Beenden startet ein Konsolidierungslauf für alle Objekte mit Facts aus der Quelle (die Seite meldet ihre Zahl und verlinkt den Lauf; startet er nicht, steht das Beenden trotzdem: dann „Profil neu berechnen“ auf den Orten).

### Hängender Lauf
Ein Crawl-Lauf im Status „Wartend“ oder „Läuft“ sperrt seine Quellen für neue Abrufe („Für die Quelle läuft bereits ein Abruf“), bis er endet; ebenso sperrt ein laufender Konverter-Vergleich bzw. „Einbettungen nachholen“ einen zweiten Start. Endet er nicht, weil der Worker abgestürzt ist und seine Jobs verloren sind (unter „Jobs“ keine aktiven oder wartenden Jobs der Queues `fetch.*`/`embed.chunks` für den Lauf), auf der Laufseite (Läufe → Lauf) **„Lauf beenden“** wählen. Der Lauf steht danach auf „Fehlgeschlagen“ mit „Beendet von <Admin> am <Zeit>“; seine noch wartenden Jobs werden abgebrochen, Jobs, die gerade laufen, enden ohne Wirkung auf den Lauf, und „Erneut versuchen“ setzt ihn nicht fort. Danach lässt sich die Quelle wieder crawlen; offene Frontier-URLs nimmt der nächste Lauf mit.

### Embeddings neu berechnen
- Fehlende Embeddings (Voyage-Ausfall, Budget-Stopp, Zahlungsmethode fehlte): Quellen → „Einbettungen nachholen“. Der Lauf bettet jeden Chunk ohne Embedding ein (älteste zuerst, höchstens 10 000 je Lauf; bei mehr Chunks erneut starten).
- Neues Modell oder neue Dimension (`config/embeddings.json`): die Spalte `chunks.embedding` hat eine feste Dimension (1024) und der Worker prüft sie beim Start. Ein Modellwechsel mit anderer Dimension braucht eine Migration; mit gleicher Dimension werden bestehende Embeddings nicht automatisch ersetzt (eigene Aufgabe, nicht Teil von M3).

### Testdaten aufnehmen (Entwicklung)
`npm run fixtures:record` ruft echte Dienste und schreibt nach `test/fixtures`:
- `-- --area <key> [--land …] [--cache …]`: Gazetteer (nur gegen eine Datenbank mit Namen `*_scratch`).
- `-- --area <key> --datasets`: Datensatz-Importe.
- `-- --area <key> --serp [--limit 1-3]`: höchstens 3 echte SERP-Suchen aus den Reviernamen (kostet je etwa 0,0035 €).
- `-- --area <key> --wikivoyage`: Wikidata-Sitelinks und Wikivoyage-Artikel (Aegina).
- `-- --converters <url> [<url> <url>]`: 1–3 Seiten über Jina und Firecrawl (kostet je Seite etwa 0,005 €), ohne Revier.
- `-- --voyage`: die zwei Test-Texte über Voyage, ohne Revier.
- `-- --nominatim <query> <tileId>`: eine Nominatim-Umkreissuche (kostenlos), ohne Revier.
- `-- --ai <classify-document|disambiguate-mention|extract-facts|extract-route> [--limit 1-5] [--max-eur 1]`: höchstens 5 echte Modellantworten zu den ersten Eingaben der Entwicklungsdatenbank (`DATABASE_URL`), synchron über die Anthropic-API, gebucht in `external_calls` und im Budget `anthropic`; bricht vor einer Antwort ab, deren Schätzung die Summe über `--max-eur` (Standard 1 €) brächte. Schreibt `test/fixtures/ai/<task>/<key>.json` nur mit Eingabe, Ausgabe, Modell und Datum (für `extract-facts` stecken die Chunk-Texte der Einheit in der Eingabe). Kosten: 5 Antworten `extract-facts` mit Sonnet etwa 0,15 €, `classify-document`/`disambiguate-mention` mit Haiku unter 0,01 €. Der Test `lib/ai/__tests__/recorded.test.ts` prüft jede aufgezeichnete `extract-facts`-Antwort gegen ihre Chunks (Belegtreue 1, Zahl verworfener Zitate als Annotation).
Aufgezeichnet werden keine Cookies und keine Client-IP-Header (`x-client-ip`, `x-analytics`); Fixtures vor dem Einchecken ansehen.

## Erwähnungen und Facts
Erwähnungen, Facts mit wörtlichem Zitat, Routen, Modellvergleich (M4). Checkliste der Abnahme: `docs/pilot/m4-abnahme.md`. Schlüssel: `ANTHROPIC_API_KEY` (Klassifikation, Disambiguierung, Extraktion über die Batch-API); Budget `anthropic` 20 €/Tag in `config/budgets.json`. Ein Text-Lauf hat sieben Stufen: Klassifikation, Abgleich der Namen, Disambiguierung, neue Namen (Nominatim), Extraktion der Facts, Routen, Belegtreue-Prüfung (`extraction.check`).

### Reihenfolge nach dem M3-Crawl
1. **„Neue Texte auswerten“** (Quellen-Liste: wirkt für alle Quellen; Quell-Seite: nur für diese Quelle): ein Text-Lauf über jede aktuelle Version, die der Abgleich mit der jetzigen Konfiguration noch nicht gesehen hat. Je Kachel geht es auch über „Texte auswerten“ auf der Kachel-Seite, je Revier unter „Läufe“. Der Lauf friert seine Versionen beim Start ein; was danach ankommt, nimmt der nächste Lauf. Die Batch-Stufen warten auf die Anthropic-Batch-API (bis zu 24 h, `config/models.json` `batch.maxHours` 26); die Laufseite zeigt je Stufe den Stand und unter „Extraktionsläufe“ Facts, verworfene Zitate, Belegtreue und Kosten.
2. **Neue Namen prüfen** (Prüfen → Ortskandidat): ein Name in mindestens zwei Dokumenten verschiedener Quellen bekommt eine Nominatim-Umkreissuche und eine Aufgabe. „Ort anlegen“ oder „Namen zuordnen“ startet einen Abgleich-Lauf (`rematch`) für die aktuellen Versionen der Fundstellen, auch wenn der Name in einem aus einer älteren Version übernommenen Abschnitt steht; scheitert dessen Start (Meldung im Log, die Entscheidung bleibt), übernimmt der nächste Kachel-Lauf die Versionen. Ein so angelegter Ort bekommt Geometrie und Ausschlussprüfung erst im nächsten Geometrie-Lauf seines Reviers (Ruling M4-F-R2): danach unter „Läufe“ „Geometrie für Revier“ starten.
3. **Modellvergleich anlegen und starten**: `npm run compare:models -- --label pilot --start` (auf dem Server: `dc run --rm worker node --import tsx scripts/compare-models.ts --label pilot --start`) oder unter „Modellvergleich“ „Vergleich anlegen“ und „Lauf starten“. Die Stichprobe sind 200 Einheiten (Version, Objekt) reihum über Dokumenttypen und Quellen; Hinweise nennen fehlende Quellen (< 8) oder Dokumenttypen. Das Skript zeigt Einheiten, Quellen, Dokumenttypen und die Kostenschätzung und legt nichts an, wenn die Schätzung über `--max-eur` (Standard 15 €) liegt; der Start wird außerdem abgelehnt, wenn die Schätzung nicht mehr in den heutigen Spielraum des Budgets `anthropic` passt (das Skript nennt dann den Grund und die Vergleichs-ID; der Vergleich bleibt und lässt sich später unter „Modellvergleich“ mit „Lauf starten“ starten). Erwartet: etwa 4–5 € Sonnet und 8–9 € Opus nach der (hohen) Schätzung mit 4000 Ausgabe-Token je Einheit, zusammen etwa 13 €, tatsächlich meist deutlich weniger; den Lauf an einem Tag ohne andere Anthropic-Ausgaben starten.
4. **50 Abweichungen bewerten** (Navigation „Modellvergleich“): nach dem Lauf je Eintrag die Werte und Zitate beider Modelle nebeneinander, Urteil mit den Knöpfen 1–5 („A richtig“, „B richtig“, „Beide richtig“, „Beide falsch“, „Unklar“); der Kopf zählt „n von 50 bewertet“. Ein zweites Urteil ersetzt das erste.
5. **Bericht**: `npm run report:models -- <comparisonId>` schreibt `docs/pilot/m4-modellvergleich.md` (auf dem Server: `dc run --rm -v /tmp/pilot:/out worker node --import tsx scripts/model-report.ts <comparisonId> --out /out/m4-modellvergleich.md`, Datei nach `docs/pilot/` holen) und einchecken.
6. **Entscheidung**: in `config/models.json` unter `tasks.extract-facts` `model` setzen, `decision.status` auf `"decided"` und `decision.note` mit Begründung (Bericht); einchecken und deployen. Mit der Entscheidung zählt der Vergleichslauf des gewählten Modells als aktiver Lauf seiner Einheiten (NOTE T19); die Facts des anderen Modells bleiben und zählen nie.
7. **Reprozessieren, falls das Modell wechselt** (oder Prompt oder Fact-Schema): je Revier unter „Läufe“ „Reprozessieren für Revier (Stufen 6–7)“, je Kachel auf der Kachel-Seite. Ein Reprozess-Lauf extrahiert jede Erwähnung neu in einen neuen Extraktionslauf; alte Facts bleiben, aktiv ist der jüngste geprüfte Lauf mit der aktiven Konfiguration. Routen zahlt nur ein Reprozess-Lauf erneut.
8. **Abnahme-Prüfung**: `npm run check:texts` (auf dem Server: `dc run --rm worker node --import tsx scripts/check-texts.ts`). Ausgabe: Belegtreue über alle Extraktionsläufe, gesperrte Extraktionsläufe, Modellentscheidung, Erwähnungen und Anteil ohne Modellaufruf (Soll > 70 %), Kosten je Erwähnung (Anthropic der Text-Läufe ohne Vergleich / Erwähnungen), Routen (jeder Stopp einem Objekt zugeordnet, Stopps ohne Objekt; das ist nicht die Kennzahl „Routen-Rekonstruktion“ unter `/quality`, die nur Stopps an bestätigten Orten zählt), Messung der Kachelgrenzen (nicht zugeordnete Namen der letzten 30 Tage, davon mit `neighbourRing` 2 gefunden; Trockenlauf). Exit 1 bei Belegtreue < 100 %, einem gesperrten Lauf, vorläufiger Modellentscheidung oder Anteil ≤ 70 %.

### Budget-Stopp bei Batches
Vor jeder Einreichung prüft die Stufe das Budget `anthropic` (heutige Ausgaben plus Reservierungen offener Batches) und reicht nur so viele Einheiten ein, wie hineinpassen; der Rest geht in einen Folge-Job. Die Reservierung je Einheit ist die volle Ausgabe-Obergrenze (`maxTokens` 16.000 × Ausgabepreis × 0,5, mit Sonnet etwa 0,07 €), abgerechnet werden meist etwa 0,02 €: bei 20 €/Tag sind also nur etwa 270 Sonnet-Einheiten gleichzeitig reserviert, und ein großer Text-Lauf verteilt sich über Stunden (jeder gebuchte Batch gibt seine Reservierung frei). Ein Abhol-Job (`ai.batch.poll`) versucht es bei Fehlern 8-mal mit wachsendem Abstand (zusammen mindestens etwa 2 Stunden), bevor er aufgibt; ein Ausfall des Anbieters von bis zu einer Stunde braucht also keinen Eingriff. Passt nichts mehr, wird der Job zurückgestellt und die Einreich-Queue pausiert bis zum nächsten Tag (UTC). Die Queue `ai.batch.poll` läuft weiter: eingereichte Batches werden abgeholt, gebucht und verteilt. Unter „Jobs“ die pausierte Queue am Folgetag oder nach einer Budget-Erhöhung „Fortsetzen“.

### Gesperrter Extraktionslauf (Belegtreue < 100 %)
Die Prüfung `extraction.check` prüft jedes Zitat erneut gegen seinen Chunk. Fällt eines durch, steht der Extraktionslauf auf „Gesperrt“ (Laufseite, Tabelle „Extraktionsläufe“, rot, mit Grund und den ersten Fehlern); seine Facts bleiben, zählen aber nie (kein aktiver Lauf, keine Konsolidierung in M5). Vorgehen: den Fall auf der Dokumentseite (Reiter „Erwähnungen und Zitate“) ansehen. Ist das Zitat wirklich nicht im Text (Fehler im Code), Issue anlegen und den Lauf gesperrt lassen; nach dem Fix das Revier reprozessieren. „Ergebnisse nach der Prüfung eingetroffen“ (ein von Hand wiederholter Batch-Job), „Lauf von Hand beendet“ und „Lauf fehlgeschlagen, vor der Prüfung“ (eine Stufe des Laufs ist ganz gescheitert, z. B. die Routen-Stufe bei einem Ausfall; die bezahlten Facts bleiben) hebt „Belegtreue neu prüfen“ auf der Laufseite auf, wenn alle Zitate stimmen; „Belegtreue unter 100 %“ bleibt gesperrt, solange die Fehler bleiben. Nie einen gesperrten Lauf von Hand in der Datenbank freischalten.

### Hängender Text-Lauf
Ein Text-Lauf, der nach einem Absturz nicht weiterkommt, wird wie ein Crawl-Lauf mit „Lauf beenden“ beendet: offene Batches werden beim Anbieter abgebrochen (bezahlte Antworten werden noch gebucht), offene Einheiten scheitern, ihre Erwähnungen stehen auf „Fehlgeschlagen“ und werden nur durch Reprozessieren erneut extrahiert; noch nicht geprüfte Extraktionsläufe stehen auf „Gesperrt“ (Lauf von Hand beendet). Eine Abgleich-Erwähnung, die ein hängender Lauf beansprucht hat, wartet bis zu diesem „Lauf beenden“. Scheitert das Aufräumen nach dem Beenden (z. B. Job-Queue oder Datenbank kurz nicht erreichbar, die Seite zeigt einen Fehler), bietet die Laufseite **„Aufräumen wiederholen“** an, bis das Aufräumen einmal vollständig durchgelaufen ist; jeder Schritt ist wiederholbar. Läufe, die vor dieser Funktion beendet wurden, markiert Migration 0051 als aufgeräumt, wenn nichts offen geblieben ist (keine offene Einheit, kein ungeprüfter laufender Extraktionslauf, kein offener Batch); nur bei den übrigen erscheint der Knopf.

## Konsolidierung
Stufe 8 (M5): aus allen Facts eines Geo-Objekts ein versioniertes Profil mit Wert, Konfidenz und Herkunft je Attribut, Konflikten, Lückenliste, Änderungsereignissen und einer Kurzbeschreibung (`summary.de`). Checkliste der Abnahme: `docs/pilot/m5-abnahme.md`. Regeln und Parameter: `config/consolidation/<version>.json`, aktiv ist die Version in `config/consolidation/active.json` (Seite „Einstellungen“ zeigt sie). Ein Konsolidierungslauf hat drei Stufen: `consolidation.geo` (je Objekt ein Job), `consolidation.summary` (Kurzbeschreibung je geändertem Profil, Sonnet, synchron, höchstens 3 Versuche) und `consolidation.followup` (gezielte Quellenfindung für Orte mit weniger als 2 Dokumenten, DataForSEO, Abklingzeit 90 Tage je Ort, höchstens 30 Orte je Lauf). Kosten: Summary nach Schätzung etwa 0,02 € je geändertem Profil (Budget `anthropic` 20 €/Tag); eine volle Quellenfindung für 12 Kacheln etwa 540 Suchen ≈ 1,90 € (Budget `dataforseo` 10 €/Tag).

### Reihenfolge je Revier (Pilot: `saronic`, danach `argolic`)
1. **Läufe → „Datensätze laden“** (Revier wählen): lädt alle Datensätze; neu für M5 sind nur die Wikidata-Sitelinks (für die Bedeutung von Inseln, Kaps und POIs). Straßen und die Ruhe-Rechnung gibt es seit M2 unverändert (`config/geometry.json` bleibt bei `geometry-1`). Unveränderte Datensätze erzeugen keine neue Version; Sitelinks, die jünger als 30 Tage sind, werden nicht neu abgefragt (`config/datasets.json`).
2. **Kein Geometrie-Lauf nötig** (Ruling M5-P1): Sitelinks wirken erst bei der Konsolidierung.
3. **Konsolidieren**:
   - **Automatisch nach jedem Text-Lauf**: der Text-Lauf hängt `consolidation.geo` an und konsolidiert die Objekte mit Facts oder Erwähnungen seiner eingefrorenen Versionen. Ist die Belegtreue eines seiner Extraktionsläufe unter 100 % (oder ist einer gesperrt oder läuft noch), plant die Stufe keine Jobs; die Laufseite zeigt „Konsolidierung gesperrt: Belegtreue unter 100 %“.
   - **Je Revier**: `npm run consolidate -- --area saronic` (auf dem Server: `dc run --rm worker node --import tsx scripts/consolidate.ts --area saronic`): alle gültigen Objekte der Küstenkacheln des Reviers, die Facts aufnehmen können (auch solche ohne einen einzigen Fact). Das ist der erste Lauf nach dem Gazetteer, für Orte ohne Text-Facts und nach einem Regelwechsel.
   - **Je Kachel**: Kachel-Seite → „Konsolidieren“ (oder `--tile <id>`).
   - **Je Ort / Geo-Objekt**: Ort-Seite oder Geo-Seite → „Profil neu berechnen“.
   - **Nach Geometrie und Ortsentscheidungen**: ein Geometrie-Lauf und jede Entscheidung über einen Ortskandidaten konsolidieren ihre Orte selbst (Abschnitt „Geometrie“).
   - **Vergleichssatz**: `npm run consolidate -- --comparison-set saronic` (die Orte des Vergleichssatzes auf „Qualität“).
   Wiederholen schadet nicht: ein Objekt mit unveränderten Werten und Konfidenzklassen bekommt keine neue Version.
4. **Review**: unter „Prüfen“ `conflict` (Wert A, Wert B, „Beide (saisonal)“, „Offen lassen“), `uncertain_change` („Übernehmen“, „Verwerfen“) und fehlgeschlagene Summaries abarbeiten (siehe unten). Jede Profil-Entscheidung startet nach dem Commit einen Konsolidierungslauf für das Objekt; die Entscheidung selbst konsolidiert nie.
5. **Abnahme-Prüfung**: `npm run check:profiles -- --area saronic` (auf dem Server: `dc run --rm worker node --import tsx scripts/check-profiles.ts --area saronic`). Ausgabe: Objekte (bestätigte Orte; Reviere, Inseln, Kaps/Meerengen, POIs in den Küstenkacheln), davon mit Profil, Objekte ohne Profil (Name, ID, Ebene), Profile mit einem Attribut ohne Herkunft oder Regel, offene Konflikte und unsichere Änderungen, Summaries der jüngsten Versionen (ok, leer), Profil zum Datum. Exit 1, wenn das Revier kein einziges Objekt hat (Gazetteer nicht gelaufen, Kacheln ohne Küste), solange ein Objekt kein Profil hat, ein Attribut ohne Herkunft ist (ohne Regel, oder ein Text-, Rechen- oder Review-Wert, der weder Fact noch Berechnung noch POI nennt) oder `profileAsOf` für den Tag vor einer späteren Version nicht die frühere Version liefert. Offene Konflikte und Unsicherheiten zählt die Prüfung nur. Ein Objekt ohne Profil: zuerst „Profil neu berechnen“; wird es übersprungen, prüfen, ob es gültig ist und sein Ort nicht abgelehnt oder zusammengelegt.

### Gesperrte Konsolidierung und Nachholen
- **Belegtreue < 100 %** sperrt die Konsolidierung des Laufs doppelt: Facts gesperrter Extraktionsläufe sind nie aktiv, und `consolidation.geo` plant keine Jobs. Vorgehen wie unter „Gesperrter Extraktionslauf“. Hebt **„Belegtreue neu prüfen“** die Sperre auf, startet die Aktion nach dem Commit selbst einen Konsolidierungslauf über die Ziele des Text-Laufs.
- **„Konsolidierung nachholen“** (Laufseite, bei „Konsolidierung übersprungen: …“): startet die übersprungene Konsolidierung genau einmal, sobald nichts mehr sperrt. Meldungen: „Belegtreue weiter unter 100 % – zuerst ‚Belegtreue neu prüfen‘“ oder „kein Geo-Objekt des Laufs lässt sich konsolidieren“. Der Knopf verschwindet, wenn das Nachholen begonnen hat; scheitert der Start, kommt er zurück.
- **Verwaister Lauf auf „Wartend“**: scheitert nach einer Entscheidung oder einem Start das Einreihen der ersten Stufe, bleibt eine Laufzeile ohne Jobs stehen (die Seite meldet „Die Konsolidierung konnte nicht gestartet werden“). Auf der Laufseite **„Lauf beenden“** und die Konsolidierung neu starten (Ort: „Profil neu berechnen“).

### Profil-Entscheidungen
- Die Aufgabe zeigt die Werte und Zitate beider Seiten. Läuft zwischen Laden und Klick eine Konsolidierung und ändert den Schlüssel oder tauscht die Seiten, lehnt die Entscheidung ab: „Der Wert hat sich geändert – bitte neu laden“. Neu laden und neu entscheiden; nichts ist gespeichert.
- „Wert A“ / „Wert B“ / „Übernehmen“ schreiben einen Review-Fact (Konfidenz 0,95, altert nicht). Ein Text, der jünger ist als die Entscheidung, geht wieder durch die Regel.
- „Beide (saisonal)“ und „Offen lassen“ schreiben keinen Fact und gelten **dauerhaft für dieses Wertepaar**; neue Facts ergeben einen neuen Schlüssel und damit eine neue Aufgabe. Ebenso „Verwerfen“ bei `uncertain_change`.
- Offene Aufgaben, deren Entwurf ein späterer Lauf nicht mehr erzeugt, schließt die Konsolidierung selbst (`dismissed`, überholt).
- Wird ein Ort abgelehnt oder zusammengelegt (oder endet sein Objekt), schließt der Folgelauf dessen offene Konflikt- und Unsicherheits-Aufgaben (`dismissed`, Grund `object_ended`); sein letztes Profil bleibt als Historie stehen und wird nie ausgeliefert.

### Sicherheitsregeln (Verbote, Gefahren, Sperrzonen)
- **Ein Verbot (`prohibitions`) wird nie durch Weglassen aufgehoben**: ein Text, der eine andere Art nennt oder ein Verbot nicht mehr erwähnt, entfernt nichts. Eine Text-Art fällt nur durch „Eintrag entfernen“ (genau diese Art) weg, eine berechnete durch eine neuere Berechnung (amtliche Sperrfläche entfällt). Eine Review-Liste verdrängt nie einen Text: eine angenommene Liste (Konflikt oder unsichere Ergänzung) fügt nur hinzu; nur „Übernehmen“ einer „Unsicheren Änderung“, deren Vorschlag Arten nicht mehr nennt, entfernt genau diese Arten (nächster Punkt). Ein später gefundener Text, der älter datiert ist als eine Entfernung (z. B. ein Revierführer von 2025, erst 2027 gecrawlt), bringt seine eigenen Arten ein; die entfernte Art kommt nur mit einem Text zurück, der jünger als die Entfernung ist. Damit ist die Entfernung für diese Art verbraucht: zählt der jüngere Text später nicht mehr (Modell- oder Prompt-Wechsel, Reprozessieren), entfällt die Art nicht wieder, sondern bleibt „in Prüfung“ mit einer Aufgabe „Unsichere Änderung“ (GR-12). Das gilt ebenso für Gefahren und Sperrzonen.
- **Sicherheitslisten (`hazards`, `restricted_zones`, `prohibitions`) verlieren Einträge nur über „Eintrag entfernen“** im Reiter „Profil“ (mit Rückfrage „Wirklich entfernen?“) oder über „Übernehmen“ einer Aufgabe „Unsichere Änderung“, deren Vorschlag den Eintrag nicht mehr nennt. „Eintrag entfernen“ schreibt einen Review-Fact `{ remove: <Eintrag> }` (bei Verboten `{ remove: { kind } }`, genau eine Art), „Übernehmen“ `{ remove: [<Einträge>] }`; beide starten einen Lauf für das Objekt. Ohne Review gehen nur Einträge einer beendeten oder abgelehnten Quelle (sofort) und berechnete Verbote, die die neueste Berechnung nicht mehr hat. Fehlt ein Text-Eintrag in einem neueren Lauf (Modell- oder Prompt-Wechsel, Reprozessieren, auch bei einer Berechnung mit leerer Liste), bleibt er mit Markierung „in Prüfung“, und eine Aufgabe „Unsichere Änderung“ fragt (GR-1). Mehrere Entfernungen hintereinander oder gleichzeitig wirken jede für sich. Berechnete Verbote (aus Sperrflächen) sind nicht entfernbar; dafür die Sperrfläche pflegen („Ankerverbots-Gebiete pflegen“). Eine Ergänzung einer Sicherheitsliste ist immer `changed` mit Severity `safety`, nie „unsicher“.
- „Eintrag entfernen“ legt intern eine sofort entschiedene Aufgabe `uncertain_change` mit Subjekt `profile_entry` an. Auswertungen entschiedener `uncertain_change`-Aufgaben zählen nur `subject_type = 'profile_attribute'`.

### Summaries
- Die Kurzbeschreibung entsteht nur bei geändertem Profil, ausschließlich aus Profilwerten. Übernimmt sie 15 Wörter am Stück aus einem Zitat, wird sie mit Hinweis neu erzeugt (höchstens 2-mal); danach bleibt sie leer und öffnet unter „Prüfen“ eine Aufgabe (fehlgeschlagener Job) mit **„Neu erzeugen“** (startet einen Lauf nur mit `consolidation.summary` für das Objekt) oder **„Ignorieren“**. Eine später gelungene Summary schließt die Aufgabe.
- **„Summary neu erzeugen“** im Reiter „Profil“ (Ort-Seite und Profil-Abschnitt der Geo-Seite, nur bei der neuesten Version): startet einen Lauf nur mit `consolidation.summary`, der die Summary der neuesten Profilversion neu schreibt, auch wenn schon eine `ok`-Summary existiert (z. B. eine, die die Paket-Prüfung `verbatim_text` ablehnt, weil sie Text aus einem anderen Dokument des Archivs übernimmt). Die neue Summary steht neben der alten (je Prompt-Version und Lauf eine `ok`-Summary, Migration 0043); angezeigt und geliefert wird die neueste. Scheitern alle Versuche, bleibt die alte stehen und eine Aufgabe „fehlgeschlagener Job“ öffnet sich.

### Regeln ändern
1. Neue Datei `config/consolidation/v2.json` (Kopie der aktiven Version, Änderungen, `version: "v2"`); die aktive Datei nie ändern, sobald Profile mit ihr existieren.
2. Bewertungslauf über den Vergleichssatz: `npm run consolidate -- --comparison-set saronic --evaluation --rules v2` (Server: `dc run --rm worker node --import tsx scripts/consolidate.ts --comparison-set saronic --evaluation --rules v2`; im Code `startConsolidationRun({ scope: { comparisonSetArea }, evaluation: true, rulesVersion: "v2" })`). Er schreibt nur `evaluation_profiles`, keine Profile, Ereignisse, Aufgaben, Summaries oder Folgeaufträge. Seit M7 startet ihn auch „Qualität“ → „Regression“ → „Bewertung starten“ (Abschnitt „Regression“ unten).
3. Aktivieren seit M7 auf „Qualität“ → „Regression“ → „Aktivieren“ (nur wenn Übereinstimmung und Abdeckung nicht sinken und an keinem Ort des Vergleichssatzes ein Verbot, eine Gefahr, ein Sperrgebiet oder ein Ausschluss entfällt); die wirksame Regelversion steht dann in `config_activations` und gilt sofort, `config/consolidation/active.json` ist nur noch der Rückfall ohne Aktivierung. Danach je Revier `npm run consolidate -- --area <key>`. Jedes Objekt mit geänderten Werten oder Klassen bekommt eine neue Version mit `rules_version` v2.

## Lieferung
Stufe 9 (M6): je Revier ein Paket nach dem „Periplus Data Contract“ (`contract/v1/`, JSON-Schemas unter `contract/schema/1.0/`), gebaut, geprüft und in S3 abgelegt (`deliveries/<ar_…>/<dataVersion>/<datei>`), abrufbar über die Liefer-API `/api/v1`. Checkliste der Abnahme: `docs/pilot/m6-abnahme.md`.

> **ODbL:** `coast.geojson`, OSM-Namen und Regionspolygone stehen unter ODbL (im Manifest unter `licenses` ausgewiesen). Bis die ODbL-Trennung (Teil-Spec 08 „Lizenz und ODbL“) rechtlich geprüft ist, gehen Pakete **nur an interne Abnehmer**: keinen API-Schlüssel an Dritte ausgeben.

### Reihenfolge je Revier (Pilot: `saronic`, danach `argolic`)
1. **Voraussetzung Profile** (M5, Abschnitt „Konsolidierung“): `npm run check:profiles -- --area saronic` (Server: `dc run --rm worker node --import tsx scripts/check-profiles.ts --area saronic`) endet mit Exit 0.
2. **„Lieferungen“ → „Paket bauen“** beim Revier: startet einen Lauf mit der Stufe `delivery.build` und öffnet seine Laufseite.
3. **Bericht prüfen**: „Lieferungen“ → Zeile des Baus. Status „Gültig“ (neue Version, Dateien gespeichert, über die API abrufbar), „Unverändert“ (gültig, aber nichts geändert: keine neue Version, keine Dateien) oder „Abgelehnt“ (mindestens eine der 16 Prüfungen mit Verstoß; die Dateien bleiben unter `deliveries/<ar_…>/rejected/<id>/` zur Diagnose, das Revier liefert weiter das letzte gültige Paket). Die Detailseite zeigt jede Prüfung mit Fundstellen (Objekt-IDs verlinken auf Ort- oder Geo-Seite), die Warnungen (was ausgelassen wurde; sie blockieren nicht), die Änderungen (`changes.json`, ab dem zweiten Paket) und die Dateien zum Herunterladen. Der Reiter „Lieferung“ einer Ort-Seite zeigt das gelieferte Vertragsobjekt und eine Vorschau des nächsten Pakets.
4. **Verstöße beheben** (unten), dann erneut „Paket bauen“.
5. **Abnehmer-Prüfung** (unten): `delivery:consume` gegen den Server endet mit `OK`.

### Verstöße beheben
| Prüfung | Abhilfe |
| --- | --- |
| Keine zwei Spots derselben Art näher als 150 m (`spot_duplicates`) | Ort-Seite → **„Mit Ort zusammenlegen“**: der Ort wird Teil des gewählten bestätigten Orts (Status abgelehnt, Grund zusammengelegt; seine Facts gehen an den Ziel-Ort, der danach konsolidiert wird). Im nächsten Paket steht der alte Spot mit `mergedInto`. Ausgeschlossene Spots zählen nicht. |
| Kein Text länger als 15 Wörter aus einer Quelle (`verbatim_text`) | Betrifft fast immer eine Summary (Fundstelle `/spots/<i>/summary/de` bzw. `/highlights/<i>/summary/de`): Ort- bzw. Geo-Seite → Reiter „Profil“ → **„Summary neu erzeugen“** (Abschnitt „Summaries“ oben), Lauf abwarten, dann erneut „Paket bauen“. Bleibt die neue Summary leer (Aufgabe „fehlgeschlagener Job“), geht der Befund an Christian. |
| Spot in der Bounding Box und höchstens 1,5 sm von Wasser (`spot_location`) | Geprüft wird der **Punkt des Orts** (`spot.position` = `places.position`), nicht die Ankerposition. Ort-Seite → Reiter „Geometrie“ → Abschnitt „Ort“ → **„Position korrigieren …“**: Breite und Länge eintragen (höchstens `geometry.anchorArea.correctionMaxDistanceM`, 2000 m, vom bisherigen Punkt; die Entscheidung wird als Review-Aufgabe `place_position` festgehalten), danach startet ein Geometrie-Lauf (oder, ohne Geometrie-Eingaben, ein Konsolidierungslauf). Die Ankerposition korrigiert die Karte desselben Reiters („Ankerposition übernehmen“); sie ändert `spot_location` nicht. Ist der Ort eine Dublette: „Mit Ort zusammenlegen“. |
| Keine fremden Inhalte (`foreign_content`) | Ein gelieferter Wert eines Spots, Highlights oder einer Region zitiert ein Dokument auf einer verbotenen Domain (`forbiddenDomains` in `config/delivery.json`, `google.*` heißt Google unter jeder öffentlichen Endung wie `google.co.uk`; auch ein nicht mehr erreichbares), oder ein Text nennt eine solche Domain. Quellen auf diesen Domains lassen sich seit M6 nicht freigeben; ein Treffer heißt, eine wurde vorher freigegeben. Abhilfe: Quelle öffnen (die Fundstelle nennt die URL, die Dokumentseite die Quelle) → **„Quelle beenden …“** (Abschnitt „Quelle pausieren und fortsetzen“): ihre Facts zählen nicht mehr, und ein Konsolidierungslauf für die betroffenen Objekte startet; ein Wert, der nur auf ihr beruht, fällt weg. Nennt eine Summary die Domain: „Summary neu erzeugen“. Bleibt ein Wert als „unsicher“ stehen (eine andere Quelle sagt etwas anderes, die alte Herkunft hängt noch an einer offenen Aufgabe), die Aufgabe unter „Prüfen“ entscheiden. |
| Schutz (`shelter`) bei Häfen und Marinas | Ein Hafen oder eine Marina braucht mindestens 0,8 je Sektor, sonst muss die Herkunft des Schutzes Text, Beobachtung oder Review sein (`harbourShelterSources` in `config/delivery.json`). Ein Wert darunter aus Rechnung allein: Befund an Christian. |
| übrige Prüfungen (Schema, IDs, Referenzen, Grenzen, Saison, Datenversion, `changes.json`) | Fehler im Bau, nicht in den Daten: Bericht und Log (`delivery rejected`) an Christian. |

Warnungen (nicht blockierend) nennen u. a. Spots ohne Profil oder mit unvollständigem Schutz (nicht geliefert; „Profil neu berechnen“), Objekte ohne Namen, Highlights ohne Spot im Radius und zusammengelegte Spots, deren Ziel nicht im Paket ist. Dazu zwei Sicherheits-Warnungen:
- **„Sperrgebiet laut Text nicht geliefert: …“** (Region) bzw. **„Gefahr laut Text nicht geliefert (<Kap/Enge>): …“** (Wetterpunkt): Sperrzonen eines Reviers oder einer Insel und Gefahren eines Kaps oder einer Enge, die nur aus Text bekannt sind, haben in Teil B kein Feld und stehen weder in `regions.json` noch in `coast.geojson`. Ist die Zone für die Routenplanung wichtig, als Ausschlussfläche erfassen („Ankerverbots-Gebiete pflegen“), dann erscheint sie als `restrictedArea`.
- **„Liegt in einem militärischen Sperrgebiet des Pakets …, ist aber nicht ausgeschlossen“** (Spot): der Spot liegt in einer `restrictedArea` mit Grund `military` des eigenen `coast.geojson`. Profil und Status des Orts prüfen („Profil neu berechnen“, Reiter „Geometrie“ → Ausschlussflächen).

### Bau (Technik)
Stufe 9 (M6): Lauf „Paket bauen“ je Revier (Stufe `delivery.build`, ein Job). Der Bau nimmt die Revier-Sperre (`pg_advisory_xact_lock`), liest alles aus einem Snapshot (eigene Transaktion, REPEATABLE READ, nur lesend), legt die Dateien in S3 ab und schreibt dann die Zeile `deliveries`. Ein abgelehntes Paket (eine Prüfung schlägt fehl, auch bei unverändertem Inhalt) steht im Log als Warnung „delivery rejected“ mit den fehlgeschlagenen Prüfungen und unter `deliveries/<ar_…>/rejected/<id>/`; das Revier liefert weiter das letzte gültige Paket.
- **Pool und Nebenläufigkeit**: ein Bau hält zwei Verbindungen des Pools (Sperr-Transaktion und Lese-Snapshot); der Pool hat 10 Verbindungen (`pg`-Standard), die sich alle Queues eines Workers teilen. `concurrency` von `delivery.build` (`config/queues.json`, Pilot 1) mal Anzahl der Worker bleibt deutlich unter der Poolgröße. Wartet ein Bau länger als `build.lockTimeoutMs` (`config/delivery.json`, 5 min) auf die Revier-Sperre, bricht er mit `lock_not_available` ab und der Job wird wiederholt; so halten wartende Bauvorgänge ihre Verbindungen nie dauerhaft. Ein Job läuft höchstens `expireInSeconds` 3600 s.

### API-Schlüssel für Abnehmer
```bash
npm run apikey:create -- <abnehmer> --scope delivery:read
# Server:
dc run --rm worker node --import tsx scripts/apikey.ts create <abnehmer> --scope delivery:read
```
Der Schlüssel (`pk_…`) wird nur einmal ausgegeben. Sperren: „Einstellungen“ → „API-Clients“ → „Sperren“ (wirkt sofort, nicht umkehrbar) oder `npm run apikey:revoke -- <abnehmer>`. Rate-Limit je Schlüssel: `api_clients.rate_limit_per_min` (Standard 60 je Minute, darüber 429).

### Liefer-API
Alle Endpunkte unter `/api/v1` brauchen `Authorization: Bearer pk_…` mit Scope `delivery:read`. Antworten tragen `ETag` (mit `If-None-Match` → 304), `Cache-Control: private, max-age=60`, `Periplus-Schema-Version` und, wo es eine gibt, `Periplus-Data-Version`. Fehler kommen als `{ "error": { "code", "message" } }` mit 400/401/403/404/429/500. `<area>` ist der Revier-Schlüssel (`saronic`) oder die öffentliche ID (`ar_…`). Nur gültige Pakete werden ausgeliefert.

```bash
read -rs PERIPLUS_API_KEY && export PERIPLUS_API_KEY   # pk_… einfügen, Enter: nicht in der Shell-History; nie in Dateien oder Tickets schreiben
H="Authorization: Bearer $PERIPLUS_API_KEY"
curl -sH "$H" https://<domain>/api/v1/areas                                        # Reviere mit aktueller dataVersion, bbox, Bauzeit
curl -sH "$H" https://<domain>/api/v1/areas/saronic/package                        # Manifest des aktuellen Pakets mit links je Datei
curl -sH "$H" https://<domain>/api/v1/areas/saronic/package/spots.json             # eine Datei des aktuellen Pakets
curl -sH "$H" "https://<domain>/api/v1/areas/saronic/package/spots.json?dataVersion=1"   # Datei eines älteren Pakets (Archiv)
curl -sH "$H" "https://<domain>/api/v1/areas/saronic/changes?since=1"              # Änderungen nach Version 1 bis heute, je Objekt zusammengefasst
curl -sH "$H" "https://<domain>/api/v1/spots/sp_…?asOf=2026-11-01"                 # ein Spot, wie er an diesem Tag geliefert war
curl -sH "$H" https://<domain>/api/v1/schema/1.0/spots.schema.json                 # JSON-Schema einer Datei
```
- **`changes?since=<n>`**: `n` von 1 bis zur aktuellen Version (`n` = aktuelle Version → leere Liste); sonst 400 `invalid_since`. Eine App, die Version `n` hat, holt damit alles bis zur aktuellen.
- **`spots/<id>?asOf=YYYY-MM-DD`**: liest das Paketarchiv (die Spot-Version des Pakets, das an diesem Tag galt), keine Neuberechnung; ohne `asOf` die zuletzt gelieferte Version. Ein gespeicherter Törn bekommt so genau die Fassung zurück, auf die er verweist. Vor einem simulierten Revisit (M7) deshalb ein Paket bauen.
- Herunterladen in der Oberfläche: Detailseite eines Pakets → Dateien (Admin-Sitzung, kein Schlüssel nötig).

### Abnehmer-Prüfung
`delivery:consume` prüft ein Paket so, wie ein fremder Abnehmer es sieht, nur über die API: Manifest holen, jede verlinkte Datei laden, ihren SHA-256 mit dem Manifest vergleichen und sie mit eigenem Ajv (Draft 2020-12) gegen das Schema von `/api/v1/schema/<version>/<datei>` prüfen.
```bash
read -rs PERIPLUS_API_KEY && export PERIPLUS_API_KEY   # Schlüssel einfügen, Enter; erscheint weder am Bildschirm noch in der Shell-History
npm run delivery:consume -- --base-url https://<domain> --area saronic
unset PERIPLUS_API_KEY
```
Ein Schlüssel in der Befehlszeile (`--key pk_…` oder `PERIPLUS_API_KEY=pk_… npm run …`) landet in der Shell-History. Die Basis-URL darf einen Pfad haben (`https://<domain>/periplus`); Links des Manifests auf einen anderen Host ruft die Prüfung nicht ab (der Schlüssel geht nur an die Basis-URL), und bei `http://` außer `localhost` warnt sie, dass der Schlüssel unverschlüsselt übertragen wird.
Ausgabe je Datei `sha256 ok|MISMATCH  schema ok|<n> error(s)` mit den ersten Fehlern (JSON-Pointer), am Ende `OK` oder `FAILED` (Exit 1). Ein falscher Schlüssel, ein unbekanntes Revier oder ein Revier ohne gültiges Paket enden mit der Fehlermeldung der API und Exit 1.

### Neue Vertragsversion
Schritte für eine neue Version (z. B. `2.0`); die laufenden Pakete bleiben bis zum nächsten Bau bei ihrer Version:
1. Neues Verzeichnis `contract/v2/` (Kopie von `v1`, Änderungen), `CONTRACT_SCHEMAS` in `contract/index.ts` darauf umstellen, `SCHEMA_VERSION` in `contract/index.ts` und `schemaVersion` in `config/delivery.json` auf die neue Version.
2. `npm run contract:generate` schreibt die JSON-Schemas nach `contract/schema/<version>/` (ein Test vergleicht sie mit den zod-Schemas); einchecken. Das alte Verzeichnis bleibt.
3. Die neue Version in `contract/schema/published.ts` eintragen (ein Test verlangt für jedes Verzeichnis einen Eintrag). `/schema/<version>/…` liefert dann alte und neue Schemas, so dass ein archiviertes Paket (`?dataVersion=`) weiter gegen sein Schema prüfbar ist. Abnehmer vorher informieren, danach je Revier „Paket bauen“.

## Qualität und Pilot (M7)
Stufe 10 (Teil-Spec 10): Kennzahlen, Navily-Vergleich, Regression und simulierter Revisit. Ablauf des Piloten mit Kosten, Stopp-Bedingungen und Entscheidungen: `docs/pilot/m7-runbook.md`; Abnahme: `docs/pilot/m7-abnahme.md`. Migrationsstand nach M7: **0047** (`npm run db:migrate`; die Entwicklungsdatenbank stand auf 0038).

### Qualität messen
- „Qualität“ → Revier → Panel „Messen“: Bezeichnung („Lauf 1“, „Lauf 2“; je Revier einmalig, eine fehlgeschlagene Messung gibt sie frei), Fenster „von“/„bis“ (optional; ohne „von“ schließt die Messung an das Ende der letzten beendeten Messung an; die erste Messung eines Reviers braucht „von“ (Beginn des ersten Pilot-Laufs, nicht der älteste Lauf der Datenbank); „bis“ einschließlich, ohne „bis“ jetzt). Eine zweite Messung desselben Reviers wird verweigert, solange eine läuft.
- Die Messung ist ein Lauf `quality.measure`; ihre Werte stehen als Snapshots (`quality_snapshots`, nur anfügend, nur Zählwerte) je Kachel, Revier und Lauf und erscheinen auf dem Dashboard mit Zielwert und Status. Abnahme-Kennzahlen: `coverage_navily`, `multi_document`, Fact-Präzision, Belegtreue, Schutz-Konfidenz, Routen-Rekonstruktion, Kosten je Ort, Review-Aufwand (`review_minutes`, ohne Pseudo-Aufgaben und ohne Vergleichsabweichungen; eine Bearbeitung zählt höchstens 10 Minuten); dazu `coverage`, `multi_source`, `places_per_tile` (Ziel 10–40).
- Kosten je Ort: `external_calls` im Fenster; Kosten ohne Kachel- oder Revierbezug nach Anteil bestätigter Orte verteilt, Kacheln ohne Revier zählen für niemanden, Einmalkosten des Piloten getrennt.
- Nach dem ersten echten Text- oder Bewertungslauf prüfen, dass bezahlte Aufrufe einen Lauf tragen: `select service, stage, count(*) from external_calls where cost_eur > 0 and run_id is null and at > '<beginn>' group by 1, 2;` – erwartet leer (außer `smoke:ai`).

### Navily-Abgleich
- Die Navily-Datei liegt lokal außerhalb des Repos bzw. auf dem Server nur für die Dauer des Laufs außerhalb des Repos (wie Abschnitt „Geometrie und Ausschlüsse“, Schritt 5); gelesen über `NAVILY_SPOTS_PATH` oder `--navily <pfad>`. **Nie Navily-Werte eintragen** – weder in Reviews, Berichte, Commits noch Tickets; gespeichert werden nur Ergebnisse (`comparison_results`, nur anfügend) und Zählwerte.
- Erstdurchgang: `npm run compare:navily -- --area saronic --accept-proposals` (Server: `dc run --rm -v /tmp/navily:/data/navily:ro -e NAVILY_SPOTS_PATH=/data/navily/navily-spots.json worker node --import tsx scripts/compare-navily.ts --area saronic --accept-proposals`). Übernimmt die Vorschläge des Assistenten (`proposal_auto`, `navily-assistant/1`), nie über ein von Hand gesetztes Ergebnis.
- Danach `/quality/compare?area=saronic`: je Ort Vorschläge prüfen und bestätigen (Navily-Namen nur zur Laufzeit angezeigt); jede Abweichung öffnet eine Aufgabe „Vergleichsabweichung“ mit „Eigener Wert stimmt“, „Navily stimmt“, „Unklar“. Abweichungen eines Bewertungslaufs tragen in der Liste und im Detail das Kennzeichen „Bewertung“.
- Abdeckung: `npm run compare:navily -- --area saronic --coverage` schreibt `coverage_navily` in die neueste Messung des Reviers. Reihenfolge je Lauf: Navily-Abgleich und Review → Messen → `--coverage` als Letztes; danach nicht erneut messen (eine neue Messung hat `coverage_navily` nicht).

### Regression
- Neue Regelversion: `config/consolidation/v<n>.json` anlegen und deployen → „Qualität“ → „Regression“ → Regelversion wählen → „Bewertung starten“ (Bewertungslauf über den Vergleichssatz) → Vergleich alt/neu und die geänderten Werte prüfen (Abweichungen als Aufgaben „Bewertung“) → „Aktivieren“ → „Jetzt aktivieren“. Der Knopf erscheint nur, wenn Übereinstimmung und Abdeckung nicht sinken und kein Sicherheitswert entfällt (Eintrag in Verboten, Gefahren oder Sperrgebieten, oder ein aufgehobener Ausschluss: Grund „Sicherheitswert entfällt: …“); verweigert, wenn ein Ort des Vergleichssatzes nach der Bewertung ein neues Profil bekam (neu bewerten). Die Aktivierung gilt für alle Reviere.
- Prompt oder Modell: Modell und Prompt-Version wählen → „Bewertung starten“ (bewertet vorhandene Extraktionsläufe dieser Konfiguration, extrahiert nichts neu) → Freigabe („Jetzt aktivieren“) → Deploy von `config/models.json`. Erst der Deploy macht die Extraktion wirksam; „Einstellungen“ zeigt, ob die laufende Konfiguration freigegeben ist.

### Simulierter Revisit
Ein Klon der Datenbank (`periplus_sim`), ein eigener Worker und ein eigenes Archiv-Präfix (`S3_WRITE_PREFIX`); der Simulations-Adapter liefert für die Szenario-URLs die bearbeiteten Inhalte, für alle anderen URLs „unverändert“. Eine Simulation erreicht außer Anthropic und Voyage keinen externen Dienst. **Revisit frühestens am Tag nach dem letzten Paketbau**, sonst trennt `asOf` die Stände nicht. **Budget je Datenbank:** Der Sim-Worker prüft und bucht seine Anthropic- und Voyage-Kosten nur in `periplus_sim` (der Klon kopiert `external_calls` einmal, danach laufen beide Bücher getrennt). Das Tagesbudget der Entwicklungsdatenbank sieht diese Ausgaben nicht und umgekehrt, obwohl beide denselben Schlüssel nutzen: an einem Tag mit Simulation und Entwicklungs-Text-Lauf könnten zusammen bis zu zweimal `dailyEur` ausgegeben werden. Deshalb am Simulationstag keinen Text-Lauf und keinen Embedding-Lauf in der Entwicklungsdatenbank starten (erwartet für die Simulation: 1–3 €); die Simulation schreibt bewusst nie in die echte Datenbank.
- **Lokal** (Compose-Dienst `db`): Entwicklungs-Worker stoppen → `npm run sim:clone` (`-- --force` ersetzt einen Klon) → `.env.sim` aus `.env.sim.example` (übrige Werte aus `.env.local`, `S3_WRITE_PREFIX=sim/<datum>/`) → `npm run sim:draft-scenario -- --area saronic --out data/sim/scenario.json` → Szenario prüfen (Christian; nur unter `data/sim/`, nie einchecken; keine „neue Seite“) → `npm run sim:worker` → zweimal `npm run sim:revisit -- --area saronic --scenario data/sim/scenario.json` → Paket in der Simulation bauen → `npm run sim:verify -- --area saronic --scenario data/sim/scenario.json --base-url http://localhost:3001 --out docs/pilot/<datum>-revisit.json` mit dem Schlüssel der Simulation in `PERIPLUS_API_KEY` (nie `--key`; nur gegen `localhost`) (Exit 0: 10 von 10, keine unerwarteten, „asOf ok“).
- **Simulations-Web** nicht mit `next dev` im selben Ordner wie der Entwicklungsserver (Next 16 sperrt `.next/dev/lock`): eigener Worktree (`git worktree add ../periplus-sim HEAD`, dort `npm ci`, `.env.sim` als `.env.local`, `data/sim/scenario.json` kopieren, `npm run build && npx next start -p 3001`).
- **Server** (`docker/compose.prod.yml`, Dienst `postgres`): das Skript liegt nach dem Bootstrap nicht auf dem Server (nur `scripts/ops` und `scripts/deploy`), deshalb zuerst kopieren: `ssh deploy@<host> mkdir -p /opt/periplus/scripts/sim && scp scripts/sim/clone.sh deploy@<host>:/opt/periplus/scripts/sim/`; dann in `/opt/periplus`: `bash scripts/sim/clone.sh --env-file .env --compose-file docker/compose.prod.yml --service postgres --db-user <POSTGRES_USER>` (ohne `--env-file` bricht Compose an `${POSTGRES_PASSWORD:?}` ab); Sim-Worker und Sim-CLIs mit denselben drei Sim-Werten als Variablen über der `.env` des Servers, z. B. `dc run --rm -e DATABASE_URL=<…/periplus_sim> -e PERIPLUS_SIMULATION=/data/sim/scenario.json -e S3_WRITE_PREFIX=sim/<datum>/ -v /tmp/sim:/data/sim:ro worker node --import tsx worker/index.ts` (ebenso `scripts/sim/revisit.ts …` und `scripts/sim/verify.ts …`, jedes Mal dieselben Werte); das Szenario nur auf dem Server außerhalb des Repos ablegen (`/tmp/sim`) und danach löschen. Auf dem Server vorher prüfen, dass der Sim-Worker den echten Worker nicht ersetzt (eigener Container, `--rm`).
- **Aufräumen**: Sim-Worker und Sim-Web stoppen, `dropdb periplus_sim` (lokal `docker compose -f docker/compose.dev.yml exec db dropdb -U periplus periplus_sim`, Server `dc exec postgres dropdb -U <POSTGRES_USER> periplus_sim`), Präfix `sim/<datum>/` im Bucket löschen, Entwicklungs-Worker wieder starten.

### Berichte
- `npm run report:costs -- --area saronic --first "Lauf 1" --second "Lauf 2" [--revisit docs/pilot/<datum>-revisit.json]` → `docs/pilot/<datum>-kostenbericht.md` (Kosten je Stufe, Dienst, Ort und Lauf, Einmalkosten, Simulation, Hochrechnung Mittelmeer für 60–100 Reviere).
- `npm run report:pilot -- --area saronic --first "Lauf 1" --second "Lauf 2" [--revisit <datei>] [--cost-report <datei>] [--consumer-ok --data-version <n>]` → `docs/pilot/<datum>-pilotbericht.md` (Checkliste, Kennzahlen, Revisit, Review-Aufwand, Kachelgröße mit der Entscheidung).

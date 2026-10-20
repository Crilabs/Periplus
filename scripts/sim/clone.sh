#!/usr/bin/env bash
# Clones the Periplus database into periplus_sim for a simulated revisit (spec 10, plan Task 15, ruling M7-P27).
#   bash scripts/sim/clone.sh [--compose-file docker/compose.dev.yml] [--service db] [--source-db periplus]
#                             [--db-user periplus] [--force]
# Local pilot (ruling M7-P20): the defaults. Server: --compose-file docker/compose.prod.yml --service postgres.
# A relative --compose-file is read from the current directory; --source-db/--db-user must match ^[a-z_][a-z0-9_]*$.
# The target is always periplus_sim (not selectable). Stop the development worker first: pg_dump is consistent, but
# batches running at that moment would be cloned mid-flight. Steps, all inside the compose service:
#   pg_dump -Fc <source> → dropdb --if-exists periplus_sim → createdb periplus_sim → pg_restore --no-owner →
#   in periplus_sim: delete every pg-boss job (queue definitions stay) and write sim_meta (cloned_at, source_db,
#   from_seq = coalesce(max(change_events.seq), 0)), the point the verification reads the change feed from.
# Cleanup after the simulation: dropdb periplus_sim and the archive objects under the S3_WRITE_PREFIX.
set -euo pipefail

TARGET=periplus_sim
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO/docker/compose.dev.yml"
SERVICE=db
SOURCE_DB=periplus
DB_USER=periplus
FORCE=0

usage() {
  echo "usage: scripts/sim/clone.sh [--compose-file <file>] [--service <name>] [--source-db <name>] [--db-user <name>] [--force]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --compose-file) [ $# -ge 2 ] || usage; COMPOSE_FILE="$2"; shift 2 ;;
    --service) [ $# -ge 2 ] || usage; SERVICE="$2"; shift 2 ;;
    --source-db) [ $# -ge 2 ] || usage; SOURCE_DB="$2"; shift 2 ;;
    --db-user) [ $# -ge 2 ] || usage; DB_USER="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) usage ;;
  esac
done

# A relative --compose-file is read from the caller's working directory, before the cd to the repo root (M7-H-R1, M-4).
case "$COMPOSE_FILE" in
  /*) ;;
  *) COMPOSE_FILE="$PWD/$COMPOSE_FILE" ;;
esac
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Abbruch: Compose-Datei $COMPOSE_FILE nicht gefunden." >&2
  exit 1
fi

# Database and role names go into SQL literals and argv: plain lower-case identifiers only (M7-H-R1, M-4).
for name in "$SOURCE_DB" "$DB_USER"; do
  if ! [[ "$name" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "Abbruch: ungültiger Name „$name“ (erlaubt: a–z, 0–9, _; nicht mit einer Ziffer beginnend)." >&2
    exit 1
  fi
done

if [ "$SOURCE_DB" = "$TARGET" ]; then
  echo "Abbruch: Quelle und Ziel sind beide $TARGET – der Klon braucht eine andere Quelldatenbank." >&2
  exit 1
fi

cd "$REPO"
DC=(docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE")

exists="$("${DC[@]}" psql -U "$DB_USER" -d postgres -Atc "select 1 from pg_database where datname = '$TARGET'")"
if [ "$exists" = "1" ] && [ "$FORCE" -ne 1 ]; then
  echo "Abbruch: $TARGET existiert schon. Mit --force wird sie gelöscht und neu geklont." >&2
  exit 1
fi

DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT

echo "1/5 pg_dump $SOURCE_DB"
"${DC[@]}" pg_dump -U "$DB_USER" -Fc "$SOURCE_DB" > "$DUMP"
echo "2/5 dropdb $TARGET"
"${DC[@]}" dropdb -U "$DB_USER" --if-exists "$TARGET"
echo "3/5 createdb $TARGET"
"${DC[@]}" createdb -U "$DB_USER" "$TARGET"
echo "4/5 pg_restore nach $TARGET"
"${DC[@]}" pg_restore -U "$DB_USER" --no-owner -d "$TARGET" < "$DUMP"
echo "5/5 pg-boss-Jobs löschen, sim_meta schreiben"
"${DC[@]}" psql -U "$DB_USER" -d "$TARGET" -v ON_ERROR_STOP=1 -c "begin; delete from pgboss.job_dependency; delete from pgboss.job; create table sim_meta (cloned_at timestamptz, source_db text, from_seq bigint); insert into sim_meta (cloned_at, source_db, from_seq) select now(), '$SOURCE_DB', coalesce(max(seq), 0) from change_events; commit;"

cat <<NEXT
$TARGET ist geklont aus $SOURCE_DB.
Nächste Schritte:
  1. .env.sim aus .env.sim.example anlegen (DATABASE_URL auf $TARGET, S3_WRITE_PREFIX=sim/<YYYYMMDD>/, PERIPLUS_SIMULATION).
  2. npm run sim:draft-scenario -- --area <key> --out data/sim/scenario.json, den Entwurf von Hand prüfen.
  3. npm run sim:worker, dann npm run sim:revisit und npm run sim:verify (alle aus .env.sim).
NEXT

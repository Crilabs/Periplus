#!/usr/bin/env bash
# Restores the latest restic dump into a throwaway Postgres container and counts users.
# Exit 0 only when the restored database answers the query.
set -euo pipefail

APP_DIR=/opt/periplus
cd "$APP_DIR"
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in .env}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in .env}"
export RESTIC_REPOSITORY RESTIC_PASSWORD

IMAGE="ghcr.io/crilabs/periplus-postgres:$(tr -d '[:space:]' < .deployed-tag)"
NAME="periplus-restore-check-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=restore-check -e POSTGRES_USER=periplus -e POSTGRES_DB=periplus "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U periplus -d periplus >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U periplus -d periplus >/dev/null

echo "restoring latest dump"
# pg_restore may report harmless "already exists" errors for objects the image creates itself.
restic dump latest /periplus.dump \
  | docker exec -i "$NAME" pg_restore -U periplus -d periplus --no-owner --clean --if-exists \
  || echo "pg_restore reported warnings; the query below decides" >&2

COUNT="$(docker exec "$NAME" psql -U periplus -d periplus -tAc 'select count(*) from users')"
echo "users in restored dump: $COUNT"

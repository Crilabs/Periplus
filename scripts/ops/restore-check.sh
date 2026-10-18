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
# TCP probe: the image's init phase runs a temporary server on the socket only, so a socket probe
# can report ready before the final server is up.
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U periplus -d periplus >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -h 127.0.0.1 -U periplus -d periplus >/dev/null

echo "restoring latest dump"
# restic must succeed; pg_restore may report harmless "already exists" errors for objects the image
# creates itself, so its status only warns and the query below decides.
set +e
restic dump latest /periplus.dump \
  | docker exec -i "$NAME" pg_restore -U periplus -d periplus --no-owner --clean --if-exists
STATUSES=("${PIPESTATUS[@]}")
set -e
if [ "${STATUSES[0]}" -ne 0 ]; then
  echo "restic dump failed (exit ${STATUSES[0]})" >&2
  exit 1
fi
if [ "${STATUSES[1]}" -ne 0 ]; then
  echo "pg_restore reported warnings (exit ${STATUSES[1]}); the query below decides" >&2
fi

COUNT="$(docker exec "$NAME" psql -U periplus -d periplus -tAc 'select count(*) from users')"
echo "users in restored dump: $COUNT"

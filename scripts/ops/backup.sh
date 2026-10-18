#!/usr/bin/env bash
# Nightly backup: Postgres dump into restic, retention, and a copy-only mirror of the S3 archive.
# Settings come from /opt/periplus/.env (RESTIC_*, STORAGEBOX_*, S3_*).
set -euo pipefail

APP_DIR=/opt/periplus
cd "$APP_DIR"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in .env}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in .env}"
: "${STORAGEBOX_HOST:?set STORAGEBOX_HOST in .env}"
: "${STORAGEBOX_USER:?set STORAGEBOX_USER in .env}"
: "${S3_ENDPOINT:?}" "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}" "${S3_BUCKET:?}"
export RESTIC_REPOSITORY RESTIC_PASSWORD

IMAGE_TAG="$(tr -d '[:space:]' < .deployed-tag)"
export IMAGE_TAG
COMPOSE=(docker compose --env-file .env -f docker/compose.prod.yml)

echo "$(date -u +%FT%TZ) dumping database"
"${COMPOSE[@]}" exec -T postgres pg_dump -Fc -U "${POSTGRES_USER:-periplus}" "${POSTGRES_DB:-periplus}" \
  | restic backup --stdin --stdin-filename periplus.dump --tag periplus-db

restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune

# Archive mirror: remotes defined through environment (no rclone.conf). copy never deletes at the target.
export RCLONE_S3_PROVIDER=Other
export RCLONE_S3_ENDPOINT="$S3_ENDPOINT"
export RCLONE_S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export RCLONE_S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export RCLONE_S3_REGION="${S3_REGION:-}"
export RCLONE_SFTP_HOST="$STORAGEBOX_HOST"
export RCLONE_SFTP_USER="$STORAGEBOX_USER"
export RCLONE_SFTP_PORT="${STORAGEBOX_PORT:-23}"
export RCLONE_SFTP_KEY_FILE="${STORAGEBOX_KEY_FILE:-$HOME/.ssh/id_storagebox}"
echo "$(date -u +%FT%TZ) copying archive"
rclone copy ":s3:${S3_BUCKET}" ":sftp:periplus-archive"
echo "$(date -u +%FT%TZ) backup done"

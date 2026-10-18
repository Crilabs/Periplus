#!/usr/bin/env bash
# Deploys an image tag on the server. Run on the server via: ssh deploy@host bash -s <sha> < deploy.sh
# Rollback = run it again with the previous sha.
set -euo pipefail

NEW_TAG="${1:?usage: deploy.sh <image-tag>}"
APP_DIR=/opt/periplus
cd "$APP_DIR"

COMPOSE=(docker compose --env-file .env -f docker/compose.prod.yml)
PREVIOUS_TAG=""
[ -f .deployed-tag ] && PREVIOUS_TAG="$(tr -d '[:space:]' < .deployed-tag)"

ready() {
  # /readyz checked from inside the web container, independent of DNS and TLS.
  "${COMPOSE[@]}" exec -T web node -e \
    "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

wait_ready() {
  for _ in $(seq 1 30); do
    if ready; then return 0; fi
    sleep 2
  done
  return 1
}

release() {
  local tag="$1"
  export IMAGE_TAG="$tag"
  "${COMPOSE[@]}" pull
  "${COMPOSE[@]}" up -d postgres
  "${COMPOSE[@]}" --profile migrate run --rm migrate
  "${COMPOSE[@]}" up -d web worker caddy
}

echo "deploying $NEW_TAG (previous: ${PREVIOUS_TAG:-none})"
if release "$NEW_TAG" && wait_ready; then
  printf '%s\n' "$NEW_TAG" > .deployed-tag
  echo "deployed $NEW_TAG"
  exit 0
fi

echo "deploy of $NEW_TAG failed" >&2
"${COMPOSE[@]}" logs --tail 50 web worker >&2 || true
if [ -n "$PREVIOUS_TAG" ] && [ "$PREVIOUS_TAG" != "$NEW_TAG" ]; then
  echo "rolling back to $PREVIOUS_TAG" >&2
  # Migrations are not reverted; they must stay backward compatible with the previous release.
  export IMAGE_TAG="$PREVIOUS_TAG"
  "${COMPOSE[@]}" up -d web worker caddy || true
  if wait_ready; then echo "rollback to $PREVIOUS_TAG ok" >&2; else echo "rollback to $PREVIOUS_TAG is NOT ready" >&2; fi
else
  echo "no previous tag to roll back to" >&2
fi
exit 1

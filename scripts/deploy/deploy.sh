#!/usr/bin/env bash
# Deploys an image tag on the server. Run on the server via: ssh periplus@host bash -s <sha> < deploy.sh
# Rollback = run it again with the previous sha.
# Any failing step (pull, migrate, up, /readyz, worker ready) rolls back to the previous tag and exits 1.
set -euo pipefail

NEW_TAG="${1:?usage: deploy.sh <image-tag>}"
# PERIPLUS_APP_DIR is only overridden by the test harness (scripts/deploy/__tests__/deploy-test.sh).
APP_DIR="${PERIPLUS_APP_DIR:-/opt/periplus}"
cd "$APP_DIR"

COMPOSE=(docker compose --env-file .env -f docker/compose.prod.yml)
PREVIOUS_TAG=""
if [ -f .deployed-tag ]; then PREVIOUS_TAG="$(tr -d '[:space:]' < .deployed-tag)"; fi

ready() {
  # /readyz checked from inside the web container, independent of DNS and TLS.
  "${COMPOSE[@]}" exec -T web node -e \
    "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1 || return 1
  # The worker's ready marker (lib/jobs/ready-marker.ts): written once its start checks passed, touched on every
  # heartbeat. A worker that fails at start restarts forever and never has a fresh one. Checked here as well as by
  # the compose healthcheck, so it also holds with a server compose file from before that healthcheck.
  "${COMPOSE[@]}" exec -T worker sh -c 'test -n "$(find /tmp/periplus-worker-ready -mmin -2 2>/dev/null)"' \
    >/dev/null 2>&1
}

wait_ready() {
  for _ in $(seq 1 30); do
    if ready; then return 0; fi
    sleep 2
  done
  return 1
}

# Every step fails explicitly: set -e is ignored inside functions whose status is tested by the caller.
release() {
  local tag="$1"
  export IMAGE_TAG="$tag"
  "${COMPOSE[@]}" pull || { echo "step failed: pull" >&2; return 1; }
  "${COMPOSE[@]}" up -d postgres || { echo "step failed: up postgres" >&2; return 1; }
  "${COMPOSE[@]}" --profile migrate run --rm migrate || { echo "step failed: migrate" >&2; return 1; }
  # --wait: until the services with a healthcheck (the worker) are healthy; fails when one turns unhealthy or exits.
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180 web worker || { echo "step failed: up web worker" >&2; return 1; }
  wait_ready || { echo "step failed: /readyz or worker not ready within 60 s" >&2; return 1; }
}

echo "deploying $NEW_TAG (previous: ${PREVIOUS_TAG:-none})"
STATUS=0
release "$NEW_TAG" || STATUS=$?
if [ "$STATUS" -eq 0 ]; then
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
  if "${COMPOSE[@]}" up -d --wait --wait-timeout 180 postgres web worker && wait_ready; then
    echo "rollback to $PREVIOUS_TAG ok" >&2
  else
    echo "rollback to $PREVIOUS_TAG is NOT ready" >&2
  fi
else
  echo "no previous tag to roll back to" >&2
fi
exit 1

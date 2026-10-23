#!/usr/bin/env bash
# Tests scripts/deploy/deploy.sh against a fake `docker` on PATH. No real Docker, no network.
#   bash scripts/deploy/__tests__/deploy-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/../deploy.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fake binaries: docker logs "IMAGE_TAG=<tag> <args>" and fails the step named in FAKE_FAIL
# (pull | migrate | up | ready | worker) while IMAGE_TAG equals FAKE_FAIL_TAG. sleep is a no-op.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
args="$*"
printf 'IMAGE_TAG=%s %s\n' "${IMAGE_TAG:-}" "$args" >> "$FAKE_LOG"
if [ "${IMAGE_TAG:-}" = "${FAKE_FAIL_TAG:-}" ]; then
  case "${FAKE_FAIL:-}:$args" in
    pull:*" pull") exit 1 ;;
    migrate:*" run --rm migrate") exit 1 ;;
    up:*" up -d --wait --wait-timeout 180 web worker") exit 1 ;;
    ready:*" exec -T web "*) exit 1 ;;
    worker:*" exec -T worker "*) exit 1 ;;
  esac
fi
exit 0
FAKE
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/sleep"
chmod +x "$WORK/bin/docker" "$WORK/bin/sleep"

FAILURES=0
CASE=""
fail() { echo "FAIL [$CASE]: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   [$CASE]"; }

# run_case <name> <fail-step or ""> ; sets RC, LOG, APP
run_case() {
  CASE="$1"
  APP="$WORK/$1"
  LOG="$APP/docker.log"
  mkdir -p "$APP"
  : > "$APP/.env"
  : > "$LOG"
  printf 'oldsha\n' > "$APP/.deployed-tag"
  RC=0
  PATH="$WORK/bin:$PATH" PERIPLUS_APP_DIR="$APP" FAKE_LOG="$LOG" FAKE_FAIL="$2" FAKE_FAIL_TAG=newsha \
    bash "$DEPLOY" newsha > "$APP/out.log" 2>&1 || RC=$?
}

# Shared assertions for every failing step.
assert_rolled_back() {
  local before="$FAILURES"
  [ "$RC" -eq 1 ] || fail "expected exit 1, got $RC"
  [ "$(cat "$APP/.deployed-tag")" = "oldsha" ] || fail ".deployed-tag changed to $(cat "$APP/.deployed-tag")"
  grep -qx 'IMAGE_TAG=oldsha compose --env-file .env -f docker/compose.prod.yml up -d --wait --wait-timeout 180 postgres web worker' "$LOG" \
    || fail "no rollback 'up' with previous tag oldsha"
  grep -q 'rollback to oldsha ok' "$APP/out.log" || fail "rollback not reported ok"
  [ "$FAILURES" -eq "$before" ] && pass
  return 0
}

run_case success ""
before="$FAILURES"
[ "$RC" -eq 0 ] || fail "expected exit 0, got $RC"
[ "$(cat "$APP/.deployed-tag")" = "newsha" ] || fail ".deployed-tag not updated"
grep -q '^IMAGE_TAG=oldsha' "$LOG" && fail "unexpected rollback"
[ "$FAILURES" -eq "$before" ] && pass

run_case migrate-fails migrate
assert_rolled_back
grep -q '^IMAGE_TAG=newsha .* up -d --wait --wait-timeout 180 web worker$' "$LOG" && fail "web/worker started with new tag after failed migrate"

run_case pull-fails pull
assert_rolled_back
grep -q '^IMAGE_TAG=newsha .*run --rm migrate$' "$LOG" && fail "migrate ran after failed pull"

run_case up-fails up
assert_rolled_back

run_case readyz-fails ready
assert_rolled_back

# Web is ready, but the worker never writes its ready marker (it fails at start and restarts forever).
run_case worker-not-ready worker
assert_rolled_back
grep -q 'worker not ready' "$APP/out.log" || fail "worker failure not reported"

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES assertion(s) failed" >&2
  exit 1
fi
echo "all deploy tests passed"

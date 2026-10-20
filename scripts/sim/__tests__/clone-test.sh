#!/usr/bin/env bash
# Tests scripts/sim/clone.sh against a fake `docker` on PATH. No real Docker, no database, no network.
#   bash scripts/sim/__tests__/clone-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLONE="$HERE/../clone.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fake docker: logs every call as one line "<args>" and answers the existence query with FAKE_SIM_EXISTS
# ("1" = periplus_sim exists); pg_dump writes a dummy dump, pg_restore reads it from stdin.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "$args" >> "$FAKE_LOG"
case "$args" in
  *"from pg_database"*) [ "${FAKE_SIM_EXISTS:-}" = "1" ] && echo 1 ;;
  *" pg_dump "*) echo "FAKE-DUMP" ;;
  *" pg_restore "*) cat > /dev/null ;;
esac
exit 0
FAKE
chmod +x "$WORK/bin/docker"

FAILURES=0
CASE=""
fail() { echo "FAIL [$CASE]: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   [$CASE]"; }

# run_case <name> <sim exists: 1 or ""> <clone.sh args…> ; sets RC, LOG, OUT
run_case() {
  CASE="$1"
  local exists="$2"
  shift 2
  mkdir -p "$WORK/$CASE"
  LOG="$WORK/$CASE/docker.log"
  OUT="$WORK/$CASE/out.log"
  : > "$LOG"
  RC=0
  PATH="$WORK/bin:$PATH" FAKE_LOG="$LOG" FAKE_SIM_EXISTS="$exists" bash "$CLONE" "$@" > "$OUT" 2>&1 || RC=$?
}

# line number of the first log line matching the pattern (0: none)
line_of() { grep -n -- "$1" "$LOG" | head -1 | cut -d: -f1 || true; }

run_case "source equals target is refused" "" --source-db periplus_sim
before="$FAILURES"
[ "$RC" -ne 0 ] || fail "expected a refusal, got exit 0"
grep -q "periplus_sim" "$OUT" || fail "refusal does not name the database"
grep -qE "pg_dump|dropdb|createdb|pg_restore" "$LOG" && fail "touched a database: $(cat "$LOG")"
[ "$FAILURES" -eq "$before" ] && pass

run_case "existing sim db without --force is refused" 1
before="$FAILURES"
[ "$RC" -ne 0 ] || fail "expected a refusal, got exit 0"
grep -q -- "--force" "$OUT" || fail "refusal does not name --force"
grep -qE "pg_dump|dropdb|createdb|pg_restore" "$LOG" && fail "touched a database: $(cat "$LOG")"
[ "$FAILURES" -eq "$before" ] && pass

run_case "existing sim db with --force is replaced" 1 --force
before="$FAILURES"
[ "$RC" -eq 0 ] || fail "expected exit 0, got $RC: $(cat "$OUT")"
grep -q "dropdb .*--if-exists periplus_sim" "$LOG" || fail "no dropdb of periplus_sim"
[ "$FAILURES" -eq "$before" ] && pass

run_case "pgboss jobs are removed after restore" ""
before="$FAILURES"
[ "$RC" -eq 0 ] || fail "expected exit 0, got $RC: $(cat "$OUT")"
grep -q "compose -f docker/compose.dev.yml exec -T db pg_dump .*-Fc periplus$" "$LOG" || fail "no pg_dump -Fc of periplus via the dev compose service db"
dump=$(line_of " pg_dump "); drop=$(line_of " dropdb "); create=$(line_of " createdb "); restore=$(line_of " pg_restore "); jobs=$(line_of "delete from pgboss.job;")
[ -n "$restore" ] && grep -q "pg_restore .*--no-owner .*-d periplus_sim" "$LOG" || fail "no pg_restore --no-owner into periplus_sim"
[ -n "$jobs" ] || fail "no delete of the pgboss jobs"
grep -q "delete from pgboss.job_dependency;" "$LOG" || fail "job dependencies not deleted"
grep -q "delete from pgboss.queue" "$LOG" && fail "queue definitions deleted"
grep -q "periplus_sim .*delete from pgboss.job;" "$LOG" || fail "jobs not deleted in periplus_sim"
if [ -n "$dump" ] && [ -n "$drop" ] && [ -n "$create" ] && [ -n "$restore" ] && [ -n "$jobs" ]; then
  [ "$dump" -lt "$drop" ] && [ "$drop" -lt "$create" ] && [ "$create" -lt "$restore" ] && [ "$restore" -lt "$jobs" ] \
    || fail "order is not pg_dump → dropdb → createdb → pg_restore → delete jobs: $(cat "$LOG")"
fi
[ "$FAILURES" -eq "$before" ] && pass

run_case "sim_meta is written with from_seq" "" --compose-file docker/compose.prod.yml --service postgres
before="$FAILURES"
[ "$RC" -eq 0 ] || fail "expected exit 0, got $RC: $(cat "$OUT")"
grep -q "compose -f docker/compose.prod.yml exec -T postgres " "$LOG" || fail "compose file and service options not used"
grep -q "periplus_sim .*create table sim_meta (cloned_at timestamptz, source_db text, from_seq bigint)" "$LOG" || fail "sim_meta not created in periplus_sim"
grep -q "insert into sim_meta (cloned_at, source_db, from_seq) select now(), 'periplus', coalesce(max(seq), 0) from change_events" "$LOG" \
  || fail "sim_meta row with from_seq = coalesce(max(change_events.seq), 0) not written"
grep -q "sim:worker" "$OUT" || fail "next step not printed"
[ "$FAILURES" -eq "$before" ] && pass

run_case "an unknown option is refused" "" --target other_db
before="$FAILURES"
[ "$RC" -ne 0 ] || fail "expected a refusal, got exit 0"
[ -s "$LOG" ] && fail "called docker: $(cat "$LOG")"
[ "$FAILURES" -eq "$before" ] && pass

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES failure(s)" >&2
  exit 1
fi
echo "all clone.sh cases passed"

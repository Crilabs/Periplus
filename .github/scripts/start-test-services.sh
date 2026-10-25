#!/usr/bin/env bash
# Test Postgres and S3 for the CI jobs that need them; waits until both answer.
set -euo pipefail

docker compose -f docker/compose.dev.yml up -d --build --wait db-test s3
for _ in $(seq 1 30); do
  if curl -s -o /dev/null http://localhost:8333; then exit 0; fi
  sleep 2
done
echo "s3 did not become reachable" >&2
docker compose -f docker/compose.dev.yml logs s3
exit 1

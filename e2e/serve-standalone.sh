#!/usr/bin/env bash
# Serves the e2e app like production (OPS-6): the standalone output of `npm run build`, laid out as
# docker/web.Dockerfile does (static assets, public/ and config/ next to server.js), started with `node server.js`
# from that directory. The environment (PORT, DATABASE_URL, …) comes from playwright.config.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/.next/standalone"
if [ ! -f "$APP/server.js" ]; then
  echo "no standalone build in $APP: run npm run build first" >&2
  exit 1
fi
rm -rf "$APP/.next/static" "$APP/public" "$APP/config"
mkdir -p "$APP/.next" "$ROOT/public"
cp -R "$ROOT/.next/static" "$APP/.next/static"
cp -R "$ROOT/public" "$APP/public"
cp -R "$ROOT/config" "$APP/config"
cd "$APP"
# Dual-stack, so both localhost resolutions (::1, 127.0.0.1) reach it.
export HOSTNAME="${HOSTNAME_E2E:-::}"
exec node server.js

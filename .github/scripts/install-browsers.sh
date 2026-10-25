#!/usr/bin/env bash
# Chromium for Playwright and, with --pdftotext, pdftotext; without apt where the runner image already has what is needed: the image
# ships Google Chrome and its system libraries, and a slow apt mirror once held a CI job for ten minutes.
set -euo pipefail

npx playwright install chromium
if [ "${1:-}" = "--pdftotext" ] && ! command -v pdftotext >/dev/null; then
  sudo apt-get update -o Acquire::Retries=3
  sudo apt-get install -y -o Acquire::Retries=3 poppler-utils
fi

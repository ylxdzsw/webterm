#!/usr/bin/env bash
# Run one webterm browser test against a freshly-started dev server.
#
# Usage:
#   scripts/ci-browser.sh <test-name>
#
# where <test-name> is one of: smoke nag nag-redirect reconnect-fail
# reconnect-scroll mobile-touch-scroll mobile-tui-scroll exit
#
# Starts `node src/server.js` with WEBTERM_DEV_PORT=8080, waits for it to
# accept connections, runs `npm run test:<test-name>`, and kills the server
# on exit. Exits with the test's exit code.
#
# Requires npm dependencies installed (npm ci) and a Chrome/Chromium binary
# findable via CHROME_PATH (defaults checked below).

set -u

PORT="${WEBTERM_DEV_PORT:-8080}"
BASE_URL="http://127.0.0.1:${PORT}/"

if [ -z "${CHROME_PATH:-}" ]; then
  for c in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then CHROME_PATH="$(command -v "$c")"; break; fi
  done
fi
if [ -z "${CHROME_PATH:-}" ]; then
  echo "ci-browser: no Chrome/Chromium found (set CHROME_PATH)" >&2
  exit 127
fi
export CHROME_PATH

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: $0 <test-name>" >&2
  echo "  smoke nag nag-redirect reconnect-fail reconnect-scroll mobile-touch-scroll mobile-tui-scroll exit" >&2
  exit 2
fi

LOG="$(mktemp)"
echo "ci-browser: starting server on ${BASE_URL}"
WEBTERM_DEV_PORT="$PORT" node src/server.js >"$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "ci-browser: server exited before becoming ready" >&2
    cat "$LOG" >&2 || true
    exit 1
  fi
  if curl -fsS -o /dev/null "$BASE_URL" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "ci-browser: server did not become ready on ${BASE_URL}" >&2
  cat "$LOG" >&2 || true
  exit 1
fi

echo "ci-browser: running test:${NAME}"
npm run "test:${NAME}"
RC=$?
echo "ci-browser: test:${NAME} exited ${RC}"
exit "$RC"

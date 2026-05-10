#!/usr/bin/env bash
# SPEC-035-4-04 §Wait-for-port helper.
#
# Polls `nc -z 127.0.0.1 $PORT` with a deadline; exits 0 when the loopback
# port is reachable, 1 on timeout. Used after `bun run server/index.ts &`
# in CI so the Playwright run only starts once the portal is listening.
#
# Usage: scripts/ci/wait-for-port.sh <port> [deadline_seconds]

set -euo pipefail

PORT="${1:?usage: wait-for-port.sh <port> [deadline_seconds]}"
DEADLINE="${2:-30}"

start_ts=$(date +%s)
while :; do
  now=$(date +%s)
  elapsed=$((now - start_ts))
  if (( elapsed >= DEADLINE )); then
    echo "wait-for-port: timed out waiting for 127.0.0.1:${PORT} after ${DEADLINE}s" >&2
    exit 1
  fi
  if nc -z 127.0.0.1 "${PORT}" 2>/dev/null; then
    exit 0
  fi
  sleep 0.5
done

#!/bin/sh
# Wait for LND gRPC to be reachable, then start LNDK.
# All arguments passed to this script are forwarded to lndk.
set -e

LND_HOST="${LND_WAIT_HOST:-localhost}"
LND_PORT="${LND_WAIT_PORT:-10009}"
MAX_ATTEMPTS=40

echo "[lndk-startup] Waiting for LND at ${LND_HOST}:${LND_PORT}..."

i=0
while ! nc -z "${LND_HOST}" "${LND_PORT}" 2>/dev/null; do
  i=$((i + 1))
  if [ "${i}" -ge "${MAX_ATTEMPTS}" ]; then
    echo "[lndk-startup] ERROR: LND not reachable after $((MAX_ATTEMPTS * 5))s — aborting."
    exit 1
  fi
  echo "[lndk-startup] Attempt ${i}/${MAX_ATTEMPTS} — retrying in 5s..."
  sleep 5
done

echo "[lndk-startup] LND is up — starting LNDK"
exec lndk "$@"

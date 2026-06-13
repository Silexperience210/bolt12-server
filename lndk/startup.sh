#!/bin/sh
# Wait for LND gRPC to be reachable, then start LNDK.
# All arguments passed to this script are forwarded to lndk.
set -e

LND_HOST="${LND_WAIT_HOST:-localhost}"
LND_PORT="${LND_WAIT_PORT:-10009}"
TIMEOUT_SEC="${LND_WAIT_TIMEOUT:-180}"
SLEEP_SEC=5

echo "[lndk-startup] Waiting for LND gRPC at ${LND_HOST}:${LND_PORT} (timeout ${TIMEOUT_SEC}s)..."

elapsed=0
while true; do
    # First check that the TCP port is open...
    if nc -z "${LND_HOST}" "${LND_PORT}" 2>/dev/null; then
        # ...then verify LND is actually serving TLS (better than a bare TCP check).
        if echo | timeout 3 openssl s_client -connect "${LND_HOST}:${LND_PORT}" 2>/dev/null | grep -q "CONNECTED"; then
            echo "[lndk-startup] LND gRPC is ready (TLS handshake OK)"
            break
        fi
    fi

    if [ "${elapsed}" -ge "${TIMEOUT_SEC}" ]; then
        echo "[lndk-startup] ERROR: LND not reachable after ${TIMEOUT_SEC}s — aborting."
        exit 1
    fi

    echo "[lndk-startup] Still waiting... ${elapsed}/${TIMEOUT_SEC}s"
    sleep "${SLEEP_SEC}"
    elapsed=$((elapsed + SLEEP_SEC))
done

echo "[lndk-startup] Starting LNDK"
exec lndk "$@"

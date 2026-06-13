#!/bin/bash
# ============================================================
# Deploy Bolt12 Server to Umbrel via SSH
# Usage: bash deploy-umbrel.sh [umbrel-ip]
# ============================================================

UMBREL_IP="${1:-192.168.1.55}"
UMBREL_USER="umbrel"
REMOTE_DIR="~/bolt12-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="silex-bolt12-server/docker-compose.yml"

echo "================================================"
echo "   BOLT12 SERVER - DEPLOY TO UMBREL"
echo "================================================"
echo "Target: ${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}"
echo ""

# ---- 1. Vérification connexion SSH ----
echo "[1/5] Testing SSH connection..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${UMBREL_USER}@${UMBREL_IP}" "echo ok" 2>/dev/null; then
    echo ""
    echo "SSH key auth not configured. Setting up SSH key..."
    echo "You'll be asked for the password once."
    ssh-copy-id "${UMBREL_USER}@${UMBREL_IP}" 2>/dev/null || {
        echo "[INFO] ssh-copy-id not available, continuing with password auth"
    }
fi

# ---- 2. Création dossier remote ----
echo ""
echo "[2/5] Creating remote directory..."
ssh "${UMBREL_USER}@${UMBREL_IP}" "mkdir -p ${REMOTE_DIR}/proto ${REMOTE_DIR}/public"

# ---- 3. Transfert des fichiers ----
echo ""
echo "[3/5] Transferring files..."
scp "${SCRIPT_DIR}/server.js"          "${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/package.json"       "${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/Dockerfile"         "${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/${COMPOSE_FILE}"    "${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}/docker-compose.yml"
scp "${SCRIPT_DIR}/proto/lndkrpc.proto" "${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}/proto/"

# Copier le public/ si présent
if [ -d "${SCRIPT_DIR}/public" ]; then
    scp -r "${SCRIPT_DIR}/public/." "${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}/public/"
fi

echo "[OK] Files transferred"

# ---- 4. Configuration .env sur Umbrel ----
echo ""
echo "[4/5] Configuring .env on Umbrel..."

# Générer une API key si pas déjà définie
API_KEY=$(ssh "${UMBREL_USER}@${UMBREL_IP}" "
    if [ -f ${REMOTE_DIR}/.env ] && grep -q '^API_KEY=' ${REMOTE_DIR}/.env; then
        grep '^API_KEY=' ${REMOTE_DIR}/.env | cut -d= -f2
    else
        node -e 'const c=require(\"crypto\"); console.log(c.randomBytes(32).toString(\"hex\"))' 2>/dev/null \\
            || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
")

# Note: unquoted heredoc delimiter allows ${API_KEY} to expand.
# All other variables are written literally (no $ in the template).
ssh "${UMBREL_USER}@${UMBREL_IP}" "cat > ${REMOTE_DIR}/.env << ENVEOF
# Bolt12 Server - Auto-generated config
NODE_ENV=production
PORT=3001

# LND
LND_REST_HOST=host.docker.internal:8080
LND_TLS_PATH=/lnd/tls.cert
LND_MACAROON_PATH=/lnd/data/chain/bitcoin/mainnet/admin.macaroon

# LNDK
LNDK_HOST=host.docker.internal:10010
LNDK_TLS_PATH=/lndk-data/tls.cert
LNDK_MACAROON_PATH=/lndk-data/admin.macaroon

# API Key (keep secret!)
API_KEY=${API_KEY}
ENVEOF"

echo "[OK] .env configured"
echo "[INFO] API Key: ${API_KEY:0:8}... (keep this secret)"

# ---- 5. Pull, build et démarrage Docker ----
echo ""
echo "[5/5] Pulling images and starting Docker container..."
ssh "${UMBREL_USER}@${UMBREL_IP}" "
    cd ${REMOTE_DIR}
    docker compose down 2>/dev/null || true
    docker compose pull
    docker compose up -d
"

# ---- Vérification ----
echo ""
echo "================================================"
echo "   VERIFICATION"
echo "================================================"

# Robust health check: retry a few times, then fall back to remote container status.
HEALTH=""
for attempt in 1 2 3 4 5; do
    HEALTH=$(curl -sS --retry 2 --retry-delay 2 --max-time 5 "http://${UMBREL_IP}:3001/health" 2>/dev/null || true)
    if echo "$HEALTH" | grep -q '"status":"ok"'; then
        break
    fi
    echo "[INFO] Health check attempt ${attempt}/5 failed, retrying in 5s..."
    sleep 5
done

if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "[OK] Server is online!"
    echo ""
    echo "  Dashboard : http://${UMBREL_IP}:3001"
    echo "  Health    : http://${UMBREL_IP}:3001/health"
    echo "  API Key   : ${API_KEY}"
else
    echo "[!] Server not responding yet. Checking remote container status..."
    ssh "${UMBREL_USER}@${UMBREL_IP}" "docker compose -f ${REMOTE_DIR}/docker-compose.yml ps" 2>/dev/null || true
    echo ""
    echo "Check logs with:"
    echo "    ssh ${UMBREL_USER}@${UMBREL_IP} 'docker logs silex-bolt12-server-server-1'"
    echo ""
    echo "Or wait 30s and test:"
    echo "    curl http://${UMBREL_IP}:3001/health"
fi

echo ""
echo "================================================"
echo "   DEPLOY COMPLETE"
echo "================================================"

#!/bin/bash
# ============================================================
# Deploy Bolt12 Server to Umbrel via SSH
# Usage: bash deploy-umbrel.sh [umbrel-ip]
# ============================================================

UMBREL_IP="${1:-192.168.1.55}"
UMBREL_USER="umbrel"
REMOTE_DIR="~/bolt12-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
scp "${SCRIPT_DIR}/docker-compose.yml" "${UMBREL_USER}@${UMBREL_IP}:${REMOTE_DIR}/"
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
    if [ -f ${REMOTE_DIR}/.env ] && grep -q 'API_KEY' ${REMOTE_DIR}/.env; then
        grep '^API_KEY=' ${REMOTE_DIR}/.env | cut -d= -f2
    else
        node -e 'const c=require(\"crypto\"); console.log(c.randomBytes(32).toString(\"hex\"))' 2>/dev/null \
            || cat /proc/sys/kernel/random/uuid | tr -d '-'
    fi
")

ssh "${UMBREL_USER}@${UMBREL_IP}" "cat > ${REMOTE_DIR}/.env << 'ENVEOF'
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

# ---- 5. Build et démarrage Docker ----
echo ""
echo "[5/5] Building and starting Docker container..."
ssh "${UMBREL_USER}@${UMBREL_IP}" "
    cd ${REMOTE_DIR}
    docker compose down 2>/dev/null || true
    docker compose up --build -d
"

# ---- Vérification ----
echo ""
echo "================================================"
echo "   VERIFICATION"
echo "================================================"
sleep 8

HEALTH=$(curl -s --max-time 5 "http://${UMBREL_IP}:3001/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "[OK] Server is online!"
    echo ""
    echo "  Dashboard : http://${UMBREL_IP}:3001"
    echo "  Health    : http://${UMBREL_IP}:3001/health"
    echo "  API Key   : ${API_KEY}"
else
    echo "[!] Server not responding yet. Check logs with:"
    echo "    ssh ${UMBREL_USER}@${UMBREL_IP} 'docker logs bolt12-server'"
    echo ""
    echo "  Or wait 30s and test:"
    echo "    curl http://${UMBREL_IP}:3001/health"
fi

echo ""
echo "================================================"
echo "   DEPLOY COMPLETE"
echo "================================================"

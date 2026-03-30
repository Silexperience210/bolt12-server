#!/bin/bash
# Script execute sur Umbrel pour configurer .env et lancer Docker
set -e

cd ~/bolt12-server

if [ ! -f .env ]; then
    API_KEY=$(node -e "const c=require('crypto'); console.log(c.randomBytes(32).toString('hex'))" 2>/dev/null \
              || cat /proc/sys/kernel/random/uuid | tr -d -)
    cat > .env << ENVEOF
NODE_ENV=production
PORT=3000
LND_HOST=host.docker.internal:10009
LND_TLS_PATH=/lnd/tls.cert
LND_MACAROON_PATH=/lnd/data/chain/bitcoin/mainnet/admin.macaroon
API_KEY=${API_KEY}
ENVEOF
    echo "[OK] .env cree"
    echo "[INFO] API Key: ${API_KEY}"
else
    echo "[OK] .env existant conserve"
    grep "API_KEY" .env
fi

echo ""
echo "[Docker] Build et demarrage..."
docker compose down 2>/dev/null || true
docker compose up --build -d

echo ""
echo "[OK] Conteneur lance"
docker ps | grep bolt12 || true

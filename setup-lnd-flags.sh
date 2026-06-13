#!/bin/bash
# Bolt12 Server - LND Protocol Flags Setup
# Run this ONCE on your Umbrel node before installing Bolt12 Server:
#   bash <(curl -s https://raw.githubusercontent.com/Silexperience210/bolt12-server/main/setup-lnd-flags.sh)

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

LND_CONF="$HOME/umbrel/app-data/lightning/data/lnd/lnd.conf"

echo ""
echo "================================================="
echo "  Bolt12 Server - LND Setup Script"
echo "================================================="
echo ""

# Check lnd.conf exists
if [ ! -f "$LND_CONF" ]; then
    echo -e "${RED}Error: lnd.conf not found at $LND_CONF${NC}"
    echo "Make sure the Lightning app is installed on your Umbrel node."
    exit 1
fi

echo -e "${YELLOW}Found lnd.conf at: $LND_CONF${NC}"
echo ""

# Backup lnd.conf before any modification
BACKUP_FILE="${LND_CONF}.bak.$(date +%Y%m%d%H%M%S)"
cp "$LND_CONF" "$BACKUP_FILE"
echo -e "${GREEN}Backup created: ${BACKUP_FILE}${NC}"
echo ""

# Add [protocol] section if missing
if ! grep -q "^\[protocol\]" "$LND_CONF"; then
    echo "" >> "$LND_CONF"
    echo "[protocol]" >> "$LND_CONF"
    echo -e "${GREEN}Added [protocol] section${NC}"
fi

# Add each flag if not already present
FLAGS=(
    "protocol.custom-message=513"
    "protocol.custom-nodeann=39"
    "protocol.custom-init=39"
)

for FLAG in "${FLAGS[@]}"; do
    KEY="${FLAG%%=*}"
    if grep -q "^${KEY}=" "$LND_CONF"; then
        echo -e "${YELLOW}Already set: $FLAG${NC}"
    else
        sed -i "/^\[protocol\]/a $FLAG" "$LND_CONF"
        echo -e "${GREEN}Added: $FLAG${NC}"
    fi
done

echo ""
echo -e "${YELLOW}Restarting LND (this may take ~30 seconds)...${NC}"

cd "$HOME/umbrel" && ./scripts/app compose lightning restart lnd

echo ""
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}  Done! LND is restarted with BOLT12 support.${NC}"
echo -e "${GREEN}=================================================${NC}"
echo ""
echo "You can now install Bolt12 Server from the Umbrel community app store."
echo "Add this store URL in Umbrel: https://github.com/Silexperience210/bolt12-server"
echo ""

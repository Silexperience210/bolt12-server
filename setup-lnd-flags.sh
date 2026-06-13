#!/bin/bash
# Bolt12 Server - LND Protocol Flags Setup
# Run this ONCE on your Umbrel node before installing Bolt12 Server:
#   bash <(curl -s https://raw.githubusercontent.com/Silexperience210/bolt12-server/main/setup-lnd-flags.sh)
#
# Supports UmbrelOS 0.5.x (lnd.conf) and UmbrelOS 1.x (settings.json).

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "================================================="
echo "  Bolt12 Server - LND Setup Script"
echo "================================================="
echo ""

# UmbrelOS paths
LND_CONF="$HOME/umbrel/app-data/lightning/data/lnd/lnd.conf"
LND_SETTINGS="$HOME/umbrel/app-data/lightning/data/lightning/settings.json"

# Detect Umbrel version
if [ -f "$LND_SETTINGS" ]; then
    echo -e "${YELLOW}Detected UmbrelOS 1.x${NC}"
    echo ""

    PYTHON_CMD=$(command -v python3 || command -v python || echo "")
    if [ -z "$PYTHON_CMD" ]; then
        echo -e "${RED}Error: python3 is required on UmbrelOS 1.x${NC}"
        exit 1
    fi

    $PYTHON_CMD << 'PY'
import json
import sys

path = "/home/umbrel/umbrel/app-data/lightning/data/lightning/settings.json"
try:
    with open(path, "r") as f:
        data = json.load(f)
except Exception as e:
    print(f"Error reading settings.json: {e}")
    sys.exit(1)

if "lnd" not in data or not isinstance(data["lnd"], dict):
    data["lnd"] = {}

flags = {
    "protocol.custom-message": 513,
    "protocol.custom-nodeann": 39,
    "protocol.custom-init": 39,
}

changed = False
for key, value in flags.items():
    if data["lnd"].get(key) != value:
        data["lnd"][key] = value
        print(f"Added {key}={value}")
        changed = True
    else:
        print(f"Already set: {key}={value}")

if changed:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print("settings.json updated.")
else:
    print("settings.json already has BOLT12 flags.")
PY

    echo ""
    echo -e "${YELLOW}Restarting Lightning app...${NC}"

    if command -v umbreld &> /dev/null; then
        umbreld client apps.restart.mutate --appId lightning
    else
        echo -e "${RED}Could not find umbreld. Please restart the Lightning app manually from the Umbrel UI.${NC}"
        exit 1
    fi

    echo ""
    echo -e "${GREEN}=================================================${NC}"
    echo -e "${GREEN}  Done! LND will restart with BOLT12 support.${NC}"
    echo -e "${GREEN}=================================================${NC}"

elif [ -f "$LND_CONF" ]; then
    echo -e "${YELLOW}Detected UmbrelOS 0.5.x${NC}"
    echo ""

    BACKUP_FILE="${LND_CONF}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$LND_CONF" "$BACKUP_FILE"
    echo -e "${GREEN}Backup created: ${BACKUP_FILE}${NC}"
    echo ""

    if ! grep -q "^\[protocol\]" "$LND_CONF"; then
        echo "" >> "$LND_CONF"
        echo "[protocol]" >> "$LND_CONF"
        echo -e "${GREEN}Added [protocol] section${NC}"
    fi

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

else
    echo -e "${RED}Error: Lightning app not found.${NC}"
    echo "Make sure the Lightning app is installed on your Umbrel node."
    exit 1
fi

echo ""
echo "You can now install Bolt12 Server from the Umbrel community app store."
echo "Add this store URL in Umbrel: https://github.com/Silexperience210/bolt12-server"
echo ""

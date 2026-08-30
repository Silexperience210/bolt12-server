#!/bin/bash
# Bolt12 Server - LND Protocol Flags Setup
# Run this ONCE on your Umbrel node before installing Bolt12 Server:
#   bash <(curl -s https://raw.githubusercontent.com/Silexperience210/bolt12-server/main/setup-lnd-flags.sh)
#
# Supports UmbrelOS 0.5.x (lnd.conf) and UmbrelOS 1.x (settings.json).

set -e

# Cleanup temp files on exit.
trap 'rm -f /tmp/bolt12-flags-*.py 2>/dev/null || true' EXIT

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[1;34m'
NC='\033[0m'

echo ""
echo "================================================="
echo "  Bolt12 Server - LND Setup Script"
echo "================================================="
echo ""

# UmbrelOS paths
LND_CONF="$HOME/umbrel/app-data/lightning/data/lnd/lnd.conf"
LND_SETTINGS="$HOME/umbrel/app-data/lightning/data/lightning/settings.json"

# Try a command without sudo first, then with sudo if needed.
# Returns 0 on success, 1 on failure. Never exits the script.
run_with_privs() {
    set +e
    "$@" 2>/dev/null
    local rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
        return 0
    fi
    if command -v sudo >/dev/null 2>&1; then
        set +e
        sudo "$@" 2>/dev/null
        rc=$?
        set -e
        return $rc
    fi
    return 1
}

# Detect Umbrel version
if [ -f "$LND_SETTINGS" ]; then
    echo -e "${YELLOW}Detected UmbrelOS 1.x${NC}"
    echo ""

    PYTHON_CMD=$(command -v python3 || command -v python || echo "")
    if [ -z "$PYTHON_CMD" ]; then
        echo -e "${RED}Error: python3 is required on UmbrelOS 1.x${NC}"
        exit 1
    fi

    # Make sure we can read the file.
    if ! run_with_privs test -r "$LND_SETTINGS"; then
        echo -e "${RED}Error: cannot read ${LND_SETTINGS}${NC}"
        exit 1
    fi

    BACKUP_FILE="${LND_SETTINGS}.bak.$(date +%Y%m%d%H%M%S)"
    run_with_privs cp "$LND_SETTINGS" "$BACKUP_FILE"
    echo -e "${GREEN}Backup created: ${BACKUP_FILE}${NC}"
    echo ""

    # Write a temporary Python updater script.
    PY_TMP=$(mktemp /tmp/bolt12-flags-XXXXXX.py)
    cat > "$PY_TMP" << 'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, "r") as f:
        data = json.load(f)
except Exception as e:
    print(f"Error reading settings.json: {e}")
    sys.exit(1)

if "lnd" not in data or not isinstance(data["lnd"], dict):
    data["lnd"] = {}

flags = {
    "protocol.custom-message": "513",
}
# NOTE: protocol.custom-nodeann=39 et protocol.custom-init=39 sont à NE PAS
# poser sur LND v0.21+ : ces versions gèrent les onion messages nativement
# (feature bit 39) et ajouter ces flags fait crasher LND au démarrage avec
# "feature bit: 39 already set". Seul le type de message custom 513 est requis.

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

    if ! run_with_privs "$PYTHON_CMD" "$PY_TMP" "$LND_SETTINGS"; then
        echo -e "${RED}Failed to update ${LND_SETTINGS}${NC}"
        echo "You can fix permissions manually and retry:"
        echo "  sudo chown $(whoami):$(whoami) ${LND_SETTINGS}"
        exit 1
    fi

    echo ""
    echo -e "${YELLOW}Restarting Lightning app...${NC}"

    if command -v umbreld &> /dev/null; then
        if ! umbreld client apps.restart.mutate --appId lightning; then
            echo -e "${YELLOW}umbreld restart call failed; trying with sudo...${NC}"
            sudo umbreld client apps.restart.mutate --appId lightning || {
                echo -e "${RED}Could not restart Lightning app automatically.${NC}"
                echo "Please restart it manually from the Umbrel UI."
                exit 1
            }
        fi
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
    run_with_privs cp "$LND_CONF" "$BACKUP_FILE"
    echo -e "${GREEN}Backup created: ${BACKUP_FILE}${NC}"
    echo ""

    if ! run_with_privs grep -q "^\[protocol\]" "$LND_CONF"; then
        run_with_privs sh -c "printf '\\n[protocol]\\n' >> '$LND_CONF'"
        echo -e "${GREEN}Added [protocol] section${NC}"
    fi

    FLAGS=(
        "protocol.custom-message=513"
    )
    # Voir note ci-dessus : pas de custom-nodeann/custom-init sur LND v0.21+.

    for FLAG in "${FLAGS[@]}"; do
        KEY="${FLAG%%=*}"
        if run_with_privs grep -q "^${KEY}=" "$LND_CONF"; then
            echo -e "${YELLOW}Already set: $FLAG${NC}"
        else
            run_with_privs sed -i "/^\[protocol\]/a $FLAG" "$LND_CONF"
            echo -e "${GREEN}Added: $FLAG${NC}"
        fi
    done

    echo ""
    echo -e "${YELLOW}Restarting LND (this may take ~30 seconds)...${NC}"
    cd "$HOME/umbrel" && ./scripts/app compose lightning restart lnd || {
        echo -e "${RED}LND restart command failed.${NC}"
        echo "Please restart the Lightning app manually from the Umbrel UI."
        exit 1
    }

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
echo -e "${BLUE}Important: BOLT12 invoice requests need at least one public${NC}"
echo -e "${BLUE}Lightning channel with a peer that supports onion messages.${NC}"
echo ""
echo "If payments still fail after installing Bolt12 Server, open a public"
echo "channel to a BOLT12-compatible node such as ACINQ:"
echo "  03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735"
echo ""
echo "You can now install Bolt12 Server from the Umbrel community app store."
echo "Add this store URL in Umbrel: https://github.com/Silexperience210/bolt12-server"
echo ""

# Bolt12 Server

BOLT12 Lightning offers server for Umbrel (LND + LNDK).
Web dashboard, payment history, webhooks, CSV export, auto-generated API key.

---

## One-Click Install (Umbrel Community App Store)

### Step 1 — Enable BOLT12 on your LND node (one time only)

SSH into your Umbrel node and run:

```bash
bash <(curl -s https://raw.githubusercontent.com/Silexperience210/bolt12-server/main/setup-lnd-flags.sh)
```

This safely adds the required protocol flags to `lnd.conf` / `settings.json` and restarts LND (~30s). The script automatically uses `sudo` if the config file is owned by root.

### Step 2 — Ensure a BOLT12-capable peer (required for invoice requests)

BOLT12 invoice requests are routed as onion messages. Your node needs **at least one public, active Lightning channel** with a peer that advertises onion-message support.

You can check this in the Bolt12 Server dashboard under **Diagnostic**. If no peer supports BOLT12, open a public channel to a compatible node such as:

```
03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@of7husrflx7sforh3fw6yqlpwstee3wg5imvvmkp4bz6rbjxtg5nljad.onion:9735
```

### Step 3 — Add the community app store

In Umbrel → App Store → **+ Community App Store**, enter:

```
https://github.com/Silexperience210/bolt12-server
```

### Step 4 — Install

Search for **Bolt12 Server** and click Install. LNDK starts automatically — no separate installation required.

---

## API

All endpoints require `x-api-key` header (except `/health` and `/api/v1/public/*`).
Your API key is visible at `http://umbrel.local:3043/api/v1/config` from your local network.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Server + LND + LNDK status |
| GET | `/api/v1/diagnostic` | BOLT12 readiness check |
| POST | `/api/v1/offers` | Create a BOLT12 offer |
| GET | `/api/v1/offers` | List active offers |
| GET | `/api/v1/offers/:id` | Get offer by ID |
| DELETE | `/api/v1/offers/:id` | Disable offer |
| GET | `/api/v1/offers/:id/qr` | QR code for offer |
| POST | `/api/v1/pay` | Pay a BOLT12 offer |
| POST | `/api/v1/pay/invoice` | Pay a BOLT12 invoice |
| POST | `/api/v1/offers/invoice` | Get invoice from offer |
| POST | `/api/v1/decode` | Decode a BOLT12 invoice |
| POST | `/api/v1/invoices` | Create BOLT11 invoice |
| GET | `/api/v1/balance` | Node balance + channel info |
| GET | `/api/v1/payments` | Payment history |
| GET | `/api/v1/payments/export` | Export payments as CSV |
| GET | `/api/v1/stats` | 14-day activity stats |
| GET/POST/DELETE | `/api/v1/templates` | Invoice templates |
| GET/POST/DELETE/PATCH | `/api/v1/webhooks` | Event webhooks |
| GET | `/api/v1/logs` | Access logs |

---

## Manual Deploy (SSH)

```bash
git clone https://github.com/Silexperience210/bolt12-server
cd bolt12-server
bash deploy-umbrel.sh [umbrel-ip]
```

Defaults to `192.168.1.55` if no IP provided.

---

## Requirements

- Umbrel (old Docker-based or umbrelOS 1.x)
- Lightning app (LND) installed
- LND v0.18.0+ with BOLT12 protocol flags (handled by `setup-lnd-flags.sh`)
- At least one **public** Lightning channel with a peer that supports BOLT12 onion messages

---

## License

MIT — [silexperience210](https://github.com/silexperience210)

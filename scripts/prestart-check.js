#!/usr/bin/env node
/**
 * Pre-start checks for Bolt12 Server.
 * Runs before server.js and prints clear warnings about missing prerequisites.
 * Exits 0 even on warnings so the container can still start (topology can improve
 * after boot), but non-recoverable errors (missing LND, bad macaroon, missing flags)
 * exit non-zero.
 */
const fs = require('fs');
const https = require('https');
const path = require('path');

const LND_TLS_PATH = process.env.LND_TLS_PATH || '/lnd/tls.cert';
const LND_MACAROON_PATH = process.env.LND_MACAROON_PATH || '/lnd/data/chain/bitcoin/mainnet/admin.macaroon';
const LND_REST_HOST = process.env.LND_REST_HOST || 'host.docker.internal:8080';
const LNDK_TLS_PATH = process.env.LNDK_TLS_PATH || '/lndk-data/tls-cert.pem';

const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const GRN = '\x1b[32m';
const RST = '\x1b[0m';

function log(level, msg) {
  const prefix = level === 'error' ? `${RED}[ERR]${RST}` : level === 'warn' ? `${YEL}[WARN]${RST}` : `${GRN}[OK]${RST}`;
  console.log(`${prefix} ${msg}`);
}

function fatal(msg) {
  log('error', msg);
  process.exit(1);
}

function readFile(p) {
  try { return fs.readFileSync(p); } catch (e) { fatal(`Cannot read ${p}: ${e.message}`); }
}

function lndRestGet(endpoint) {
  return new Promise((resolve, reject) => {
    const [host, port] = LND_REST_HOST.split(':');
    const req = https.request({
      hostname: host,
      port: parseInt(port || 8080, 10),
      path: endpoint,
      method: 'GET',
      ca: readFile(LND_TLS_PATH),
      servername: 'localhost',
      headers: { 'Grpc-Metadata-macaroon': readFile(LND_MACAROON_PATH).toString('hex') },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('LND request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function checkLndBolt12Flags() {
  const confPaths = ['/lnd/lnd/lnd.conf', '/lnd/lnd.conf'];
  const settingsPaths = ['/lightning/settings.json', '/lnd/lightning/settings.json', '/lnd/data/lightning/settings.json'];
  const expected = { 'protocol.custom-message': 513, 'protocol.custom-nodeann': 39, 'protocol.custom-init': 39 };

  for (const p of confPaths) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const flags = {};
      for (const key of Object.keys(expected)) {
        const re = new RegExp(`^${key.replace(/\./g, '\\.')}\s*=\s*(\\d+)`, 'm');
        const m = text.match(re);
        flags[key] = m ? Number(m[1]) : null;
      }
      return { source: p, flags };
    } catch { /* try next */ }
  }

  for (const p of settingsPaths) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const lnd = data.lnd || {};
      const flags = {};
      for (const key of Object.keys(expected)) {
        flags[key] = lnd[key] != null ? Number(lnd[key]) : null;
      }
      return { source: p, flags };
    } catch { /* try next */ }
  }
  return { source: null, flags: null, error: 'LND config not found in container' };
}

function hasOnionMessageSupport(features) {
  if (!features) return false;
  return !!features['38'] || !!features['39'];
}

async function main() {
  console.log('');
  console.log('⚡ Bolt12 Server — pre-start checks');
  console.log('===================================');
  console.log('');

  if (!fs.existsSync(LND_TLS_PATH)) fatal(`LND TLS cert not found: ${LND_TLS_PATH}`);
  if (!fs.existsSync(LND_MACAROON_PATH)) fatal(`LND macaroon not found: ${LND_MACAROON_PATH}`);
  log('ok', 'LND TLS cert and macaroon are mounted');

  let info;
  try {
    info = await lndRestGet('/v1/getinfo');
  } catch (e) {
    fatal(`Cannot reach LND REST API at ${LND_REST_HOST}: ${e.message}`);
  }
  log('ok', `LND connected: ${info.alias || '?'} (${info.version || '?'})`);

  if (!info.synced_to_chain) log('warn', 'LND is not yet synced to chain. Payments will fail until sync completes.');
  if (!info.synced_to_graph) log('warn', 'LND is not yet synced to graph. Routes may be unreliable.');

  const flags = checkLndBolt12Flags();
  if (!flags.flags) {
    fatal(`Cannot detect BOLT12 protocol flags: ${flags.error}. Run setup-lnd-flags.sh on the Umbrel host and restart the Lightning app.`);
  }
  const expected = { 'protocol.custom-message': 513, 'protocol.custom-nodeann': 39, 'protocol.custom-init': 39 };
  const missing = Object.entries(expected).filter(([k, v]) => Number(flags.flags[k]) !== v);
  if (missing.length) {
    fatal(`Missing BOLT12 protocol flags in ${flags.source}: ${missing.map(([k, v]) => `${k}=${v}`).join(', ')}. Run setup-lnd-flags.sh on the Umbrel host and restart the Lightning app.`);
  }
  log('ok', `BOLT12 protocol flags OK (${flags.source})`);

  const channels = await lndRestGet('/v1/channels').catch(() => ({ channels: [] }));
  const chans = Array.isArray(channels.channels) ? channels.channels : [];
  const publicChans = chans.filter(c => c.private === false && c.active);
  if (!chans.length) {
    log('warn', 'No active Lightning channels found. You need at least one public channel to receive BOLT12 payments.');
  } else if (!publicChans.length) {
    log('warn', 'Active channels exist but none are public. BOLT12 invoice requests require at least one announced (public) channel to build a blinded path.');
  } else {
    log('ok', `${publicChans.length} public active channel(s) found`);
  }

  const peers = await lndRestGet('/v1/peers').catch(() => ({ peers: [] }));
  const peerList = Array.isArray(peers.peers) ? peers.peers : [];
  if (!peerList.length) {
    log('warn', 'No peers connected. BOLT12 invoice requests cannot be relayed without at least one peer supporting onion messages.');
  } else {
    const bolt12Peers = peerList.filter(p => hasOnionMessageSupport(p.features));
    if (!bolt12Peers.length) {
      log('warn', `Connected to ${peerList.length} peer(s), but none advertise onion-message support. BOLT12 invoice requests will not reach this node. Open a public channel to a BOLT12-compatible node such as ACINQ (03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f).`);
    } else {
      log('ok', `${bolt12Peers.length}/${peerList.length} peer(s) support BOLT12 onion messaging`);
    }
  }

  if (!fs.existsSync(LNDK_TLS_PATH)) {
    log('warn', `LNDK TLS cert not yet created at ${LNDK_TLS_PATH}. LNDK may still be starting.`);
  } else {
    log('ok', 'LNDK TLS cert is present');
  }

  console.log('');
  console.log('Starting Bolt12 Server…');
  console.log('');
}

main().catch(e => fatal(e.message));

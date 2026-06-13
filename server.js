const express = require('express');
const grpc    = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const rateLimit   = require('express-rate-limit');
const https   = require('https');
const http    = require('http');
const dns     = require('dns');
const net     = require('net');
const util    = require('util');
const ipaddr  = require('ipaddr.js');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const QRCode  = require('qrcode');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Umbrel app_proxy sits in front

// ============================================
// SECURITY HEADERS
// ============================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "font-src 'self'"
  );
  next();
});

// ============================================
// RATE LIMITING
// ============================================
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
});

const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
});

app.use(limiter);
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ============================================
// CONFIGURATION
// ============================================
const PORT               = process.env.PORT            || 3001;
const LND_TLS_PATH       = process.env.LND_TLS_PATH;
const LND_MACAROON_PATH  = process.env.LND_MACAROON_PATH;
const LND_REST_HOST      = process.env.LND_REST_HOST   || 'host.docker.internal:8080';
const LNDK_HOST          = process.env.LNDK_HOST       || 'host.docker.internal:10010';
const LNDK_MACAROON_PATH = process.env.LNDK_MACAROON_PATH || '/lndk-data/admin.macaroon';
const DATA_DIR           = path.join(__dirname, 'data');
const OFFERS_FILE        = path.join(DATA_DIR, 'offers.json');
const KEY_FILE           = path.join(DATA_DIR, 'api_key.txt');

// Auto-generate API key on first run, persist in /app/data/api_key.txt
fs.mkdirSync(DATA_DIR, { recursive: true });
let API_KEY = process.env.API_KEY;
if (!API_KEY) {
  if (fs.existsSync(KEY_FILE)) {
    API_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
  } else {
    API_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_FILE, API_KEY, { mode: 0o600 });
    console.log('🔑 API Key generated — visible via /api/v1/config on local network');
  }
}

if (!fs.existsSync(LND_TLS_PATH))      { console.error(`❌ TLS cert not found: ${LND_TLS_PATH}`); process.exit(1); }
if (!fs.existsSync(LND_MACAROON_PATH)) { console.error(`❌ Macaroon not found: ${LND_MACAROON_PATH}`); process.exit(1); }

if (!fs.existsSync(OFFERS_FILE)) fs.writeFileSync(OFFERS_FILE, '[]');

// ============================================
// ATOMIC JSON STORE HELPERS (prevents corruption)
// ============================================
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const WEBHOOKS_FILE  = path.join(DATA_DIR, 'webhooks.json');
const LOG_FILE       = path.join(DATA_DIR, 'access_log.json');
[TEMPLATES_FILE, WEBHOOKS_FILE, LOG_FILE].forEach(f => {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '[]');
});

/** Simple Promise-based mutex (no external dependency) */
function createMutex() {
  let queue = Promise.resolve();
  return {
    runExclusive(fn) {
      const result = queue.then(() => fn());
      queue = result.catch(() => {});
      return result;
    }
  };
}

const fileMutexes = new Map();
function getFileMutex(file) {
  if (!fileMutexes.has(file)) fileMutexes.set(file, createMutex());
  return fileMutexes.get(file);
}

async function loadJsonAsync(file, def = []) {
  return getFileMutex(file).runExclusive(() => loadJson(file, def));
}

async function saveJsonAsync(file, data) {
  return getFileMutex(file).runExclusive(() => saveJson(file, data));
}

function loadJson(file, def = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

/** Atomic write: write to .tmp then rename — safe against power-loss corruption.
 *  Serializes BigInt values as decimal strings for JSON compatibility. */
function saveJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v, null, 2));
  fs.renameSync(tmp, file);
}

function loadOffers() { return loadJson(OFFERS_FILE, []); }
function saveOffers(offers) { saveJson(OFFERS_FILE, offers); }

// ============================================
// INPUT VALIDATION HELPERS
// ============================================
const MAX_SATS = 21_000_000n * 100_000_000n; // 21M BTC in sats

/**
 * Parse and validate a BigInt amount value.
 * Returns BigInt or throws on invalid/negative/over-supply.
 */
function parseBigIntAmount(val, fieldName = 'amount') {
  if (val === undefined || val === null || val === '') return null;
  let n;
  try { n = BigInt(val); } catch {
    throw new Error(`${fieldName} must be a valid integer`);
  }
  if (n < 0n)        throw new Error(`${fieldName} must be positive`);
  if (n > MAX_SATS)  throw new Error(`${fieldName} exceeds maximum Bitcoin supply`);
  return n;
}

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  return str.slice(0, max);
}

/**
 * Escape a CSV cell. Quotes everything, doubles embedded quotes,
 * and prefixes formula-triggering characters with a tab to neutralise
 * spreadsheet injection vectors.
 */
function csvEscape(value) {
  let str = String(value ?? '');
  if (/^[+\-=@\t\r]/.test(str)) {
    str = '\t' + str;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

// ============================================
// SSRF PROTECTION FOR WEBHOOKS
// ============================================
const dnsResolve4 = util.promisify(dns.resolve4);
const dnsResolve6 = util.promisify(dns.resolve6);

function isPrivateIp(ip) {
  try {
    const addr = ipaddr.parse(ip);
    const range = addr.range();
    return range === 'private' || range === 'loopback' || range === 'linkLocal' ||
           range === 'uniqueLocal' || range === 'multicast' || range === 'broadcast';
  } catch {
    return false;
  }
}

function looksLikeIpv4Alternative(hostname) {
  // Blocks decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1),
  // abbreviated (127.1) and any dotted form with non-decimal parts.
  return /^(0x[0-9a-f]+|\d+)$/i.test(hostname) ||
         /^(\d+|0x[0-9a-f]+)(\.(\d+|0x[0-9a-f]+)){1,3}$/i.test(hostname);
}

async function resolveHostIps(hostname) {
  const ips = [];
  try { ips.push(...(await dnsResolve4(hostname))); } catch {}
  try { ips.push(...(await dnsResolve6(hostname))); } catch {}
  return ips;
}

async function isPrivateHost(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.username || u.password) return true;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;

    const host = u.hostname;
    if (!host) return true;

    if (/^(localhost|ip6-localhost|ip6-loopback)$/i.test(host)) return true;

    // Standard IPv4 / IPv6 literals
    if (net.isIPv4(host) || net.isIPv6(host)) {
      return isPrivateIp(host);
    }

    // Non-standard IP-like literals (decimal/hex/octal/abbreviated) are blocked
    if (looksLikeIpv4Alternative(host)) return true;

    // Hostname: resolve and check all returned IPs
    const ips = await resolveHostIps(host);
    if (ips.length === 0) return true;
    return ips.some(ip => isPrivateIp(ip));
  } catch {
    return true;
  }
}

// ============================================
// LND REST CLIENT
// ============================================
const lndTlsCert  = fs.readFileSync(LND_TLS_PATH);
const lndMacaroon = fs.readFileSync(LND_MACAROON_PATH).toString('hex');

function lndRestGet(endpoint) {
  return new Promise((resolve, reject) => {
    const [host, port] = LND_REST_HOST.split(':');
    const req = https.request({
      hostname: host,
      port: parseInt(port) || 8080,
      path: endpoint,
      method: 'GET',
      ca: lndTlsCert,
      servername: 'localhost',
      headers: { 'Grpc-Metadata-macaroon': lndMacaroon },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`LND REST ${res.statusCode}: ${data}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`Invalid JSON from LND: ${err.message}`)); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('LND REST request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function lndRestPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const [host, port] = LND_REST_HOST.split(':');
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: host, port: parseInt(port) || 8080, path: endpoint, method: 'POST',
      ca: lndTlsCert, servername: 'localhost',
      headers: {
        'Grpc-Metadata-macaroon': lndMacaroon,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`LND REST ${res.statusCode}: ${data}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`Invalid JSON from LND: ${err.message}`)); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('LND REST request timeout')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ============================================
// ACCESS LOG MIDDLEWARE (async — does not block request)
// ============================================
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const entry = {
      method: req.method,
      path: req.path,
      ip: req.ip || '',
      ts: new Date().toISOString(),
      authed: !!req.headers['x-api-key'],
    };
    setImmediate(async () => {
      try {
        await getFileMutex(LOG_FILE).runExclusive(() => {
          const logs = loadJson(LOG_FILE, []);
          logs.unshift(entry);
          saveJson(LOG_FILE, logs.slice(0, 300));
        });
      } catch (err) {
        console.warn('[log] write failed:', err.message);
      }
    });
  }
  next();
});

// ============================================
// WEBHOOKS FIRE UTILITY
// ============================================
const MAX_WEBHOOK_RESPONSE = 1024 * 1024;

async function fireWebhooks(event, data) {
  const hooks = (await loadJsonAsync(WEBHOOKS_FILE, [])).filter(w => w.active && (w.event === event || w.event === '*'));
  await Promise.all(hooks.map(async wh => {
    try {
      if (await isPrivateHost(wh.url)) {
        return console.warn(`[webhook] Blocked private URL [${event}] → ${wh.url}`);
      }
      const u = new URL(wh.url);
      const body = JSON.stringify({ event, data, ts: new Date().toISOString() });
      const mod = u.protocol === 'https:' ? https : http;
      await new Promise((resolve, reject) => {
        const r = mod.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          let recv = '';
          let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size <= MAX_WEBHOOK_RESPONSE) recv += chunk;
          });
          res.on('end', () => {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
            } else {
              resolve();
            }
          });
        });
        const to = setTimeout(() => {
          r.destroy(new Error('Webhook timeout'));
        }, 5000);
        r.on('error', reject);
        r.on('close', () => clearTimeout(to));
        r.write(body); r.end();
      });
    } catch (err) {
      console.warn(`[webhook] Failed [${event}] → ${wh.url}: ${err.message}`);
    }
  }));
}

// ============================================
// LNDK gRPC CLIENT with exponential-backoff retry
// ============================================
let lndkClient = null;
let lndkReady  = false;
let _retryTimer = null;

function initLndkClient() {
  try {
    const PROTO_PATH = path.join(__dirname, 'proto', 'lndkrpc.proto');
    if (!fs.existsSync(PROTO_PATH)) {
      console.warn('⚠️  lndkrpc.proto not found — BOLT12 ops unavailable');
      return false;
    }

    const pkgDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [path.join(__dirname, 'proto')],
    });

    const lndkrpc = grpc.loadPackageDefinition(pkgDef).lndkrpc;

    const macaroonCreds = grpc.credentials.createFromMetadataGenerator((args, cb) => {
      const m = new grpc.Metadata();
      if (fs.existsSync(LNDK_MACAROON_PATH)) {
        m.add('macaroon', fs.readFileSync(LNDK_MACAROON_PATH).toString('hex'));
      }
      cb(null, m);
    });

    const LNDK_TLS = process.env.LNDK_TLS_PATH || '/lndk-data/tls.cert';
    if (!fs.existsSync(LNDK_TLS)) {
      console.error(`❌ LNDK TLS cert not found: ${LNDK_TLS}`);
      process.exit(1);
    }
    const lndkCert = fs.readFileSync(LNDK_TLS);
    const sslCreds = grpc.credentials.createSsl(lndkCert);
    const creds = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);

    lndkClient = new lndkrpc.Offers(LNDK_HOST, creds, {
      'grpc.ssl_target_name_override': 'localhost',
      'grpc.default_authority': 'localhost',
    });
    lndkReady  = true;
    clearTimeout(_retryTimer);
    console.log(`✅ LNDK client initialized at ${LNDK_HOST}`);
    return true;
  } catch (err) {
    console.warn('⚠️  LNDK init failed:', err.message);
    return false;
  }
}

/** Retry LNDK connection with exponential backoff (max 60s) */
function scheduleLndkRetry(attempt = 1) {
  if (lndkReady) return;
  const delay = Math.min(60000, 2000 * Math.pow(2, attempt - 1));
  console.log(`[lndk] Retry in ${Math.round(delay / 1000)}s (attempt ${attempt})…`);
  _retryTimer = setTimeout(() => {
    if (!lndkReady) {
      if (!initLndkClient()) scheduleLndkRetry(attempt + 1);
    }
  }, delay);
}

// ============================================
// MIDDLEWARES
// ============================================
function auth(req, res, next) {
  const provided = req.headers['x-api-key'] || '';
  if (provided.length !== API_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY)))
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

// ============================================
// HEALTH
// ============================================
app.get('/health', async (req, res) => {
  try {
    const info = await lndRestGet('/v1/getinfo');
    res.json({
      status: 'ok',
      service: 'bolt12-offer-server',
      version: '2.2.0',
      lnd: { connected: true, alias: info.alias, version: info.version },
      lndk: { ready: lndkReady },
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      lnd: { connected: false, error: err.message },
      lndk: { ready: lndkReady },
    });
  }
});

function isLocalAddress(ip) {
  if (!ip) return false;
  const raw = ip.replace(/^::ffff:/, '');
  if (raw === '127.0.0.1' || raw === '::1') return true;
  if (raw.startsWith('10.') || raw.startsWith('192.168.') || raw.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(raw)) return true;
  return false;
}

// Config endpoint — local network only (never trust proxy headers)
app.get('/api/v1/config', (req, res) => {
  const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  if (!isLocalAddress(raw)) return res.status(403).json({ success: false, error: 'Forbidden' });
  res.json({ apiKey: API_KEY, lndkReady, version: '2.2.0' });
});

function checkLndBolt12Flags() {
  // UmbrelOS 0.5.x uses lnd.conf; UmbrelOS 1.x uses lightning/settings.json
  const confPaths = [
    '/lnd/lnd/lnd.conf',
    '/lnd/lnd.conf',
  ];
  const settingsPaths = [
    '/lightning/settings.json',
    '/lnd/lightning/settings.json',
    '/lnd/data/lightning/settings.json',
  ];

  const expected = {
    'protocol.custom-message': 513,
    'protocol.custom-nodeann': 39,
    'protocol.custom-init': 39,
  };

  // lnd.conf style
  for (const p of confPaths) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const flags = {};
      for (const key of Object.keys(expected)) {
        const re = new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s*(\\d+)`, 'm');
        const m = text.match(re);
        flags[key] = m ? Number(m[1]) : null;
      }
      return { source: p, flags };
    } catch { /* try next */ }
  }

  // settings.json style
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

app.get('/api/v1/diagnostic', auth, async (req, res) => {
  try {
    const [info, channels] = await Promise.all([
      lndRestGet('/v1/getinfo'),
      lndRestGet('/v1/channels').catch(() => ({ channels: [] })),
    ]);
    const flags = checkLndBolt12Flags();
    const chans = Array.isArray(channels.channels) ? channels.channels : [];
    const publicChannels = chans.filter(c => c.private === false);
    res.json({
      success: true,
      lnd: {
        connected: true,
        alias: info.alias,
        version: info.version,
        synced_to_chain: info.synced_to_chain,
        synced_to_graph: info.synced_to_graph,
        uris: info.uris || [],
        num_peers: info.num_peers,
        num_active_channels: info.num_active_channels,
        num_public_channels: publicChannels.length,
        num_pending_channels: info.num_pending_channels,
        features: info.features,
      },
      bolt12_flags: flags,
      lndk: {
        ready: lndkReady,
        host: LNDK_HOST,
      },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: err.message,
      lnd: { connected: false },
      bolt12_flags: checkLndBolt12Flags(),
      lndk: { ready: lndkReady, host: LNDK_HOST },
    });
  }
});

app.get('/', (req, res) => res.redirect('/dashboard.html'));

// ============================================
// BOLT12 OFFER ENDPOINTS
// ============================================

// Create an offer
app.post('/api/v1/offers', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ success: false, error: 'LNDK not ready', hint: 'LNDK is still starting up' });

  const { amount, description, expiry, issuer, quantity } = req.body;
  if (!description) return res.status(400).json({ success: false, error: 'description required' });

  // Validate and truncate inputs
  const desc    = truncate(String(description), 1024);
  const issuerV = issuer ? truncate(String(issuer), 256) : undefined;

  let amountB, expiryB, quantityB;
  try {
    amountB   = parseBigIntAmount(amount,   'amount');
    expiryB   = parseBigIntAmount(expiry,   'expiry');
    quantityB = parseBigIntAmount(quantity, 'quantity');
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const request = { description: desc };
  // gRPC int64/uint64 fields expect strings (longs: String in protoLoader)
  if (amountB   !== null) request.amount   = amountB.toString();
  if (expiryB   !== null) request.expiry   = expiryB.toString();
  if (issuerV)            request.issuer   = issuerV;
  if (quantityB !== null) request.quantity = quantityB.toString();

  lndkClient.CreateOffer(request, async (err, response) => {
    if (err) {
      console.error('LNDK CreateOffer error:', err.message);
      return res.status(500).json({ success: false, error: 'LNDK error', message: err.message });
    }

    try {
      const offer = await getFileMutex(OFFERS_FILE).runExclusive(async () => {
        // Generate collision-free unique ID
        const existingOffers = loadJson(OFFERS_FILE, []);
        let id;
        do { id = crypto.randomBytes(16).toString('hex'); }
        while (existingOffers.some(o => o.id === id));

        const newOffer = {
          id,
          offer:       response.offer,
          description: desc,
          amount:      amountB,
          issuer:      issuerV || null,
          expiry:      expiryB,
          quantity:    quantityB,
          active:      true,
          createdAt:   new Date().toISOString(),
        };

        existingOffers.push(newOffer);
        saveJson(OFFERS_FILE, existingOffers);
        return newOffer;
      });

      res.json({ success: true, data: offer });
    } catch (storeErr) {
      console.error('Store offer error:', storeErr.message);
      return res.status(500).json({ success: false, error: 'Failed to store offer' });
    }
  });
});

// List active offers
app.get('/api/v1/offers', auth, async (req, res) => {
  const offers = (await loadJsonAsync(OFFERS_FILE, [])).filter(o => o.active === true);
  res.json({ success: true, data: offers, count: offers.length });
});

// Get offer by ID
app.get('/api/v1/offers/:id', auth, async (req, res) => {
  const offer = (await loadJsonAsync(OFFERS_FILE, [])).find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ success: false, error: 'Offer not found' });
  res.json({ success: true, data: offer });
});

// Disable an offer
app.delete('/api/v1/offers/:id', auth, async (req, res) => {
  try {
    await getFileMutex(OFFERS_FILE).runExclusive(() => {
      const offers = loadJson(OFFERS_FILE, []);
      const idx = offers.findIndex(o => o.id === req.params.id);
      if (idx === -1) throw new Error('Offer not found');
      offers[idx].active = false;
      saveJson(OFFERS_FILE, offers);
    });
    res.json({ success: true, message: 'Offer disabled', id: req.params.id });
  } catch (err) {
    if (err.message === 'Offer not found') return res.status(404).json({ success: false, error: 'Offer not found' });
    console.error('Disable offer error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to disable offer' });
  }
});

// QR Code (PNG généré localement)
app.get('/api/v1/offers/:id/qr', auth, async (req, res) => {
  try {
    const offer = (await loadJsonAsync(OFFERS_FILE, [])).find(o => o.id === req.params.id);
    if (!offer) return res.status(404).json({ success: false, error: 'Offer not found' });
    const size = Math.min(Math.max(parseInt(req.query.size) || 300, 100), 1000);
    const buf = await QRCode.toBuffer(offer.offer, {
      type: 'png',
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(buf);
  } catch (err) {
    console.error('QR generation error:', err.message);
    res.status(500).json({ success: false, error: 'QR generation failed' });
  }
});

// ============================================
// BALANCE & NODE INFO
// ============================================
app.get('/api/v1/balance', auth, readLimiter, async (req, res) => {
  try {
    const [ch, chain, info] = await Promise.all([
      lndRestGet('/v1/balance/channels'),
      lndRestGet('/v1/balance/blockchain'),
      lndRestGet('/v1/getinfo'),
    ]);
    res.json({ success: true, data: {
      lightning: {
        local:   parseInt(ch.local_balance?.sat  || ch.local_balance  || 0),
        remote:  parseInt(ch.remote_balance?.sat || ch.remote_balance || 0),
        pending: parseInt(ch.pending_open_local_balance?.sat || 0),
      },
      onchain: {
        confirmed:   parseInt(chain.confirmed_balance   || 0),
        unconfirmed: parseInt(chain.unconfirmed_balance || 0),
      },
      channels: {
        active:   info.num_active_channels   || 0,
        inactive: info.num_inactive_channels || 0,
        pending:  info.num_pending_channels  || 0,
      },
      node: {
        alias:        info.alias,
        pubkey:       info.identity_pubkey,
        synced:       info.synced_to_chain,
        block_height: info.block_height,
      },
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// PAYMENT HISTORY
// ============================================
app.get('/api/v1/payments', auth, readLimiter, async (req, res) => {
  try {
    const [sent, recv] = await Promise.all([
      lndRestGet('/v1/payments?max_payments=30&reversed=true&include_incomplete=false'),
      lndRestGet('/v1/invoices?reversed=true&num_max_invoices=30'),
    ]);
    const payments = (sent.payments || []).map(p => ({
      type:        'sent',
      hash:        p.payment_hash,
      amount_sat:  parseInt(p.value_sat || p.value || 0),
      fee_sat:     parseInt(p.fee_sat || p.fee || 0),
      status:      p.status,
      date:        parseInt(p.creation_time_ns ? p.creation_time_ns / 1e9 : p.creation_date || 0),
      description: p.payment_request ? null : 'BOLT12',
    }));
    const invoices = (recv.invoices || [])
      .filter(i => i.state === 'SETTLED')
      .map(i => ({
        type:        'received',
        hash:        i.r_hash,
        amount_sat:  parseInt(i.amt_paid_sat || i.value || 0),
        fee_sat:     0,
        status:      'SUCCEEDED',
        date:        parseInt(i.settle_date || i.creation_date || 0),
        description: i.memo || null,
      }));
    const all = [...payments, ...invoices].sort((a, b) => b.date - a.date).slice(0, 40);
    res.json({ success: true, data: all });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// PAY BOLT12 OFFER (LNDK)
// ============================================
app.post('/api/v1/pay', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ success: false, error: 'LNDK not ready' });
  const { offer, amount, payer_note } = req.body;
  if (!offer || !offer.startsWith('lno')) return res.status(400).json({ success: false, error: 'Valid BOLT12 offer required (starts with lno)' });

  let amountB;
  try { amountB = parseBigIntAmount(amount, 'amount'); } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const request = { offer };
  if (amountB !== null) request.amount = amountB.toString();
  if (payer_note) request.payer_note = truncate(String(payer_note), 256);

  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + 90);

  lndkClient.PayOffer(request, { deadline }, async (err, response) => {
    if (err) return res.status(500).json({ success: false, error: 'Payment failed', message: err.message });
    await fireWebhooks('payment_sent', { preimage: response.payment_preimage, offer });
    res.json({ success: true, data: { preimage: response.payment_preimage } });
  });
});

// ============================================
// GET INVOICE FROM OFFER (LNDK)
// ============================================
app.post('/api/v1/offers/invoice', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ success: false, error: 'LNDK not ready' });
  const { offer, amount, payer_note } = req.body;
  if (!offer || !offer.startsWith('lno')) return res.status(400).json({ success: false, error: 'Valid BOLT12 offer required (starts with lno)' });

  let amountB;
  try { amountB = parseBigIntAmount(amount, 'amount'); } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const request = { offer };
  if (amountB !== null) request.amount = amountB.toString();
  if (payer_note) request.payer_note = truncate(String(payer_note), 256);

  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + 30);

  lndkClient.GetInvoice(request, { deadline }, (err, response) => {
    if (err) return res.status(500).json({ success: false, error: 'GetInvoice failed', message: err.message });
    res.json({ success: true, data: { invoice: response.invoice_hex_str, contents: response.invoice_contents } });
  });
});

// ============================================
// PAY BOLT12 INVOICE DIRECTLY (LNDK)
// ============================================
app.post('/api/v1/pay/invoice', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ success: false, error: 'LNDK not ready' });
  const { invoice, amount } = req.body;
  if (!invoice || !invoice.startsWith('lni')) return res.status(400).json({ success: false, error: 'Valid BOLT12 invoice required (starts with lni)' });

  let amountB;
  try { amountB = parseBigIntAmount(amount, 'amount'); } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const request = { invoice };
  if (amountB !== null) request.amount = amountB.toString();

  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + 90);

  lndkClient.PayInvoice(request, { deadline }, async (err, response) => {
    if (err) return res.status(500).json({ success: false, error: 'PayInvoice failed', message: err.message });
    await fireWebhooks('payment_sent', { preimage: response.payment_preimage, invoice });
    res.json({ success: true, data: { preimage: response.payment_preimage } });
  });
});

// ============================================
// DECODE BOLT12 INVOICE (LNDK)
// ============================================
app.post('/api/v1/decode', auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ success: false, error: 'LNDK not ready' });
  const { invoice } = req.body;
  if (!invoice || !invoice.startsWith('lni')) return res.status(400).json({ success: false, error: 'Valid BOLT12 invoice required (starts with lni)' });

  lndkClient.DecodeInvoice({ invoice }, (err, response) => {
    if (err) return res.status(500).json({ success: false, error: 'Decode failed', message: err.message });
    res.json({ success: true, data: response });
  });
});

// ============================================
// BOLT11 INVOICE
// ============================================
app.post('/api/v1/invoices', apiLimiter, auth, async (req, res) => {
  const { amount, description, expiry } = req.body;
  if (!description) return res.status(400).json({ success: false, error: 'description required' });

  let amountB;
  try {
    amountB = parseBigIntAmount(amount, 'amount') ?? 0n;
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  if (expiry !== undefined && (!Number.isInteger(expiry) || expiry <= 0)) {
    return res.status(400).json({ success: false, error: 'expiry must be a positive integer' });
  }

  try {
    const data = await lndRestPost('/v1/invoices', {
      value: amountB.toString(), // LND REST accepts string for int64
      memo: truncate(String(description), 1024),
      expiry: expiry || 3600,
    });
    if (data.payment_request) {
      await fireWebhooks('invoice_created', { payment_request: data.payment_request, amount: Number(amountB), description });
      res.json({ success: true, data: { payment_request: data.payment_request, r_hash: data.r_hash } });
    } else {
      res.status(500).json({ success: false, error: 'LND error', message: JSON.stringify(data) });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// STATS
// ============================================
app.get('/api/v1/stats', auth, readLimiter, async (req, res) => {
  try {
    const [sent, recv] = await Promise.all([
      lndRestGet('/v1/payments?max_payments=200&reversed=true&include_incomplete=false'),
      lndRestGet('/v1/invoices?reversed=true&num_max_invoices=200'),
    ]);
    const payments = sent.payments || [];
    const invoices = (recv.invoices || []).filter(i => i.state === 'SETTLED');
    const now = Date.now() / 1000;
    const day = 86400;
    const buckets = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date((now - i * day) * 1000);
      buckets[d.toISOString().slice(0, 10)] = { sent: 0, recv: 0 };
    }
    let totalSent = 0, totalRecv = 0, feesPaid = 0;
    payments.forEach(p => {
      const sats = parseInt(p.value_sat || p.value || 0);
      const fee  = parseInt(p.fee_sat || p.fee || 0);
      totalSent += sats; feesPaid += fee;
      const d = new Date(parseInt(p.creation_time_ns ? p.creation_time_ns / 1e9 : p.creation_date) * 1000).toISOString().slice(0, 10);
      if (buckets[d]) buckets[d].sent += sats;
    });
    invoices.forEach(i => {
      const sats = parseInt(i.amt_paid_sat || 0);
      totalRecv += sats;
      const d = new Date(parseInt(i.settle_date) * 1000).toISOString().slice(0, 10);
      if (buckets[d]) buckets[d].recv += sats;
    });
    res.json({ success: true, data: {
      days:   Object.entries(buckets).map(([date, v]) => ({ date, sent_sats: v.sent, received_sats: v.recv })),
      totals: { sent_sats: totalSent, received_sats: totalRecv, fees_paid: feesPaid, count: payments.length + invoices.length },
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// CSV EXPORT
// ============================================
app.get('/api/v1/payments/export', auth, readLimiter, async (req, res) => {
  try {
    const [sent, recv] = await Promise.all([
      lndRestGet('/v1/payments?max_payments=500&reversed=true&include_incomplete=false'),
      lndRestGet('/v1/invoices?reversed=true&num_max_invoices=500'),
    ]);
    const rows = [['type', 'date', 'amount_sats', 'fee_sats', 'status', 'hash', 'description']];
    (sent.payments || []).forEach(p => rows.push([
      'sent',
      new Date(parseInt(p.creation_time_ns ? p.creation_time_ns / 1e9 : p.creation_date) * 1000).toISOString(),
      p.value_sat || p.value || 0,
      p.fee_sat || p.fee || 0,
      p.status,
      p.payment_hash,
      '',
    ]));
    (recv.invoices || []).filter(i => i.state === 'SETTLED').forEach(i => rows.push([
      'received',
      new Date(parseInt(i.settle_date) * 1000).toISOString(),
      i.amt_paid_sat || 0,
      0,
      'SETTLED',
      i.r_hash,
      i.memo || '',
    ]));
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bolt12-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// PUBLIC OFFER (no auth — for pay page)
// ============================================
app.get('/api/v1/public/offers/:id', readLimiter, async (req, res) => {
  // Explicit active === true check (not `!== false`) to avoid returning
  // offers where active is undefined/null/missing
  const offer = (await loadJsonAsync(OFFERS_FILE, [])).find(o => o.id === req.params.id && o.active === true);
  if (!offer) return res.status(404).json({ success: false, error: 'Offer not found' });
  res.json({ success: true, data: {
    id:          offer.id,
    offer:       offer.offer,
    description: offer.description,
    amount:      offer.amount,
    issuer:      offer.issuer,
  }});
});

app.get('/pay/:id', (req, res) => res.redirect(`/pay.html?id=${encodeURIComponent(req.params.id)}`));

// ============================================
// TEMPLATES
// ============================================
app.get('/api/v1/templates', auth, async (req, res) => {
  res.json({ success: true, data: await loadJsonAsync(TEMPLATES_FILE) });
});

app.post('/api/v1/templates', auth, async (req, res) => {
  const { name, amount, description } = req.body;
  if (!name || !description) return res.status(400).json({ success: false, error: 'name and description required' });
  try {
    const t = await getFileMutex(TEMPLATES_FILE).runExclusive(() => {
      const templates = loadJson(TEMPLATES_FILE);
      const newT = {
        id:          Date.now().toString(36),
        name:        truncate(String(name), 256),
        amount:      amount || 0,
        description: truncate(String(description), 1024),
        createdAt:   new Date().toISOString(),
      };
      templates.push(newT);
      saveJson(TEMPLATES_FILE, templates);
      return newT;
    });
    res.json({ success: true, data: t });
  } catch (err) {
    console.error('Create template error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create template' });
  }
});

app.delete('/api/v1/templates/:id', auth, async (req, res) => {
  try {
    await getFileMutex(TEMPLATES_FILE).runExclusive(() => {
      saveJson(TEMPLATES_FILE, loadJson(TEMPLATES_FILE).filter(t => t.id !== req.params.id));
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete template error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete template' });
  }
});

// ============================================
// WEBHOOKS
// ============================================
app.get('/api/v1/webhooks', auth, async (req, res) => {
  res.json({ success: true, data: await loadJsonAsync(WEBHOOKS_FILE) });
});

app.post('/api/v1/webhooks', auth, async (req, res) => {
  const { url, event } = req.body;
  if (!url || !event) return res.status(400).json({ success: false, error: 'url and event required' });
  try { new URL(url); } catch { return res.status(400).json({ success: false, error: 'Invalid URL' }); }
  // Block SSRF — webhook URLs must be public
  if (await isPrivateHost(url)) return res.status(400).json({ success: false, error: 'Private/local URLs are not allowed for webhooks' });
  try {
    const h = await getFileMutex(WEBHOOKS_FILE).runExclusive(() => {
      const hooks = loadJson(WEBHOOKS_FILE);
      const newH = { id: Date.now().toString(36), url, event, active: true, createdAt: new Date().toISOString() };
      hooks.push(newH);
      saveJson(WEBHOOKS_FILE, hooks);
      return newH;
    });
    res.json({ success: true, data: h });
  } catch (err) {
    console.error('Create webhook error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create webhook' });
  }
});

app.delete('/api/v1/webhooks/:id', auth, async (req, res) => {
  try {
    await getFileMutex(WEBHOOKS_FILE).runExclusive(() => {
      saveJson(WEBHOOKS_FILE, loadJson(WEBHOOKS_FILE).filter(h => h.id !== req.params.id));
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete webhook error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete webhook' });
  }
});

app.patch('/api/v1/webhooks/:id', auth, async (req, res) => {
  try {
    const hook = await getFileMutex(WEBHOOKS_FILE).runExclusive(() => {
      const hooks = loadJson(WEBHOOKS_FILE);
      const idx = hooks.findIndex(h => h.id === req.params.id);
      if (idx === -1) throw new Error('Webhook not found');
      hooks[idx].active = !hooks[idx].active;
      saveJson(WEBHOOKS_FILE, hooks);
      return hooks[idx];
    });
    res.json({ success: true, data: hook });
  } catch (err) {
    if (err.message === 'Webhook not found') return res.status(404).json({ success: false, error: 'Webhook not found' });
    console.error('Patch webhook error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update webhook' });
  }
});

// ============================================
// LNURL-PAY / LIGHTNING ADDRESS
// ============================================
const LNURL_DOMAIN   = process.env.LNURL_DOMAIN   || '';
const LNURL_USERNAME = process.env.LNURL_USERNAME  || 'pay';
const LNURL_MIN_MSATS = parseInt(process.env.LNURL_MIN_MSATS || '1000');
const LNURL_MAX_MSATS = parseInt(process.env.LNURL_MAX_MSATS || '10000000000');

// BIP-353 / RFC-compliant Lightning Address: pay@domain.com
// Wallets fetch /.well-known/lnurlp/<username> then call the callback
app.get('/.well-known/lnurlp/:username', readLimiter, async (req, res) => {
  if (!LNURL_DOMAIN) {
    return res.status(404).json({
      status: 'ERROR',
      reason: 'Lightning Address not configured. Set LNURL_DOMAIN in environment.',
    });
  }
  if (req.params.username !== LNURL_USERNAME) {
    return res.status(404).json({ status: 'ERROR', reason: 'User not found' });
  }

  let nodeAlias = 'BOLT12 Server';
  try {
    const info = await lndRestGet('/v1/getinfo');
    nodeAlias = info.alias || nodeAlias;
  } catch { /* non-fatal */ }

  const metadata = JSON.stringify([
    ['text/plain',      `Pay ${LNURL_USERNAME}@${LNURL_DOMAIN} · ${nodeAlias}`],
    ['text/identifier', `${LNURL_USERNAME}@${LNURL_DOMAIN}`],
  ]);

  res.json({
    callback:     `https://${LNURL_DOMAIN}/api/v1/lnurl/callback`,
    maxSendable:  LNURL_MAX_MSATS,
    minSendable:  LNURL_MIN_MSATS,
    metadata,
    tag:          'payRequest',
    commentAllowed: 120,
  });
});

// LNURL-pay callback — wallet sends amount, we return a BOLT11 invoice
app.get('/api/v1/lnurl/callback', readLimiter, async (req, res) => {
  if (!LNURL_DOMAIN) {
    return res.status(404).json({ status: 'ERROR', reason: 'LNURL not configured' });
  }

  const amount_msats = parseInt(req.query.amount);
  if (!amount_msats || amount_msats < LNURL_MIN_MSATS || amount_msats > LNURL_MAX_MSATS) {
    return res.status(400).json({
      status: 'ERROR',
      reason: `Amount must be between ${LNURL_MIN_MSATS} and ${LNURL_MAX_MSATS} msats`,
    });
  }
  if (amount_msats % 1000 !== 0) {
    return res.status(400).json({
      status: 'ERROR',
      reason: 'Amount must be a whole number of satoshis (multiple of 1000 msats)',
    });
  }

  const comment = req.query.comment ? truncate(String(req.query.comment), 120) : '';
  const amount_sats = amount_msats / 1000;

  // Build the description hash required by the LNURL-pay spec
  const metadata = JSON.stringify([
    ['text/plain',      `Pay ${LNURL_USERNAME}@${LNURL_DOMAIN}`],
    ['text/identifier', `${LNURL_USERNAME}@${LNURL_DOMAIN}`],
  ]);
  const descHashBase64 = crypto
    .createHash('sha256')
    .update(metadata)
    .digest('base64');

  try {
    const data = await lndRestPost('/v1/invoices', {
      value:            amount_sats,
      description_hash: descHashBase64,
      expiry:           3600,
    });

    if (!data.payment_request || !data.payment_request.startsWith('ln')) {
      return res.status(500).json({ status: 'ERROR', reason: 'Failed to generate invoice' });
    }

    await fireWebhooks('lnurl_payment', { amount_sats, comment, domain: LNURL_DOMAIN });
    res.json({ pr: data.payment_request, routes: [] });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', reason: err.message });
  }
});

// LNURL config info (dashboard use)
app.get('/api/v1/lnurl/info', auth, (req, res) => {
  res.json({
    success: true,
    data: {
      configured:  !!LNURL_DOMAIN,
      domain:      LNURL_DOMAIN || null,
      address:     LNURL_DOMAIN ? `${LNURL_USERNAME}@${LNURL_DOMAIN}` : null,
      minSats:     Math.floor(LNURL_MIN_MSATS / 1000),
      maxSats:     Math.floor(LNURL_MAX_MSATS / 1000),
    },
  });
});

// ============================================
// ACCESS LOGS
// ============================================
app.get('/api/v1/logs', auth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  res.json({ success: true, data: (await loadJsonAsync(LOG_FILE)).slice(0, limit) });
});

// ============================================
// STARTUP
// ============================================
console.log('⚡ Bolt12 Offer Server v2.2.0 (LNDK mode)');
console.log('==========================================');

if (!initLndkClient()) {
  // LNDK may not be ready yet (slow start) — retry with backoff
  scheduleLndkRetry(1);
}

const server = app.listen(PORT, () => {
  console.log('==========================================');
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log('==========================================');
});

// ============================================
// GRACEFUL SHUTDOWN (Docker SIGTERM support)
// ============================================
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  clearTimeout(_retryTimer);
  server.close(() => {
    console.log('Server closed. Goodbye.');
    process.exit(0);
  });
  // Force exit if server takes too long to close
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;

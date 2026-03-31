const express = require('express');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const rateLimit = require('express-rate-limit');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Umbrel app_proxy sits in front

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

app.use(limiter);
app.use(express.json());
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
    const crypto = require('crypto');
    API_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_FILE, API_KEY);
    console.log(`🔑 API Key generated — visible via /api/v1/config on local network`);
  }
}

if (!fs.existsSync(LND_TLS_PATH))      { console.error(`❌ TLS cert not found: ${LND_TLS_PATH}`); process.exit(1); }
if (!fs.existsSync(LND_MACAROON_PATH)) { console.error(`❌ Macaroon not found: ${LND_MACAROON_PATH}`); process.exit(1); }

if (!fs.existsSync(OFFERS_FILE)) fs.writeFileSync(OFFERS_FILE, '[]');

// ============================================
// LOCAL OFFER STORE (LNDK n'a pas ListOffers)
// ============================================
function loadOffers() {
  try { return JSON.parse(fs.readFileSync(OFFERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveOffers(offers) {
  fs.writeFileSync(OFFERS_FILE, JSON.stringify(offers, null, 2));
}

// ============================================
// LND REST CLIENT (health check)
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
      servername: 'localhost',  // TLS SNI override (cert has localhost)
      headers: { 'Grpc-Metadata-macaroon': lndMacaroon },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
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
      headers: { 'Grpc-Metadata-macaroon': lndMacaroon, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ============================================
// GENERIC JSON STORE HELPERS
// ============================================
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const WEBHOOKS_FILE  = path.join(DATA_DIR, 'webhooks.json');
const LOG_FILE       = path.join(DATA_DIR, 'access_log.json');
[TEMPLATES_FILE, WEBHOOKS_FILE, LOG_FILE].forEach(f => { if (!fs.existsSync(f)) fs.writeFileSync(f, '[]'); });

function loadJson(file, def = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ============================================
// ACCESS LOG MIDDLEWARE
// ============================================
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const logs = loadJson(LOG_FILE, []);
    logs.unshift({ method: req.method, path: req.path, ip: req.ip || '', ts: new Date().toISOString(), authed: !!req.headers['x-api-key'] });
    saveJson(LOG_FILE, logs.slice(0, 300));
  }
  next();
});

// ============================================
// WEBHOOKS FIRE UTILITY
// ============================================
function fireWebhooks(event, data) {
  const hooks = loadJson(WEBHOOKS_FILE, []).filter(w => w.active && (w.event === event || w.event === '*'));
  hooks.forEach(wh => {
    try {
      const u = new URL(wh.url);
      const body = JSON.stringify({ event, data, ts: new Date().toISOString() });
      const mod = u.protocol === 'https:' ? require('https') : http;
      const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
      r.on('error', () => {});
      r.write(body); r.end();
    } catch {}
  });
}

// ============================================
// LNDK gRPC CLIENT (BOLT12 offers)
// ============================================
let lndkClient = null;
let lndkReady  = false;

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

    // LNDK macaroon (créé par LNDK au démarrage)
    let lndkMeta = null;
    if (fs.existsSync(LNDK_MACAROON_PATH)) {
      const mac = fs.readFileSync(LNDK_MACAROON_PATH).toString('hex');
      lndkMeta = () => {
        const m = new grpc.Metadata();
        m.add('macaroon', mac);
        return m;
      };
    }

    const macaroonCreds = grpc.credentials.createFromMetadataGenerator((args, cb) => {
      const m = new grpc.Metadata();
      if (fs.existsSync(LNDK_MACAROON_PATH)) {
        m.add('macaroon', fs.readFileSync(LNDK_MACAROON_PATH).toString('hex'));
      }
      cb(null, m);
    });

    // LNDK génère son propre cert TLS dans /lndk-data
    const LNDK_TLS = process.env.LNDK_TLS_PATH || '/lndk-data/tls.cert';
    let creds;
    if (fs.existsSync(LNDK_TLS)) {
      const lndkCert = fs.readFileSync(LNDK_TLS);
      const sslCreds = grpc.credentials.createSsl(lndkCert);
      creds = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);
    } else {
      console.warn('⚠️  LNDK TLS cert not found — using insecure (localhost only)');
      creds = grpc.credentials.createInsecure();
    }

    lndkClient = new lndkrpc.Offers(LNDK_HOST, creds);
    lndkReady  = true;
    console.log(`✅ LNDK client initialized at ${LNDK_HOST}`);
    return true;
  } catch (err) {
    console.warn('⚠️  LNDK init failed:', err.message);
    return false;
  }
}

// ============================================
// MIDDLEWARES
// ============================================
function auth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
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
      version: '2.0.0',
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

// Config (réseau local seulement)
app.get('/api/v1/config', (req, res) => {
  const raw = req.ip || '';
  const ip  = raw.replace(/^::ffff:/, ''); // normalize IPv6-mapped IPv4
  const isLocal = ['127.0.0.1','::1'].includes(raw) || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.');
  if (!isLocal) return res.status(403).json({ error: 'Forbidden' });
  res.json({ apiKey: API_KEY, lndkReady, version: '2.0.0' });
});

app.get('/', (req, res) => res.redirect('/dashboard.html'));

// ============================================
// BOLT12 OFFER ENDPOINTS
// ============================================

// Créer une offer
app.post('/api/v1/offers', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ error: 'LNDK not ready', hint: 'LNDK is still building or not started' });

  const { amount, description, expiry, issuer, quantity } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });

  const request = {};
  if (amount)      request.amount = BigInt(amount);
  if (description) request.description = description;
  if (expiry)      request.expiry = BigInt(expiry);
  if (issuer)      request.issuer = issuer;
  if (quantity)    request.quantity = BigInt(quantity);

  lndkClient.CreateOffer(request, (err, response) => {
    if (err) {
      console.error('LNDK CreateOffer error:', err.message);
      return res.status(500).json({ error: 'LNDK error', message: err.message });
    }

    const offer = {
      id: Buffer.from(response.offer).toString('base64').slice(0, 16),
      offer: response.offer,
      description,
      amount: amount || 0,
      issuer: issuer || null,
      expiry: expiry || null,
      quantity: quantity || null,
      active: true,
      createdAt: new Date().toISOString(),
    };

    const offers = loadOffers();
    offers.push(offer);
    saveOffers(offers);

    res.json({ success: true, data: offer });
  });
});

// Lister les offers
app.get('/api/v1/offers', auth, (req, res) => {
  const offers = loadOffers().filter(o => o.active !== false);
  res.json({ success: true, data: offers, count: offers.length });
});

// Récupérer une offer
app.get('/api/v1/offers/:id', auth, (req, res) => {
  const offer = loadOffers().find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  res.json({ success: true, data: offer });
});

// Désactiver une offer
app.delete('/api/v1/offers/:id', auth, (req, res) => {
  const offers = loadOffers();
  const idx = offers.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Offer not found' });
  offers[idx].active = false;
  saveOffers(offers);
  res.json({ success: true, message: 'Offer disabled', id: req.params.id });
});

// QR Code
app.get('/api/v1/offers/:id/qr', auth, (req, res) => {
  const offer = loadOffers().find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  const size = Math.min(Math.max(parseInt(req.query.size) || 300, 100), 1000);
  res.json({
    success: true,
    data: {
      offer: offer.offer,
      qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(offer.offer)}`,
      bitcoinUri: `bitcoin:?lno=${offer.offer}`,
      id: offer.id,
    }
  });
});

// ============================================
// BALANCE & NODE INFO
// ============================================
app.get('/api/v1/balance', auth, async (req, res) => {
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
        alias:       info.alias,
        pubkey:      info.identity_pubkey,
        synced:      info.synced_to_chain,
        block_height: info.block_height,
      },
    }});
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PAYMENT HISTORY
// ============================================
app.get('/api/v1/payments', auth, async (req, res) => {
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
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PAY BOLT12 OFFER (LNDK)
// ============================================
app.post('/api/v1/pay', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ error: 'LNDK not ready', hint: 'BTC node still syncing' });
  const { offer, amount, payer_note } = req.body;
  if (!offer || !offer.startsWith('lno')) return res.status(400).json({ error: 'Valid BOLT12 offer required (starts with lno)' });

  const request = { offer };
  if (amount)     request.amount     = BigInt(amount);
  if (payer_note) request.payer_note = payer_note;

  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + 90);

  lndkClient.PayOffer(request, { deadline }, (err, response) => {
    if (err) return res.status(500).json({ error: 'Payment failed', message: err.message });
    fireWebhooks('payment_sent', { preimage: response.payment_preimage, offer });
    res.json({ success: true, data: { preimage: response.payment_preimage } });
  });
});

// ============================================
// GET INVOICE FROM OFFER (LNDK) — sans payer
// ============================================
app.post('/api/v1/offers/invoice', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ error: 'LNDK not ready' });
  const { offer, amount, payer_note } = req.body;
  if (!offer || !offer.startsWith('lno')) return res.status(400).json({ error: 'Valid BOLT12 offer required (starts with lno)' });

  const request = { offer };
  if (amount)     request.amount     = BigInt(amount);
  if (payer_note) request.payer_note = payer_note;

  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + 30);

  lndkClient.GetInvoice(request, { deadline }, (err, response) => {
    if (err) return res.status(500).json({ error: 'GetInvoice failed', message: err.message });
    res.json({ success: true, data: { invoice: response.invoice_hex_str, contents: response.invoice_contents } });
  });
});

// ============================================
// PAY BOLT12 INVOICE DIRECTLY (LNDK)
// ============================================
app.post('/api/v1/pay/invoice', apiLimiter, auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ error: 'LNDK not ready' });
  const { invoice, amount } = req.body;
  if (!invoice || !invoice.startsWith('lni')) return res.status(400).json({ error: 'Valid BOLT12 invoice required (starts with lni)' });

  const request = { invoice };
  if (amount) request.amount = BigInt(amount);

  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + 90);

  lndkClient.PayInvoice(request, { deadline }, (err, response) => {
    if (err) return res.status(500).json({ error: 'PayInvoice failed', message: err.message });
    fireWebhooks('payment_sent', { preimage: response.payment_preimage, invoice });
    res.json({ success: true, data: { preimage: response.payment_preimage } });
  });
});

// ============================================
// DECODE BOLT12 INVOICE (LNDK)
// ============================================
app.post('/api/v1/decode', auth, (req, res) => {
  if (!lndkReady) return res.status(503).json({ error: 'LNDK not ready' });
  const { invoice } = req.body;
  if (!invoice || !invoice.startsWith('lni')) return res.status(400).json({ error: 'Valid BOLT12 invoice required (starts with lni)' });

  lndkClient.DecodeInvoice({ invoice }, (err, response) => {
    if (err) return res.status(500).json({ error: 'Decode failed', message: err.message });
    res.json({ success: true, data: response });
  });
});

// ============================================
// BOLT11 INVOICE
// ============================================
app.post('/api/v1/invoices', apiLimiter, auth, async (req, res) => {
  const { amount, description, expiry } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const data = await lndRestPost('/v1/invoices', { value: amount || 0, memo: description, expiry: expiry || 3600 });
    if (data.payment_request) {
      fireWebhooks('invoice_created', { payment_request: data.payment_request, amount, description });
      res.json({ success: true, data: { payment_request: data.payment_request, r_hash: data.r_hash } });
    } else {
      res.status(500).json({ error: 'LND error', message: JSON.stringify(data) });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// STATS
// ============================================
app.get('/api/v1/stats', auth, async (req, res) => {
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
      const fee = parseInt(p.fee_sat || p.fee || 0);
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
      days: Object.entries(buckets).map(([date, v]) => ({ date, sent_sats: v.sent, received_sats: v.recv })),
      totals: { sent_sats: totalSent, received_sats: totalRecv, fees_paid: feesPaid, count: payments.length + invoices.length },
    }});
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// CSV EXPORT
// ============================================
app.get('/api/v1/payments/export', auth, async (req, res) => {
  try {
    const [sent, recv] = await Promise.all([
      lndRestGet('/v1/payments?max_payments=500&reversed=true&include_incomplete=false'),
      lndRestGet('/v1/invoices?reversed=true&num_max_invoices=500'),
    ]);
    const rows = [['type','date','amount_sats','fee_sats','status','hash','description']];
    (sent.payments || []).forEach(p => rows.push(['sent', new Date(parseInt(p.creation_time_ns ? p.creation_time_ns/1e9 : p.creation_date)*1000).toISOString(), p.value_sat||p.value||0, p.fee_sat||p.fee||0, p.status, p.payment_hash, '']));
    (recv.invoices||[]).filter(i=>i.state==='SETTLED').forEach(i => rows.push(['received', new Date(parseInt(i.settle_date)*1000).toISOString(), i.amt_paid_sat||0, 0, 'SETTLED', i.r_hash, i.memo||'']));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bolt12-payments-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// PUBLIC OFFER (no auth — for pay page)
// ============================================
app.get('/api/v1/public/offers/:id', (req, res) => {
  const offer = loadOffers().find(o => o.id === req.params.id && o.active !== false);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  res.json({ success: true, data: { id: offer.id, offer: offer.offer, description: offer.description, amount: offer.amount, issuer: offer.issuer } });
});

app.get('/pay/:id', (req, res) => res.redirect(`/pay.html?id=${req.params.id}`));

// ============================================
// TEMPLATES
// ============================================
app.get('/api/v1/templates', auth, (req, res) => res.json({ success: true, data: loadJson(TEMPLATES_FILE) }));

app.post('/api/v1/templates', auth, (req, res) => {
  const { name, amount, description } = req.body;
  if (!name || !description) return res.status(400).json({ error: 'name and description required' });
  const templates = loadJson(TEMPLATES_FILE);
  const t = { id: Date.now().toString(36), name, amount: amount || 0, description, createdAt: new Date().toISOString() };
  templates.push(t); saveJson(TEMPLATES_FILE, templates);
  res.json({ success: true, data: t });
});

app.delete('/api/v1/templates/:id', auth, (req, res) => {
  const templates = loadJson(TEMPLATES_FILE).filter(t => t.id !== req.params.id);
  saveJson(TEMPLATES_FILE, templates);
  res.json({ success: true });
});

// ============================================
// WEBHOOKS
// ============================================
app.get('/api/v1/webhooks', auth, (req, res) => res.json({ success: true, data: loadJson(WEBHOOKS_FILE) }));

app.post('/api/v1/webhooks', auth, (req, res) => {
  const { url, event } = req.body;
  if (!url || !event) return res.status(400).json({ error: 'url and event required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid URL' }); }
  const hooks = loadJson(WEBHOOKS_FILE);
  const h = { id: Date.now().toString(36), url, event, active: true, createdAt: new Date().toISOString() };
  hooks.push(h); saveJson(WEBHOOKS_FILE, hooks);
  res.json({ success: true, data: h });
});

app.delete('/api/v1/webhooks/:id', auth, (req, res) => {
  saveJson(WEBHOOKS_FILE, loadJson(WEBHOOKS_FILE).filter(h => h.id !== req.params.id));
  res.json({ success: true });
});

app.patch('/api/v1/webhooks/:id', auth, (req, res) => {
  const hooks = loadJson(WEBHOOKS_FILE);
  const idx = hooks.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Webhook not found' });
  hooks[idx].active = !hooks[idx].active;
  saveJson(WEBHOOKS_FILE, hooks);
  res.json({ success: true, data: hooks[idx] });
});

// ============================================
// ACCESS LOGS
// ============================================
app.get('/api/v1/logs', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 300);
  res.json({ success: true, data: loadJson(LOG_FILE).slice(0, limit) });
});

// ============================================
// STARTUP
// ============================================
console.log('⚡ Bolt12 Offer Server v2.0.0 (LNDK mode)');
console.log('==========================================');
console.log(`📡 LND REST : ${LND_REST_HOST}`);
console.log(`⚡ LNDK gRPC: ${LNDK_HOST}`);

initLndkClient();

app.listen(PORT, () => {
  console.log('==========================================');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔍 Health: http://localhost:${PORT}/health`);
  console.log('==========================================');
});

module.exports = app;

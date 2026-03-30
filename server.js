const express = require('express');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const rateLimit = require('express-rate-limit');
const https = require('https');
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

  const { amount, description, expiry, issuer } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });

  const request = {};
  if (amount)      request.amount = BigInt(amount);
  if (description) request.description = description;
  if (expiry)      request.expiry = BigInt(expiry);
  if (issuer)      request.issuer = issuer;

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

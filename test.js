/**
 * BOLT12 Server — Test Suite
 * Usage: node test.js [base_url] [api_key]
 *
 * Examples:
 *   node test.js http://localhost:3001 my-api-key
 *   node test.js http://192.168.1.55:3001 my-api-key
 *
 * Tests every API endpoint and reports PASS / FAIL with details.
 */

'use strict';

const http  = require('http');
const https = require('https');

const BASE    = process.argv[2] || 'http://localhost:3001';
let   API_KEY = process.argv[3] || '';

// ─── colours ────────────────────────────────────────────────────────────────
const C = {
  reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m',
  yellow:'\x1b[33m', cyan:'\x1b[36m', bold:'\x1b[1m', dim:'\x1b[2m',
};

// ─── stats ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;

function log(ok, name, detail='') {
  if (ok === true)  { passed++; console.log(`  ${C.green}✓${C.reset} ${name}${detail ? C.dim+' — '+detail+C.reset : ''}`); }
  else if (ok === 'warn') { warned++; console.log(`  ${C.yellow}⚠${C.reset} ${name}${detail ? C.dim+' — '+detail+C.reset : ''}`); }
  else               { failed++; console.log(`  ${C.red}✗${C.reset} ${name}${detail ? C.dim+' — '+detail+C.reset : ''}`); }
}

function section(name) {
  console.log(`\n${C.bold}${C.cyan}▶ ${name}${C.reset}`);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function request(method, path, body, extraHeaders={}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        ...extraHeaders,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      rejectUnauthorized: false,
    };

    const req = lib.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.status || res.statusCode, body: json, raw, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const GET    = (p, h)    => request('GET',    p, null, h);
const POST   = (p, b, h) => request('POST',   p, b,    h);
const DELETE = (p, h)    => request('DELETE', p, null, h);

// ─── timeout helper ──────────────────────────────────────────────────────────
function withTimeout(promise, ms, name) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms)),
  ]).catch(e => ({ __timeout: true, error: e.message }));
}

// ─── test helpers ────────────────────────────────────────────────────────────
function expect(name, condition, detail='') {
  log(condition, name, detail);
}

function expectStatus(name, res, expected) {
  log(res.status === expected, name, `got ${res.status}, expected ${expected}`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
let createdOfferId = null;
let createdWebhookId = null;

async function run() {
  console.log(`\n${C.bold}BOLT12 Server — Test Suite${C.reset}`);
  console.log(`${C.dim}Target: ${BASE}${C.reset}`);
  console.log(`${C.dim}API Key: ${API_KEY ? API_KEY.slice(0,8)+'…' : '(none — some tests may fail)'}${C.reset}`);

  // ── 1. PUBLIC endpoints (no auth) ──────────────────────────────────────────
  section('Health & Public');

  let res = await withTimeout(GET('/health'), 10000, 'GET /health');
  if (res.__timeout) { log('warn', 'GET /health', res.error); }
  else {
    expectStatus('GET /health returns 200', res, 200);
    expect('health.lnd present', res.body && 'lnd' in res.body, JSON.stringify(res.body?.lnd));
    expect('health.lndk present', res.body && 'lndk' in res.body, JSON.stringify(res.body?.lndk));
  }

  res = await withTimeout(GET('/api/v1/config'), 5000, 'GET /api/v1/config');
  if (res.__timeout) { log(false, 'GET /api/v1/config', res.error); }
  else {
    // /config returns 403 if called from external IP (only serves LAN)
    if (res.status === 200) {
      log(true, 'GET /api/v1/config (local) → 200');
      if (res.body?.apiKey && !API_KEY) {
        // Auto-capture key so the remaining authed tests can run
        API_KEY = res.body.apiKey;
        console.log(`  ${C.yellow}→ API key captured automatically${C.reset}`);
      }
    } else if (res.status === 403) {
      log('warn', 'GET /api/v1/config → 403 (external IP, expected on remote node)');
    } else {
      log(false, 'GET /api/v1/config', `got ${res.status}`);
    }
  }

  // ── 2. Auth ────────────────────────────────────────────────────────────────
  section('Authentication');

  res = await withTimeout(GET('/api/v1/offers', { 'x-api-key': 'invalid-key-xxx' }), 5000);
  if (!res.__timeout) expectStatus('Wrong API key → 401', res, 401);

  res = await withTimeout(GET('/api/v1/offers', { 'x-api-key': '' }), 5000);
  if (!res.__timeout) expectStatus('No API key → 401', res, 401);

  // ── 3. Offers ──────────────────────────────────────────────────────────────
  section('Offers CRUD');

  // List
  res = await withTimeout(GET('/api/v1/offers'), 5000);
  if (res.__timeout) { log(false, 'GET /api/v1/offers', res.error); }
  else {
    expectStatus('GET /api/v1/offers → 200', res, 200);
    expect('response.success = true', res.body?.success === true);
    expect('response.data is array', Array.isArray(res.body?.data));
  }

  // Create
  res = await withTimeout(POST('/api/v1/offers', { amount: 21000, description: 'Test Suite Offer' }), 30000);
  if (res.__timeout) { log('warn', 'POST /api/v1/offers timed out (LNDK may not be running)', res.error); }
  else if (res.status === 200 || res.status === 201) {
    log(true, 'POST /api/v1/offers → creates offer');
    expect('response.data.offer starts with lno', res.body?.data?.offer?.startsWith('lno'), res.body?.data?.offer?.slice(0,12)+'…');
    expect('response.data.id present', !!res.body?.data?.id);
    createdOfferId = res.body?.data?.id;
  } else {
    log('warn', `POST /api/v1/offers → ${res.status} (LNDK may not be reachable)`, res.body?.error || res.body?.message);
  }

  // Public endpoint (no auth)
  if (createdOfferId) {
    res = await withTimeout(GET(`/api/v1/public/offers/${createdOfferId}`, { 'x-api-key': '' }), 5000);
    if (!res.__timeout) {
      expectStatus('GET /api/v1/public/offers/:id (no auth) → 200', res, 200);
      expect('public offer has offer string', !!res.body?.data?.offer);
    }

    // Pay page redirect
    res = await withTimeout(GET(`/pay/${createdOfferId}`, { 'x-api-key': '' }), 5000);
    if (!res.__timeout) {
      expect('GET /pay/:id redirects or serves page', res.status < 400, `got ${res.status}`);
    }

    // Delete
    res = await withTimeout(DELETE(`/api/v1/offers/${createdOfferId}`), 5000);
    if (!res.__timeout) {
      expectStatus('DELETE /api/v1/offers/:id → 200', res, 200);
      expect('delete success=true', res.body?.success === true);
    }
  }

  // 404 for unknown offer
  res = await withTimeout(GET('/api/v1/public/offers/unknown-id-99999', { 'x-api-key': '' }), 5000);
  if (!res.__timeout) expectStatus('GET /api/v1/public/offers/unknown → 404', res, 404);

  // ── 4. Balance ─────────────────────────────────────────────────────────────
  section('Balance');

  res = await withTimeout(GET('/api/v1/balance'), 8000);
  if (res.__timeout) { log('warn', 'GET /api/v1/balance timed out'); }
  else if (res.status === 200) {
    log(true, 'GET /api/v1/balance → 200');
    expect('data.lightning.local is number', typeof res.body?.data?.lightning?.local === 'number', String(res.body?.data?.lightning?.local));
    expect('data.onchain.confirmed is number', typeof res.body?.data?.onchain?.confirmed === 'number');
    expect('data.channels.active is number', typeof res.body?.data?.channels?.active === 'number');
  } else {
    log('warn', `GET /api/v1/balance → ${res.status}`, res.body?.message);
  }

  // ── 5. Payments history ────────────────────────────────────────────────────
  section('Payments History');

  res = await withTimeout(GET('/api/v1/payments'), 8000);
  if (res.__timeout) { log('warn', 'GET /api/v1/payments timed out'); }
  else {
    expectStatus('GET /api/v1/payments → 200', res, 200);
    expect('response.data is array', Array.isArray(res.body?.data));
    if (Array.isArray(res.body?.data) && res.body.data.length > 0) {
      const p = res.body.data[0];
      expect('payment has type field', p.type === 'sent' || p.type === 'received', p.type);
      expect('payment has amount_sat', typeof p.amount_sat === 'number');
    }
  }

  // CSV export
  res = await withTimeout(GET('/api/v1/payments/export'), 8000);
  if (res.__timeout) { log('warn', 'GET /api/v1/payments/export timed out'); }
  else {
    expectStatus('GET /api/v1/payments/export → 200', res, 200);
    expect('Content-Type is text/csv', (res.headers['content-type']||'').includes('csv'), res.headers['content-type']);
    expect('CSV has header row', res.raw.includes('"type"') && res.raw.includes('"amount_sats"'), res.raw.slice(0,60));
  }

  // ── 6. Stats ───────────────────────────────────────────────────────────────
  section('Stats');

  res = await withTimeout(GET('/api/v1/stats'), 8000);
  if (res.__timeout) { log('warn', 'GET /api/v1/stats timed out'); }
  else {
    expectStatus('GET /api/v1/stats → 200', res, 200);
    expect('data.days is array', Array.isArray(res.body?.data?.days));
    expect('data.days has 14 entries', res.body?.data?.days?.length === 14, `got ${res.body?.data?.days?.length}`);
    expect('data.totals present', typeof res.body?.data?.totals === 'object');
  }

  // ── 7. Decode ──────────────────────────────────────────────────────────────
  section('Decode');

  // invalid format → should return error
  res = await withTimeout(POST('/api/v1/decode', { invoice: 'notaninvoice' }), 10000);
  if (!res.__timeout) {
    expect('POST /api/v1/decode with invalid invoice → non-200 or error', !res.body?.success || res.status !== 200, `status=${res.status}`);
  }

  // valid format but probably no live LNDK
  res = await withTimeout(POST('/api/v1/decode', { invoice: '' }), 5000);
  if (!res.__timeout) {
    expectStatus('POST /api/v1/decode with empty invoice → 400', res, 400);
  }

  // ── 8. Pay ─────────────────────────────────────────────────────────────────
  section('Pay');

  // Missing offer field
  res = await withTimeout(POST('/api/v1/pay', {}), 5000);
  if (!res.__timeout) expectStatus('POST /api/v1/pay with no offer → 400', res, 400);

  // Invalid offer prefix
  res = await withTimeout(POST('/api/v1/pay', { offer: 'invalid_offer_string' }), 5000);
  if (!res.__timeout) {
    expect('POST /api/v1/pay with invalid offer → 400 or error', res.status === 400 || !res.body?.success);
  }

  // ── 8.5 GetInvoice / PayInvoice (BOLT12) ──────────────────────────────────
  section('GetInvoice & PayInvoice (BOLT12)');

  // GetInvoice — missing body → 400
  res = await withTimeout(POST('/api/v1/offers/invoice', {}), 5000);
  if (!res.__timeout) expectStatus('POST /api/v1/offers/invoice with no offer → 400', res, 400);

  // GetInvoice — invalid offer string → 400
  res = await withTimeout(POST('/api/v1/offers/invoice', { offer: 'notanoffer' }), 5000);
  if (!res.__timeout) {
    expect('POST /api/v1/offers/invoice with invalid offer → 400 or error', res.status === 400 || !res.body?.success);
  }

  // PayInvoice — missing body → 400
  res = await withTimeout(POST('/api/v1/pay/invoice', {}), 5000);
  if (!res.__timeout) expectStatus('POST /api/v1/pay/invoice with no invoice → 400', res, 400);

  // PayInvoice — not starting with lni1 → 400
  res = await withTimeout(POST('/api/v1/pay/invoice', { invoice: 'lno1thisisanoffer' }), 5000);
  if (!res.__timeout) {
    expect('POST /api/v1/pay/invoice with lno1 invoice → 400', res.status === 400, `got ${res.status}`);
  }

  // ── 9. Invoices (BOLT11) ───────────────────────────────────────────────────
  section('Invoices BOLT11');

  res = await withTimeout(POST('/api/v1/invoices', {}), 5000);
  if (!res.__timeout) expectStatus('POST /api/v1/invoices with no data → 400', res, 400);

  res = await withTimeout(POST('/api/v1/invoices', { amount: 1000, description: 'Test invoice' }), 10000);
  if (res.__timeout) { log('warn', 'POST /api/v1/invoices timed out (LND may not be reachable)'); }
  else if (res.status === 200 || res.status === 201) {
    log(true, 'POST /api/v1/invoices → 200');
    expect('response has payment_request', !!res.body?.data?.payment_request, res.body?.data?.payment_request?.slice(0,12)+'…');
  } else {
    log('warn', `POST /api/v1/invoices → ${res.status}`, res.body?.message || res.body?.error);
  }

  // ── 10. Webhooks ───────────────────────────────────────────────────────────
  section('Webhooks');

  res = await withTimeout(GET('/api/v1/webhooks'), 5000);
  if (!res.__timeout) {
    expectStatus('GET /api/v1/webhooks → 200', res, 200);
    expect('data is array', Array.isArray(res.body?.data));
  }

  res = await withTimeout(POST('/api/v1/webhooks', {}), 5000);
  if (!res.__timeout) expectStatus('POST /api/v1/webhooks with no URL → 400', res, 400);

  res = await withTimeout(POST('/api/v1/webhooks', { url: 'https://example.com/hook', event: '*' }), 5000);
  if (!res.__timeout && res.status === 200) {
    log(true, 'POST /api/v1/webhooks → 200');
    createdWebhookId = res.body?.data?.id;

    if (createdWebhookId) {
      const delRes = await withTimeout(DELETE(`/api/v1/webhooks/${createdWebhookId}`), 5000);
      if (!delRes.__timeout) expectStatus('DELETE /api/v1/webhooks/:id → 200', delRes, 200);
    }
  } else if (!res.__timeout) {
    log('warn', `POST /api/v1/webhooks → ${res.status}`, res.body?.message);
  }

  // ── 11. Access logs ────────────────────────────────────────────────────────
  section('Access Logs');

  res = await withTimeout(GET('/api/v1/logs'), 5000);
  if (!res.__timeout) {
    expectStatus('GET /api/v1/logs → 200', res, 200);
    expect('data is array', Array.isArray(res.body?.data));
    if (Array.isArray(res.body?.data) && res.body.data.length > 0) {
      const l = res.body.data[0];
      expect('log has method', typeof l.method === 'string');
      expect('log has path', typeof l.path === 'string');
      expect('log has ts', typeof l.ts === 'string');
    }
  }

  // ── 12. Templates ──────────────────────────────────────────────────────────
  section('Templates');

  res = await withTimeout(GET('/api/v1/templates'), 5000);
  if (!res.__timeout) {
    expectStatus('GET /api/v1/templates → 200', res, 200);
    expect('data is array', Array.isArray(res.body?.data));
  }

  res = await withTimeout(POST('/api/v1/templates', {}), 5000);
  if (!res.__timeout) expectStatus('POST /api/v1/templates with no name → 400', res, 400);

  let tplId = null;
  res = await withTimeout(POST('/api/v1/templates', { name: 'Test Template', amount: 5000, description: 'Test desc' }), 5000);
  if (!res.__timeout && res.status === 200) {
    log(true, 'POST /api/v1/templates → 200');
    tplId = res.body?.data?.id;
    if (tplId) {
      const delRes = await withTimeout(DELETE(`/api/v1/templates/${tplId}`), 5000);
      if (!delRes.__timeout) expectStatus('DELETE /api/v1/templates/:id → 200', delRes, 200);
    }
  } else if (!res.__timeout) {
    log('warn', `POST /api/v1/templates → ${res.status}`, res.body?.message);
  }

  // ── 13. Static pages ───────────────────────────────────────────────────────
  section('Static Pages');

  res = await withTimeout(GET('/dashboard.html', { 'x-api-key': '' }), 5000);
  if (!res.__timeout) {
    expect('GET /dashboard.html serves dashboard', res.status === 200, `got ${res.status}`);
    expect('dashboard has DOCTYPE', res.raw.includes('<!DOCTYPE html'), res.raw.slice(0,40));
  }

  res = await withTimeout(GET('/pay.html', { 'x-api-key': '' }), 5000);
  if (!res.__timeout) {
    expect('GET /pay.html serves public page', res.status === 200, `got ${res.status}`);
    expect('pay.html has DOCTYPE', res.raw.includes('<!DOCTYPE html'));
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed + warned;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${C.bold}Results: ${C.green}${passed} passed${C.reset} · ${C.yellow}${warned} warned${C.reset} · ${C.red}${failed} failed${C.reset} / ${total} tests`);

  if (warned > 0) {
    console.log(`\n${C.yellow}Warnings${C.reset} usually mean LNDK or LND is not reachable from this host.`);
    console.log(`Run this test from within the Umbrel node or with a valid API key for full coverage.`);
  }

  if (failed > 0) {
    console.log(`\n${C.red}${failed} test(s) failed.${C.reset} Check the server is running at ${BASE} and the API key is correct.`);
    process.exit(1);
  } else {
    console.log(`\n${C.green}All critical tests passed!${C.reset}`);
  }
}

run().catch(e => {
  console.error(`\n${C.red}Fatal error:${C.reset}`, e.message);
  process.exit(1);
});

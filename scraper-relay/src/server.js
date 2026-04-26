'use strict';

const express = require('express');
const morgan = require('morgan');
const { scrapeFlexMls } = require('./scrapers/flexmls');

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_TOKEN =
  process.env.RELAY_AUTH_TOKEN ||
  'dak_live_KLZAZ9DV9ACsM7-FtN6rc6LGfjgyK32qtGOvQ7gxxR8';

const SBR_WS_ENDPOINT =
  process.env.SBR_WS_ENDPOINT ||
  'wss://brd-customer-hl_ebc27cb0-zone-crexi:m6yo5yksj0py@brd.superproxy.io:9222';

app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// --- Auth middleware ---------------------------------------------------------
function requireBearer(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

// --- Public routes -----------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'ayre-scraper-relay',
    version: '1.0.0',
    endpoints: ['/health', '/whoami', 'POST /scrape/flexmls'],
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    uptime_s: Math.round(process.uptime()),
    sbr_configured: Boolean(SBR_WS_ENDPOINT),
    timestamp: new Date().toISOString(),
  });
});

// Returns the outbound public IP of this Railway service so it can be
// whitelisted in Bright Data. Useful for ops; not authenticated.
app.get('/whoami', async (_req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const data = await r.json();
    res.json({ ok: true, outbound_ip: data.ip });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message) });
  }
});

// --- Authenticated routes ----------------------------------------------------
app.post('/scrape/flexmls', requireBearer, async (req, res) => {
  const { url, timeout_ms } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res
      .status(400)
      .json({ ok: false, error: 'missing or invalid "url" in body' });
  }
  try {
    const started = Date.now();
    const data = await scrapeFlexMls({
      url,
      sbrWsEndpoint: SBR_WS_ENDPOINT,
      timeoutMs: Number(timeout_ms) > 0 ? Number(timeout_ms) : 90_000,
    });
    return res.json({
      ok: true,
      duration_ms: Date.now() - started,
      data,
    });
  } catch (err) {
    console.error('[scrape/flexmls] error:', err);
    return res.status(502).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
});

// --- Error handler -----------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`[ayre-scraper-relay] listening on :${PORT}`);
});

'use strict';

const express = require('express');
const morgan = require('morgan');
const https = require('https');
const { scrapeFlexMls } = require('./scrapers/flexmls');
const { scrapeCrexi } = require('./scrapers/crexi');

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_TOKEN =
  process.env.RELAY_AUTH_TOKEN ||
  'dak_live_KLZAZ9DV9ACsM7-FtN6rc6LGfjgyK32qtGOvQ7gxxR8';

const SBR_WS_ENDPOINT =
  process.env.SBR_WS_ENDPOINT ||
  'wss://brd-customer-hl_ebc27cb0-zone-crexi:m6yo5yksj0py@brd.superproxy.io:9222';

// Bright Data Web Unlocker API credentials (for /scrape/url)
const BD_API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const BD_API_URL = process.env.BRIGHTDATA_API_URL || 'https://api.brightdata.com/request';
const BD_ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';

app.use(express.json({ limit: '2mb' }));
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
    version: '1.2.1',
    endpoints: [
      '/health',
      '/whoami',
      '/diag/sbr',
      'POST /scrape/flexmls',
      'POST /scrape/url',
      'POST /scrape/crexi',
    ],
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    uptime_s: Math.round(process.uptime()),
    sbr_configured: Boolean(SBR_WS_ENDPOINT),
    bd_api_configured: Boolean(BD_API_KEY),
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

// Diagnostic: test raw HTTPS/WebSocket connectivity to Bright Data SBR.
app.get('/diag/sbr', async (_req, res) => {
  const wsUrl = SBR_WS_ENDPOINT;
  const match = wsUrl.match(/^wss?:\/\/([^@]+)@([^:/]+):?(\d+)?/);
  if (!match) {
    return res.status(500).json({ ok: false, error: 'Cannot parse SBR_WS_ENDPOINT' });
  }
  const auth = match[1];
  const hostname = match[2];
  const port = parseInt(match[3] || '9222', 10);

  const result = await new Promise((resolve) => {
    const options = {
      hostname,
      port,
      path: '/',
      method: 'GET',
      auth,
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': Buffer.from('diag-test-key-00').toString('base64'),
        'Sec-WebSocket-Version': '13',
        'Host': `${hostname}:${port}`,
      },
      rejectUnauthorized: false,
    };
    const req = https.request(options, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => resolve({ statusCode: r.statusCode, body: body.trim(), headers: r.headers }));
    });
    req.on('error', (e) => resolve({ statusCode: null, body: null, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ statusCode: null, body: null, error: 'timeout' }); });
    req.end();
  });

  const connected = result.statusCode === 101;
  res.json({
    ok: connected,
    sbr_status_code: result.statusCode,
    sbr_response: result.body,
    error: result.error || null,
    interpretation: connected
      ? 'WebSocket upgrade accepted — IP is whitelisted ✓'
      : result.body && result.body.includes('ip_forbidden')
        ? 'IP is NOT whitelisted in Bright Data (ip_forbidden)'
        : `Unexpected response: ${result.statusCode} ${result.body}`,
  });
});

// --- Authenticated routes ----------------------------------------------------

// POST /scrape/flexmls — Scrape a FlexMLS listing via SBR (Playwright CDP)
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

// POST /scrape/url — Generic URL fetch via Bright Data Web Unlocker API
//
// Accepts: { url: string, timeout_ms?: number }
// Returns: { ok: true, html: string, status: number, duration_ms: number }
//
// This endpoint uses Bright Data's Web Unlocker API (HTTP-based, no browser)
// to fetch any URL with anti-bot bypass. It's faster and cheaper than SBR.
// Falls back to SBR (real headless Chrome) if Web Unlocker fails or returns
// a page with insufficient content.
app.post('/scrape/url', requireBearer, async (req, res) => {
  const { url, timeout_ms } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res
      .status(400)
      .json({ ok: false, error: 'missing or invalid "url" in body' });
  }

  const timeout = Number(timeout_ms) > 0 ? Number(timeout_ms) : 90000;
  const started = Date.now();

  // Strategy 1: Try Bright Data Web Unlocker API (fast, cheap)
  if (BD_API_KEY) {
    try {
      console.log(`[scrape/url] Trying Web Unlocker for: ${url}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const bdResp = await fetch(BD_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BD_API_KEY}`,
        },
        body: JSON.stringify({
          zone: BD_ZONE,
          url,
          format: 'raw',
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const html = await bdResp.text();

      if (bdResp.status === 200 && html.length > 500) {
        console.log(`[scrape/url] Web Unlocker success: ${url} (${html.length} bytes, ${Date.now() - started}ms)`);
        return res.json({
          ok: true,
          html,
          status: 200,
          method: 'web_unlocker',
          duration_ms: Date.now() - started,
        });
      }

      console.warn(`[scrape/url] Web Unlocker returned ${bdResp.status} (${html.length} bytes) for ${url}`);
    } catch (err) {
      console.warn(`[scrape/url] Web Unlocker failed for ${url}: ${err.message}`);
    }
  } else {
    console.log('[scrape/url] No BRIGHTDATA_API_KEY configured, skipping Web Unlocker');
  }

  // Strategy 2: Fall back to SBR (real headless Chrome via Playwright CDP)
  if (SBR_WS_ENDPOINT) {
    try {
      console.log(`[scrape/url] Falling back to SBR for: ${url}`);
      const html = await fetchViaSBR(url, timeout);

      if (html && html.length > 500) {
        console.log(`[scrape/url] SBR success: ${url} (${html.length} bytes, ${Date.now() - started}ms)`);
        return res.json({
          ok: true,
          html,
          status: 200,
          method: 'sbr',
          duration_ms: Date.now() - started,
        });
      }

      console.warn(`[scrape/url] SBR returned insufficient content for ${url} (${html ? html.length : 0} bytes)`);
    } catch (err) {
      console.error(`[scrape/url] SBR failed for ${url}: ${err.message}`);
    }
  }

  // Both strategies failed
  return res.status(502).json({
    ok: false,
    error: 'Both Web Unlocker and SBR failed to fetch the URL',
    html: '',
    status: 0,
    duration_ms: Date.now() - started,
  });
});

/**
 * Fetch a URL using Bright Data Scraping Browser (SBR) via Playwright CDP.
 * Returns the full page HTML after rendering JavaScript.
 */
async function fetchViaSBR(url, timeoutMs) {
  const pw = require('playwright-core');
  let browser = null;

  try {
    browser = await pw.chromium.connectOverCDP(SBR_WS_ENDPOINT, {
      timeout: 30000,
    });

    const page = await browser.newPage();
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs - 10000,
      });

      // Wait for JS rendering
      await page.waitForTimeout(5000);

      const html = await page.content();
      return html;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// POST /scrape/crexi — Log into Crexi via SBR and extract seller listing metrics.
//
// Body: { email, password, timeout_ms? }
// Response: { ok: true, listings: [{ listingId, title, address, views, inquiries, saves, listingUrl }] }
//
// Uses the BRIGHTDATA_SBR_WS_ENDPOINT env var if set, otherwise falls back to
// the default SBR_WS_ENDPOINT (crexi zone). The crexi zone is already whitelisted
// for Railway's static IP (162.220.234.15).
app.post('/scrape/crexi', requireBearer, async (req, res) => {
  const { email, password, timeout_ms } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing or invalid "email" in body' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing or invalid "password" in body' });
  }

  // Allow a dedicated SBR endpoint for Crexi (in case the zone differs)
  const sbrEndpoint =
    process.env.BRIGHTDATA_SBR_WS_ENDPOINT ||
    process.env.SBR_WS_ENDPOINT ||
    'wss://brd-customer-hl_ebc27cb0-zone-crexi:m6yo5yksj0py@brd.superproxy.io:9222';

  const timeoutMs = Number(timeout_ms) > 0 ? Number(timeout_ms) : 120_000;
  const started = Date.now();

  try {
    console.log(`[scrape/crexi] Starting scrape for ${email}`);
    const listings = await scrapeCrexi({
      email,
      password,
      sbrWsEndpoint: sbrEndpoint,
      timeoutMs,
    });

    // If the scraper returned a debug object instead of an array, surface it
    if (listings && listings.__debug) {
      console.warn('[scrape/crexi] No listings found — returning debug snapshot');
      return res.status(200).json({
        ok: false,
        error: 'No listings found — page structure may have changed',
        debug: listings,
        duration_ms: Date.now() - started,
      });
    }

    console.log(`[scrape/crexi] Found ${listings.length} listing(s) in ${Date.now() - started}ms`);
    return res.json({
      ok: true,
      count: listings.length,
      listings,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[scrape/crexi] error:', err);
    return res.status(502).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
      duration_ms: Date.now() - started,
    });
  }
});

// --- Error handler -----------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`[ayre-scraper-relay] v1.2.1 listening on :${PORT}`);
  console.log(`[ayre-scraper-relay] Web Unlocker: ${BD_API_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`[ayre-scraper-relay] SBR: ${SBR_WS_ENDPOINT ? 'configured' : 'NOT configured'}`);
});

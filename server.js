'use strict';

const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Configuration ────────────────────────────────────────────────────────────
const RELAY_BEARER_TOKEN = process.env.RELAY_BEARER_TOKEN || 'dak_live_KLZAZ9DV9ACsM7-FtN6rc6LGfjgyK32qtGOvQ7gxxR8';
const UPSTREAM_BASE_URL  = process.env.UPSTREAM_BASE_URL  || 'https://dashboard.andrewyaggie.com';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireBearerAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || token !== RELAY_BEARER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid Bearer token required.' });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ayre-mls-relay',
    timestamp: new Date().toISOString(),
    upstream: UPSTREAM_BASE_URL
  });
});

// ── MLS proxy route ───────────────────────────────────────────────────────────
app.all('/api/mls/*', requireBearerAuth, async (req, res) => {
  // Build upstream URL: strip /api/mls prefix and reattach under upstream base
  const upstreamPath = req.originalUrl; // e.g. /api/mls/listings?...
  const upstreamUrl  = `${UPSTREAM_BASE_URL}${upstreamPath}`;

  // Build headers that mimic a real browser to bypass Cloudflare bot detection
  const forwardHeaders = {
    'Accept':                    'application/json, text/plain, */*',
    'Accept-Language':           'en-US,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Cache-Control':             'no-cache',
    'Pragma':                    'no-cache',
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Sec-Ch-Ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile':          '?0',
    'Sec-Ch-Ua-Platform':        '"Windows"',
    'Sec-Fetch-Dest':            'empty',
    'Sec-Fetch-Mode':            'cors',
    'Sec-Fetch-Site':            'same-origin',
    'Referer':                   `${UPSTREAM_BASE_URL}/`,
    'Origin':                    UPSTREAM_BASE_URL,
    'Connection':                'keep-alive',
  };

  // Forward Content-Type for POST/PUT/PATCH
  if (req.headers['content-type']) {
    forwardHeaders['Content-Type'] = req.headers['content-type'];
  }

  // Forward any cookies passed by the caller
  if (req.headers['cookie']) {
    forwardHeaders['Cookie'] = req.headers['cookie'];
  }

  // Build fetch options
  const fetchOptions = {
    method:  req.method,
    headers: forwardHeaders,
    redirect: 'follow',
  };

  // Attach body for non-GET/HEAD requests
  if (!['GET', 'HEAD'].includes(req.method.toUpperCase()) && req.body) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (bodyStr && bodyStr !== '{}') {
      fetchOptions.body = bodyStr;
    }
  }

  try {
    console.log(`[RELAY] ${req.method} ${upstreamUrl}`);
    const upstreamRes = await fetch(upstreamUrl, fetchOptions);

    // Mirror status code
    res.status(upstreamRes.status);

    // Mirror safe response headers
    const PASSTHROUGH_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'x-request-id'];
    for (const header of PASSTHROUGH_HEADERS) {
      const val = upstreamRes.headers.get(header);
      if (val) res.setHeader(header, val);
    }

    // Stream body back
    const buffer = await upstreamRes.buffer();
    res.send(buffer);

  } catch (err) {
    console.error('[RELAY ERROR]', err.message);
    res.status(502).json({
      error: 'Bad Gateway',
      message: 'Upstream request failed.',
      detail: err.message
    });
  }
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[ayre-mls-relay] Listening on port ${PORT}`);
  console.log(`[ayre-mls-relay] Upstream: ${UPSTREAM_BASE_URL}`);
});

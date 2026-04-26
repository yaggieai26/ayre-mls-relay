'use strict';

const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Configuration ────────────────────────────────────────────────────────────
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://dashboard.andrewyaggie.com';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
// No relay-level auth — all requests are passed straight through to the upstream.
// The upstream dashboard is responsible for validating the Authorization header.
app.all('/api/mls/*', async (req, res) => {
  const upstreamUrl = `${UPSTREAM_BASE_URL}${req.originalUrl}`;

  // Build headers that mimic a real browser to bypass Cloudflare bot detection
  const forwardHeaders = {
    'Accept':           'application/json, text/plain, */*',
    'Accept-Language':  'en-US,en;q=0.9',
    'Accept-Encoding':  'gzip, deflate, br',
    'Cache-Control':    'no-cache',
    'Pragma':           'no-cache',
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Sec-Ch-Ua':        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest':   'empty',
    'Sec-Fetch-Mode':   'cors',
    'Sec-Fetch-Site':   'same-origin',
    'Referer':          `${UPSTREAM_BASE_URL}/`,
    'Origin':           UPSTREAM_BASE_URL,
    'Connection':       'keep-alive',
  };

  // Pass through Authorization header unchanged
  if (req.headers['authorization']) {
    forwardHeaders['Authorization'] = req.headers['authorization'];
  }

  // Pass through Content-Type for POST/PUT/PATCH
  if (req.headers['content-type']) {
    forwardHeaders['Content-Type'] = req.headers['content-type'];
  }

  // Pass through cookies if present
  if (req.headers['cookie']) {
    forwardHeaders['Cookie'] = req.headers['cookie'];
  }

  const fetchOptions = {
    method:   req.method,
    headers:  forwardHeaders,
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

    res.status(upstreamRes.status);

    const PASSTHROUGH_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'x-request-id'];
    for (const header of PASSTHROUGH_HEADERS) {
      const val = upstreamRes.headers.get(header);
      if (val) res.setHeader(header, val);
    }

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

// ── Also proxy /api/trpc/* for tRPC endpoints ─────────────────────────────────
app.all('/api/trpc/*', async (req, res) => {
  const upstreamUrl = `${UPSTREAM_BASE_URL}${req.originalUrl}`;

  const forwardHeaders = {
    'Accept':           'application/json, text/plain, */*',
    'Accept-Language':  'en-US,en;q=0.9',
    'Accept-Encoding':  'gzip, deflate, br',
    'Cache-Control':    'no-cache',
    'Pragma':           'no-cache',
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Sec-Ch-Ua':        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest':   'empty',
    'Sec-Fetch-Mode':   'cors',
    'Sec-Fetch-Site':   'same-origin',
    'Referer':          `${UPSTREAM_BASE_URL}/`,
    'Origin':           UPSTREAM_BASE_URL,
    'Connection':       'keep-alive',
  };

  if (req.headers['authorization']) {
    forwardHeaders['Authorization'] = req.headers['authorization'];
  }
  if (req.headers['content-type']) {
    forwardHeaders['Content-Type'] = req.headers['content-type'];
  }
  if (req.headers['cookie']) {
    forwardHeaders['Cookie'] = req.headers['cookie'];
  }

  const fetchOptions = {
    method:   req.method,
    headers:  forwardHeaders,
    redirect: 'follow',
  };

  if (!['GET', 'HEAD'].includes(req.method.toUpperCase()) && req.body) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (bodyStr && bodyStr !== '{}') {
      fetchOptions.body = bodyStr;
    }
  }

  try {
    console.log(`[RELAY] ${req.method} ${upstreamUrl}`);
    const upstreamRes = await fetch(upstreamUrl, fetchOptions);

    res.status(upstreamRes.status);

    const PASSTHROUGH_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'x-request-id'];
    for (const header of PASSTHROUGH_HEADERS) {
      const val = upstreamRes.headers.get(header);
      if (val) res.setHeader(header, val);
    }

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
  console.log(`[ayre-mls-relay] No relay-level auth — all requests passed through`);
});

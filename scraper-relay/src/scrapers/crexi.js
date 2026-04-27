'use strict';

/**
 * Crexi API scraper (v1.3.0+).
 *
 * Strategy: Call the Crexi internal JSON API directly, routing the request
 * through Bright Data Web Unlocker to bypass Cloudflare's bot challenge.
 *
 * Endpoint:
 *   GET https://api.crexi.com/assets/sell-list?count=40&offset=0&sortDirection=Descending&sortOrder=NumberOfOffers
 *   Auth: Bearer <CREXI_AUTH_TOKEN>
 *   Response: { totalCount, data: [ { id, name, status, askingPrice, location, stats, searchScore, urlSlug, ... } ] }
 *
 * The Bearer token is stored in the Railway env var `CREXI_AUTH_TOKEN` or
 * passed in the request body as `crexi_token`.
 *
 * Bright Data Web Unlocker (zone `web_unlocker1`) is used because the Railway
 * outbound IP hits Cloudflare's "Just a moment..." interstitial on
 * api.crexi.com if queried directly. Web Unlocker handles the CF challenge.
 */

const BD_API_URL = process.env.BRIGHTDATA_API_URL || 'https://api.brightdata.com/request';
const BD_API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const BD_ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';

const CREXI_API_BASE = 'https://api.crexi.com';

/**
 * Fetch a Crexi API URL through Bright Data Web Unlocker.
 * Returns the parsed JSON response.
 */
async function fetchViaWebUnlocker(targetUrl, crexiToken, timeoutMs) {
  if (!BD_API_KEY) {
    throw new Error('BRIGHTDATA_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(BD_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BD_API_KEY}`,
      },
      body: JSON.stringify({
        zone: BD_ZONE,
        url: targetUrl,
        format: 'raw',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${crexiToken}`,
          accept: 'application/json, text/plain, */*',
          origin: 'https://www.crexi.com',
          referer: 'https://www.crexi.com/',
          'accept-language': 'en-US,en;q=0.9',
        },
      }),
      signal: controller.signal,
    });

    const bodyText = await resp.text();

    if (resp.status !== 200) {
      const brdErr =
        resp.headers.get('x-brd-err-msg') ||
        resp.headers.get('x-brd-err-code') ||
        '';
      throw new Error(
        `Web Unlocker HTTP ${resp.status}: ${brdErr || bodyText.slice(0, 300)}`,
      );
    }

    // Bright Data returns the target body as-is (format=raw).
    // Detect Cloudflare HTML interstitial (shouldn't happen via Web Unlocker
    // but worth catching explicitly).
    if (bodyText.startsWith('<') || bodyText.includes('Just a moment')) {
      throw new Error(
        `Crexi returned HTML challenge instead of JSON: ${bodyText.slice(0, 200)}`,
      );
    }

    try {
      return JSON.parse(bodyText);
    } catch (parseErr) {
      throw new Error(
        `Failed to parse Crexi response as JSON: ${parseErr.message}. Body preview: ${bodyText.slice(0, 200)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize a Crexi asset into a flat listing object matching the schema
 * requested by the relay consumer.
 */
function normalizeListing(asset) {
  const loc = asset.location || {};
  const stateCode = (loc.state && loc.state.code) || '';
  const addressParts = [
    loc.address,
    [loc.city, stateCode].filter(Boolean).join(', '),
    loc.zip,
  ].filter(Boolean);
  const address = addressParts.join(', ');

  const stats = asset.stats || {};
  const views = Number(stats.numberOfPageViews) || 0;
  const visitors = Number(stats.numberOfVisitors) || 0;
  const omOpens = Number(stats.numberOfOpenedOMs) || 0;
  const flyerOpens = Number(stats.numberOfOpenedFlyers) || 0;
  const offers = Number(stats.numberOfOffers) || 0;
  const followers = Number(stats.numberOfFollowers) || 0;
  const vaultUsers = Number(stats.numberOfVaultUsers) || 0;
  const caUsers = Number(stats.numberOfCAUsers) || 0;
  const impressions = Number(stats.numberOfImpressions) || 0;

  return {
    // Requested schema
    listingId: asset.id,
    title: asset.name || '',
    address,
    views,
    // Crexi's dashboard has an "Offers" column (not "Inquiries"); we map
    // offers -> inquiries as the closest analog.
    inquiries: offers,
    // Crexi's dashboard has an "OM/Flyer" column (downloads of marketing
    // docs); we map OM+Flyer opens -> saves.
    saves: omOpens + flyerOpens,

    // Rich supplementary fields
    status: asset.status || '',
    askingPrice: asset.askingPrice,
    searchScore: asset.searchScore,
    listingUrl: asset.urlSlug
      ? `https://www.crexi.com/properties/${asset.id}/${asset.urlSlug}`
      : null,
    activatedOn: asset.activatedOn,
    updatedOn: asset.updatedOn,
    location: {
      address: loc.address || '',
      city: loc.city || '',
      state: stateCode,
      zip: loc.zip || '',
      county: loc.county || '',
      latitude: loc.latitude,
      longitude: loc.longitude,
    },

    // Full stats object (every metric Crexi exposes)
    stats: {
      pageViews: views,
      visitors,
      impressions,
      omOpens,
      flyerOpens,
      omAndFlyerOpens: omOpens + flyerOpens,
      offers,
      followers,
      vaultUsers,
      caUsers,
    },
  };
}

/**
 * scrapeCrexi — fetches all of the broker's listings via the Crexi API.
 *
 * @param {object} opts
 * @param {string} opts.crexiToken  Bearer token for api.crexi.com
 * @param {number} [opts.timeoutMs]  Per-request timeout
 * @param {string} [opts.sortOrder]  'NumberOfOffers' (default) or other
 * @param {string} [opts.sortDirection]  'Descending' (default) or 'Ascending'
 * @param {number} [opts.count]  Page size, default 40 (Crexi max)
 * @returns {Promise<Array>}  Array of normalized listing objects
 */
async function scrapeCrexi(opts = {}) {
  const {
    crexiToken,
    timeoutMs = 60_000,
    sortOrder = 'NumberOfOffers',
    sortDirection = 'Descending',
    count = 40,
  } = opts;

  if (!crexiToken || typeof crexiToken !== 'string') {
    throw new Error('crexiToken is required (Bearer token for api.crexi.com)');
  }

  const started = Date.now();
  const url =
    `${CREXI_API_BASE}/assets/sell-list` +
    `?count=${encodeURIComponent(count)}` +
    `&offset=0` +
    `&sortDirection=${encodeURIComponent(sortDirection)}` +
    `&sortOrder=${encodeURIComponent(sortOrder)}`;

  console.log(`[scrape/crexi] GET ${url}`);
  const data = await fetchViaWebUnlocker(url, crexiToken, timeoutMs);
  console.log(
    `[scrape/crexi] Response: totalCount=${data.totalCount}, data.length=${
      Array.isArray(data.data) ? data.data.length : '(not array)'
    } in ${Date.now() - started}ms`,
  );

  if (!Array.isArray(data.data)) {
    throw new Error(
      `Unexpected response shape: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  return data.data.map(normalizeListing);
}

module.exports = { scrapeCrexi };

'use strict';

const { chromium } = require('playwright-core');

/**
 * Scrape a FlexMLS listing page via Bright Data Scraping Browser (SBR).
 *
 * Connects to SBR over CDP, navigates to the URL, waits for the listing
 * content to render, then extracts a normalized property record.
 *
 * @param {Object} opts
 * @param {string} opts.url            FlexMLS listing URL
 * @param {string} opts.sbrWsEndpoint  Bright Data SBR WebSocket URL
 * @param {number} [opts.timeoutMs]    Total navigation/extraction timeout
 * @returns {Promise<Object>}          Normalized property data
 */
async function scrapeFlexMls({ url, sbrWsEndpoint, timeoutMs = 90_000 }) {
  if (!sbrWsEndpoint) {
    throw new Error('SBR WebSocket endpoint is not configured');
  }

  const browser = await chromium.connectOverCDP(sbrWsEndpoint, {
    timeout: 60_000,
  });

  let context;
  let page;
  try {
    // SBR returns a default context on connect.
    context =
      browser.contexts()[0] ||
      (await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
      }));

    page = await context.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // FlexMLS listing pages render most content client-side; give it a beat.
    await page
      .waitForLoadState('networkidle', { timeout: 30_000 })
      .catch(() => {
        // Some listings have long-running trackers; networkidle isn't critical.
      });

    // Best-effort wait for a price node to appear.
    await page
      .waitForSelector(
        [
          '[data-testid*="price" i]',
          '[class*="price" i]',
          '[itemprop="price"]',
        ].join(','),
        { timeout: 15_000 }
      )
      .catch(() => null);

    const data = await page.evaluate(() => {
      // ---- helpers --------------------------------------------------------
      const text = (el) => (el && (el.innerText || el.textContent) || '').trim();
      const pickText = (selectors) => {
        for (const s of selectors) {
          const el = document.querySelector(s);
          const t = text(el);
          if (t) return t;
        }
        return null;
      };
      const cleanNum = (s) => {
        if (!s) return null;
        const m = String(s).replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/);
        return m ? Number(m[0]) : null;
      };

      // ---- structured data (preferred) ------------------------------------
      const ldJson = [];
      document
        .querySelectorAll('script[type="application/ld+json"]')
        .forEach((s) => {
          try {
            const parsed = JSON.parse(s.textContent || '{}');
            if (Array.isArray(parsed)) ldJson.push(...parsed);
            else ldJson.push(parsed);
          } catch (_) {
            /* ignore */
          }
        });
      const productLd =
        ldJson.find(
          (o) =>
            o &&
            (o['@type'] === 'Product' ||
              o['@type'] === 'SingleFamilyResidence' ||
              o['@type'] === 'Residence' ||
              o['@type'] === 'House')
        ) || null;

      // ---- meta tags ------------------------------------------------------
      const metaProp = (name) => {
        const el =
          document.querySelector(`meta[property="${name}"]`) ||
          document.querySelector(`meta[name="${name}"]`);
        return el ? el.getAttribute('content') : null;
      };

      // ---- core fields ----------------------------------------------------
      const title =
        pickText(['h1', '[data-testid="listing-title"]', '.listing-title']) ||
        metaProp('og:title') ||
        document.title ||
        null;

      const priceText = pickText([
        '[data-testid*="price" i]',
        '[class*="ListingPrice" i]',
        '[class*="listing-price" i]',
        '[class*="price" i]',
        '[itemprop="price"]',
      ]);
      const price =
        cleanNum(priceText) ||
        (productLd && productLd.offers && cleanNum(productLd.offers.price)) ||
        null;

      const address =
        pickText([
          '[data-testid*="address" i]',
          '[class*="address" i]',
          '[itemprop="streetAddress"]',
        ]) ||
        (productLd &&
          productLd.address &&
          [
            productLd.address.streetAddress,
            productLd.address.addressLocality,
            productLd.address.addressRegion,
            productLd.address.postalCode,
          ]
            .filter(Boolean)
            .join(', ')) ||
        null;

      const description =
        pickText([
          '[data-testid*="description" i]',
          '[class*="description" i]',
          '[class*="remarks" i]',
          '[itemprop="description"]',
        ]) ||
        metaProp('og:description') ||
        metaProp('description') ||
        null;

      // ---- spec block (beds / baths / sqft / lot / year) ------------------
      const specs = {};
      const bodyText = document.body ? document.body.innerText : '';
      const grab = (re) => {
        const m = bodyText.match(re);
        return m ? m[1] : null;
      };
      specs.beds = cleanNum(grab(/(\d+(?:\.\d+)?)\s*(?:bd|bed|beds|bedrooms?)/i));
      specs.baths = cleanNum(
        grab(/(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms?)/i)
      );
      specs.sqft = cleanNum(
        grab(/([\d,]+)\s*(?:sq\s?ft|square\s?feet|sqft)/i)
      );
      specs.lot_sqft = cleanNum(
        grab(/lot[^0-9]{0,15}([\d,]+)\s*sq\s?ft/i)
      );
      specs.lot_acres = cleanNum(grab(/([\d.]+)\s*acres?/i));
      specs.year_built = cleanNum(grab(/year\s*built[^0-9]{0,5}(\d{4})/i));

      // ---- photos ---------------------------------------------------------
      const photoSet = new Set();
      document.querySelectorAll('img').forEach((img) => {
        const src =
          img.getAttribute('src') ||
          img.getAttribute('data-src') ||
          img.getAttribute('data-lazy') ||
          '';
        if (
          src &&
          /^https?:\/\//.test(src) &&
          !/sprite|icon|logo|placeholder/i.test(src) &&
          (img.naturalWidth >= 400 ||
            img.width >= 400 ||
            /listing|photo|media|cdn/i.test(src))
        ) {
          photoSet.add(src);
        }
      });
      // og:image as a fallback
      const ogImg = metaProp('og:image');
      if (ogImg) photoSet.add(ogImg);
      const photos = Array.from(photoSet).slice(0, 60);

      // ---- MLS ID ---------------------------------------------------------
      const mlsId =
        grab(/MLS\s*#?\s*[:\-]?\s*([A-Z0-9\-]{4,})/i) ||
        (productLd && productLd.sku) ||
        null;

      return {
        url: location.href,
        title,
        price,
        price_text: priceText,
        address,
        description,
        mls_id: mlsId,
        specs,
        photos,
        og_image: ogImg,
        ld_json: productLd,
      };
    });

    return data;
  } finally {
    try {
      if (page) await page.close();
    } catch (_) {}
    try {
      await browser.close();
    } catch (_) {}
  }
}

module.exports = { scrapeFlexMls };

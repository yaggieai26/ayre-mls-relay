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

      /**
       * grabSpec: find the FIRST match of a regex in bodyText, return capture group 1.
       * Validates the result is within [min, max] to reject false positives.
       */
      const grabSpec = (re, min, max) => {
        const m = bodyText.match(re);
        if (!m) return null;
        const n = cleanNum(m[1]);
        if (n === null) return null;
        if (min !== undefined && n < min) return null;
        if (max !== undefined && n > max) return null;
        return n;
      };

      // Beds: require the number to be a standalone integer (word boundary on
      // both sides) and cap at 20 to avoid zip codes / sqft bleeding in.
      // Pattern: "<number> bed(s)/bedroom(s)" OR "Bedrooms <number>"
      specs.beds =
        grabSpec(/\b([1-9]\d?)\s*(?:bd|bed|beds|bedrooms?)\b/i, 1, 20) ||
        grabSpec(/\bbedrooms?\s*[:\-]?\s*([1-9]\d?)\b/i, 1, 20) ||
        null;

      // Baths: same approach, cap at 20.
      specs.baths =
        grabSpec(/\b(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms?)\b/i, 0.5, 20) ||
        grabSpec(/\bbaths?\s*(?:total\s*)?[:\-]?\s*(\d+(?:\.\d+)?)\b/i, 0.5, 20) ||
        null;

      // Sqft: FlexMLS always shows total sqft in the listing header summary bar
      // as "X,XXX SF" (e.g. "2 beds  2 baths  1,408 SF"). This is the most
      // reliable source and avoids Foundation/sub-floor fields in the details
      // section that can have their own numeric values.
      //
      // Priority order:
      //   1. Header summary bar: "1,408 SF" pattern (space + uppercase SF)
      //   2. Labeled field: "Total Finished Sqft" or "Main Floor Total SqFt"
      //      (skip any field whose label contains "foundation")
      //   3. Generic sqft pattern as last resort

      const sqftFromHeader = (() => {
        // The header bar text is something like:
        //   "2 beds  2 baths  1,408 SF  #7059633  New Listing"
        // Match a number immediately followed by " SF" (space + SF, word boundary).
        // Use grabSpec with a tight range to avoid false positives.
        const m = bodyText.match(/\b([\d,]+)\s+SF\b/);
        if (m) {
          const n = cleanNum(m[1]);
          if (n && n >= 100 && n <= 99999) return n;
        }
        return null;
      })();

      const sqftFromDetails = (() => {
        // Walk labeled field pairs in the Listing Details section.
        // Accept labels that mention "total" sqft / finished sqft.
        // Explicitly SKIP any label that mentions "foundation".
        const allEls = Array.from(
          document.querySelectorAll('dt, th, label, [class*="label" i], [class*="field-name" i], h1, h2, h3, h4')
        );
        for (const el of allEls) {
          const labelText = text(el);
          // Skip foundation-related labels entirely
          if (/foundation/i.test(labelText)) continue;
          // Only match labels that clearly indicate total/finished sqft
          if (/total\s*(finished\s*)?sq|main\s*floor.*sq|finished.*sq|above.*grd.*sq/i.test(labelText)) {
            const candidates = [
              el.nextElementSibling,
              el.parentElement && el.parentElement.nextElementSibling,
              el.closest('tr') && el.closest('tr').querySelector('td:last-child'),
            ];
            for (const c of candidates) {
              const n = cleanNum(text(c));
              if (n && n >= 100 && n <= 99999) return n;
            }
          }
        }
        return null;
      })();

      specs.sqft =
        sqftFromHeader ||
        sqftFromDetails ||
        // Last resort: generic "X,XXX sq ft" pattern — but only if it doesn't
        // appear within 60 chars of the word "foundation"
        (() => {
          const m = bodyText.match(/([\d,]+)\s*(?:sq\s?ft|square\s?feet|sqft)\b/i);
          if (!m) return null;
          const idx = m.index;
          const surrounding = bodyText.slice(Math.max(0, idx - 60), idx + 60);
          if (/foundation/i.test(surrounding)) return null;
          const n = cleanNum(m[1]);
          return (n && n >= 100 && n <= 99999) ? n : null;
        })() ||
        null;

      specs.lot_sqft = grabSpec(/lot[^0-9]{0,15}([\d,]+)\s*sq\s?ft/i, 1, 9_999_999) || null;
      specs.lot_acres = grabSpec(/([\d.]+)\s*acres?\b/i, 0.01, 9999) || null;
      specs.year_built = grabSpec(/year\s*built[^0-9]{0,5}(\d{4})/i, 1800, 2100) || null;

      // ---- primary photo only ---------------------------------------------
      // Prefer og:image (always the hero/primary photo on FlexMLS).
      // Fall back to the first qualifying <img> if og:image is absent.
      const ogImg = metaProp('og:image');
      let primaryPhoto = ogImg || null;

      if (!primaryPhoto) {
        const imgs = Array.from(document.querySelectorAll('img'));
        for (const img of imgs) {
          const src =
            img.getAttribute('src') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-lazy') ||
            '';
          if (
            src &&
            /^https?:\/\//.test(src) &&
            !/sprite|icon|logo|placeholder|avatar|map/i.test(src) &&
            (img.naturalWidth >= 400 || img.width >= 400 || /media|listing|photo/i.test(src))
          ) {
            primaryPhoto = src;
            break;
          }
        }
      }

      // ---- MLS ID ---------------------------------------------------------
      const mlsId =
        (() => {
          // FlexMLS shows "#XXXXXXX" in the address block
          const m = bodyText.match(/#(\d{6,8})\b/);
          return m ? m[1] : null;
        })() ||
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
        photo: primaryPhoto,   // single primary photo
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

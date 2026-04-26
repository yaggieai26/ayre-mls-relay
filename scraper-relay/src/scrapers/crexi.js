'use strict';

/**
 * scrapeCrexi
 *
 * Logs into Crexi using Bright Data SBR (Playwright over CDP) and extracts
 * per-listing metrics from the seller's My Listings dashboard.
 *
 * @param {object} opts
 * @param {string} opts.email          - Crexi account email
 * @param {string} opts.password       - Crexi account password
 * @param {string} opts.sbrWsEndpoint  - Bright Data SBR WebSocket URL
 * @param {number} [opts.timeoutMs]    - Overall timeout in ms (default 120s)
 * @returns {Promise<Array>}           - Array of listing metric objects
 */
async function scrapeCrexi({ email, password, sbrWsEndpoint, timeoutMs = 120_000 }) {
  const { chromium } = require('playwright-core');

  const browser = await chromium.connectOverCDP(sbrWsEndpoint, { timeout: 60_000 });
  let page;

  try {
    // ── 1. Open a fresh page ─────────────────────────────────────────────────
    const context =
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

    // ── 2. Navigate to login page ────────────────────────────────────────────
    console.log('[crexi] Navigating to login page…');
    await page.goto('https://www.crexi.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // Wait for the Angular app to hydrate and render the login form.
    // Crexi uses standard HTML input types inside an Angular reactive form.
    await page.waitForSelector(
      'input[type="email"], input[name="email"], input[placeholder*="email" i], input[formcontrolname="email"]',
      { timeout: 30_000 }
    );
    console.log('[crexi] Login form visible');

    // ── 3. Fill in credentials ───────────────────────────────────────────────
    // Email field — try multiple selector strategies
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[formcontrolname="email"]',
      'input[placeholder*="email" i]',
      'input[id*="email" i]',
    ];
    let emailFilled = false;
    for (const sel of emailSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.fill(email);
          emailFilled = true;
          console.log(`[crexi] Filled email via selector: ${sel}`);
          break;
        }
      } catch (_) {}
    }
    if (!emailFilled) const title = await page.title(); const html = await page.content(); throw new Error(`Could not find email input on Crexi login page. Title: ${title}. HTML snippet: ${html.slice(0, 500)}`);

    // Password field
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[formcontrolname="password"]',
      'input[placeholder*="password" i]',
      'input[id*="password" i]',
    ];
    let passwordFilled = false;
    for (const sel of passwordSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.fill(password);
          passwordFilled = true;
          console.log(`[crexi] Filled password via selector: ${sel}`);
          break;
        }
      } catch (_) {}
    }
    if (!passwordFilled) throw new Error('Could not find password input on Crexi login page');

    // Small delay to let Angular's reactive form validators run
    await page.waitForTimeout(500);

    // ── 4. Submit the login form ─────────────────────────────────────────────
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Log In")',
      'button:has-text("Sign In")',
      'button:has-text("Login")',
      '[data-testid*="login" i]',
      '[data-testid*="submit" i]',
      'crx-button button',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          submitted = true;
          console.log(`[crexi] Clicked submit via selector: ${sel}`);
          break;
        }
      } catch (_) {}
    }
    if (!submitted) {
      // Last resort: press Enter from the password field
      await page.keyboard.press('Enter');
      submitted = true;
      console.log('[crexi] Submitted via Enter key');
    }

    // ── 5. Wait for login to complete ────────────────────────────────────────
    // After login Crexi redirects to /dashboard or /my-listings or similar.
    // Wait for the URL to change away from /login.
    await page.waitForFunction(
      () => !window.location.pathname.includes('/login'),
      { timeout: 30_000 }
    ).catch(async () => {
      // Check if we're still on login — might be an error message
      const errText = await page.$eval(
        '[class*="error" i], [class*="alert" i], .crx-error, .error-message',
        (el) => el.textContent.trim()
      ).catch(() => null);
      if (errText) throw new Error(`Login failed: ${errText}`);
      throw new Error('Login did not redirect away from /login within 30s');
    });

    const postLoginUrl = page.url();
    console.log(`[crexi] Login successful, now at: ${postLoginUrl}`);

    // ── 6. Navigate to My Listings page ─────────────────────────────────────
    // Crexi's seller dashboard is typically at /my-listings or /profile/listings
    const myListingsUrls = [
      'https://www.crexi.com/my-listings',
      'https://www.crexi.com/profile/listings',
      'https://www.crexi.com/seller/listings',
    ];

    let listingsPageLoaded = false;
    for (const url of myListingsUrls) {
      try {
        console.log(`[crexi] Trying listings URL: ${url}`);
        const resp = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        if (resp && resp.status() < 400) {
          // Wait for content to render
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
          const currentUrl = page.url();
          // If we got redirected to login, this URL didn't work
          if (!currentUrl.includes('/login')) {
            listingsPageLoaded = true;
            console.log(`[crexi] Loaded listings page: ${currentUrl}`);
            break;
          }
        }
      } catch (err) {
        console.warn(`[crexi] URL ${url} failed: ${err.message}`);
      }
    }

    if (!listingsPageLoaded) {
      // Try finding a "My Listings" link in the nav
      const navLink = await page.$('a[href*="my-listing" i], a[href*="seller" i], a:has-text("My Listings")');
      if (navLink) {
        await navLink.click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        console.log(`[crexi] Navigated via nav link to: ${page.url()}`);
        listingsPageLoaded = true;
      }
    }

    if (!listingsPageLoaded) {
      throw new Error('Could not navigate to Crexi My Listings page');
    }

    // ── 7. Extract listing metrics from the DOM ──────────────────────────────
    await page.waitForTimeout(2000); // let any lazy-loaded content settle

    const listings = await page.evaluate(() => {
      const results = [];

      // Helper: extract a number from text, stripping commas
      const toNum = (str) => {
        if (!str) return null;
        const m = str.replace(/,/g, '').match(/\d+/);
        return m ? parseInt(m[0], 10) : null;
      };

      // Helper: get trimmed text content
      const txt = (el) => (el ? el.textContent.trim() : '');

      // ── Strategy A: Crexi listing cards ─────────────────────────────────
      // Crexi renders listings as cards. Common class patterns:
      //   .listing-card, .property-card, crx-listing-card, [class*="listing-item"]
      const cardSelectors = [
        '.listing-card',
        '.property-card',
        '[class*="listing-card"]',
        '[class*="listing-item"]',
        '[class*="property-card"]',
        'crx-listing-card',
        'crx-property-card',
        '[data-testid*="listing"]',
        'article',
      ];

      let cards = [];
      for (const sel of cardSelectors) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) {
          cards = found;
          break;
        }
      }

      for (const card of cards) {
        const listing = {
          listingId: null,
          title: null,
          address: null,
          views: null,
          inquiries: null,
          saves: null,
          listingUrl: null,
        };

        // Listing ID from data attribute or URL
        listing.listingId =
          card.getAttribute('data-id') ||
          card.getAttribute('data-listing-id') ||
          card.getAttribute('id') ||
          null;

        // Title
        const titleEl = card.querySelector(
          'h1, h2, h3, h4, [class*="title"], [class*="name"], [class*="heading"]'
        );
        listing.title = txt(titleEl) || null;

        // Address
        const addrEl = card.querySelector(
          '[class*="address"], [class*="location"], [class*="city"]'
        );
        listing.address = txt(addrEl) || null;

        // Listing URL
        const linkEl = card.querySelector('a[href*="/properties/"], a[href*="/listing"]');
        if (linkEl) {
          const href = linkEl.getAttribute('href');
          listing.listingUrl = href
            ? href.startsWith('http')
              ? href
              : `https://www.crexi.com${href}`
            : null;
          // Extract listing ID from URL if not already set
          if (!listing.listingId && href) {
            const m = href.match(/\/(\d+)(?:\/|$)/);
            if (m) listing.listingId = m[1];
          }
        }

        // Metrics — look for stat/metric elements within the card
        // Crexi typically shows: "Views", "Inquiries", "Saves" labels with numbers
        const allText = card.innerText || '';

        // Try structured metric elements first
        const metricEls = card.querySelectorAll(
          '[class*="metric"], [class*="stat"], [class*="count"], [class*="analytics"]'
        );
        for (const el of metricEls) {
          const label = txt(el).toLowerCase();
          const numEl = el.querySelector('[class*="value"], [class*="count"], strong, span');
          const num = toNum(numEl ? txt(numEl) : txt(el));
          if (/view/.test(label) && num !== null) listing.views = num;
          else if (/inquir/.test(label) && num !== null) listing.inquiries = num;
          else if (/save|favor|watch/.test(label) && num !== null) listing.saves = num;
        }

        // Fallback: regex scan the card's full text for metric patterns
        // e.g. "1,234 Views", "56 Inquiries", "89 Saves"
        if (listing.views === null) {
          const m = allText.match(/([\d,]+)\s*Views?/i);
          if (m) listing.views = toNum(m[1]);
        }
        if (listing.inquiries === null) {
          const m = allText.match(/([\d,]+)\s*Inquir/i);
          if (m) listing.inquiries = toNum(m[1]);
        }
        if (listing.saves === null) {
          const m = allText.match(/([\d,]+)\s*(?:Save|Favor|Watch)/i);
          if (m) listing.saves = toNum(m[1]);
        }

        // Only include cards that have at least a title or URL
        if (listing.title || listing.listingUrl) {
          results.push(listing);
        }
      }

      // ── Strategy B: table rows (some dashboard views use tables) ─────────
      if (results.length === 0) {
        const rows = Array.from(document.querySelectorAll('tr[class*="listing"], tbody tr'));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) continue;
          const rowText = row.innerText || '';
          const listing = {
            listingId: row.getAttribute('data-id') || null,
            title: txt(cells[0]) || null,
            address: txt(cells[1]) || null,
            views: null,
            inquiries: null,
            saves: null,
            listingUrl: null,
          };
          const link = row.querySelector('a');
          if (link) {
            const href = link.getAttribute('href');
            listing.listingUrl = href
              ? href.startsWith('http') ? href : `https://www.crexi.com${href}`
              : null;
          }
          const mViews = rowText.match(/([\d,]+)\s*Views?/i);
          if (mViews) listing.views = toNum(mViews[1]);
          const mInq = rowText.match(/([\d,]+)\s*Inquir/i);
          if (mInq) listing.inquiries = toNum(mInq[1]);
          const mSave = rowText.match(/([\d,]+)\s*(?:Save|Favor)/i);
          if (mSave) listing.saves = toNum(mSave[1]);

          if (listing.title) results.push(listing);
        }
      }

      // ── Strategy C: capture raw page text for debugging ──────────────────
      // If no structured data found, return a debug snapshot so we can refine
      if (results.length === 0) {
        return {
          __debug: true,
          url: window.location.href,
          title: document.title,
          bodyText: (document.body.innerText || '').slice(0, 3000),
          cardSelectorsFound: (() => {
            const sels = [
              '.listing-card', '.property-card', '[class*="listing-card"]',
              '[class*="listing-item"]', 'crx-listing-card', 'article',
            ];
            return sels.map(s => ({ sel: s, count: document.querySelectorAll(s).length }));
          })(),
        };
      }

      return results;
    });

    return listings;
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { scrapeCrexi };

'use strict';
/**
 * scrapeCrexi  v1.2.1
 *
 * Logs into Crexi using Bright Data SBR (Playwright over CDP) and extracts
 * per-listing metrics from the seller's My Listings dashboard.
 *
 * Key findings from live DOM inspection (2026-04-26):
 *  - crexi.com/login returns a 404. Login is a modal opened from the header.
 *  - The modal uses Angular Material (cui-form-field / cuiforminput).
 *    Inputs have NO name/id/formcontrolname — only type and data-cy="textInput".
 *  - Submit button: button[data-cy="button-login"]
 *  - Dashboard uses AG Grid (.ag-pinned-left-cols-container / .ag-center-cols-container)
 *    with col-id attributes: Property, AskingPrice, Status, SearchScore,
 *    NumberOfPageViews, NumberOfVisitors, NumberOfDownloadedDocument,
 *    NumberOfOffers, Actions.
 *
 * Metric mapping:
 *   views     -> NumberOfPageViews
 *   inquiries -> NumberOfOffers  (closest proxy; no "inquiries" column on grid)
 *   saves     -> NumberOfDownloadedDocument (OM/Flyer downloads; no "saves" column)
 */
async function scrapeCrexi({ email, password, sbrWsEndpoint, timeoutMs = 150_000 }) {
  const { chromium } = require('playwright-core');
  const browser = await chromium.connectOverCDP(sbrWsEndpoint, { timeout: 60_000 });
  let page;

  try {
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

    // 1. Navigate to Crexi home (login modal is triggered from the header)
    console.log('[crexi] Navigating to https://www.crexi.com/');
    await page.goto('https://www.crexi.com/', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // 2. Open the Sign-in modal
    console.log('[crexi] Clicking Sign in header button');
    await page.locator('button', { hasText: /^Sign in$/i }).first().click({ timeout: 30_000 });

    // 3. Switch to the Log In tab (modal opens on Sign Up by default)
    console.log('[crexi] Switching to Log In tab');
    await page.locator('button[role="tab"]', { hasText: /^Log In$/i }).click({ timeout: 20_000 });

    // 4. Fill credentials
    // Crexi uses Angular Material cui-form-field with bare <input type="email"
    // data-cy="textInput"> - no name/id/formcontrolname attributes.
    console.log('[crexi] Filling email');
    const emailInput = page.locator('input[type="email"][data-cy="textInput"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 20_000 });
    await emailInput.fill(email);

    console.log('[crexi] Filling password');
    const passwordInput = page.locator('input[type="password"][data-cy="textInput"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 10_000 });
    await passwordInput.fill(password);

    // 5. Submit
    console.log('[crexi] Clicking Log In submit button');
    await page.locator('button[data-cy="button-login"]').first().click({ timeout: 20_000 });

    // 6. Wait for auth to complete
    // Signal: "Sign in" button disappears OR user-menu button appears
    console.log('[crexi] Waiting for post-login state');
    await Promise.race([
      page.locator('button[hint="User menu"], button[aria-label*="User menu" i]')
          .first().waitFor({ state: 'visible', timeout: 45_000 }),
      page.locator('button', { hasText: /^Sign in$/i })
          .first().waitFor({ state: 'detached', timeout: 45_000 })
          .catch(function() {}),
    ]).catch(function() {});

    // Dismiss welcome tour if present
    await page.locator('button', { hasText: /^Skip tour$/i })
      .first().click({ timeout: 5_000 }).catch(function() {});

    // 7. Navigate to My Listings dashboard
    console.log('[crexi] Navigating to /dashboard/my-listings');
    await page.goto('https://www.crexi.com/dashboard/my-listings', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // 8. Wait for AG Grid to render
    console.log('[crexi] Waiting for AG Grid rows');
    await page.waitForSelector(
      '.ag-pinned-left-cols-container .ag-row, .ag-center-cols-container .ag-row',
      { timeout: 60_000 }
    );
    // Give the grid a moment to fully populate all metric cells
    await page.waitForTimeout(2500);

    // 9. Extract listings from AG Grid
    console.log('[crexi] Extracting listings from AG Grid');
    const listings = await page.evaluate(function() {
      var cleanWS = function(s) { return (s || '').replace(/\s+/g, ' ').trim(); };
      var cleanNum = function(s) {
        if (s == null) return null;
        var m = String(s).replace(/[, ]/g, '').match(/-?\d+(?:\.\d+)?/);
        return m ? Number(m[0]) : null;
      };
      var parseCountCell = function(raw) {
        var text = cleanWS(raw);
        if (!text) return { total: null, new_count: null };
        var newMatch = text.match(/([\d,]+)\s*new/i);
        var totalMatch = text.match(/^([\d,]+)/);
        return {
          total: totalMatch ? cleanNum(totalMatch[1]) : null,
          new_count: newMatch ? cleanNum(newMatch[1]) : null,
        };
      };

      var byIndex = new Map();
      var ensure = function(idx) {
        if (!byIndex.has(idx)) byIndex.set(idx, { idx: Number(idx), title: null, subtitle: null, href: null, cells: {} });
        return byIndex.get(idx);
      };

      // Property column (pinned-left)
      document.querySelectorAll('.ag-pinned-left-cols-container .ag-row').forEach(function(r) {
        var idx = r.getAttribute('row-index');
        if (idx == null) return;
        var cell = r.querySelector('.ag-cell[col-id="Property"]') || r.querySelector('.ag-cell');
        if (!cell) return;
        var obj = ensure(idx);
        var lines = (cell.innerText || '').split(/\n+/).map(function(s) { return s.trim(); }).filter(function(s) { return s && s !== 'Edit Property'; });
        obj.title = lines[0] || null;
        obj.subtitle = lines[1] || null;
        var link = cell.querySelector('a[href]');
        obj.href = link ? link.getAttribute('href') : null;
      });

      // Metric columns (center)
      document.querySelectorAll('.ag-center-cols-container .ag-row').forEach(function(r) {
        var idx = r.getAttribute('row-index');
        if (idx == null) return;
        var obj = ensure(idx);
        r.querySelectorAll('.ag-cell').forEach(function(c) {
          var colId = c.getAttribute('col-id');
          if (colId) obj.cells[colId] = cleanWS(c.innerText);
        });
      });

      return Array.from(byIndex.values()).sort(function(a, b) { return a.idx - b.idx; }).map(function(r) {
        var c = r.cells || {};
        var pageViews = parseCountCell(c.NumberOfPageViews);
        var visitors = parseCountCell(c.NumberOfVisitors);
        var docs = parseCountCell(c.NumberOfDownloadedDocument);
        var offers = parseCountCell(c.NumberOfOffers);
        var priceText = cleanWS((c.AskingPrice || '').replace(/^Asking\s*/i, ''));
        // Status cell contains dropdown options as text; first line is the actual status
        var statusLine = cleanWS((c.Status || '').split(/\n/)[0]);
        return {
          title: r.title,
          address: r.title,
          subtitle: r.subtitle,
          href: r.href ? (r.href.startsWith('http') ? r.href : 'https://www.crexi.com' + r.href) : null,
          asking_price: priceText || null,
          status: statusLine || null,
          search_score: cleanNum(cleanWS(c.SearchScore)),
          views: pageViews.total,
          inquiries: offers.total,
          saves: docs.total,
          visitors: visitors.total,
          om_flyer_downloads: docs.total,
          offers: offers.total,
          page_views_new: pageViews.new_count,
          visitors_new: visitors.new_count,
          om_flyer_new: docs.new_count,
        };
      });
    });

    console.log('[crexi] Extracted', listings.length, 'listings');
    return listings;

  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { scrapeCrexi };

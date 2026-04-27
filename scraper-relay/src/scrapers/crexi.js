'use strict';
/**
 * scrapeCrexi  v1.2.3
 *
 * Logs into Crexi using Bright Data SBR (Playwright over CDP) and extracts
 * per-listing metrics from the seller's My Listings dashboard.
 *
 * Includes debug mode: pass debug=true to get page HTML snapshot if grid not found.
 */
async function scrapeCrexi({ email, password, sbrWsEndpoint, timeoutMs = 150_000, debug = false }) {
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

    // Step 1: Navigate to dashboard - will redirect to login if not authenticated
    console.log('[crexi] Navigating to /dashboard/my-listings');
    await page.goto('https://www.crexi.com/dashboard/my-listings', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    console.log('[crexi] Current URL after navigation:', currentUrl);

    // Check if we need to log in
    const onDashboard = currentUrl.includes('/dashboard') && !currentUrl.includes('login');

    if (!onDashboard) {
      console.log('[crexi] Not on dashboard, attempting login...');

      let emailInput = null;

      // Try to find email input directly
      try {
        emailInput = page.locator('input[type="email"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 5000 });
        console.log('[crexi] Found email input directly on page');
      } catch (_) {
        emailInput = null;
      }

      if (!emailInput) {
        // Try clicking sign-in buttons
        const signInSelectors = [
          'button[data-cy="button-sign-in"]',
          'button:has-text("Sign in")',
          'button:has-text("Sign In")',
          'button:has-text("Log in")',
          'button:has-text("Log In")',
          'a[href*="login"]',
        ];

        for (const sel of signInSelectors) {
          try {
            const el = page.locator(sel).first();
            await el.waitFor({ state: 'visible', timeout: 3000 });
            await el.click({ timeout: 5000 });
            console.log('[crexi] Clicked sign-in element:', sel);
            await page.waitForTimeout(2000);
            break;
          } catch (_) {}
        }

        // Try Log In tab
        try {
          await page.locator('button[role="tab"]:has-text("Log In")').first().click({ timeout: 3000 });
          await page.waitForTimeout(1000);
        } catch (_) {}

        try {
          emailInput = page.locator('input[type="email"]').first();
          await emailInput.waitFor({ state: 'visible', timeout: 10000 });
          console.log('[crexi] Found email input after clicking sign-in');
        } catch (_) {
          emailInput = null;
        }
      }

      if (!emailInput) {
        const title = await page.title().catch(() => 'unknown');
        const url = page.url();
        const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '').catch(() => '');
        const allInputs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input')).map(i => ({
            type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
            dataCy: i.getAttribute('data-cy'), visible: i.offsetParent !== null
          }))
        ).catch(() => []);
        const allButtons = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button')).slice(0, 15).map(b => ({
            text: b.innerText.trim().slice(0, 50),
            dataCy: b.getAttribute('data-cy')
          }))
        ).catch(() => []);
        throw new Error(`Could not find email input. URL: ${url}, Title: ${title}, Body: ${bodyText.slice(0,200)}, Inputs: ${JSON.stringify(allInputs)}, Buttons: ${JSON.stringify(allButtons)}`);
      }

      // Fill credentials
      console.log('[crexi] Filling email');
      await emailInput.fill(email);

      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
      console.log('[crexi] Filling password');
      await passwordInput.fill(password);

      // Submit
      console.log('[crexi] Submitting login form');
      let submitted = false;
      for (const sel of ['button[data-cy="button-login"]', 'button[type="submit"]', 'button:has-text("Log In")', 'button:has-text("Sign In")']) {
        try {
          await page.locator(sel).first().click({ timeout: 5000 });
          console.log('[crexi] Submitted with selector:', sel);
          submitted = true;
          break;
        } catch (_) {}
      }
      if (!submitted) {
        await passwordInput.press('Enter');
        console.log('[crexi] Submitted by pressing Enter');
      }

      // Wait for login
      console.log('[crexi] Waiting for post-login navigation...');
      await page.waitForTimeout(5000);

      // Navigate to dashboard
      console.log('[crexi] Navigating to /dashboard/my-listings after login');
      await page.goto('https://www.crexi.com/dashboard/my-listings', {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      await page.waitForTimeout(3000);
    }

    // Wait for the page to fully render
    // Try multiple grid selectors in case the structure changed
    console.log('[crexi] Waiting for AG Grid or listing content...');

    const gridSelectors = [
      '.ag-pinned-left-cols-container .ag-row',
      '.ag-center-cols-container .ag-row',
      '.ag-row[row-index]',
      '[class*="ag-row"]',
      '.ag-root-wrapper',
      '.listing-row',
      '[data-testid*="listing"]',
    ];

    let gridFound = false;
    for (const sel of gridSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        console.log('[crexi] Found grid element with selector:', sel);
        gridFound = true;
        break;
      } catch (_) {}
    }

    if (!gridFound) {
      // Capture debug info
      const url = page.url();
      const title = await page.title().catch(() => 'unknown');
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '').catch(() => '');
      const html = debug ? await page.content().catch(() => '') : '';
      const agClasses = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="ag-"]');
        return Array.from(new Set(Array.from(els).map(e => e.className.split(' ').filter(c => c.startsWith('ag-')).join(' ')))).slice(0, 20);
      }).catch(() => []);

      if (debug) {
        return {
          __debug: true,
          url,
          title,
          bodyText,
          html: html.slice(0, 10000),
          agClasses,
        };
      }
      throw new Error(`AG Grid not found. URL: ${url}, Title: ${title}, Body: ${bodyText.slice(0,500)}, AG classes found: ${JSON.stringify(agClasses)}`);
    }

    // Give the grid a moment to fully populate
    await page.waitForTimeout(3000);

    // Extract listings from AG Grid
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
      document.querySelectorAll('.ag-pinned-left-cols-container .ag-row, .ag-row[row-index]').forEach(function(r) {
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
      document.querySelectorAll('.ag-center-cols-container .ag-row, .ag-row[row-index]').forEach(function(r) {
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

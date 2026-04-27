'use strict';
/**
 * scrapeCrexi  v1.2.2
 *
 * Logs into Crexi using Bright Data SBR (Playwright over CDP) and extracts
 * per-listing metrics from the seller's My Listings dashboard.
 *
 * Strategy:
 * 1. Navigate directly to /dashboard/my-listings (Crexi redirects to login if not authed)
 * 2. If redirected to login, fill credentials using multiple selector fallbacks
 * 3. Extract AG Grid data after successful login
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

    // Strategy: Navigate directly to dashboard - Crexi will redirect to login if not authed.
    // This avoids needing to find the "Sign in" button on the homepage.
    console.log('[crexi] Navigating to /dashboard/my-listings (will redirect to login if needed)');
    await page.goto('https://www.crexi.com/dashboard/my-listings', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // Wait for the page to settle
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log('[crexi] Current URL after navigation:', currentUrl);

    // Check if we're already logged in (on the dashboard)
    const onDashboard = currentUrl.includes('/dashboard') && !currentUrl.includes('login');

    if (!onDashboard) {
      // We need to log in. Try multiple approaches.
      console.log('[crexi] Not on dashboard, attempting login...');

      // Check if there's a login form visible already (some redirect paths show it inline)
      let emailInput = null;

      // Try approach 1: Direct email/password inputs (no modal needed)
      try {
        emailInput = page.locator('input[type="email"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 5000 });
        console.log('[crexi] Found email input directly on page');
      } catch (_) {
        emailInput = null;
      }

      if (!emailInput) {
        // Try approach 2: Click "Sign in" or "Log In" button to open modal
        // Try various selectors for the sign-in button
        const signInSelectors = [
          'button[data-cy="button-sign-in"]',
          'button[data-cy="sign-in"]',
          'a[data-cy="sign-in"]',
          'button:has-text("Sign in")',
          'button:has-text("Sign In")',
          'button:has-text("Log in")',
          'button:has-text("Log In")',
          '[class*="sign-in"]',
          '[class*="login"]',
          'a[href*="login"]',
        ];

        let clicked = false;
        for (const sel of signInSelectors) {
          try {
            const el = page.locator(sel).first();
            await el.waitFor({ state: 'visible', timeout: 3000 });
            await el.click({ timeout: 5000 });
            console.log('[crexi] Clicked sign-in element with selector:', sel);
            clicked = true;
            await page.waitForTimeout(2000);
            break;
          } catch (_) {}
        }

        if (!clicked) {
          // Approach 3: Use evaluate to find and click the sign-in button
          console.log('[crexi] Trying page.evaluate to click sign-in...');
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            const signIn = buttons.find(b => /sign.?in|log.?in/i.test(b.textContent || b.innerText || ''));
            if (signIn) signIn.click();
          });
          await page.waitForTimeout(2000);
        }

        // Now try to find the email input
        try {
          emailInput = page.locator('input[type="email"]').first();
          await emailInput.waitFor({ state: 'visible', timeout: 10000 });
          console.log('[crexi] Found email input after clicking sign-in');
        } catch (_) {
          // Try the Log In tab if we're on a sign-up modal
          try {
            await page.locator('button[role="tab"]:has-text("Log In"), [role="tab"]:has-text("Log In")').first().click({ timeout: 5000 });
            await page.waitForTimeout(1000);
            emailInput = page.locator('input[type="email"]').first();
            await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            console.log('[crexi] Found email input after switching to Log In tab');
          } catch (_) {
            emailInput = null;
          }
        }
      }

      if (!emailInput) {
        // Capture debug info
        const title = await page.title().catch(() => 'unknown');
        const url = page.url();
        const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1000) : '').catch(() => '');
        const allInputs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input')).map(i => ({
            type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
            dataCy: i.getAttribute('data-cy'), visible: i.offsetParent !== null
          }))
        ).catch(() => []);
        const allButtons = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button')).slice(0, 20).map(b => ({
            text: b.innerText.trim().slice(0, 50),
            dataCy: b.getAttribute('data-cy'),
            class: b.className.slice(0, 80)
          }))
        ).catch(() => []);
        throw new Error(`Could not find email input. URL: ${url}, Title: ${title}, Body: ${bodyText.slice(0,300)}, Inputs: ${JSON.stringify(allInputs)}, Buttons: ${JSON.stringify(allButtons)}`);
      }

      // Fill email
      console.log('[crexi] Filling email');
      await emailInput.fill(email);

      // Find password input
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
      console.log('[crexi] Filling password');
      await passwordInput.fill(password);

      // Submit - try multiple selectors
      console.log('[crexi] Submitting login form');
      let submitted = false;
      const submitSelectors = [
        'button[data-cy="button-login"]',
        'button[type="submit"]',
        'button:has-text("Log In")',
        'button:has-text("Sign In")',
        'button:has-text("Login")',
      ];
      for (const sel of submitSelectors) {
        try {
          await page.locator(sel).first().click({ timeout: 5000 });
          console.log('[crexi] Submitted with selector:', sel);
          submitted = true;
          break;
        } catch (_) {}
      }
      if (!submitted) {
        // Try pressing Enter
        await passwordInput.press('Enter');
        console.log('[crexi] Submitted by pressing Enter');
      }

      // Wait for login to complete
      console.log('[crexi] Waiting for post-login navigation...');
      await page.waitForTimeout(4000);

      // Navigate to dashboard
      console.log('[crexi] Navigating to /dashboard/my-listings after login');
      await page.goto('https://www.crexi.com/dashboard/my-listings', {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    }

    // Wait for AG Grid to render
    console.log('[crexi] Waiting for AG Grid rows');
    await page.waitForSelector(
      '.ag-pinned-left-cols-container .ag-row, .ag-center-cols-container .ag-row',
      { timeout: 60_000 }
    );
    // Give the grid a moment to fully populate all metric cells
    await page.waitForTimeout(2500);

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

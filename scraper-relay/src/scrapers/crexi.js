'use strict';
/**
 * scrapeCrexi  v1.2.4
 *
 * Logs into Crexi using Bright Data SBR (Playwright over CDP) and extracts
 * per-listing metrics from the seller's My Listings dashboard.
 *
 * Key fix in v1.2.4:
 * - Crexi is an Angular SPA. Using waitUntil:'domcontentloaded' fires before
 *   Angular bootstraps and renders any content. Must use 'networkidle' or
 *   wait for specific Angular-rendered elements.
 * - Navigate to crexi.com/ first, wait for Angular to render the header,
 *   then click Sign In to open the login modal.
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

    // Step 1: Navigate to Crexi homepage and wait for Angular to bootstrap
    console.log('[crexi] Navigating to https://www.crexi.com/');
    await page.goto('https://www.crexi.com/', {
      waitUntil: 'networkidle',
      timeout: 90_000,
    });

    console.log('[crexi] Waiting for Angular app to render...');
    // Wait for the Angular app to render - look for the header nav or any button
    // Angular apps render a <app-root> or similar component
    // Try multiple signals that Angular has bootstrapped
    let appReady = false;
    const angularSignals = [
      'header button',
      'nav button',
      'button',
      'app-root',
      'crx-header',
      '[class*="header"]',
      'mat-toolbar',
    ];
    for (const sel of angularSignals) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        console.log('[crexi] Angular rendered, found:', sel);
        appReady = true;
        break;
      } catch (_) {}
    }

    if (!appReady) {
      // Capture debug info
      const title = await page.title().catch(() => 'unknown');
      const url = page.url();
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '').catch(() => '');
      const html = debug ? await page.content().catch(() => '') : '';
      if (debug) {
        return { __debug: true, url, title, bodyText, html: html.slice(0, 5000), stage: 'angular_bootstrap' };
      }
      throw new Error(`Angular app did not render. URL: ${url}, Title: ${title}, Body: ${bodyText.slice(0,200)}`);
    }

    // Give Angular a moment to fully render
    await page.waitForTimeout(2000);

    // Step 2: Check if we're already logged in
    const isLoggedIn = await page.evaluate(() => {
      // Check for user menu button or avatar (indicates logged in state)
      const userMenu = document.querySelector('[hint="User menu"], [aria-label*="User menu" i], [class*="user-menu"], [class*="avatar"]');
      // Also check if Sign in button is absent
      const signIn = Array.from(document.querySelectorAll('button')).find(b => /^sign.?in$/i.test(b.innerText.trim()));
      return { hasUserMenu: Boolean(userMenu), hasSignIn: Boolean(signIn) };
    }).catch(() => ({ hasUserMenu: false, hasSignIn: true }));

    console.log('[crexi] Login state check:', JSON.stringify(isLoggedIn));

    if (!isLoggedIn.hasUserMenu) {
      // Need to log in
      console.log('[crexi] Not logged in, opening Sign In modal...');

      // Find and click the Sign In button
      let signInClicked = false;
      const signInSelectors = [
        'button:has-text("Sign in")',
        'button:has-text("Sign In")',
        'button:has-text("Log in")',
        'button:has-text("Log In")',
        '[data-cy*="sign-in"]',
        '[data-cy*="signin"]',
      ];

      for (const sel of signInSelectors) {
        try {
          const el = page.locator(sel).first();
          await el.waitFor({ state: 'visible', timeout: 5000 });
          await el.click({ timeout: 5000 });
          console.log('[crexi] Clicked Sign In with selector:', sel);
          signInClicked = true;
          await page.waitForTimeout(1500);
          break;
        } catch (_) {}
      }

      if (!signInClicked) {
        // Try evaluate-based click
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const signIn = buttons.find(b => /sign.?in|log.?in/i.test(b.innerText.trim()));
          if (signIn) { signIn.click(); return true; }
          return false;
        }).catch(() => false);
        if (clicked) {
          console.log('[crexi] Clicked Sign In via evaluate');
          await page.waitForTimeout(1500);
        }
      }

      // Wait for the modal to appear
      console.log('[crexi] Waiting for login modal...');
      let emailInput = null;

      // Try to find email input (may need to switch to Log In tab first)
      try {
        emailInput = page.locator('input[type="email"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 10000 });
        console.log('[crexi] Found email input');
      } catch (_) {
        // Try switching to Log In tab
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
            class: b.className.slice(0, 60)
          }))
        ).catch(() => []);
        const html = debug ? await page.content().catch(() => '') : '';
        if (debug) {
          return { __debug: true, url, title, bodyText, allInputs, allButtons, html: html.slice(0, 5000), stage: 'find_email_input' };
        }
        throw new Error(`Could not find email input. URL: ${url}, Inputs: ${JSON.stringify(allInputs)}, Buttons: ${JSON.stringify(allButtons.slice(0,10))}`);
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

      // Wait for login to complete
      console.log('[crexi] Waiting for post-login state...');
      await page.waitForTimeout(5000);
    }

    // Step 3: Navigate to the My Listings dashboard
    console.log('[crexi] Navigating to /dashboard/my-listings');
    await page.goto('https://www.crexi.com/dashboard/my-listings', {
      waitUntil: 'networkidle',
      timeout: 90_000,
    });
    await page.waitForTimeout(3000);

    const dashUrl = page.url();
    console.log('[crexi] Dashboard URL:', dashUrl);

    // Step 4: Wait for AG Grid to render
    console.log('[crexi] Waiting for AG Grid...');
    const gridSelectors = [
      '.ag-pinned-left-cols-container .ag-row',
      '.ag-center-cols-container .ag-row',
      '.ag-row[row-index]',
      '.ag-root-wrapper',
    ];

    let gridFound = false;
    for (const sel of gridSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 20000 });
        console.log('[crexi] Found grid with selector:', sel);
        gridFound = true;
        break;
      } catch (_) {}
    }

    if (!gridFound) {
      const url = page.url();
      const title = await page.title().catch(() => 'unknown');
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '').catch(() => '');
      const agClasses = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="ag-"]');
        return Array.from(new Set(Array.from(els).map(e => e.className.split(' ').filter(c => c.startsWith('ag-')).join(' ')))).slice(0, 20);
      }).catch(() => []);
      const html = debug ? await page.content().catch(() => '') : '';
      if (debug) {
        return { __debug: true, url, title, bodyText, agClasses, html: html.slice(0, 8000), stage: 'grid_not_found' };
      }
      throw new Error(`AG Grid not found. URL: ${url}, Body: ${bodyText.slice(0,400)}, AG classes: ${JSON.stringify(agClasses)}`);
    }

    // Give the grid a moment to fully populate
    await page.waitForTimeout(3000);

    // Step 5: Extract listings
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

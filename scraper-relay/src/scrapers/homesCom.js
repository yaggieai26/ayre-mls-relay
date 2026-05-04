'use strict';

const { chromium } = require('playwright-core');

/**
 * Scrape Homes.com agent dashboard listing analytics via Bright Data SBR.
 *
 * Flow:
 *   1) Connect to SBR over CDP.
 *   2) Navigate to https://www.homes.com/sign-in/ and fill email + password.
 *   3) Wait for successful login (dashboard nav or profile icon visible).
 *   4) Navigate to the agent dashboard listings analytics page.
 *   5) Scrape all listing rows (address, views, saves, inquiries, etc.).
 *   6) If pagination exists, iterate through all pages.
 *
 * Homes.com dashboard analytics URL patterns:
 *   - https://www.homes.com/account/listings/  (agent's listings overview)
 *   - https://www.homes.com/account/analytics/ (analytics/performance)
 *
 * @param {Object} opts
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {string} opts.sbrWsEndpoint     Bright Data SBR WS URL
 * @param {number} [opts.timeoutMs=180000]
 * @param {boolean} [opts.debug=false]
 * @returns {Promise<{listings: Array, debug: Object}>}
 */
async function scrapeHomesCom({ email, password, sbrWsEndpoint, timeoutMs = 180_000, debug: debugMode = false }) {
  if (!sbrWsEndpoint) {
    throw new Error('SBR WebSocket endpoint is not configured');
  }
  if (!email || !password) {
    throw new Error('email and password are required');
  }

  const browser = await chromium.connectOverCDP(sbrWsEndpoint, { timeout: 60_000 });

  let context;
  let page;
  const debugInfo = { steps: [], screenshots: [] };
  const log = (msg) => {
    console.log(`[Homes.com] ${msg}`);
    debugInfo.steps.push(`${new Date().toISOString()} ${msg}`);
  };

  try {
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

    // ── Step 1: Navigate to sign-in page ──────────────────────────────────────
    log('goto https://www.homes.com/sign-in/');
    await page.goto('https://www.homes.com/sign-in/', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    await page.waitForTimeout(2_000);

    const signInTitle = await page.title();
    log(`sign-in page title: ${signInTitle}`);

    // ── Step 2: Fill login form ────────────────────────────────────────────────
    // Homes.com sign-in form uses standard email/password inputs
    log('waiting for email input');
    const emailInput = page.locator(
      'input[type="email"], input[name="email"], input[id*="email" i], input[placeholder*="email" i]'
    ).first();
    await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
    await emailInput.fill(email);
    log('email filled');

    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15_000 });
    await passwordInput.fill(password);
    log('password filled');

    // ── Step 3: Submit login ───────────────────────────────────────────────────
    log('submitting login form');
    // Try to find a submit button first, fall back to Enter key
    const submitBtn = page.locator(
      'button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Sign in"), input[type="submit"]'
    ).first();
    const submitCount = await submitBtn.count();
    if (submitCount > 0) {
      await submitBtn.click({ timeout: 15_000 });
    } else {
      await passwordInput.press('Enter');
    }

    // ── Step 4: Wait for login to complete ────────────────────────────────────
    log('waiting for login to complete...');
    await Promise.race([
      // Success: redirected away from sign-in page
      page.waitForURL((url) => !url.toString().includes('/sign-in'), { timeout: 45_000 }),
      // Success: profile/account icon appears
      page.locator('[data-testid*="user" i], [aria-label*="account" i], [aria-label*="profile" i], .user-menu, .account-menu').first().waitFor({ state: 'visible', timeout: 45_000 }),
      // Success: any dashboard-like nav appears
      page.locator('a[href*="/account/"], a[href*="/dashboard/"]').first().waitFor({ state: 'visible', timeout: 45_000 }),
    ]).catch(() => {
      log('login wait timed out - proceeding anyway');
    });

    const postLoginUrl = page.url();
    const postLoginTitle = await page.title();
    log(`post-login URL: ${postLoginUrl}`);
    log(`post-login title: ${postLoginTitle}`);

    // Check if we're still on sign-in (login failed)
    if (postLoginUrl.includes('/sign-in') || postLoginUrl.includes('/login')) {
      // Check for error message
      const errorText = await page.locator('.error, [class*="error"], [class*="alert"]').first().textContent().catch(() => '');
      throw new Error(`Login failed - still on sign-in page. Error: ${errorText || 'unknown'}`);
    }

    // ── Step 5: Navigate to listings analytics ────────────────────────────────
    // Try the analytics/listings dashboard pages
    const dashboardUrls = [
      'https://www.homes.com/account/listings/',
      'https://www.homes.com/account/',
      'https://www.homes.com/account/analytics/',
    ];

    let listingsFound = false;
    let allListings = [];

    for (const dashUrl of dashboardUrls) {
      log(`trying dashboard URL: ${dashUrl}`);
      await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(3_000);

      const dashTitle = await page.title();
      const dashUrl2 = page.url();
      log(`dashboard page title: ${dashTitle}, url: ${dashUrl2}`);

      // Check if we got redirected to login again
      if (dashUrl2.includes('/sign-in') || dashUrl2.includes('/login')) {
        log('redirected to login - session expired');
        continue;
      }

      // Look for listing rows/cards on this page
      const pageHtml = await page.content();
      const hasListings = pageHtml.includes('listing') || pageHtml.includes('property') || pageHtml.includes('address');
      log(`page has listing content: ${hasListings}, html length: ${pageHtml.length}`);

      if (hasListings && pageHtml.length > 10_000) {
        // Try to extract listing data from this page
        const extracted = await extractListingsFromPage(page, log);
        if (extracted.length > 0) {
          allListings = extracted;
          listingsFound = true;
          log(`extracted ${extracted.length} listings from ${dashUrl}`);
          break;
        }
      }

      // Save HTML snippet for debugging
      if (debugMode) {
        debugInfo.screenshots.push({
          url: dashUrl2,
          html_snippet: pageHtml.substring(0, 5000),
        });
      }
    }

    if (!listingsFound) {
      // Last resort: save the full page HTML for analysis
      const finalHtml = await page.content();
      log(`no listings found on any dashboard page. Final URL: ${page.url()}`);
      if (debugMode) {
        debugInfo.screenshots.push({
          url: page.url(),
          html_snippet: finalHtml.substring(0, 10000),
        });
      }
    }

    log(`total listings extracted: ${allListings.length}`);
    return { listings: allListings, debug: debugInfo };

  } finally {
    try {
      if (page) await page.close();
    } catch (_) {}
    try {
      await browser.close();
    } catch (_) {}
  }
}

/**
 * Extract listing analytics data from the current page.
 * Homes.com dashboard uses various layouts - we try multiple strategies.
 */
async function extractListingsFromPage(page, log) {
  return await page.evaluate(() => {
    const cleanText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const parseNum = (s) => {
      if (!s) return null;
      const m = String(s).replace(/[,\s]/g, '').match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    };

    const results = [];

    // Strategy 1: Look for table rows with listing data
    const tableRows = document.querySelectorAll('table tr, [role="row"]');
    if (tableRows.length > 1) {
      // Find header row to understand column positions
      const headerRow = tableRows[0];
      const headers = Array.from(headerRow.querySelectorAll('th, [role="columnheader"]')).map(h => cleanText(h).toLowerCase());
      
      for (let i = 1; i < tableRows.length; i++) {
        const row = tableRows[i];
        const cells = Array.from(row.querySelectorAll('td, [role="cell"]'));
        if (cells.length === 0) continue;
        
        const rowData = {};
        cells.forEach((cell, idx) => {
          const header = headers[idx] || `col_${idx}`;
          rowData[header] = cleanText(cell);
        });
        
        if (Object.keys(rowData).length > 0) {
          results.push(rowData);
        }
      }
      
      if (results.length > 0) return results;
    }

    // Strategy 2: Look for listing cards/tiles
    const listingCards = document.querySelectorAll(
      '[class*="listing-card"], [class*="property-card"], [class*="listing-row"], [class*="listing-item"], [data-testid*="listing"]'
    );
    
    if (listingCards.length > 0) {
      listingCards.forEach((card) => {
        const addressEl = card.querySelector('[class*="address"], [class*="street"], h2, h3, .title');
        const viewsEl = card.querySelector('[class*="view"], [class*="impression"]');
        const savesEl = card.querySelector('[class*="save"], [class*="favorite"]');
        const inquiriesEl = card.querySelector('[class*="inquir"], [class*="lead"], [class*="contact"]');
        
        const address = cleanText(addressEl);
        if (!address) return;
        
        results.push({
          address,
          views: parseNum(cleanText(viewsEl)),
          saves: parseNum(cleanText(savesEl)),
          inquiries: parseNum(cleanText(inquiriesEl)),
          raw_card: card.textContent.replace(/\s+/g, ' ').trim().substring(0, 500),
        });
      });
      
      if (results.length > 0) return results;
    }

    // Strategy 3: Look for any structured data with numbers that look like analytics
    // Scan for elements with address-like text near numeric data
    const allElements = document.querySelectorAll('li, article, [class*="row"], [class*="item"]');
    const addressPattern = /\d+\s+[A-Za-z]/;
    
    allElements.forEach((el) => {
      const text = cleanText(el);
      if (!addressPattern.test(text) || text.length > 500) return;
      
      // Look for numbers that could be views/saves
      const numbers = text.match(/\b\d{1,6}\b/g);
      if (!numbers || numbers.length < 2) return;
      
      results.push({
        raw_text: text,
        numbers_found: numbers.map(Number),
      });
    });

    return results;
  });
}

module.exports = { scrapeHomesCom };

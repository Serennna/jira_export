import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import path from 'path';

const CDP_URL = 'http://127.0.0.1:9222';

/**
 * Export Xray test steps by connecting to an already-running Chrome instance
 * via the Chrome DevTools Protocol (CDP).
 *
 * Prerequisites:
 *   1. Run:  sh start-chrome-debug.sh
 *   2. Log in to Jira in that Chrome window
 *   3. Then call this function (or run export-steps-ui.js)
 *
 * @param {object} opts
 * @param {string} opts.jiraBaseUrl
 * @param {string} opts.issueKey
 * @param {string} [opts.outputDir]
 */
export async function exportStepsViaUI({
  jiraBaseUrl,
  issueKey,
  outputDir = './output',
}) {
  mkdirSync(outputDir, { recursive: true });

  // ── Connect to running Chrome via CDP ─────────────────────────────────────
  console.log(`  Connecting to Chrome at ${CDP_URL}…`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    throw new Error(
      `Could not connect to Chrome on ${CDP_URL}.\n`
      + 'Please run:  sh start-chrome-debug.sh\n'
      + 'Then log in to Jira and try again.'
    );
  }

  // Use the first existing browser context (your normal Chrome session)
  const context = browser.contexts()[0];
  if (!context) throw new Error('No browser context found in Chrome.');

  // Open a new tab (keeps existing tabs untouched)
  const page = await context.newPage();

  try {
    const ticketUrl = `${jiraBaseUrl}/browse/${issueKey}`;
    console.log(`  Navigating to ${ticketUrl}`);
    await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // ── Verify we are logged in ────────────────────────────────────────────
    await page.waitForTimeout(2_000);
    if (!page.url().startsWith(jiraBaseUrl)) {
      throw new Error(
        `Redirected to ${page.url()} — not logged in.\n`
        + 'Please log in to Jira in the Chrome window opened by start-chrome-debug.sh, then retry.'
      );
    }

    // ── Wait for full page load including Connect app iframes ─────────────
    console.log('  Waiting for page to fully load…');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {
      console.log('  (networkidle timeout, continuing anyway)');
    });

    // ── Debug screenshot ───────────────────────────────────────────────────
    const screenshotPath = path.join(outputDir, `${issueKey}_debug.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`  Debug screenshot → ${screenshotPath}`);

    // ── Diagnose frames ────────────────────────────────────────────────────
    await diagnosePage(page);

    // ── Find Xray frame ───────────────────────────────────────────────────
    console.log('\n  Locating Xray test panel…');
    const xrayFrame = await findXrayFrame(page, outputDir, issueKey);

    // ── Click "…" more-options ─────────────────────────────────────────────
    console.log('  Clicking "…" (more options) button…');
    await clickMoreOptionsButton(xrayFrame);

    // ── Set up download listener BEFORE clicking "To csv…" ────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });

    console.log('  Selecting "To csv…"…');
    await clickToCsv(xrayFrame);

    // ── Capture download ───────────────────────────────────────────────────
    console.log('  Waiting for download…');
    const download  = await downloadPromise;
    const destPath  = path.join(outputDir, `${issueKey}_xray_steps.csv`);
    await download.saveAs(destPath);

    console.log(`  Downloaded → ${destPath}`);
    return destPath;

  } finally {
    await page.close();      // close only the tab we opened
    await browser.close();   // disconnect from Chrome (does NOT quit Chrome)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

async function diagnosePage(page) {
  const frames = page.frames();
  console.log(`\n  [diag] ${frames.length} frame(s) on page:`);
  for (const f of frames) console.log(`    ${f.url()}`);

  const iframeSrcs = await page.$$eval('iframe', (els) =>
    els.map((el) => el.src || el.getAttribute('src') || '(no src)')
  ).catch(() => []);
  console.log(`\n  [diag] ${iframeSrcs.length} <iframe> element(s) in DOM:`);
  for (const src of iframeSrcs) console.log(`    ${src}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Find Xray frame
// ─────────────────────────────────────────────────────────────────────────────

async function findXrayFrame(page, outputDir, issueKey) {
  const XRAY_PATTERNS = [/xpandit/i, /xray/i, /getxray/i, /plugins\/servlet\/ac\/.*xray/i];

  // Strategy 1: frame URL
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url && XRAY_PATTERNS.some((p) => p.test(url))) {
      console.log(`  Found Xray frame by URL: ${url}`);
      return frame;
    }
  }

  // Strategy 2: iframe DOM src
  for (const iframeEl of await page.$$('iframe')) {
    const src = (await iframeEl.getAttribute('src').catch(() => '')) ?? '';
    if (XRAY_PATTERNS.some((p) => p.test(src))) {
      const frame = await iframeEl.contentFrame();
      if (frame) { console.log(`  Found Xray iframe by src: ${src}`); return frame; }
    }
  }

  // Strategy 3: "Add Step" button
  for (const frame of page.frames()) {
    const ok = await frame.locator('button:has-text("Add Step")')
      .first().isVisible({ timeout: 1_000 }).catch(() => false);
    if (ok) { console.log(`  Found Xray frame (Add Step): ${frame.url()}`); return frame; }
  }

  // Strategy 4: "Test details" heading
  for (const frame of page.frames()) {
    const ok = await frame.locator('text="Test details"')
      .first().isVisible({ timeout: 1_000 }).catch(() => false);
    if (ok) { console.log(`  Found Xray frame (Test details): ${frame.url()}`); return frame; }
  }

  // Strategy 5: scroll and retry
  console.log('  Scrolling page to trigger lazy-loaded panels…');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3_000);

  const scrollShot = path.join(outputDir, `${issueKey}_debug_scrolled.png`);
  await page.screenshot({ path: scrollShot, fullPage: true });
  console.log(`  Debug screenshot (scrolled) → ${scrollShot}`);

  for (const frame of page.frames()) {
    const url = frame.url();
    if (url && XRAY_PATTERNS.some((p) => p.test(url))) {
      console.log(`  Found Xray frame after scroll: ${url}`); return frame;
    }
    const ok = await frame.locator('button:has-text("Add Step")')
      .first().isVisible({ timeout: 500 }).catch(() => false);
    if (ok) { console.log(`  Found Xray frame after scroll (Add Step): ${frame.url()}`); return frame; }
  }

  console.warn('  No Xray iframe found — trying main page frame');
  return page;
}

// ─────────────────────────────────────────────────────────────────────────────
// Click "…" more-options button
// ─────────────────────────────────────────────────────────────────────────────

async function clickMoreOptionsButton(frame) {
  const candidates = [
    '[data-testid="more-button"]', '[data-testid="stepsMoreButton"]',
    '[data-testid="step-actions-more"]', '[aria-label="More options"]',
    '[aria-label="More"]', '[title="More options"]', '[title="More"]',
  ];

  for (const sel of candidates) {
    const btn = await frame.$(sel).catch(() => null);
    if (btn) { await btn.click(); console.log(`  Clicked "…" via: ${sel}`); return; }
  }

  // Fallback: scan all buttons
  const allButtons = await frame.$$('button');
  console.log(`  [diag] ${allButtons.length} button(s) in frame:`);
  for (const btn of allButtons) {
    const text  = (await btn.innerText().catch(() => null)) ?? '';
    const label = (await btn.getAttribute('aria-label').catch(() => null)) ?? '';
    const title = (await btn.getAttribute('title').catch(() => null)) ?? '';
    console.log(`    text="${text.trim()}" aria-label="${label}" title="${title}"`);
    if (
      text.trim() === '...' || text.trim() === '…' ||
      label.toLowerCase().includes('more') || title.toLowerCase().includes('more')
    ) {
      await btn.click();
      console.log(`  Clicked "…" via text/label: "${text.trim() || label || title}"`);
      return;
    }
  }

  throw new Error('Could not find the "…" more-options button. Check [diag] output above.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Click "To csv…"
// ─────────────────────────────────────────────────────────────────────────────

async function clickToCsv(frame) {
  await frame.waitForTimeout(600);

  const candidates = [
    'text="To csv..."', 'text="To csv…"', ':text("To csv")',
    '[data-testid="export-csv"]', 'li:has-text("To csv")',
    'button:has-text("To csv")', 'a:has-text("To csv")', 'span:has-text("To csv")',
  ];

  for (const sel of candidates) {
    const el = await frame.$(sel).catch(() => null);
    if (el) { await el.click(); console.log(`  Clicked "To csv" via: ${sel}`); return; }
  }

  throw new Error('Could not find the "To csv…" menu item. Dropdown may not have opened.');
}

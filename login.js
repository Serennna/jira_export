/**
 * One-time login setup.
 *
 * Opens the Jira login page in a visible Chrome window and waits for you to
 * complete the Google SSO / Atlassian login interactively.  Once logged in,
 * the session cookies are saved to .auth/session.json so that subsequent
 * export runs can work headlessly without re-logging in.
 *
 * Usage:
 *   node login.js
 *
 * Run this once.  The saved session typically stays valid for days or weeks.
 * Re-run if exports start returning "not logged in" errors.
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import path from 'path';

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
if (!JIRA_BASE_URL) {
  console.error('Error: JIRA_BASE_URL not set. Check your .env file.');
  process.exit(1);
}

const AUTH_FILE = '.auth/session.json';
mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

// ── Check if we can connect to a running Chrome via CDP ───────────────────────
async function tryGetCDPBrowser() {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    return browser;
  } catch {
    return null;
  }
}

// ── Wait for the user to be logged in to Jira ─────────────────────────────────
async function waitForJiraLogin(page, maxWaitMs = 180_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.startsWith(JIRA_BASE_URL) && !url.includes('/login')) {
      return true;
    }
    await page.waitForTimeout(2_000);
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n── Jira Login Setup ─────────────────────────────────────────────');
console.log('A browser window will open. Please log in to Jira using Google SSO.');
console.log('Once you are on the Jira board, this script will save your session.\n');

// Prefer CDP if Chrome is already running with debug port
let cdpBrowser = await tryGetCDPBrowser();
let context, page, ownBrowser;

if (cdpBrowser) {
  console.log('Connected to running Chrome (port 9222).');
  context  = cdpBrowser.contexts()[0];
  page     = await context.newPage();
  ownBrowser = false;
} else {
  // Launch a fresh Chromium (Playwright bundled) in headed mode
  console.log('Launching browser for login…');
  ownBrowser = await chromium.launch({ headless: false });
  context    = await ownBrowser.newContext();
  page       = await context.newPage();
}

// Navigate to Jira
console.log(`Opening ${JIRA_BASE_URL}…\n`);
await page.goto(JIRA_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

const alreadyLoggedIn = page.url().startsWith(JIRA_BASE_URL) && !page.url().includes('/login');

if (alreadyLoggedIn) {
  console.log('Already logged in!');
} else {
  console.log('Please complete the Google SSO login in the browser window.');
  console.log('(Waiting up to 3 minutes…)\n');

  const ok = await waitForJiraLogin(page);
  if (!ok) {
    console.error('Login timed out after 3 minutes. Please try again.');
    if (ownBrowser) await ownBrowser.close();
    else if (cdpBrowser) { await page.close(); await cdpBrowser.close(); }
    process.exit(1);
  }

  console.log('Logged in! Saving session…');
}

// Save session cookies
await context.storageState({ path: AUTH_FILE });
console.log(`\nSession saved → ${AUTH_FILE}`);
console.log('\nYou can now run the export without logging in again:');
console.log('  node export-full.js ACANDMAU-1538');
console.log('  node export-full.js --project ACANDMAU --type Test\n');

if (ownBrowser) {
  await ownBrowser.close();
} else if (cdpBrowser) {
  await page.close();
  await cdpBrowser.close();
}

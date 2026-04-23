/**
 * One-time authentication setup for Google SSO / Atlassian Cloud.
 *
 * Run this ONCE to save your browser session:
 *   node setup-auth.js
 *
 * IMPORTANT: Close Google Chrome before running this script.
 * The script opens Chrome using your existing profile (already logged in to
 * Google), so the SSO flow completes without you having to type a password.
 *
 * After the session is saved to .auth/session.json, export-steps-ui.js will
 * reuse it automatically until it expires.
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { AUTH_FILE } from './src/playwright/auth.js';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
if (!JIRA_BASE_URL) {
  console.error('Error: JIRA_BASE_URL not set in .env');
  process.exit(1);
}

mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

// ── Locate the Chrome profile directory ───────────────────────────────────────
// macOS default Chrome profile
const CHROME_PROFILE_DIR = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome'
);

if (!existsSync(CHROME_PROFILE_DIR)) {
  console.error(`Chrome profile not found at: ${CHROME_PROFILE_DIR}`);
  console.error('Please install Google Chrome and try again.');
  process.exit(1);
}

console.log('\n── Jira SSO Authentication Setup ──────────────────────────────');
console.log('Using your existing Chrome profile (already logged in to Google).');

// ── Check Chrome is not running ────────────────────────────────────────────
function isChromeRunning() {
  try {
    const result = execSync('pgrep -x "Google Chrome"', { encoding: 'utf8' }).trim();
    return result.length > 0;
  } catch {
    return false; // pgrep returns exit code 1 if no match
  }
}

if (isChromeRunning()) {
  console.log('\n  Chrome is currently running.');
  console.log('  Please quit Chrome completely: Chrome menu → Quit Google Chrome (Cmd+Q)');
  console.log('  Then press Enter here to continue…');
  await new Promise((resolve) => process.stdin.once('data', resolve));

  if (isChromeRunning()) {
    console.error('Chrome is still running. Please quit it and try again.');
    process.exit(1);
  }
} else {
  console.log('\nChrome is not running. Press Enter to open it…');
  await new Promise((resolve) => process.stdin.once('data', resolve));
}
process.stdin.destroy();

// Remove stale SingletonLock if it exists (can linger after a crash)
const singletonLock = path.join(CHROME_PROFILE_DIR, 'SingletonLock');
if (existsSync(singletonLock)) {
  unlinkSync(singletonLock);
  console.log('  Removed stale SingletonLock.');
}

console.log('\nOpening Chrome with your profile…');

// ── Launch Chrome with the existing user profile ───────────────────────────
// Using launchPersistentContext so Chrome loads with your existing cookies/session.
// channel: 'chrome' ensures we use the real installed Chrome binary (not
// Playwright's Chromium), which avoids Google's bot detection.
const context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
  channel:  'chrome',
  headless: false,
  args: [
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const page = context.pages()[0] ?? await context.newPage();

// Navigate to Jira
console.log(`Navigating to ${JIRA_BASE_URL}…`);
await page.goto(JIRA_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

// If already logged in (profile has valid Atlassian session) → the Jira nav
// will appear immediately.  If not, the browser will handle Google SSO
// automatically (since Chrome knows your Google account).
console.log('Waiting for Jira to load (up to 3 minutes)…\n');

// Listen across ALL pages in the context (Google OAuth may open a popup)
let resolved = false;
const waitForJira = (p) =>
  p.waitForSelector('[data-testid="atlassian-navigation"]', { timeout: 180_000 })
    .then(() => { if (!resolved) { resolved = true; return p; } })
    .catch(() => null);

// Also watch any popup pages that open during OAuth
context.on('page', (newPage) => {
  console.log(`  [popup] ${newPage.url() || '(loading...)'}`);
  waitForJira(newPage);
});

const loggedInPage = await waitForJira(page);

if (!loggedInPage) {
  console.error('Could not confirm Jira login within 3 minutes.');
  await context.close();
  process.exit(1);
}

// Give post-login redirects a moment to settle
await loggedInPage.waitForTimeout(2_000);

// Save session cookies
await context.storageState({ path: AUTH_FILE });
console.log(`\nSession saved → ${AUTH_FILE}`);
console.log('You can now close Chrome and run:\n');
console.log('  node export-steps-ui.js ACIOSMAU-88\n');

await context.close();

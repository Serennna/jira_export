import { existsSync, mkdirSync } from 'fs';
import path from 'path';

export const AUTH_FILE = '.auth/session.json';

/**
 * Perform Atlassian Cloud login and save the session to disk.
 *
 * Atlassian login is a two-step flow:
 *   Step 1 — enter email  → click Continue
 *   Step 2 — enter password → click Log in
 *
 * Some orgs redirect to SSO at step 2; in that case the script will
 * pause in headed mode so the user can complete SSO manually.
 *
 * @param {import('playwright').Page} page
 * @param {string} email
 * @param {string} password
 */
export async function login(page, email, password) {
  console.log('  Logging in to Atlassian…');

  // ── Step 1: email ──────────────────────────────────────────────────────────
  await page.waitForSelector('#username', { timeout: 15_000 });
  await page.fill('#username', email);
  await page.click('#login-submit');

  // ── Step 2: password (or SSO redirect) ────────────────────────────────────
  try {
    await page.waitForSelector('#password', { timeout: 10_000 });
    await page.fill('#password', password);
    await page.click('#login-submit');
  } catch {
    // Likely redirected to corporate SSO — wait up to 60 s for user to complete
    console.warn('  SSO detected. Complete login in the browser window (60 s timeout)…');
    await page.waitForURL(/atlassian\.net/, { timeout: 60_000 });
  }

  // Wait until we land on a Jira page
  await page.waitForURL(/atlassian\.net/, { timeout: 30_000 });
  console.log('  Login successful.');
}

/**
 * Save the current browser context's cookies + storage to AUTH_FILE
 * so subsequent runs can skip the login step.
 *
 * @param {import('playwright').BrowserContext} context
 */
export async function saveSession(context) {
  mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  console.log(`  Session saved → ${AUTH_FILE}`);
}

/**
 * Returns true if a saved session file exists on disk.
 * @returns {boolean}
 */
export function sessionExists() {
  return existsSync(AUTH_FILE);
}

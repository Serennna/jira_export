/**
 * Capture the list of Test issue keys contained in a Jira/Xray Test Set.
 *
 * Works in the same two modes as captureSteps.js:
 *  1. Session mode  — headless Chromium with .auth/session.json (preferred)
 *  2. CDP mode      — connects to Chrome on port 9222
 *
 * When the Xray Connect iframe loads a Test Set page it calls its own API to
 * list the contained Tests.  This module intercepts those responses and
 * extracts the Jira issue keys ("ACIOSMAU-100", etc.).
 *
 * If Xray only returns numeric issue IDs, the caller should resolve them to
 * keys via the Jira REST API.
 */

import { chromium }  from 'playwright';
import { existsSync } from 'fs';

const CDP_URL   = 'http://127.0.0.1:9222';
const AUTH_FILE = '.auth/session.json';

const XRAY_URL_PATTERNS = [/getxray\.app/i, /xpandit/i, /xray/i];

/**
 * Capture the Test keys contained in a Xray Test Set.
 *
 * @param {object} opts
 * @param {string} opts.jiraBaseUrl  e.g. "https://leadtech.atlassian.net"
 * @param {string} opts.issueKey     Test Set key, e.g. "ACIOSMAU-1827"
 * @param {number} [opts.waitMs=8000]
 * @returns {Promise<{ keys: string[], rawIds: string[] }>}
 *   keys    — resolved Jira keys (e.g. ["ACIOSMAU-100", …])
 *   rawIds  — any numeric IDs found that the caller may need to resolve
 */
export async function captureTestSetTests({
  jiraBaseUrl,
  issueKey,
  waitMs = 8_000,
}) {
  const keys     = new Set();
  const rawIds   = new Set();
  const seen     = new Set();
  const debugLog = [];

  const useSession = existsSync(AUTH_FILE);
  const useCDP     = await checkCDP();

  if (!useSession && !useCDP) {
    throw new Error(
      'Not logged in to Jira.\n'
      + 'Run "node login.js" once to save your session, then try again.',
    );
  }

  let browser, context, page;

  if (useSession) {
    console.log('  Using saved session (.auth/session.json)…');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ storageState: AUTH_FILE });
    page    = await context.newPage();
  } else {
    console.log(`  Connecting to Chrome at ${CDP_URL}…`);
    browser = await chromium.connectOverCDP(CDP_URL);
    context = browser.contexts()[0];
    if (!context) throw new Error('No browser context found in Chrome.');
    page = await context.newPage();
  }

  // ── Intercept all Xray network responses ──────────────────────────────────
  page.on('response', async (response) => {
    const url = response.url();
    if (!XRAY_URL_PATTERNS.some((p) => p.test(url))) return;

    try {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;

      const text = await response.text().catch(() => null);
      if (!text || seen.has(text)) return;
      seen.add(text);

      debugLog.push({ url, preview: text.slice(0, 300) });

      const json = JSON.parse(text);
      const { keys: parsedKeys, ids: parsedIds } = parseTestKeys(json);

      for (const k of parsedKeys) keys.add(k);
      for (const id of parsedIds) rawIds.add(id);

      if (parsedKeys.length > 0 || parsedIds.length > 0) {
        console.log(
          `  Found ${parsedKeys.length} key(s)` +
          (parsedIds.length ? ` + ${parsedIds.length} unresolved ID(s)` : '') +
          ` in Xray response`,
        );
      }
    } catch {
      // Non-JSON — ignore
    }
  });

  try {
    const ticketUrl = `${jiraBaseUrl}/browse/${issueKey}`;
    console.log(`  Navigating to ${ticketUrl}…`);
    await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });

    // Verify login
    await page.waitForTimeout(2_000);
    const currentUrl = page.url();
    if (!currentUrl.startsWith(jiraBaseUrl)) {
      throw new Error(
        `Not logged in — redirected to ${currentUrl.slice(0, 80)}\n`
        + 'Run "node login.js" to refresh your session.',
      );
    }

    console.log('  Waiting for Xray panel…');
    await page.waitForLoadState('networkidle', { timeout: 35_000 }).catch(() => {
      console.log('  (networkidle timeout — continuing)');
    });
    await page.waitForTimeout(waitMs);

    // Scroll to reveal lazy-loaded panels
    if (keys.size === 0 && rawIds.size === 0) {
      console.log('  Scrolling to reveal Xray panel…');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      // The Xray iframe can take 20-30 s to fire its API requests after scroll
      await page.waitForTimeout(25_000);
    }

    // Drain: give in-flight async response.text() calls time to complete
    // before page.close() destroys the context
    await page.waitForTimeout(3_000);

    if (keys.size === 0 && rawIds.size === 0) {
      console.warn(`  ⚠ No tests found in Test Set ${issueKey}`);
      if (debugLog.length > 0) {
        console.warn('  Xray-related responses seen:');
        for (const d of debugLog) {
          console.warn(`    ${d.url}`);
          console.warn(`      ${d.preview}`);
        }
      } else {
        console.warn('  No Xray network requests detected.');
        console.warn('  Ensure the Xray test-list panel is visible on the page.');
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }

  return { keys: [...keys], rawIds: [...rawIds] };
}

// ── CDP availability check ────────────────────────────────────────────────────

async function checkCDP() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Response parsers for the various Xray Cloud formats ───────────────────────

/**
 * @param {unknown} json
 * @returns {{ keys: string[], ids: string[] }}
 */
function parseTestKeys(json) {
  const keys = [];
  const ids  = [];

  // ── Format A: GraphQL getTestSet ────────────────────────────────────────────
  // { data: { getTestSet: { tests: { results: [{ issueId, jira: { key } }] } } } }
  const gqlSet = json?.data?.getTestSet?.tests?.results;
  if (Array.isArray(gqlSet) && gqlSet.length > 0) {
    for (const t of gqlSet) extractFromItem(t, keys, ids);
    if (keys.length > 0 || ids.length > 0) return { keys, ids };
  }

  // ── Format B: { tests: [...] } ───────────────────────────────────────────────
  if (Array.isArray(json?.tests) && json.tests.length > 0) {
    for (const t of json.tests) extractFromItem(t, keys, ids);
    if (keys.length > 0 || ids.length > 0) return { keys, ids };
  }

  // ── Format C: { results: [...] } ────────────────────────────────────────────
  if (Array.isArray(json?.results) && json.results.length > 0) {
    for (const t of json.results) extractFromItem(t, keys, ids);
    if (keys.length > 0 || ids.length > 0) return { keys, ids };
  }

  // ── Format D: top-level array ────────────────────────────────────────────────
  if (Array.isArray(json) && json.length > 0) {
    for (const t of json) extractFromItem(t, keys, ids);
    if (keys.length > 0 || ids.length > 0) return { keys, ids };
  }

  // ── Format E: { items: [...] } ───────────────────────────────────────────────
  if (Array.isArray(json?.items) && json.items.length > 0) {
    for (const t of json.items) extractFromItem(t, keys, ids);
  }

  return { keys, ids };
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

function extractFromItem(obj, keys, ids) {
  if (!obj || typeof obj !== 'object') return;

  // Prefer explicit key fields
  for (const field of ['key', 'issueKey', 'testKey']) {
    const v = obj[field];
    if (v && KEY_RE.test(v)) { keys.push(v); return; }
  }

  // Nested jira.key
  const jiraKey = obj.jira?.key ?? obj.jira?.issueKey;
  if (jiraKey && KEY_RE.test(jiraKey)) { keys.push(jiraKey); return; }

  // Fallback: numeric issueId (caller resolves via Jira REST)
  const numId = obj.issueId ?? obj.id;
  if (numId && /^\d+$/.test(String(numId))) {
    ids.push(String(numId));
  }
}

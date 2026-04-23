/**
 * Capture Xray test steps via browser network interception.
 *
 * Two modes (auto-detected):
 *
 *  1. Session mode  — uses .auth/session.json (preferred, no Chrome needed).
 *     Run "node login.js" once to create the session file, then exports
 *     work headlessly without any manual steps.
 *
 *  2. CDP mode      — connects to an already-running Chrome on port 9222.
 *     Requires:  sh start-chrome-debug.sh  + manual Jira login.
 *
 * Xray stores test steps in its own Cloud database — NOT in Jira custom
 * fields.  This module intercepts the network requests that the Xray Connect
 * app iframe makes to Xray Cloud and parses the step data from the responses.
 */

import { chromium }  from 'playwright';
import { existsSync } from 'fs';

const CDP_URL   = 'http://127.0.0.1:9222';
const AUTH_FILE = '.auth/session.json';

// Patterns that identify Xray Cloud API responses
const XRAY_URL_PATTERNS = [/getxray\.app/i, /xpandit/i, /xray/i];

/**
 * Capture Xray test steps for a single Jira issue.
 *
 * @param {object}  opts
 * @param {string}  opts.jiraBaseUrl   e.g. "https://leadtech.atlassian.net"
 * @param {string}  opts.issueKey      e.g. "ACANDMAU-1538"
 * @param {number}  [opts.waitMs=8000] extra ms to wait after networkidle
 * @returns {Array<{stepIndex,testKey,testSummary,testType,action,data,result}>}
 */
export async function captureXraySteps({
  jiraBaseUrl,
  issueKey,
  waitMs = 8_000,
}) {
  const steps       = [];
  const seenKeys    = new Set();
  const debugLog    = [];

  // ── Choose mode ────────────────────────────────────────────────────────────
  const useSession = existsSync(AUTH_FILE);
  const useCDP     = await checkCDP();

  if (!useSession && !useCDP) {
    throw new Error(
      'Not logged in to Jira.\n'
      + 'Run "node login.js" once to save your session, then try again.\n'
      + '(Alternatively: sh start-chrome-debug.sh, log in to Jira, then retry.)',
    );
  }

  let browser, context, page;

  if (useSession) {
    // ── Session mode: launch headless Chromium with saved storage state ──────
    console.log('  Using saved session (.auth/session.json)…');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      storageState: AUTH_FILE,
    });
    page = await context.newPage();
  } else {
    // ── CDP mode: connect to running Chrome ───────────────────────────────────
    console.log(`  Connecting to Chrome at ${CDP_URL}…`);
    browser = await chromium.connectOverCDP(CDP_URL);
    context = browser.contexts()[0];
    if (!context) throw new Error('No browser context found in Chrome.');
    page = await context.newPage();
  }

  // ── Attach response listener ───────────────────────────────────────────────
  page.on('response', async (response) => {
    const url = response.url();
    if (!XRAY_URL_PATTERNS.some((p) => p.test(url))) return;

    try {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;

      const text = await response.text().catch(() => null);
      if (!text) return;

      debugLog.push({ url, preview: text.slice(0, 150) });

      const json   = JSON.parse(text);
      const parsed = parseSteps(json, issueKey);

      // Filter out completely empty steps
      const nonEmpty = parsed.filter(
        (s) => s.action.trim() || s.data.trim() || s.result.trim(),
      );
      if (nonEmpty.length === 0) return;

      // Deduplicate by content fingerprint
      const dedupKey = nonEmpty.map((s) => `${s.action}|${s.data}|${s.result}`).join('§');
      if (seenKeys.has(dedupKey)) return;
      seenKeys.add(dedupKey);

      // Re-index steps sequentially starting from 1
      const offset = steps.length;
      nonEmpty.forEach((s, i) => { s.stepIndex = offset + i + 1; });

      console.log(`  ✓ Captured ${nonEmpty.length} step(s) from Xray`);
      steps.push(...nonEmpty);
    } catch {
      // Non-JSON or unexpected — ignore
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

    // Wait for the Xray iframe to fully load
    console.log('  Waiting for Xray panel…');
    await page.waitForLoadState('networkidle', { timeout: 35_000 }).catch(() => {
      console.log('  (networkidle timeout — continuing)');
    });
    await page.waitForTimeout(waitMs);

    // Scroll to trigger lazy-loaded panels
    if (steps.length === 0) {
      console.log('  Scrolling to reveal Xray panel…');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(5_000);
    }

    if (steps.length === 0) {
      console.warn('  ⚠ No Xray steps captured via network interception.');
      if (debugLog.length > 0) {
        console.warn('  Xray-related responses seen:');
        for (const d of debugLog) console.warn(`    ${d.url}\n      ${d.preview}`);
      } else {
        console.warn('  No Xray network requests detected.');
        console.warn('  Ensure the Xray test-steps panel is visible on the page.');
      }
    }

  } finally {
    await page.close();
    if (useSession) {
      await browser.close();
    } else {
      await browser.close(); // disconnect from CDP (doesn't quit Chrome)
    }
  }

  return steps;
}

// ── CDP availability check ─────────────────────────────────────────────────

async function checkCDP() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step parsers for the various Xray Cloud response formats
// ─────────────────────────────────────────────────────────────────────────────

function parseSteps(json, issueKey) {
  // ── Format A: Xray Cloud GraphQL ──────────────────────────────────────────
  // POST /api/v2/graphql  → { data: { getTests: { results: [{ steps: [...] }] } } }
  const gqlResults = json?.data?.getTests?.results;
  if (Array.isArray(gqlResults)) {
    for (const test of gqlResults) {
      if (Array.isArray(test?.steps) && test.steps.length > 0) {
        return test.steps.map((s, i) => ({
          stepIndex:   i + 1,
          testKey:     issueKey,
          testSummary: '',
          testType:    test.testType?.name ?? 'Manual',
          action:      adfToText(s.action),
          data:        adfToText(s.data),
          result:      adfToText(s.result),
        }));
      }
    }
  }

  // ── Format B: Xray REST array  ────────────────────────────────────────────
  // GET /api/v2/test/{key}/steps  → [ { id, index, action, data, result }, … ]
  if (Array.isArray(json) && json.length > 0 && json[0] !== null
      && (json[0].action !== undefined || json[0].id !== undefined)) {
    return json.map((s, i) => ({
      stepIndex:   s.index ?? i + 1,
      testKey:     issueKey,
      testSummary: '',
      testType:    'Manual',
      action:      adfToText(s.action),
      data:        adfToText(s.data),
      result:      adfToText(s.result),
    }));
  }

  // ── Format C: Xray REST wrapper  ──────────────────────────────────────────
  // { steps: [...], total: N }
  if (Array.isArray(json?.steps) && json.steps.length > 0) {
    return json.steps.map((s, i) => ({
      stepIndex:   s.index ?? i + 1,
      testKey:     issueKey,
      testSummary: '',
      testType:    'Manual',
      action:      adfToText(s.action),
      data:        adfToText(s.data),
      result:      adfToText(s.result),
    }));
  }

  // ── Format D: Xray Connect app internal  ──────────────────────────────────
  // { testScript: { steps: [...], type: "Manual" } }
  if (Array.isArray(json?.testScript?.steps) && json.testScript.steps.length > 0) {
    return json.testScript.steps.map((s, i) => ({
      stepIndex:   s.index ?? i + 1,
      testKey:     issueKey,
      testSummary: '',
      testType:    json.testScript?.type ?? 'Manual',
      action:      adfToText(s.action),
      data:        adfToText(s.data),
      result:      adfToText(s.result),
    }));
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Atlassian Document Format → plain text
// ─────────────────────────────────────────────────────────────────────────────

function adfToText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();

  const walk = (node) => {
    if (!node) return '';
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'paragraph') {
      return (node.content ?? []).map(walk).join('') + '\n';
    }
    if (node.type === 'listItem') {
      return '- ' + (node.content ?? []).map(walk).join('').trim() + '\n';
    }
    if (node.type === 'orderedList' || node.type === 'bulletList') {
      return (node.content ?? []).map(walk).join('');
    }
    if (node.type === 'heading') {
      return '#'.repeat(node.attrs?.level ?? 1) + ' '
        + (node.content ?? []).map(walk).join('') + '\n';
    }
    if (node.content) return (node.content ?? []).map(walk).join('');
    return '';
  };

  return walk(value).trim();
}

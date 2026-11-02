import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

export const SESSION_FILE = '.auth/import-session.json';

// Only Jira / Atlassian / Xray (Forge CDN) cookies are kept — never the rest of the Chrome profile
const KEEP_DOMAIN = /(^|\.)(atlassian\.net|atlassian\.com|atlassian-dev\.net|getxray\.app)$/;

function filterState(state) {
  return {
    cookies: state.cookies.filter((c) => KEEP_DOMAIN.test(c.domain.replace(/^\./, ''))),
    origins: state.origins.filter((o) => KEEP_DOMAIN.test(new URL(o.origin).hostname)),
  };
}

function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(session) {
  mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

async function exportFromChrome(cdpUrl) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch {
    throw new Error(
      `Saved session is missing or expired, and Chrome is not reachable on ${cdpUrl}.\n` +
      '  Run: sh start-chrome-debug.sh, log in to Jira, then retry.'
    );
  }
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No browser context in Chrome.');
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
    const session = { userAgent, state: filterState(await ctx.storageState()) };
    saveSession(session);
    console.log(`  Session exported from Chrome → ${SESSION_FILE} (${session.state.cookies.length} cookies)`);
    return session;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function launch(session) {
  // Prefer the installed Google Chrome so no Playwright browser download is needed
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
    .catch(() => chromium.launch({ headless: true }));
  const context = await browser.newContext({
    storageState: session.state,
    userAgent:    session.userAgent,
    viewport:     { width: 1440, height: 900 },
  });
  return { browser, context };
}

async function isLoggedIn(context, baseUrl) {
  const res = await context.request.get(`${baseUrl}/rest/api/3/myself`).catch(() => null);
  return !!res?.ok();
}

/**
 * Launch a headless Chromium logged in to Jira.
 * Session cookies come from SESSION_FILE; when it is missing or expired they are
 * re-exported from the debug Chrome on cdpUrl. Call persist() regularly so cookies
 * Jira refreshes during the run are written back to SESSION_FILE.
 */
export async function openHeadlessSession({ baseUrl, cdpUrl }) {
  let session = loadSession();
  if (!session) {
    console.log('  No saved session, exporting from Chrome…');
    session = await exportFromChrome(cdpUrl);
  }

  let { browser, context } = await launch(session);

  if (!(await isLoggedIn(context, baseUrl))) {
    await browser.close();
    console.log('  Saved session expired, re-exporting from Chrome…');
    session = await exportFromChrome(cdpUrl);
    ({ browser, context } = await launch(session));
    if (!(await isLoggedIn(context, baseUrl))) {
      await browser.close();
      throw new Error('Chrome is not logged in to Jira either — log in there and retry.');
    }
  }

  console.log('✓ Headless browser logged in to Jira');

  const persist = async () => {
    const state = await context.storageState().catch(() => null);
    if (state) saveSession({ userAgent: session.userAgent, state: filterState(state) });
  };

  return { browser, context, persist };
}

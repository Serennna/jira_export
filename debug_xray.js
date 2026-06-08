/**
 * Diagnostic v2: intercept the EXACT network request made when
 * "Add Step" is clicked in Xray Connect.
 *
 * Usage:
 *   node debug_xray.js TTIOSMAU-XXXX
 *
 * The script will:
 *   1. Navigate to the issue
 *   2. Find the Xray frame
 *   3. Click "Add Step", fill dummy text, click Save
 *   4. Print the exact POST request (URL + headers + body) Xray sent
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const issueKey = process.argv[2];
if (!issueKey) { console.error('Usage: node debug_xray.js <ISSUE-KEY>'); process.exit(1); }

const { JIRA_BASE_URL } = process.env;
const CDP_URL = 'http://127.0.0.1:9222';
mkdirSync('./output', { recursive: true });

console.log('Connecting to Chrome…');
const browser  = await chromium.connectOverCDP(CDP_URL);
const context  = browser.contexts()[0];
const page     = await context.newPage();

// ── Capture ALL Xray POST requests ──────────────────────────────────────────
const captured = [];
page.on('request', async (req) => {
  const url = req.url();
  if (!/xray|xpandit|getxray/i.test(url)) return;
  if (req.method() !== 'POST' && req.method() !== 'PUT' && req.method() !== 'PATCH') return;
  let body = '';
  try { body = req.postData() ?? ''; } catch {}
  captured.push({
    method:  req.method(),
    url,
    headers: req.headers(),
    body,
  });
});
page.on('response', async (res) => {
  const url = res.url();
  if (!/xray|xpandit|getxray/i.test(url)) return;
  if (!['POST','PUT','PATCH'].includes(res.request().method())) return;
  let body = '';
  try { body = await res.text(); } catch {}
  const found = captured.find(
    (c) => c.url === url && !c.responseStatus
  );
  if (found) { found.responseStatus = res.status(); found.responseBody = body.slice(0, 500); }
});

console.log(`Navigating to ${JIRA_BASE_URL}/browse/${issueKey}…`);
await page.goto(`${JIRA_BASE_URL}/browse/${issueKey}`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(4_000);

// ── Find Xray frame ──────────────────────────────────────────────────────────
let xrayFrame = page.frames().find(f => f.url().includes('xray.cloud.getxray.app/view/webpanel/test/all-in-one'));
if (!xrayFrame) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(6_000);
  xrayFrame = page.frames().find(f => f.url().includes('xray.cloud.getxray.app/view/webpanel/test/all-in-one'));
}
if (!xrayFrame) { console.error('Xray frame not found'); process.exit(1); }
console.log('✓ Xray frame found');

// ── Dump iframe URL params ───────────────────────────────────────────────────
const iframeUrl   = new URL(xrayFrame.url());
const issueId     = iframeUrl.searchParams.get('issueId');
const projectId   = iframeUrl.searchParams.get('projectId');
const jwtInUrl    = iframeUrl.searchParams.get('jwt');
console.log(`issueId:   ${issueId}`);
console.log(`projectId: ${projectId}`);
console.log(`jwt (first 40): ${jwtInUrl?.slice(0, 40)}…`);

// ── Try AP.context.getToken() ───────────────────────────────────────────────
console.log('\nTrying AP.context.getToken()…');
const apToken = await xrayFrame.evaluate(() =>
  new Promise((resolve) => {
    if (typeof AP !== 'undefined' && AP?.context?.getToken) {
      AP.context.getToken((t) => resolve(t));
      setTimeout(() => resolve(null), 5000);
    } else {
      resolve(null);
    }
  })
).catch(() => null);
console.log(apToken ? `AP token (first 40): ${apToken.slice(0, 40)}…` : 'AP.context.getToken not available');

// ── Click Add Step ───────────────────────────────────────────────────────────
console.log('\nClicking "Add Step"…');
const addBtn = xrayFrame.locator('button:has-text("Add Step")').first();
try {
  await addBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await addBtn.click();
  console.log('Clicked. Waiting 3 s for step editor…');
  await xrayFrame.waitForTimeout(3_000);
} catch (e) {
  console.warn('Could not click Add Step:', e.message);
}

// ── Dump all ProseMirror editors ─────────────────────────────────────────────
const editors = await xrayFrame.locator('.ProseMirror').all();
console.log(`\nProseMirror editors found: ${editors.length}`);
for (let i = 0; i < editors.length; i++) {
  const text = (await editors[i].innerText().catch(() => '')).trim().slice(0, 60);
  const box  = await editors[i].boundingBox().catch(() => null);
  console.log(`  [${i}] text="${text}" bbox=${JSON.stringify(box)}`);
}

// ── Fill first 3 editors ─────────────────────────────────────────────────────
if (editors.length >= 1) {
  console.log('\nFilling editors…');
  for (let i = 0; i < Math.min(editors.length, 3); i++) {
    try {
      await editors[i].click();
      await editors[i].fill(`__DEBUG_FIELD_${i}__`);
      console.log(`  filled editor[${i}]`);
    } catch (e) { console.warn(`  editor[${i}] fill failed: ${e.message}`); }
  }
}

// ── Click Save ────────────────────────────────────────────────────────────────
console.log('\nLooking for Save button…');
const allBtns = await xrayFrame.locator('button').all();
for (const btn of allBtns) {
  const txt = (await btn.innerText().catch(() => '')).trim();
  if (/^(save|ok|confirm|✓|check)$/i.test(txt) || (await btn.getAttribute('data-testid').catch(() => ''))?.includes('save')) {
    console.log(`  Clicking Save: "${txt}"`);
    await btn.click().catch(() => {});
    break;
  }
}
await xrayFrame.waitForTimeout(3_000);

// ── Print captured requests ──────────────────────────────────────────────────
console.log('\n── Captured Xray POST/PUT/PATCH requests ────────────────────────');
if (!captured.length) {
  console.log('  (none captured)');
} else {
  for (const r of captured) {
    console.log(`\n  ${r.method} ${r.url}`);
    const authHdr = r.headers['authorization'] ?? r.headers['Authorization'] ?? '(none)';
    console.log(`  Authorization: ${authHdr.slice(0, 80)}`);
    console.log(`  Body: ${r.body.slice(0, 300)}`);
    console.log(`  Response: ${r.responseStatus}  ${(r.responseBody ?? '').slice(0, 300)}`);
  }
}

// ── Screenshot ───────────────────────────────────────────────────────────────
const shot = `./output/${issueKey}_after_add_step.png`;
await page.screenshot({ path: shot, fullPage: true });
console.log(`\nScreenshot → ${shot}`);

await page.close();
await browser.close();
console.log('\nDone.\n');

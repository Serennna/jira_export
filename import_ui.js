/**
 * Jira/Xray Test Case Importer — Bypasses Xray API Key requirement
 *
 * Strategy
 * ────────
 * 1. Create Jira Test issue via Jira REST API (email + API token).
 * 2. Connect to your running Chrome via CDP (Playwright).
 * 3. Navigate to the new issue → wait for the Xray Connect iframe to load
 *    (eu.xray.cloud.getxray.app/view/webpanel/test/all-in-one).
 * 4. Call Xray's internal API **from within that iframe** using page.evaluate()
 *    → same-origin fetch, cookies are automatic, no Xray API keys needed.
 *    Endpoints used:
 *      POST /api/internal/tests/versions  → get testVersionId
 *      POST /api/internal/test/{issueId}/steps  → add each step
 * 5. Fall back to UI click automation if the API calls fail.
 *
 * Prerequisites
 * ─────────────
 *   sh start-chrome-debug.sh      # launch Chrome with CDP on port 9222
 *   Log in to Jira in that Chrome window
 *
 * Usage
 * ─────
 *   node import_ui.js <file.xlsx|file.csv> --project KEY [options]
 *
 *   --project KEY      Jira project key  (required)
 *   --dry-run          Parse input only, do not create issues/steps
 *   --delay N          ms between issues (default 1500)
 *   --test-set KEY     Add every created test to this Xray Test Set
 */

import 'dotenv/config';
import { chromium }    from 'playwright';
import { JiraClient }  from './src/jiraClient.js';
import ExcelJS         from 'exceljs';
import { existsSync, readFileSync } from 'fs';
import { parse as parseCsv } from 'csv-parse/sync';
import path from 'path';

// ── CLI ───────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const flag      = (n) => args.includes(n);
const opt       = (n, d = null) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };

const inputFile  = args.find((a) => !a.startsWith('--'));
const projectKey = opt('--project');
const dryRun     = flag('--dry-run');
const delay      = parseInt(opt('--delay', '1500'), 10);
const testSetKey = opt('--test-set');

if (!inputFile || !projectKey) {
  console.error([
    '',
    'Usage: node import_ui.js <file.xlsx|file.csv> --project KEY [options]',
    '  --project KEY   Jira project key (required)',
    '  --dry-run       Parse only, no issues/steps created',
    '  --delay N       ms between issues (default 1500)',
    '  --test-set KEY  Add tests to an existing Xray Test Set',
    '',
  ].join('\n'));
  process.exit(1);
}

if (!existsSync(inputFile)) { console.error(`File not found: ${inputFile}`); process.exit(1); }

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN in .env');
  process.exit(1);
}

const CDP_URL = 'http://127.0.0.1:9222';

// ── 1. Parse input file ───────────────────────────────────────────────────────

function norm(s) { return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

function cellStr(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v?.richText)) return v.richText.map((r) => r.text ?? '').join('').trim();
  if (v?.result != null) return String(v.result).trim();
  if (v?.text   != null) return String(v.text).trim();
  return String(v).trim();
}

async function parseInputFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let rows = [];

  if (ext === '.csv') {
    const raw = readFileSync(filePath, 'utf8');
    rows = parseCsv(raw, { columns: true, skip_empty_lines: true, trim: true })
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), String(v ?? '').trim()])));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    const headers = {};
    ws.getRow(1).eachCell((cell, col) => { headers[col] = norm(cellStr(cell)); });
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, col) => { if (headers[col]) obj[headers[col]] = cellStr(cell); });
      rows.push(obj);
    });
  }

  return buildTestCases(rows);
}

function buildTestCases(rows) {
  if (!rows.length) return [];
  const sample = rows[0];
  const keys   = Object.keys(sample);
  const col    = (...aliases) => aliases.find((a) => keys.includes(norm(a))) ?? aliases[0];

  const COL_SUMMARY = col('test summary', 'summary', 'title', 'name');
  const COL_ACTION  = col('action', 'step', 'step action', 'description');
  const COL_DATA    = col('test data', 'data', 'input');
  const COL_RESULT  = col('expected result', 'result', 'expected');

  const tests = [];
  let current = null;

  for (const row of rows) {
    const summary = (row[COL_SUMMARY] ?? '').trim();
    const action  = (row[COL_ACTION]  ?? '').trim();
    const data    = (row[COL_DATA]    ?? '').trim();
    const result  = (row[COL_RESULT]  ?? '').trim();
    if (!action && !data && !result) continue;
    if (summary) { current = { summary, steps: [] }; tests.push(current); }
    if (!current) { current = { summary: `Test ${tests.length + 1}`, steps: [] }; tests.push(current); }
    current.steps.push({ action, data, result });
  }
  return tests.filter((t) => t.steps.length > 0);
}

// ── 2. Connect to Chrome ──────────────────────────────────────────────────────

async function connectChrome() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx     = browser.contexts()[0];
    if (!ctx) throw new Error('No browser context in Chrome.');
    console.log('✓ Connected to Chrome via CDP');
    return { browser, context: ctx };
  } catch {
    console.error('\n✗ Cannot connect to Chrome on port 9222.\n  Run: sh start-chrome-debug.sh\n  Then log in to Jira.\n');
    process.exit(1);
  }
}

// ── 3. Find the Xray "all-in-one" iframe ─────────────────────────────────────

/**
 * Navigate to a Jira issue and return the Xray Connect "all-in-one" iframe.
 * Waits up to ~40 s for the frame to appear (new issues load slower).
 */
async function openIssueAndFindXrayFrame(context, issueKey) {
  const page = await context.newPage();

  await page.goto(`${JIRA_BASE_URL}/browse/${issueKey}`, {
    waitUntil: 'domcontentloaded',
    timeout: 40_000,
  });

  // Wait for networkidle so the iframe has time to appear
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3_000);

  const findFrame = () =>
    page.frames().find((f) =>
      f.url().includes('xray.cloud.getxray.app/view/webpanel/test/all-in-one')
    ) ?? null;

  let xrayFrame = findFrame();

  if (!xrayFrame) {
    // Scroll to trigger any lazy-loaded panels
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(8_000);
    xrayFrame = findFrame();
  }

  return { page, xrayFrame };
}

// ── 4a. Add steps via Xray internal API (same-origin iframe fetch) ────────────

/**
 * Execute fetch() calls from within the Xray iframe.
 * Because the call is same-origin (eu.xray.cloud.getxray.app), cookies are
 * sent automatically — no separate Xray credentials needed.
 */
async function addStepsViaInternalAPI(context, issueKey, issueId, steps) {
  console.log(`  Opening issue and waiting for Xray panel…`);
  const { page, xrayFrame } = await openIssueAndFindXrayFrame(context, issueKey);

  try {
    if (!xrayFrame) {
      const allFrames = page.frames().map((f) => f.url()).join('\n    ');
      throw new Error(
        `Xray panel iframe not found.\n  Frames on page:\n    ${allFrames}`
      );
    }

    console.log(`  ✓ Xray frame: ${xrayFrame.url().split('?')[0]}`);

    // Wait for the Xray panel to fully initialize — "Add Step" must be visible
    // before we make API calls (new issues need extra time to be indexed by Xray)
    console.log('  Waiting for Xray panel to initialize…');
    await xrayFrame
      .locator('button:has-text("Add Step")')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => console.log('  (Add Step button not visible yet — continuing)'));

    // --- Get x-acpt token (Atlassian Connect Plugin Token) ---
    // Xray's internal API authenticates via x-acpt + x-addon-key headers,
    // NOT via cookies or Authorization: Bearer.
    // AP.context.getToken() returns exactly this token.
    const acpt = await xrayFrame.evaluate(() =>
      new Promise((resolve) => {
        if (typeof AP !== 'undefined' && AP?.context?.getToken) {
          AP.context.getToken((t) => resolve(t ?? null));
          setTimeout(() => resolve(null), 5_000);
        } else {
          resolve(null);
        }
      })
    ).catch(() => null);

    if (acpt) {
      console.log(`  x-acpt token obtained`);
    } else {
      console.log(`  x-acpt token: not available`);
    }

    const xrayHeaders = {
      'Content-Type':  'application/json',
      'x-addon-key':   'com.xpandit.plugins.xray',
      ...(acpt ? { 'x-acpt': acpt } : {}),
    };

    // --- Get testVersionId ---
    // Body format: {"issueIds":["<id>"],"includeArchived":true,"includeTestType":true}
    // Response:    { "<id>": [{ testVersionId: "...", ... }] }
    const { testVersionId, versionsError } = await xrayFrame.evaluate(
      async ({ xrayIssueId, headers }) => {
        try {
          const res = await fetch('/api/internal/tests/versions', {
            method:  'POST',
            headers,
            body:    JSON.stringify({
              issueIds:        [xrayIssueId],
              includeArchived: true,
              includeTestType: true,
            }),
          });
          const text = await res.text();
          if (!res.ok) return { testVersionId: null, versionsError: `${res.status}: ${text.slice(0, 200)}` };
          const data = JSON.parse(text);
          const versions = data?.[xrayIssueId];
          const tvId = Array.isArray(versions) ? (versions[0]?.testVersionId ?? null) : null;
          return { testVersionId: tvId, versionsError: tvId ? null : `empty: ${text.slice(0, 150)}` };
        } catch (e) {
          return { testVersionId: null, versionsError: String(e) };
        }
      },
      { xrayIssueId: issueId, headers: xrayHeaders }
    );

    if (testVersionId) {
      console.log(`  testVersionId: ${testVersionId}`);
    } else {
      console.log(`  testVersionId: not obtained (${versionsError})`);
    }

    // --- Add each step ---
    let successCount = 0;

    for (let i = 0; i < steps.length; i++) {
      const step  = steps[i];
      const label = `step ${i + 1}/${steps.length}`;

      const result = await xrayFrame.evaluate(
        async ({ xrayIssueId, testVersionId, step, headers, index }) => {
          const body = {
            index,
            testVersionId: testVersionId ?? undefined,
            action: step.action || '',
            data:   step.data   || '',
            result: step.result || '',
          };

          const endpoints = [
            `/api/internal/test/${xrayIssueId}/steps`,
            `/api/internal/test/${xrayIssueId}/step`,
          ];

          for (const url of endpoints) {
            try {
              const res = await fetch(url, {
                method:  'POST',
                headers,
                body:    JSON.stringify(body),
              });

              if (res.ok) return { ok: true, url };
              if (res.status === 404) continue;

              const errText = await res.text().catch(() => '');
              return { ok: false, status: res.status, error: errText.slice(0, 300), url };
            } catch (err) {
              // network error — try next
            }
          }

          return { ok: false, error: 'All endpoints returned 404 or failed' };
        },
        { xrayIssueId: issueId, testVersionId, step, headers: xrayHeaders, index: i }
      );

      if (result?.ok) {
        console.log(`    ✓ ${label} added`);
        successCount++;
      } else {
        console.warn(`    ✗ ${label}: ${result?.error ?? JSON.stringify(result)}`);
      }
    }

    return successCount === steps.length;
  } finally {
    await page.close();
  }
}

// ── 4b. UI automation fallback ────────────────────────────────────────────────

async function addStepsViaUI(context, issueKey, steps) {
  console.log('  Falling back to UI automation…');
  const { page, xrayFrame } = await openIssueAndFindXrayFrame(context, issueKey);

  try {
    if (!xrayFrame) throw new Error('Xray panel not found for UI automation');

    // "Add Step" is a dropdown button. Clicking it reveals a menu with
    // [role="menuitem"] items: "New" | "Import Step" | "Call Test"
    // We always click "Add Step" then pick the "New" menuitem.
    const addStepBtn = xrayFrame.locator('button:has-text("Add Step")').first();
    await addStepBtn.waitFor({ state: 'visible', timeout: 15_000 });

    let successCount = 0;

    for (let i = 0; i < steps.length; i++) {
      const step  = steps[i];
      const label = `step ${i + 1}/${steps.length}`;

      try {
        // 1. Open the dropdown
        await addStepBtn.click();
        await xrayFrame.waitForTimeout(400);

        // 2. Click "New" menuitem (exact text match to avoid "Import Step" etc.)
        const newItem = xrayFrame.getByRole('menuitem', { name: 'New', exact: true });
        await newItem.waitFor({ state: 'visible', timeout: 3_000 });
        await newItem.click();

        // 3. Wait for the inline step editor to appear (3 ProseMirror editors)
        await xrayFrame.waitForTimeout(800);

        // 4. Fill Action / Data / Expected Result in order
        const editors = await xrayFrame.locator('.ProseMirror').all();

        const fillEditor = async (idx, value) => {
          if (!value || !editors[idx]) return;
          await editors[idx].click();
          await editors[idx].fill(value);
        };

        await fillEditor(0, step.action);
        await fillEditor(1, step.data);
        await fillEditor(2, step.result);

        // 5. Click "Create" (the save button in Xray Cloud's step editor)
        const createBtn = xrayFrame.getByRole('button', { name: 'Create', exact: true });
        await createBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await createBtn.click();
        await xrayFrame.waitForTimeout(1_500);

        console.log(`    ✓ ${label} added (UI)`);
        successCount++;
      } catch (err) {
        console.warn(`    ✗ ${label} UI failed: ${err.message}`);
      }
    }

    return successCount === steps.length;
  } finally {
    await page.close();
  }
}

// ── 5. Add test to a Test Set (optional) ─────────────────────────────────────

async function addTestToTestSet(context, testKey, testSetKey) {
  const page = await context.newPage();
  try {
    await page.goto(`${JIRA_BASE_URL}/browse/${testSetKey}`, {
      waitUntil: 'domcontentloaded',
      timeout: 40_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const { page: _p, xrayFrame } = await openIssueAndFindXrayFrame(context, testSetKey);

    if (xrayFrame) {
      const r = await xrayFrame.evaluate(
        async ({ baseUrl, testSetKey, testKey }) => {
          // Try Xray internal API first, then Raven REST
          const endpoints = [
            { url: `/api/internal/testset/${testSetKey}/tests`, body: { add: [testKey] } },
          ];
          for (const { url, body } of endpoints) {
            try {
              const res = await fetch(url, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              if (res.ok) return { ok: true };
            } catch {}
          }
          return { ok: false };
        },
        { baseUrl: JIRA_BASE_URL, testSetKey, testKey }
      );
      if (r?.ok) console.log(`  ✓ Added ${testKey} to Test Set ${testSetKey}`);
      else        console.warn(`  ⚠ Could not add ${testKey} to Test Set (check manually)`);
      await _p.close();
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n── Jira/Xray Test Importer ──────────────────────────────────────`);
  console.log(`Input:   ${inputFile}`);
  console.log(`Project: ${projectKey}`);
  if (dryRun)     console.log('Mode:    DRY RUN');
  if (testSetKey) console.log(`Test Set: ${testSetKey}`);
  console.log('');

  // Parse
  const tests = await parseInputFile(inputFile);
  if (!tests.length) { console.error('No test cases found.'); process.exit(1); }

  console.log(`Found ${tests.length} test case(s):`);
  for (const t of tests) console.log(`  • ${t.summary}  (${t.steps.length} steps)`);
  console.log('');

  if (dryRun) { console.log('[dry-run] Done.'); return; }

  // Jira REST client
  const jira = new JiraClient({ baseUrl: JIRA_BASE_URL, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN });

  // Connect Chrome
  const { browser, context } = await connectChrome();

  const results = [];

  for (let idx = 0; idx < tests.length; idx++) {
    const test = tests[idx];
    console.log(`\n[${idx + 1}/${tests.length}] ${test.summary}`);

    // 1. Create Jira issue
    let issueKey, issueId;
    try {
      const created = await jira.createIssue({
        project:   { key: projectKey },
        issuetype: { name: 'Test' },
        summary:   test.summary,
      });
      issueKey = created.key;
      issueId  = created.id;
      console.log(`  ✓ Created: ${issueKey}  (id: ${issueId})`);
    } catch (err) {
      const msg = err.response?.data?.errorMessages?.join(', ') ?? err.message;
      console.error(`  ✗ Jira issue creation failed: ${msg}`);
      results.push({ summary: test.summary, issueKey: null, status: 'JIRA_FAILED' });
      continue;
    }

    if (!test.steps.length) {
      results.push({ summary: test.summary, issueKey, status: 'OK_NO_STEPS' });
      continue;
    }

    // 2. Add steps — internal API first, UI fallback
    let stepsOk = await addStepsViaInternalAPI(context, issueKey, issueId, test.steps);

    if (!stepsOk) {
      stepsOk = await addStepsViaUI(context, issueKey, test.steps);
    }

    results.push({
      summary: test.summary,
      issueKey,
      status: stepsOk ? 'OK' : 'STEPS_PARTIAL',
    });

    // 3. Add to Test Set
    if (testSetKey) await addTestToTestSet(context, issueKey, testSetKey);

    if (idx < tests.length - 1) await sleep(delay);
  }

  // Summary
  console.log('\n── Results ──────────────────────────────────────────────────────');
  for (const r of results) {
    const icon = r.status === 'OK' || r.status === 'OK_NO_STEPS' ? '✓' : r.status === 'STEPS_PARTIAL' ? '⚠' : '✗';
    const note = r.status === 'STEPS_PARTIAL' ? '  ← steps incomplete' : '';
    if (r.issueKey) console.log(`  ${icon} ${r.issueKey}  ${r.summary}${note}`);
    else            console.log(`  ✗ (failed)  ${r.summary}`);
  }

  const ok      = results.filter((r) => ['OK','OK_NO_STEPS'].includes(r.status)).length;
  const partial = results.filter((r) => r.status === 'STEPS_PARTIAL').length;
  const failed  = results.filter((r) => r.status === 'JIRA_FAILED').length;
  console.log(`\nTotal: ${ok} ok / ${partial} partial / ${failed} failed`);

  await browser.close();
  console.log('Done.\n');
}

main().catch((err) => { console.error('\nFatal:', err.message); process.exit(1); });

/**
 * Jira/Xray Test Case Importer — Two-Phase Approach
 *
 * Phase 1: Create all Jira Test issues via REST API
 * Phase 2: After waiting for Xray indexing, add steps to each issue
 *
 * Usage
 * ─────
 *   node import_ui.js <file.xlsx|file.csv> --project KEY [options]
 *   node import_ui.js --resume --wait 0 
 *
 *   --project KEY      Jira project key  (required)
 *   --dry-run          Parse input only, do not create issues/stepssh
 *   --delay N          ms between issues in phase 2 (default 1500)
 *   --test-set KEY     Add every created test to this Xray Test Set
 *   --wait N           seconds to wait between phase 1 and 2 (default 120)
 *   --resume           Skip phase 1, read from created_issues.json
 *   --fix-version A,B  Fix versions (must already exist in the project)
 *   --component A,B    Components (must already exist in the project)
 *   --labels A,B       Labels (no spaces)
 *                      With --resume these are added to the existing issues
 *   --headless         Add steps in a background Chromium using saved cookies
 *                      (.auth/import-session.json, exported from the debug Chrome when missing/expired)
 *   --config FILE      Defaults for project / testSet / fixVersions / components / labels / headless
 *                      (default import.config.json if present; CLI flags override it)
 */

import 'dotenv/config';
import { chromium }    from 'playwright';
import { JiraClient }  from './src/jiraClient.js';
import { openHeadlessSession } from './src/playwright/headlessSession.js';
import ExcelJS         from 'exceljs';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { parse as parseCsv } from 'csv-parse/sync';
import path from 'path';

// ── CLI ───────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const flag      = (n) => args.includes(n);
const opt       = (n, d = null) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };

const BOOLEAN_FLAGS = ['--dry-run', '--resume', '--headless'];
const inputFile  = args.find((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !BOOLEAN_FLAGS.includes(args[i - 1]))
);

const configFile = opt('--config', 'import.config.json');
if (flag('--config') && !existsSync(configFile)) {
  console.error(`Config file not found: ${configFile}`);
  process.exit(1);
}
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};

const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);
const list = (n, fallback) => (flag(n) ? toList(opt(n)) : toList(fallback));

const projectKey = opt('--project', config.project ?? null);
const dryRun     = flag('--dry-run');
const delay      = parseInt(opt('--delay', '1500'), 10);
const testSetKey = opt('--test-set', config.testSet ?? null);
const waitSec    = parseInt(opt('--wait', '120'), 10);
const resume     = flag('--resume');
const headless   = flag('--headless') || config.headless === true;
const fixVersions = list('--fix-version', config.fixVersions);
const components  = list('--component',   config.components);
const labels      = list('--labels',      config.labels);

if (labels.some((l) => /\s/.test(l))) {
  console.error('Labels cannot contain spaces');
  process.exit(1);
}

if (!resume && (!inputFile || !projectKey)) {
  console.error([
    '',
    'Usage: node import_ui.js <file.xlsx|file.csv> --project KEY [options]',
    '  --project KEY   Jira project key (required)',
    '  --dry-run       Parse only, no issues/steps created',
    '  --delay N       ms between issues in phase 2 (default 1500)',
    '  --test-set KEY  Add tests to an existing Xray Test Set',
    '  --wait N        seconds to wait between phase 1 and 2 (default 120)',
    '  --resume        Skip phase 1, read from created_issues.json',
    '  --fix-version A,B  Fix versions (must exist in the project)',
    '  --component A,B    Components (must exist in the project)',
    '  --labels A,B       Labels (no spaces)',
    '  --headless         Run steps in a background browser with saved cookies',
    '  --config FILE      Defaults file (default import.config.json)',
    '',
  ].join('\n'));
  process.exit(1);
}

if (!resume && !existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN in .env');
  process.exit(1);
}

const CDP_URL = 'http://127.0.0.1:9222';
const CREATED_ISSUES_FILE = 'created_issues.json';

// Set once the Forge-based Xray panel is seen; the internal API is then skipped for all issues
let forgePanel = false;

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

async function openIssueAndFindXrayFrame(context, issueKey) {
  const page = await context.newPage();

  await page.goto(`${JIRA_BASE_URL}/browse/${issueKey}`, {
    waitUntil: 'domcontentloaded',
    timeout: 40_000,
  });

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3_000);

  // Xray on Forge renders the panel from an atlassian-dev.net CDN under /test-issue-panel/
  const findFrame = () =>
    page.frames().find((f) =>
      f.url().includes('xray.cloud.getxray.app/view/webpanel/test/all-in-one') ||
      f.url().includes('/test-issue-panel/')
    ) ?? null;

  // Try to find and scroll the iframe element into view to trigger lazy load
  const allInOneEl = page.locator('iframe[src*="all-in-one"]').first();
  const elExists = await allInOneEl.count().then((n) => n > 0).catch(() => false);

  if (elExists) {
    console.log('  Found all-in-one iframe element, scrolling into view…');
    await allInOneEl.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
  } else {
    // Progressively scroll the page to trigger lazy-loaded panels
    console.log('  Scrolling page progressively to trigger lazy load…');
    for (let i = 1; i <= 5; i++) {
      await page.evaluate((ratio) => {
        window.scrollTo(0, document.body.scrollHeight * ratio);
      }, i * 0.2);
      await page.waitForTimeout(1_500);
    }
  }

  let xrayFrame = findFrame();

  // Poll for the frame to appear (up to 30s)
  if (!xrayFrame) {
    console.log('  Polling for all-in-one frame (up to 30s)…');
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3_000);
      xrayFrame = findFrame();
      if (xrayFrame) {
        console.log(`  ✓ Frame appeared after ${(i + 1) * 3}s`);
        break;
      }
      // Re-scroll on each attempt
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    }
  }

  return { page, xrayFrame };
}

// ── 4a. Add steps via Xray internal API ──────────────────────────────────────

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

    if (!xrayFrame.url().includes('xray.cloud.getxray.app')) {
      forgePanel = true;
      throw new Error('Xray Forge panel detected — internal API not available');
    }

    // Wait for "Add Step" button — fail hard if it doesn't appear
    console.log('  Waiting for Xray panel to initialize…');
    let panelReady = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await xrayFrame
          .locator('button:has-text("Add Step")')
          .first()
          .waitFor({ state: 'visible', timeout: 8_000 });
        panelReady = true;
        break;
      } catch {
        console.log(`  Xray panel not ready, retry ${attempt + 1}/5…`);
        await xrayFrame.waitForTimeout(4_000);
      }
    }
    if (!panelReady) {
      throw new Error('Xray panel did not initialize after retries — Add Step button never appeared');
    }

    // Get x-acpt token with retries
    let acpt = null;
    for (let i = 0; i < 3; i++) {
      acpt = await xrayFrame.evaluate(() =>
        new Promise((resolve) => {
          if (typeof AP !== 'undefined' && AP?.context?.getToken) {
            AP.context.getToken((t) => resolve(t ?? null));
            setTimeout(() => resolve(null), 5_000);
          } else {
            resolve(null);
          }
        })
      ).catch(() => null);
      if (acpt) break;
      console.log(`  x-acpt token not available, retry ${i + 1}/3…`);
      await xrayFrame.waitForTimeout(3_000);
    }

    if (acpt) {
      console.log(`  x-acpt token obtained`);
    } else {
      throw new Error('x-acpt token unavailable after retries — Xray session may not be authenticated');
    }

    const xrayHeaders = {
      'Content-Type': 'application/json',
      'x-addon-key':  'com.xpandit.plugins.xray',
      'x-acpt':       acpt,
    };

    // Get testVersionId — fail hard if not available
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

    if (!testVersionId) {
      throw new Error(`Cannot get testVersionId: ${versionsError}`);
    }
    console.log(`  testVersionId: ${testVersionId}`);

    // Add each step
    let successCount = 0;

    for (let i = 0; i < steps.length; i++) {
      const step  = steps[i];
      const label = `step ${i + 1}/${steps.length}`;

      const result = await xrayFrame.evaluate(
        async ({ xrayIssueId, testVersionId, step, headers, index }) => {
          const body = {
            index,
            testVersionId,
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
            } catch {
              // network error — try next endpoint
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

    const addStepBtn = xrayFrame.locator('button:has-text("Add Step")').first();
    await addStepBtn.waitFor({ state: 'visible', timeout: 15_000 });

    const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    // Text of saved steps only — editor contents of an open form are excluded
    const panelText = async () => squash(await xrayFrame.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('.ProseMirror').forEach((e) => e.remove());
      return clone.innerText;
    }));
    const existing = await panelText();

    let successCount = 0;

    for (let i = 0; i < steps.length; i++) {
      const step  = steps[i];
      const label = `step ${i + 1}/${steps.length}`;
      const marker = squash(step.action || step.result).slice(0, 80);

      if (marker && existing.includes(marker)) {
        console.log(`    – ${label} already exists, skipping`);
        successCount++;
        continue;
      }

      try {
        await addStepBtn.click();
        await xrayFrame.waitForTimeout(400);

        const newItem = xrayFrame.getByRole('menuitem', { name: 'New', exact: true });
        await newItem.waitFor({ state: 'visible', timeout: 3_000 });
        await newItem.click();

        await xrayFrame.waitForTimeout(800);

        const editors = await xrayFrame.locator('.ProseMirror').all();

        const fillEditor = async (idx, value) => {
          if (!value || !editors[idx]) return;
          await editors[idx].click();
          await editors[idx].fill(value);
        };

        await fillEditor(0, step.action);
        await fillEditor(1, step.data);
        await fillEditor(2, step.result);

        // Xray ignores Create clicked right after typing, before the editors sync their content
        await xrayFrame.waitForTimeout(1_000);

        const createBtn = xrayFrame.locator('#step-action-submit');
        await createBtn.waitFor({ state: 'visible', timeout: 5_000 });

        let saved = false;
        for (let attempt = 0; attempt < 2 && !saved; attempt++) {
          if (!(await createBtn.isVisible().catch(() => false))) break;
          await createBtn.click();
          for (let t = 0; t < 20 && !saved; t++) {
            await xrayFrame.waitForTimeout(500);
            const formOpen = await createBtn.isVisible().catch(() => false);
            saved = !formOpen && (!marker || (await panelText()).includes(marker));
          }
        }
        if (!saved) throw new Error('step was not saved after Create');
        await xrayFrame.waitForTimeout(1_000);

        console.log(`    ✓ ${label} added (UI)`);
        successCount++;
      } catch (err) {
        console.warn(`    ✗ ${label} UI failed: ${err.message}`);
        break;
      }
    }

    return successCount === steps.length;
  } finally {
    await page.close();
  }
}

// ── 5. Add test to a Test Set (optional) ─────────────────────────────────────

async function addTestToTestSet(context, testKey, testSetKey) {
  const { page: _p, xrayFrame } = await openIssueAndFindXrayFrame(context, testSetKey);

  try {
    if (xrayFrame) {
      const r = await xrayFrame.evaluate(
        async ({ testSetKey, testKey }) => {
          try {
            const res = await fetch(`/api/internal/testset/${testSetKey}/tests`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ add: [testKey] }),
            });
            if (res.ok) return { ok: true };
            return { ok: false };
          } catch {
            return { ok: false };
          }
        },
        { testSetKey, testKey }
      );
      if (r?.ok) console.log(`  ✓ Added ${testKey} to Test Set ${testSetKey}`);
      else        console.warn(`  ⚠ Could not add ${testKey} to Test Set (check manually)`);
    }
  } finally {
    await _p.close().catch(() => {});
  }
}

// ── Countdown helper ──────────────────────────────────────────────────────────

async function countdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 10) {
    const wait = Math.min(10, remaining);
    process.stdout.write(`  ${remaining}s remaining…\r`);
    await sleep(wait * 1000);
  }
  process.stdout.write('  Done waiting.              \n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jiraError(err) {
  const data = err.response?.data;
  const parts = [...(data?.errorMessages ?? []), ...Object.entries(data?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
  return parts.length ? parts.join(', ') : err.message;
}

async function addFieldsToExisting(items) {
  const jira = new JiraClient({ baseUrl: JIRA_BASE_URL, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN });
  const update = {
    ...(fixVersions.length && { fixVersions: fixVersions.map((name) => ({ add: { name } })) }),
    ...(components.length  && { components:  components.map((name) => ({ add: { name } })) }),
    ...(labels.length      && { labels:      labels.map((l) => ({ add: l })) }),
  };

  console.log('\n── Adding Fix versions / Components / Labels ────────────────────');
  if (fixVersions.length) console.log(`  Fix versions: ${fixVersions.join(', ')}`);
  if (components.length)  console.log(`  Components:   ${components.join(', ')}`);
  if (labels.length)      console.log(`  Labels:       ${labels.join(', ')}`);

  for (const item of items) {
    try {
      await jira.updateIssue(item.issueKey, { update });
      console.log(`  ✓ ${item.issueKey}`);
    } catch (err) {
      console.error(`  ✗ ${item.issueKey} — ${jiraError(err)}`);
    }
    await sleep(300);
  }
}

async function main() {
  console.log(`\n── Jira/Xray Test Importer (Two-Phase) ──────────────────────────`);

  // ── Phase 1: Create issues (or resume from file) ──────────────────────────
  let created = [];

  if (resume) {
    if (!existsSync(CREATED_ISSUES_FILE)) {
      console.error(`--resume: ${CREATED_ISSUES_FILE} not found`);
      process.exit(1);
    }
    created = JSON.parse(readFileSync(CREATED_ISSUES_FILE, 'utf8'));
    console.log(`Resuming from ${CREATED_ISSUES_FILE}: ${created.length} issue(s)`);

    if (fixVersions.length || components.length || labels.length) {
      await addFieldsToExisting(created);
    }
  } else {
    console.log(`Input:   ${inputFile}`);
    console.log(`Project: ${projectKey}`);
    if (dryRun)     console.log('Mode:    DRY RUN');
    if (testSetKey) console.log(`Test Set: ${testSetKey}`);
    if (fixVersions.length) console.log(`Fix versions: ${fixVersions.join(', ')}`);
    if (components.length)  console.log(`Components:   ${components.join(', ')}`);
    if (labels.length)      console.log(`Labels:       ${labels.join(', ')}`);
    console.log('');

    const tests = await parseInputFile(inputFile);
    if (!tests.length) { console.error('No test cases found.'); process.exit(1); }

    console.log(`Found ${tests.length} test case(s):`);
    for (const t of tests) console.log(`  • ${t.summary}  (${t.steps.length} steps)`);
    console.log('');

    if (dryRun) { console.log('[dry-run] Done.'); return; }

    const jira = new JiraClient({ baseUrl: JIRA_BASE_URL, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN });

    console.log('── Phase 1: Creating Jira issues ────────────────────────────────');
    for (const test of tests) {
      try {
        const { key, id } = await jira.createIssue({
          project:   { key: projectKey },
          issuetype: { name: 'Test' },
          summary:   test.summary,
          ...(fixVersions.length && { fixVersions: fixVersions.map((name) => ({ name })) }),
          ...(components.length  && { components:  components.map((name) => ({ name })) }),
          ...(labels.length      && { labels }),
        });
        console.log(`  ✓ ${key}  ${test.summary}`);
        created.push({ ...test, issueKey: key, issueId: id });
      } catch (err) {
        console.error(`  ✗ Failed to create: ${test.summary} — ${jiraError(err)}`);
      }
      await sleep(500);
    }

    // Persist phase 1 results for potential --resume
    writeFileSync(CREATED_ISSUES_FILE, JSON.stringify(created, null, 2));
    console.log(`\n  Saved ${created.length} issue(s) to ${CREATED_ISSUES_FILE}`);
  }

  if (!created.length) {
    console.error('No issues to process.');
    process.exit(1);
  }

  // ── Wait for Xray to index all issues ─────────────────────────────────────
  console.log(`\n── Waiting ${waitSec}s for Xray to index all issues ─────────────────`);
  await countdown(waitSec);

  // ── Phase 2: Add steps ────────────────────────────────────────────────────
  console.log('\n── Phase 2: Adding steps ────────────────────────────────────────');

  const { browser, context, persist } = headless
    ? await openHeadlessSession({ baseUrl: JIRA_BASE_URL, cdpUrl: CDP_URL })
    : { ...(await connectChrome()), persist: async () => {} };
  const results = [];

  for (let idx = 0; idx < created.length; idx++) {
    const item = created[idx];
    console.log(`\n[${idx + 1}/${created.length}] ${item.issueKey}  ${item.summary}`);

    if (!item.steps?.length) {
      results.push({ ...item, status: 'OK_NO_STEPS' });
      continue;
    }

    if (item.stepsDone) {
      console.log('  Steps already added in a previous run, skipping');
      results.push({ ...item, status: 'OK' });
      continue;
    }

    let stepsOk = false;
    if (!forgePanel) {
      try {
        stepsOk = await addStepsViaInternalAPI(context, item.issueKey, item.issueId, item.steps);
      } catch (err) {
        console.warn(`  ⚠ Internal API failed: ${err.message}`);
      }
    }

    if (!stepsOk) {
      stepsOk = await addStepsViaUI(context, item.issueKey, item.steps);
    }

    results.push({ ...item, status: stepsOk ? 'OK' : 'STEPS_PARTIAL' });

    if (stepsOk) {
      item.stepsDone = true;
      writeFileSync(CREATED_ISSUES_FILE, JSON.stringify(created, null, 2));
    }

    if (testSetKey) await addTestToTestSet(context, item.issueKey, testSetKey);

    await persist();

    if (idx < created.length - 1) await sleep(delay);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n── Results ──────────────────────────────────────────────────────');
  for (const r of results) {
    const icon = ['OK', 'OK_NO_STEPS'].includes(r.status) ? '✓' : r.status === 'STEPS_PARTIAL' ? '⚠' : '✗';
    const note = r.status === 'STEPS_PARTIAL' ? '  ← steps incomplete' : '';
    console.log(`  ${icon} ${r.issueKey}  ${r.summary}${note}`);
  }

  const ok      = results.filter((r) => ['OK', 'OK_NO_STEPS'].includes(r.status)).length;
  const partial = results.filter((r) => r.status === 'STEPS_PARTIAL').length;
  const failed  = results.filter((r) => r.status === 'JIRA_FAILED').length;
  console.log(`\nTotal: ${ok} ok / ${partial} partial / ${failed} failed`);

  await browser.close();
  console.log('Done.\n');
}

main().catch((err) => { console.error('\nFatal:', err.message); process.exit(1); });
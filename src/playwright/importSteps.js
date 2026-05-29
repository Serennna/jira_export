import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const CDP_URL = 'http://127.0.0.1:9222';
const AUTH_FILE = '.auth/session.json';
const XRAY_FRAME_URL_RE = /getxray\.app|xpandit|xray/i;
const DEBUG_ROOT = 'output/import-debug';
const FINAL_ROOT = 'output/import-final';
const INTERACTIVE_LOGIN_TIMEOUT_MS = 180_000;
const ADD_STEP_SELECTORS = [
  'button:has-text("Add Step")',
  'button:has-text("Add step")',
  '[role="button"]:has-text("Add Step")',
  '[role="button"]:has-text("Add step")',
  'button:text-matches("Add\\\\s*Step", "i")',
  '[role="button"]:text-matches("Add\\\\s*Step", "i")',
  'xpath=//*[self::button or @role="button" or self::a][contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"add step")]',
  '[aria-label*="Add Step"]',
  '[aria-label*="Add step"]',
  '[data-testid*="add-step"]',
];

/**
 * Import manual test steps into an existing Jira/Xray Test using the browser
 * session that the Xray iframe establishes after Jira login.
 *
 * @param {object} opts
 * @param {string} opts.jiraBaseUrl
 * @param {string} opts.issueKey
 * @param {string} opts.issueId
 * @param {Array<{action?: string, data?: string, result?: string}>} opts.steps
 * @param {number} [opts.waitMs=8000]
 * @returns {Promise<Array<{id: string, action: string, data: string, result: string}>>}
 */
export async function importXraySteps({
  jiraBaseUrl,
  issueKey,
  issueId,
  steps,
  waitMs = 8_000,
  debug = false,
  captureFinalScreenshot = true,
}) {
  if (!jiraBaseUrl || !issueKey || !issueId) {
    throw new Error('importXraySteps requires jiraBaseUrl, issueKey, and issueId');
  }

  const normalizedSteps = (steps ?? []).map(normalizeStep);
  if (normalizedSteps.length === 0) return [];

  const { browser, page, useSession } = await openBrowserPage({ jiraBaseUrl, autoRecover: true });
  const debugEnabled = Boolean(debug);
  const debugDir = debugEnabled ? prepareDebugDir(issueKey) : null;

  try {
    const ticketUrl = `${jiraBaseUrl}/browse/${issueKey}`;
    console.log(`  Navigating to ${ticketUrl}…`);
    await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(2_000);
    if (debugEnabled) {
      await saveDebugScreenshot(page, debugDir, '01-after-open');
    }

    const currentUrl = page.url();
    if (!currentUrl.startsWith(jiraBaseUrl)) {
      throw new Error(
        `Not logged in — redirected to ${currentUrl.slice(0, 120)}\n`
        + 'Run "node login.js" to refresh your session.',
      );
    }

    console.log('  Waiting for issue page and Xray panel…');
    await page.waitForTimeout(Math.min(waitMs, 5_000));

    const frame = await waitForXrayFrame(page, 60_000, debugDir);
    console.log('  Xray iframe ready.');
    await focusTestDetails(frame);
    await nudgeIntoTestDetailsArea(frame);
    const testDetailsRoot = await locateTestDetailsRoot(frame);
    console.log('  Locked onto Test details section.');
    if (debugEnabled) {
      await saveDebugScreenshot(page, debugDir, '02-after-focus-test-details');
    }
    await waitForAddStepButton(page, frame, testDetailsRoot, 45_000, debugDir);

    const createdSteps = [];
    for (const [index, step] of normalizedSteps.entries()) {
      const created = await addStepViaUI({
        page,
        frame,
        scope: testDetailsRoot,
        issueKey,
        step,
        stepNumber: index + 1,
        totalSteps: normalizedSteps.length,
        debugDir,
      });

      createdSteps.push(created);
    }

    if (captureFinalScreenshot) {
      const finalDir = prepareFinalDir();
      const finalPath = path.join(finalDir, `${issueKey}.png`);
      await page.screenshot({ path: finalPath, fullPage: true });
      console.log(`  Final screenshot: ${finalPath}`);
    }

    return createdSteps;
  } catch (error) {
    if (captureFinalScreenshot) {
      const finalDir = prepareFinalDir();
      const errorPath = path.join(finalDir, `${issueKey}-error.png`);
      await page.screenshot({ path: errorPath, fullPage: true }).catch(() => {});
      console.log(`  Error screenshot: ${errorPath}`);
    }
    if (debugEnabled) {
      await saveDebugScreenshot(page, debugDir, '99-error-state').catch(() => {});
    }
    throw error;
  } finally {
    await page.close();
    if (useSession) {
      await browser.close();
    } else {
      await browser.close();
    }
  }
}

export async function ensureJiraImportSession(jiraBaseUrl) {
  const { browser, page } = await openBrowserPage({ jiraBaseUrl, autoRecover: true });
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

async function openBrowserPage({ jiraBaseUrl = '', autoRecover = true } = {}) {
  const useSession = existsSync(AUTH_FILE);
  const useCDP = await checkCDP();

  let browser;
  let context;
  let page;

  if (useSession) {
    console.log('  Using saved session (.auth/session.json)…');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ storageState: AUTH_FILE });
    page = await context.newPage();
    const valid = jiraBaseUrl ? await verifyJiraSession(page, jiraBaseUrl) : true;
    if (valid) {
      return { browser, context, page, useSession: true };
    }

    console.log('  Saved session is expired. Re-authentication required.');
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (useCDP) {
    console.log(`  Connecting to Chrome at ${CDP_URL}…`);
    browser = await chromium.connectOverCDP(CDP_URL);
    context = browser.contexts()[0];
    if (!context) throw new Error('No browser context found in Chrome.');
    page = await context.newPage();
    const valid = jiraBaseUrl ? await verifyJiraSession(page, jiraBaseUrl) : true;
    if (valid) {
      return { browser, context, page, useSession: false };
    }
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (!autoRecover) {
    throw new Error(
      'Not logged in to Jira.\n'
      + 'Run "npm run login" once to save your session, then retry import.',
    );
  }

  await refreshSessionInteractively(jiraBaseUrl);

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ storageState: AUTH_FILE });
  page = await context.newPage();
  const valid = jiraBaseUrl ? await verifyJiraSession(page, jiraBaseUrl) : true;
  if (!valid) {
    throw new Error('Session was refreshed but Jira login is still invalid. Please run "npm run login" manually.');
  }
  return { browser, context, page, useSession: true };
}

async function checkCDP() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function verifyJiraSession(page, jiraBaseUrl) {
  if (!jiraBaseUrl) return true;
  try {
    await page.goto(jiraBaseUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    const url = page.url();
    if (url.startsWith(jiraBaseUrl) && !url.includes('/login')) {
      return true;
    }
    const navVisible = await page.locator('[data-testid="atlassian-navigation"]')
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    return navVisible;
  } catch {
    return false;
  }
}

async function refreshSessionInteractively(jiraBaseUrl) {
  console.log('\n  Session missing/expired. Starting interactive Jira login...');
  console.log('  A browser window will open. Complete SSO login, then import will continue.\n');

  const browser = await launchHeadfulChrome();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(jiraBaseUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
  const ok = await waitForJiraLogin(page, jiraBaseUrl, INTERACTIVE_LOGIN_TIMEOUT_MS);
  if (!ok) {
    await browser.close().catch(() => {});
    throw new Error(
      'Interactive login timed out.\n'
      + 'Please run "npm run login" manually, then retry import.',
    );
  }

  await context.storageState({ path: AUTH_FILE });
  console.log(`  Session refreshed and saved to ${AUTH_FILE}`);
  await browser.close().catch(() => {});
}

async function launchHeadfulChrome() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    return chromium.launch({ headless: false });
  }
}

async function waitForJiraLogin(page, jiraBaseUrl, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.startsWith(jiraBaseUrl) && !url.includes('/login')) return true;
    const navVisible = await page.locator('[data-testid="atlassian-navigation"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (navVisible) return true;
    await page.waitForTimeout(2_000);
  }
  return false;
}

async function waitForXrayFrame(page, timeoutMs = 45_000, debugDir = null) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const candidateFrames = [];
    const frameDiagnostics = [];

    for (const frame of page.frames()) {
      const url = frame.url();
      const hasAddStep = await hasVisibleAny(frame, ADD_STEP_SELECTORS);
      const hasTestDetails = await frame.locator('text="Test details"')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      const hasNoSteps = await frame.locator('text="There are no steps defined"')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);

      frameDiagnostics.push({
        url: truncate(url || '(no url)', 120),
        addStep: hasAddStep,
        testDetails: hasTestDetails,
        noSteps: hasNoSteps,
      });

      if (hasAddStep || hasNoSteps) {
        console.log(`  Found Xray UI frame on scan ${attempt}: ${truncate(url || '(no url)', 120)}`);
        return frame;
      }

      if (url && !url.startsWith('about:blank') && XRAY_FRAME_URL_RE.test(url)) {
        candidateFrames.push(frame);
      }
    }

    for (const frame of candidateFrames) {
      await frame.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});

      const hasAddStep = await hasVisibleAny(frame, ADD_STEP_SELECTORS);
      const hasTestDetails = await frame.locator('text="Test details"')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      const hasNoSteps = await frame.locator('text="There are no steps defined"')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);

      if (hasAddStep || hasNoSteps) {
        return frame;
      }

      // Do not early-return a candidate frame without UI signals.
      // Xray sometimes loads an empty shell first; returning here causes
      // downstream "Add Step" timeout with no buttons visible.
    }

    if (attempt === 1 || attempt % 3 === 0) {
      console.log(`  Scanning frames for Xray UI (attempt ${attempt})…`);
      for (const info of frameDiagnostics.slice(0, 8)) {
        console.log(`    frame addStep=${info.addStep} testDetails=${info.testDetails} noSteps=${info.noSteps} url=${info.url}`);
      }
      if (debugDir) {
        await saveDebugScreenshot(page, debugDir, `frame-scan-${String(attempt).padStart(2, '0')}`).catch(() => {});
      }
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2_000);
  }

  throw new Error('Timed out waiting for the Xray iframe to load on the issue page.');
}

async function focusTestDetails(frame) {
  const locators = [
    'button:has-text("Test details")',
    '[role="tab"]:has-text("Test details")',
    '[data-testid*="test-details"]',
  ];

  for (const selector of locators) {
    const locator = frame.locator(selector).first();
    if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
      await locator.click().catch(() => {});
      await frame.waitForTimeout(500);
      return;
    }
  }
}

async function nudgeIntoTestDetailsArea(frame) {
  const anchors = [
    'text="Test Repository"',
    'text="There are no steps defined"',
    'button:has-text("Add Step")',
    'text="Test details"',
  ];

  for (const selector of anchors) {
    const locator = frame.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 300 }).catch(() => false);
    if (!visible) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await frame.waitForTimeout(300);
    return;
  }

  await scrollFrameDown(frame, 700);
}

async function locateTestDetailsRoot(frame) {
  const selectors = [
    'xpath=(//*[normalize-space(.)="Test details"]/ancestor::*[.//*[contains(normalize-space(.),"Test Repository")]][1])[1]',
    'xpath=(//*[normalize-space(.)="Test details"]/ancestor::*[.//*[contains(normalize-space(.),"There are no steps defined") or .//button[contains(normalize-space(.),"Add Step")]]][1])[1]',
    'xpath=(//*[normalize-space(.)="Test details"]/ancestor::*[.//*[contains(@data-testid,"issue-view-ecosystem.connect.meat-ball-menu")]][1])[1]',
    'xpath=(//*[normalize-space(.)="Test details"]/ancestor::*[.//*[contains(normalize-space(.),"Test Plans")] and .//*[contains(normalize-space(.),"Test Runs")]][1])[1]',
    'xpath=(//*[normalize-space(.)="Test details"]/parent::*[1])[1]',
  ];

  for (const selector of selectors) {
    const locator = frame.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
    if (visible) return locator;
  }

  return frame.locator('body');
}

async function waitForAddStepButton(page, frame, scope, timeoutMs = 45_000, debugDir = null) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    if (attempt === 1 || attempt % 6 === 0) {
      await focusTestDetails(frame).catch(() => {});
      await nudgeIntoTestDetailsArea(frame).catch(() => {});
    }

    // If the meatball menu accidentally opened, close it so it doesn't mask buttons.
    const strayMenu = await scope.locator('[role="menuitem"]:has-text("Hide Test details")').first().isVisible({ timeout: 150 }).catch(() => false);
    if (strayMenu) {
      await frame.page().keyboard.press('Escape').catch(() => {});
      await frame.waitForTimeout(200);
    }

    const headerOnlyScope = await isHeaderOnlyScope(scope);
    const searchScope = headerOnlyScope ? frame.locator('body') : scope;
    const addStepLocator = await resolveAddStepLocator(searchScope, frame);
    if (addStepLocator) {
      await addStepLocator.scrollIntoViewIfNeeded().catch(() => {});
      console.log(`  Add Step button appeared on attempt ${attempt}.`);
      return;
    }
    if (attempt === 1 || attempt % 4 === 0) {
      const visibleButtons = await collectVisibleButtonTexts(searchScope);
      const hasSkeleton = await hasLoadingSkeleton(scope);
      const nearBy = await collectVisibleButtonTexts(frame.locator('body'));
      console.log(`  Waiting for Add Step button (attempt ${attempt})… skeleton=${hasSkeleton} headerOnlyScope=${headerOnlyScope} sectionButtons=${visibleButtons.join(' | ') || '(none)'} globalButtons=${nearBy.join(' | ') || '(none)'}`);
      if (debugDir) {
        const stamp = `wait-add-step-${String(attempt).padStart(2, '0')}`;
        await saveFrameDebugSnapshot(scope, debugDir, stamp).catch(() => {});
        await saveDebugScreenshot(page, debugDir, stamp).catch(() => {});
      }
    }
    if (attempt % 2 === 0) {
      await scope.scrollIntoViewIfNeeded().catch(() => {});
      await scrollTowardStepsArea(frame, 700).catch(() => {});
    }
    await frame.waitForTimeout(500);
  }

  throw new Error('Timed out waiting for Add Step button to appear.');
}

async function hasAddStepButton(scope) {
  const locator = await resolveFirstVisibleLocator(scope, ADD_STEP_SELECTORS);
  return Boolean(locator);
}

async function resolveAddStepLocator(scope, frame) {
  const selectors = ADD_STEP_SELECTORS;

  const inScope = await resolveFirstVisibleLocator(scope, selectors);
  if (inScope) return inScope;

  const inFrame = await resolveFirstVisibleLocator(frame, selectors);
  if (inFrame) return inFrame;

  return null;
}

async function scrollFrameDown(frame, deltaY = 500) {
  await frame.evaluate((pixels) => {
    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    scrollingElement.scrollBy?.(0, pixels);
    window.scrollBy(0, pixels);
  }, deltaY);
}

async function scrollTowardStepsArea(frame, deltaY = 700) {
  await frame.evaluate((pixels) => {
    const textMatch = (node, text) =>
      node && node.textContent && node.textContent.toLowerCase().includes(text.toLowerCase());

    const all = Array.from(document.querySelectorAll('div, section, article, main'));
    const target = all.find((node) => textMatch(node, 'There are no steps defined'))
      || all.find((node) => textMatch(node, 'Test details'));

    const isScrollable = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY || style.overflow;
      return (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 20;
    };

    const maybeScroll = (node) => {
      if (!node) return false;
      let current = node;
      while (current && current !== document.body) {
        if (isScrollable(current)) {
          current.scrollTop += pixels;
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };

    const didInnerScroll = maybeScroll(target);

    // Fallback: nudge all scrollable containers a bit to trigger lazy render.
    if (!didInnerScroll) {
      for (const node of all) {
        if (isScrollable(node)) {
          node.scrollTop += Math.floor(pixels / 2);
        }
      }
    }

    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    scrollingElement.scrollBy?.(0, pixels);
    window.scrollBy(0, pixels);
  }, deltaY);
}

async function addStepViaUI({
  page,
  frame,
  scope,
  issueKey,
  step,
  stepNumber,
  totalSteps,
  debugDir,
}) {
  console.log(`  Adding step ${stepNumber}/${totalSteps} via UI…`);
  const beforeCount = await countExistingSteps(frame);

  if (!await resolveAddStepLocator(scope, frame)) {
    console.log('  Current frame lost Add Step; rescanning frames…');
    frame = await waitForXrayFrame(page, 10_000, debugDir);
    scope = await locateTestDetailsRoot(frame);
    await waitForAddStepButton(page, frame, scope, 45_000, debugDir);
  }

  const addStepButton = await resolveAddStepLocator(scope, frame);
  if (!addStepButton) {
    throw new Error('Could not resolve Add Step button after wait.');
  }
  await addStepButton.scrollIntoViewIfNeeded().catch(() => {});
  await addStepButton.click().catch(async () => {
    await addStepButton.click({ force: true });
  });
  console.log('  Clicked Add Step.');

  await frame.waitForTimeout(600);

  await clickFirstVisible(scope, [
    '[role="menuitem"]:has-text("New")',
    'button:has-text("New")',
    'text="New"',
  ], 'New step menu item');
  console.log('  Clicked New.');

  await waitForInlineEditor(frame);
  // Xray often renders toolbars first, then enables editable boxes 2-3s later.
  await frame.waitForTimeout(2_500);
  if (debugDir) {
        await saveFrameDebugSnapshot(scope, debugDir, `inline-editor-step-${stepNumber}`).catch(() => {});
  }

  const editors = await waitForStepEditorsReady(frame, 12_000);
  if (editors.length < 3) {
    const visibleButtons = await collectVisibleButtonTexts(scope);
    console.log(`  Could not resolve step editors. Visible buttons: ${visibleButtons.join(' | ') || '(none)'}`);
    throw new Error(`Opened "New" for ${issueKey}, but could not find the step editor fields.`);
  }
  const stableEditors = await orderAndDedupeEditors(editors);
  if (stableEditors.length < 3) {
    throw new Error(`Resolved duplicate/invalid editor mapping (${stableEditors.length}/3).`);
  }
  console.log(`  Resolved ${stableEditors.length} editor(s) for Action/Data/Expected.`);

  if (step.action) {
    await setEditableValue(page, stableEditors[0], step.action);
  }
  if (step.data) {
    await setEditableValue(page, stableEditors[1], step.data);
  }
  if (step.result) {
    await setEditableValue(page, stableEditors[2], step.result);
  }
  await assertEditorsContainValues(stableEditors, [step.action, step.data, step.result]);

  await frame.waitForTimeout(300);

  const saved = await tryClickAny(scope, [
    'button:has-text("Create")',
    'button:has-text("Save")',
    'button:has-text("Add")',
    'button:has-text("Done")',
    '[aria-label*="Save"]',
    '[aria-label*="Create"]',
    '[data-testid*="save"]',
    '[data-testid*="create"]',
  ]);

  if (!saved) {
    console.log('  No explicit save button matched; trying keyboard shortcut.');
    await page.keyboard.press('Meta+Enter').catch(() => {});
    await frame.waitForTimeout(500);
  } else {
    console.log('  Triggered step save/create button.');
  }

  await waitForCreateCompletion(frame, scope, step.action);
  await waitForStepVisible(frame, step.action).catch(async (error) => {
    const afterCount = await countExistingSteps(frame);
    if (afterCount > beforeCount) {
      console.log(`  Step text not visible yet, but step count increased (${beforeCount} -> ${afterCount}).`);
      return;
    }
    throw error;
  });
  console.log(`  Added step ${stepNumber}/${totalSteps}`);
  return {
    id: `${issueKey}-step-${stepNumber}`,
    action: step.action,
    data: step.data,
    result: step.result,
  };
}

async function countExistingSteps(frame) {
  const rows = await frame.locator('xpath=//*[contains(@class,"step") and .//*[normalize-space(.)="Action"]]').count().catch(() => 0);
  if (rows > 0) return rows;
  const numberBadges = await frame.locator('xpath=//*[self::div or self::span][normalize-space(text()) and string-length(normalize-space(text())) <= 3]').evaluateAll((nodes) =>
    nodes
      .map((n) => (n.textContent || '').trim())
      .filter((t) => /^\d+$/.test(t))
      .length).catch(() => 0);
  return numberBadges;
}

function normalizeStep(step = {}) {
  return {
    action: asString(step.action).trim(),
    data: asString(step.data).trim(),
    result: asString(step.result).trim(),
  };
}

function asString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

async function clickFirstVisible(frame, selectors, description) {
  const clicked = await tryClickAny(frame, selectors);
  if (!clicked) {
    throw new Error(`Could not find ${description}.`);
  }
}

async function tryClickAny(frame, selectors) {
  for (const selector of selectors) {
    const locator = await resolveFirstVisibleLocator(frame, [selector]);
    if (!locator) continue;
    await locator.click().catch(async () => {
      await locator.click({ force: true });
    });
    console.log(`  Clicked selector: ${selector}`);
    return true;
  }
  return false;
}

async function resolveFirstVisibleLocator(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible({ timeout: 200 }).catch(() => false);
      if (visible) return candidate;
    }
  }
  return null;
}

async function hasVisibleAny(scope, selectors) {
  const locator = await resolveFirstVisibleLocator(scope, selectors);
  return Boolean(locator);
}

async function collectStepEditors(frame) {
  const activeRoot = await locateActiveStepEditorRoot(frame);
  if (activeRoot) {
    const activeEditors = await collectEditorsFromRoot(activeRoot);
    if (activeEditors.length >= 3) {
      return activeEditors.slice(0, 3);
    }
  }

  // Xray inline step editor typically renders exactly 3 rich text boxes
  // (Action, Data, Expected Result) with the same aria-label.
  const ariaTextboxes = frame.locator('[role="textbox"][aria-label*="start typing"], [role="textbox"][aria-label*="Main content area"]');
  const ariaCount = await ariaTextboxes.count().catch(() => 0);
  if (ariaCount >= 3) {
    const ordered = [];
    for (let i = 0; i < ariaCount; i++) {
      const candidate = ariaTextboxes.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const resolved = await resolveEditableLocator(candidate);
      ordered.push(resolved ?? candidate);
      if (ordered.length === 3) break;
    }
    const stableOrdered = await orderAndDedupeEditors(ordered);
    if (stableOrdered.length >= 3) {
      return stableOrdered.slice(0, 3);
    }
  }

  const byLabel = await collectEditorsByLabel(frame);
  if (byLabel.length >= 3) {
    return byLabel.slice(0, 3);
  }

  const labelled = [];
  const action = await findEditorByLabel(frame, 'Action');
  const data = await findEditorByLabel(frame, 'Data');
  const result = await findEditorByLabel(frame, 'Expected');
  if (action) labelled.push(action);
  if (data) labelled.push(data);
  if (result) labelled.push(result);

  if (labelled.length >= 3) return labelled;

  const fallback = [];
  const locator = frame.locator('textarea, input:not([type="hidden"]):not([readonly]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const writable = await isWritable(candidate);
    if (!writable) continue;
    const resolved = await resolveEditableLocator(candidate);
    fallback.push(resolved ?? candidate);
  }

  const merged = await orderAndDedupeEditors([...labelled, ...fallback]);
  return merged.slice(0, 3);
}

async function locateActiveStepEditorRoot(frame) {
  const selectors = [
    'xpath=(//button[normalize-space()="Create"]/ancestor::*[.//*[contains(normalize-space(.),"Action")] and .//*[contains(normalize-space(.),"Data")] and .//*[contains(normalize-space(.),"Expected")]][1])[1]',
    'xpath=(//button[normalize-space()="Create"]/ancestor::*[.//*[contains(normalize-space(.),"Action")]][1])[1]',
  ];
  for (const selector of selectors) {
    const root = frame.locator(selector).first();
    const visible = await root.isVisible({ timeout: 250 }).catch(() => false);
    if (visible) return root;
  }
  return null;
}

async function collectEditorsFromRoot(root) {
  // Prefer the 3 textboxes immediately preceding the active Create button,
  // so we bind to the currently opened inline editor only.
  const nearCreate = root.locator(
    'xpath=(.//button[normalize-space()="Create"]/preceding::*[@role="textbox"][contains(@aria-label,"start typing") or contains(@aria-label,"Main content area")])[position() > last()-3]',
  );

  const primary = [];
  const nearCount = await nearCreate.count().catch(() => 0);
  for (let i = 0; i < nearCount; i++) {
    const candidate = nearCreate.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const writable = await isWritable(candidate);
    if (!writable) continue;
    const resolved = await resolveEditableLocator(candidate);
    primary.push(resolved ?? candidate);
  }
  const primaryStable = await orderAndDedupeEditors(primary);
  if (primaryStable.length >= 3) {
    return primaryStable.slice(0, 3);
  }

  // Fallback: collect all visible editors in root.
  const textboxes = root.locator('[role="textbox"][aria-label*="start typing"], [role="textbox"][aria-label*="Main content area"], [role="textbox"]');
  const count = await textboxes.count().catch(() => 0);
  const collected = [];
  for (let i = 0; i < count; i++) {
    const candidate = textboxes.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const writable = await isWritable(candidate);
    if (!writable) continue;
    const resolved = await resolveEditableLocator(candidate);
    collected.push(resolved ?? candidate);
  }
  const stable = await orderAndDedupeEditors(collected);
  return stable.slice(0, 3);
}

async function collectEditorsByLabel(frame) {
  const action = await findEditorByLabelStrict(frame, ['Action*', 'Action']);
  const data = await findEditorByLabelStrict(frame, ['Data']);
  const expected = await findEditorByLabelStrict(frame, ['Expected Result', 'Expected']);
  const editors = [action, data, expected].filter(Boolean);
  const stable = await orderAndDedupeEditors(editors);
  return stable.length === 3 ? stable : [];
}

async function findEditorByLabelStrict(frame, labels) {
  for (const label of labels) {
    const escaped = label.replace(/"/g, '\\"');
    const strictXpaths = [
      `xpath=(//*[normalize-space(.)="${escaped}"]/following::*[@role="textbox"][1])[1]`,
      `xpath=(//*[contains(normalize-space(.), "${escaped}")]/following::*[@role="textbox"][1])[1]`,
      `xpath=(//*[contains(normalize-space(.), "${escaped}")]/following::*[@contenteditable and @contenteditable!="false"][1])[1]`,
    ];

    for (const selector of strictXpaths) {
      const locator = frame.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) continue;
      const resolved = await resolveEditableLocator(locator);
      if (resolved) return resolved;
      if (await isWritable(locator)) return locator;
    }
  }
  return null;
}

async function waitForStepEditorsReady(frame, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const editors = await collectStepEditors(frame);
    if (editors.length >= 3) {
      if (attempt > 1) {
        console.log(`  Step editors became writable on attempt ${attempt}.`);
      }
      return editors;
    }

    if (attempt % 3 === 0) {
      const counts = await frame.evaluate(() => {
        const countVisible = (selector) =>
          Array.from(document.querySelectorAll(selector)).filter((node) => {
            if (!(node instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(node);
            return style.visibility !== 'hidden' && style.display !== 'none' && node.offsetParent !== null;
          }).length;
        return {
          contenteditable: countVisible('[contenteditable]:not([contenteditable="false"])'),
          textboxes: countVisible('[role="textbox"]'),
          textareas: countVisible('textarea'),
          inputs: countVisible('input:not([type="hidden"]):not([readonly])'),
        };
      }).catch(() => null);
      console.log(`  Waiting editors (attempt ${attempt})… ${counts ? JSON.stringify(counts) : 'no-dom-stats'}`);

      // Nudge the Action area to trigger editor activation when lazy-mounted.
      const actionLabel = frame.locator('text=/Action\\*/i').first();
      if (await actionLabel.isVisible({ timeout: 150 }).catch(() => false)) {
        await actionLabel.click().catch(() => {});
      }
    }

    await frame.waitForTimeout(500);
  }

  return [];
}

async function findEditorByLabel(frame, labelText) {
  const containerXpaths = [
    `xpath=(//*[contains(normalize-space(.), "${labelText}")]/ancestor::*[descendant::*[@contenteditable and @contenteditable!="false" or @role="textbox" or contains(@class,"ProseMirror")]][1])[1]`,
    `xpath=(//*[contains(normalize-space(.), "${labelText}")]/parent::*[descendant::*[@contenteditable and @contenteditable!="false" or @role="textbox" or contains(@class,"ProseMirror")]][1])[1]`,
  ];

  for (const selector of containerXpaths) {
    const container = frame.locator(selector).first();
    const visible = await container.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) continue;

    const nested = container.locator('[contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, textarea, input:not([type="hidden"]):not([readonly])');
    const count = await nested.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = nested.nth(index);
      const candidateVisible = await candidate.isVisible().catch(() => false);
      if (!candidateVisible) continue;
      const writable = await isWritable(candidate);
      if (writable) {
        const resolved = await resolveEditableLocator(candidate);
        return resolved ?? candidate;
      }
    }
  }

  const directXpaths = [
    `xpath=(//*[contains(@aria-label, "${labelText}") or contains(@placeholder, "${labelText}")][not(@readonly) and @aria-readonly!="true"])[1]`,
  ];
  for (const selector of directXpaths) {
    const locator = frame.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) continue;
    const writable = await isWritable(locator);
    if (writable) return locator;
  }

  return null;
}

function dedupeLocators(locators) {
  const seen = new Set();
  return locators.filter((locator) => {
    const key = String(locator);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function orderAndDedupeEditors(locators) {
  const keyed = [];
  for (const locator of locators) {
    if (!locator) continue;
    const box = await locator.boundingBox().catch(() => null);
    if (!box) continue;

    const duplicate = keyed.some((item) => {
      const dx = Math.abs(item.box.x - box.x);
      const dy = Math.abs(item.box.y - box.y);
      const dw = Math.abs(item.box.width - box.width);
      const dh = Math.abs(item.box.height - box.height);
      return dx < 4 && dy < 4 && dw < 4 && dh < 4;
    });
    if (!duplicate) {
      keyed.push({ locator, box });
    }
  }

  keyed.sort((a, b) => {
    const yDiff = a.box.y - b.box.y;
    if (Math.abs(yDiff) > 4) return yDiff;
    return a.box.x - b.box.x;
  });

  return keyed.map((item) => item.locator);
}

async function setEditableValue(page, locator, value) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  const resolvedLocator = await resolveEditableLocator(locator);
  if (resolvedLocator) {
    locator = resolvedLocator;
  }

  const tagName = (await locator.evaluate((node) => node.tagName.toLowerCase()).catch(() => '')) || '';
  const contentEditable = await locator.evaluate((node) => node.getAttribute('contenteditable')).catch(() => null);
  const readOnly = await locator.evaluate((node) =>
    node.hasAttribute('readonly') || node.getAttribute('aria-readonly') === 'true',
  ).catch(() => false);

  const shouldPreferTyping = tagName !== 'input' && tagName !== 'textarea';
  if (shouldPreferTyping) {
    const bulletItems = parseBulletItems(value);
    if (bulletItems.length >= 2) {
      const typedList = await tryTypeBulletList(page, locator, bulletItems);
      if (typedList) return;
    }
    const typed = await tryTypeIntoEditor(page, locator, value);
    if (typed) return;
  }

  if ((tagName === 'input' || tagName === 'textarea') && !readOnly) {
    await locator.evaluate((node, nextValue) => {
      node.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(node, nextValue);
      else node.value = nextValue;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.blur();
    }, value);
    return;
  }

  if (isContentEditableValue(contentEditable)) {
    await locator.evaluate((node, nextValue) => {
      node.focus();
      node.innerHTML = '';
      node.textContent = nextValue;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue, inputType: 'insertText' }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.blur();
    }, value);
    return;
  }

  await locator.evaluate((node, nextValue) => {
    const target = node.matches('textarea, input:not([readonly]), [contenteditable]:not([contenteditable="false"]), .ProseMirror')
      ? node
      : node.querySelector?.('textarea, input:not([readonly]), [contenteditable]:not([contenteditable="false"]), .ProseMirror, [role="textbox"] [contenteditable]:not([contenteditable="false"])');

    if (!target) {
      throw new Error('No writable editor found');
    }

    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value = nextValue;
    } else if (target instanceof HTMLElement && target.isContentEditable) {
      target.innerHTML = '';
      target.textContent = nextValue;
    } else {
      target.textContent = nextValue;
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.blur();
  }, value).catch(async () => {
    const typed = await tryTypeIntoEditor(page, locator, value);
    if (!typed) {
      throw new Error('Failed to set editor value via both DOM and typing');
    }
  });
}

async function waitForStepVisible(frame, actionText, timeoutMs = 15_000) {
  const trimmed = asString(actionText).trim();
  if (!trimmed) {
    await frame.waitForTimeout(1_000);
    return;
  }

  const escaped = escapeForRegex(trimmed.slice(0, 80));
  const preview = trimmed.slice(0, 80);
  const exact = frame.locator(`text=/${escaped}/i`).first();
  const previewLocator = frame.locator(`text=${preview}`).first();

  const exactVisible = await exact.isVisible({ timeout: timeoutMs }).catch(() => false);
  if (exactVisible) return;

  const previewVisible = await previewLocator.isVisible({ timeout: 1_500 }).catch(() => false);
  if (previewVisible) return;

  throw new Error(`Step text did not appear after save: "${preview}"`);
}

async function waitForCreateCompletion(frame, scope, actionText, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  const normalizedAction = asString(actionText).trim().toLowerCase();

  while (Date.now() < deadline) {
    const createVisible = await scope.locator('button:has-text("Create")').first()
      .isVisible({ timeout: 200 })
      .catch(() => false);

    const actionInReadonlyArea = normalizedAction
      ? await frame.evaluate((needle) => {
        const nodes = Array.from(document.querySelectorAll('*'));
        return nodes.some((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (node.closest('[contenteditable], [role="textbox"]')) return false;
          const text = (node.innerText || node.textContent || '').trim().toLowerCase();
          return text.includes(needle);
        });
      }, normalizedAction).catch(() => false)
      : true;

    // Best signal: new step text is visible in readonly area.
    // In Xray, after creating a step it may immediately open the next empty editor,
    // which keeps a Create button visible and should still count as completion.
    if (actionInReadonlyArea) {
      await frame.waitForTimeout(600);
      return;
    }

    // Fallback: editor is gone; still add a short settle to avoid last-step race.
    if (!createVisible) {
      await frame.waitForTimeout(1_000);
      return;
    }

    await frame.waitForTimeout(300);
  }

  throw new Error('Timed out waiting for step create completion.');
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function isContentEditableValue(value) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== 'false';
}

async function isWritable(locator) {
  return locator.evaluate((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.getAttribute('aria-readonly') === 'true') return false;
    if (node.hasAttribute('readonly')) return false;
    if (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false') return true;
    if (node instanceof HTMLTextAreaElement) return true;
    if (node instanceof HTMLInputElement) {
      return !node.readOnly && node.type !== 'hidden';
    }
    if (node.getAttribute('role') === 'textbox') {
      if (node instanceof HTMLElement && node.isContentEditable) return true;
      if (node.querySelector?.('[contenteditable]:not([contenteditable="false"]), textarea, input:not([readonly])')) {
        return true;
      }
      return false;
    }
    if (node.classList.contains('ProseMirror')) return true;
    return false;
  }).catch(() => false);
}

async function assertEditorsContainValues(editors, expectedValues) {
  for (let index = 0; index < Math.min(editors.length, expectedValues.length); index++) {
    const expected = normalizeComparisonText(expectedValues[index]);
    if (!expected) continue;
    const actual = normalizeComparisonText(await readEditorValue(editors[index]));
    if (!actual.includes(expected)) {
      throw new Error(`Editor ${index + 1} did not accept value. expected="${truncate(expected, 80)}" actual="${truncate(actual, 80)}"`);
    }
  }
}

async function readEditorValue(locator) {
  return locator.evaluate((node) => {
    const readNode = (target) => {
      if (!(target instanceof HTMLElement)) return '';
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return target.value || '';
      }
      return target.innerText || target.textContent || '';
    };

    if (node instanceof HTMLElement && node.isContentEditable) {
      return readNode(node);
    }

    const nested = node.querySelector?.('[contenteditable]:not([contenteditable="false"]), .ProseMirror, [role="textbox"] [contenteditable]:not([contenteditable="false"]), textarea, input:not([readonly])');
    if (nested) return readNode(nested);
    return readNode(node);
  }).catch(() => '');
}

async function resolveEditableLocator(locator) {
  const selfEditable = await locator.evaluate((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return !node.readOnly;
    if (node.isContentEditable) return true;
    if (node.classList.contains('ProseMirror')) return true;
    return false;
  }).catch(() => false);
  if (selfEditable) return locator;

  const nested = locator.locator(
    '[contenteditable]:not([contenteditable="false"]), .ProseMirror, [role="textbox"] [contenteditable]:not([contenteditable="false"]), textarea, input:not([readonly])',
  ).first();
  const visible = await nested.isVisible({ timeout: 200 }).catch(() => false);
  if (visible) return nested;

  return null;
}

async function tryTypeIntoEditor(page, locator, value) {
  try {
    await locator.click({ force: true, timeout: 2_000, position: { x: 24, y: 24 } }).catch(async () => {
      await locator.focus({ timeout: 2_000 });
    });
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    if (value) {
      await page.keyboard.insertText(value);
    }
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(120);
    const actual = await readEditorValue(locator);
    const expected = asString(value).trim();
    if (!expected) return true;
    return actual.toLowerCase().includes(expected.toLowerCase());
  } catch {
    return false;
  }
}

async function tryTypeBulletList(page, locator, items) {
  try {
    await locator.click({ force: true, timeout: 2_000, position: { x: 24, y: 24 } }).catch(async () => {
      await locator.focus({ timeout: 2_000 });
    });
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});

    // Atlassian rich editor shortcut for bullet list.
    await page.keyboard.press('Meta+Shift+8').catch(() => {});
    await page.keyboard.press('Control+Shift+8').catch(() => {});

    for (let i = 0; i < items.length; i++) {
      if (items[i]) {
        await page.keyboard.insertText(items[i]);
      }
      if (i < items.length - 1) {
        await page.keyboard.press('Enter').catch(() => {});
      }
    }
    // Do NOT use Tab here: in Atlassian list editor, Tab indents the current item.
    await locator.evaluate((node) => {
      if (node instanceof HTMLElement) node.blur();
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    }).catch(() => {});
    await page.waitForTimeout(120);
    const actual = normalizeComparisonText(await readEditorValue(locator));
    const expected = normalizeComparisonText(items.join('\n'));
    return expected ? actual.includes(expected.slice(0, Math.min(expected.length, 80))) : true;
  } catch {
    return false;
  }
}

function parseBulletItems(value) {
  const lines = asString(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const items = lines.map((line) => line.replace(/^[\-\*\u2022]\s*/, '').trim()).filter(Boolean);
  return items.length >= 2 ? items : [];
}

function normalizeComparisonText(value) {
  return asString(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/^[\-\*\u2022]\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function waitForInlineEditor(frame, timeoutMs = 10_000) {
  const candidates = [
    'button:has-text("Create")',
    'text=/Action\\*/i',
    'text=/Expected/i',
    '[contenteditable]:not([contenteditable="false"])',
    '.ProseMirror',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      const visible = await frame.locator(selector).first().isVisible({ timeout: 300 }).catch(() => false);
      if (visible) {
        console.log(`  Inline editor appeared via selector: ${selector}`);
        await frame.waitForTimeout(300);
        return;
      }
    }
    await frame.waitForTimeout(300);
  }
}

function prepareDebugDir(issueKey) {
  const dir = path.join(DEBUG_ROOT, issueKey);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function prepareFinalDir() {
  mkdirSync(FINAL_ROOT, { recursive: true });
  return FINAL_ROOT;
}

async function saveDebugScreenshot(page, debugDir, label) {
  const filePath = path.join(debugDir, `${label}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`  Debug screenshot: ${filePath}`);
}

async function saveFrameDebugSnapshot(frame, debugDir, label) {
  const summary = await frame.locator('button, [role="tab"], [role="menuitem"], [contenteditable], [role="textbox"]')
    .evaluateAll((nodes) => nodes.map((node) => ({
      tag: node.tagName,
      text: (node.innerText || '').trim(),
      role: node.getAttribute('role'),
      aria: node.getAttribute('aria-label'),
      testid: node.getAttribute('data-testid'),
    })).filter((entry) => entry.text || entry.role || entry.aria || entry.testid))
    .catch(() => []);
  const filePath = path.join(debugDir, `${label}.json`);
  writeFileSync(filePath, JSON.stringify(summary, null, 2));
  console.log(`  Debug frame snapshot: ${filePath}`);
}

async function collectVisibleButtonTexts(frame) {
  return frame.locator('button, [role="button"], [role="tab"], [role="menuitem"]')
    .evaluateAll((nodes) => nodes
      .map((node) => (node.innerText || node.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
      .slice(0, 20))
    .catch(() => []);
}

async function isHeaderOnlyScope(scope) {
  const buttons = await collectVisibleButtonTexts(scope);
  if (buttons.length === 0) return false;
  const normalized = buttons.map((item) => item.toLowerCase());
  return (
    normalized.length <= 3
    && normalized.some((item) => item.includes('more actions for test details'))
    && !normalized.some((item) => item.includes('add step'))
  );
}

async function hasLoadingSkeleton(scope) {
  const selectors = [
    '[data-testid*="skeleton"]',
    '[class*="skeleton"]',
    '[class*="Skeleton"]',
  ];

  for (const selector of selectors) {
    const visible = await scope.locator(selector).first().isVisible({ timeout: 200 }).catch(() => false);
    if (visible) return true;
  }

  return false;
}

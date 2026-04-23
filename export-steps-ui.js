/**
 * UI automation export — Xray test steps → CSV
 *
 * Connects to an already-running Chrome instance (via CDP) and clicks
 * the Xray "Export → To csv…" button on a Jira ticket page.
 *
 * Prerequisites:
 *   1. sh start-chrome-debug.sh      ← opens Chrome with --remote-debugging-port=9222
 *   2. Log in to Jira in that Chrome window (Google SSO, normally)
 *   3. Then run this script
 *
 * Usage:
 *   node export-steps-ui.js ACIOSMAU-88
 *   node export-steps-ui.js --issue ACIOSMAU-88 [--output ./output]
 */

import 'dotenv/config';
import { exportStepsViaUI } from './src/playwright/exportSteps.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const issueKey  = getArg('--issue') ?? args.find((a) => !a.startsWith('--')) ?? process.env.JIRA_ISSUE_KEY;
const outputDir = getArg('--output') ?? process.env.OUTPUT_DIR ?? './output';

if (!issueKey) {
  console.error(
    'Usage:\n'
    + '  node export-steps-ui.js ACIOSMAU-88\n'
    + '  node export-steps-ui.js --issue ACIOSMAU-88\n'
    + '\nOr set JIRA_ISSUE_KEY in .env\n'
    + '\nMake sure Chrome is running with remote debugging first:\n'
    + '  sh start-chrome-debug.sh'
  );
  process.exit(1);
}

// ── Validate env ──────────────────────────────────────────────────────────────

const { JIRA_BASE_URL } = process.env;

if (!JIRA_BASE_URL) {
  console.error('Error: missing environment variable JIRA_BASE_URL. Check your .env file.');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\nExporting Xray steps for ${issueKey} via browser UI (CDP)`);
console.log('Make sure Chrome is running: sh start-chrome-debug.sh\n');

try {
  const csvPath = await exportStepsViaUI({
    jiraBaseUrl: JIRA_BASE_URL,
    issueKey,
    outputDir,
  });

  console.log(`\nDone. Steps CSV → ${csvPath}`);
} catch (err) {
  console.error(`\nExport failed: ${err.message}`);
  process.exit(1);
}

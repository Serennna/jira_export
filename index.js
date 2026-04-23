/**
 * Jira + Xray test-step exporter
 *
 * Single ticket:
 *   node index.js ACANDMAU-499
 *
 * Bulk by project + issue type:
 *   node index.js --project ACIOSMAU --type Test
 *
 * Bulk by raw JQL:
 *   node index.js --jql "project = ACIOSMAU AND issuetype = Test ORDER BY created DESC"
 *
 * Output files (in ./output/):
 *   <label>_tickets.csv  — one row per Jira ticket
 *   <label>_steps.csv    — one row per test step (requires Xray keys — currently disabled)
 */

import 'dotenv/config';
import { JiraClient } from './src/jiraClient.js';
// import { XrayClient } from './src/xrayClient.js';  // TODO: re-enable when Xray API keys are available
import { exportToCsv } from './src/csvExporter.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);

  // --jql "..."
  const jqlIdx = args.indexOf('--jql');
  if (jqlIdx !== -1) {
    return { mode: 'jql', jql: args[jqlIdx + 1] };
  }

  // --project FOO [--type Bar]
  const projectIdx = args.indexOf('--project');
  if (projectIdx !== -1) {
    const project = args[projectIdx + 1];
    const typeIdx  = args.indexOf('--type');
    const issueType = typeIdx !== -1 ? args[typeIdx + 1] : null;
    return { mode: 'bulk', project, issueType };
  }

  // plain issue key, e.g. ACANDMAU-499
  const issueKey = args[0] || process.env.JIRA_ISSUE_KEY;
  if (issueKey) return { mode: 'single', issueKey };

  return null;
}

const parsed = parseArgs(process.argv);
if (!parsed) {
  console.error(
    'Usage:\n' +
    '  node index.js ACANDMAU-499\n' +
    '  node index.js --project ACIOSMAU --type Test\n' +
    '  node index.js --jql "project = ACIOSMAU AND issuetype = Test"\n' +
    '\nOr set JIRA_ISSUE_KEY in .env for single-ticket mode.'
  );
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  // XRAY_CLIENT_ID,     // TODO: re-enable when Xray API keys are available
  // XRAY_CLIENT_SECRET, // TODO: re-enable when Xray API keys are available
  OUTPUT_DIR = './output',
} = process.env;

for (const [name, val] of Object.entries({ JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN })) {
  if (!val) {
    console.error(`Error: missing environment variable ${name}. Check your .env file.`);
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const jira = new JiraClient({ baseUrl: JIRA_BASE_URL, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN });

  let tickets = [];
  let label   = '';

  if (parsed.mode === 'single') {
    // ── Single ticket ──────────────────────────────────────────────────────────
    const { issueKey } = parsed;
    console.log(`\nExporting ${issueKey} from ${JIRA_BASE_URL}\n`);
    console.log('Fetching Jira ticket…');

    let rawIssue;
    try {
      rawIssue = await jira.getIssue(issueKey);
    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.errorMessages?.join(', ') ?? err.message;
      console.error(`Jira API error (${status ?? 'network'}): ${msg}`);
      process.exit(1);
    }

    tickets = [JiraClient.summarize(rawIssue)];
    label   = issueKey;
    console.log(`  Found: [${tickets[0].issueType}] ${tickets[0].summary} — ${tickets[0].status}`);

  } else {
    // ── Bulk (JQL or project+type) ─────────────────────────────────────────────
    let jql;
    if (parsed.mode === 'jql') {
      jql   = parsed.jql;
      label = 'bulk_export';
    } else {
      const { project, issueType } = parsed;
      jql   = `project = ${project}${issueType ? ` AND issuetype = "${issueType}"` : ''} ORDER BY created DESC`;
      label = issueType ? `${project}_${issueType}` : project;
    }

    console.log(`\nExporting from ${JIRA_BASE_URL}`);
    console.log(`JQL: ${jql}\n`);
    console.log('Fetching tickets…');

    try {
      tickets = await jira.searchIssues(jql);
    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.errorMessages?.join(', ') ?? err.message;
      console.error(`Jira API error (${status ?? 'network'}): ${msg}`);
      process.exit(1);
    }

    console.log(`  Found ${tickets.length} ticket${tickets.length !== 1 ? 's' : ''}`);
  }

  // ── Xray test steps ──────────────────────────────────────────────────────────
  // NOTE: Xray Cloud stores test steps in its own database, not in the standard
  // Jira REST API. There is no alternative way to retrieve them without Xray
  // API credentials (Client ID + Client Secret).
  // Re-enable the block below once the keys are available.
  //
  // console.log('\nFetching Xray test steps…');
  // const xray = new XrayClient({ clientId: XRAY_CLIENT_ID, clientSecret: XRAY_CLIENT_SECRET });
  // let steps = [];
  // try {
  //   await xray.authenticate();
  //   // For bulk mode, fetch steps for each ticket individually
  //   const allSteps = await Promise.all(
  //     tickets.map((t) => xray.getSteps(t.key, 'auto'))
  //   );
  //   steps = allSteps.flat();
  //   console.log(`  Found ${steps.length} step(s) across ${tickets.length} ticket(s)`);
  // } catch (err) {
  //   const detail = err.response?.data ?? err.message;
  //   console.warn(`  Warning: could not fetch Xray steps — ${JSON.stringify(detail)}`);
  //   console.warn('  Continuing with empty steps…');
  // }

  const steps = []; // placeholder until Xray keys are available

  // ── Export to CSV ─────────────────────────────────────────────────────────────
  console.log(`\nWriting CSV to ${OUTPUT_DIR}/`);
  const { ticketFile, stepsFile } = await exportToCsv({ tickets, steps, outputDir: OUTPUT_DIR, label });

  console.log(`\nDone.`);
  console.log(`  Tickets : ${ticketFile}`);
  console.log(`  Steps   : ${stepsFile}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

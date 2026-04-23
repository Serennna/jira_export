/**
 * Full Jira + Xray export — ticket data (REST API) + test steps (Playwright)
 *
 * Prerequisites:
 *   Run "node login.js" once to save your Jira session.
 *
 * Usage:
 *   Single ticket:
 *     node export-full.js ACANDMAU-1538
 *     node export-full.js ACIOSMAU-1985 --output ./output/ios
 *
 *   Bulk (project + type):
 *     node export-full.js --project ACANDMAU --type Test --output ./output/android
 *
 *   Bulk (raw JQL):
 *     node export-full.js --jql "project = ACANDMAU AND issuetype = Test ORDER BY created DESC"
 *
 *   Skip Xray step capture (tickets CSV only):
 *     node export-full.js ACANDMAU-1538 --no-steps
 *
 * Options:
 *   --output <dir>   override the output directory (default: OUTPUT_DIR in .env or ./output)
 *   --no-steps       skip Xray step capture, write tickets CSV only
 *
 * Output files:
 *   <outputDir>/<label>_tickets.csv   — one row per Jira ticket
 *   <outputDir>/<label>_steps.csv     — one row per Xray test step
 */

import 'dotenv/config';
import { JiraClient }       from './src/jiraClient.js';
import { captureXraySteps } from './src/playwright/captureSteps.js';
import { exportToCsv }      from './src/csvExporter.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const noSteps = args.includes('--no-steps');

  // --output <dir>
  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : null;

  const jqlIdx = args.indexOf('--jql');
  if (jqlIdx !== -1) return { mode: 'jql', jql: args[jqlIdx + 1], noSteps, outputDir };

  const projectIdx = args.indexOf('--project');
  if (projectIdx !== -1) {
    const project   = args[projectIdx + 1];
    const typeIdx   = args.indexOf('--type');
    const issueType = typeIdx !== -1 ? args[typeIdx + 1] : null;
    return { mode: 'bulk', project, issueType, noSteps, outputDir };
  }

  const issueKey = args.find((a) => !a.startsWith('--')) ?? process.env.JIRA_ISSUE_KEY;
  if (issueKey) return { mode: 'single', issueKey, noSteps, outputDir };

  return null;
}

const parsed = parseArgs(process.argv);
if (!parsed) {
  console.error(
    'Usage:\n'
    + '  node export-full.js ACANDMAU-1538\n'
    + '  node export-full.js ACANDMAU-1538 --output ./output/android\n'
    + '  node export-full.js --project ACANDMAU --type Test\n'
    + '  node export-full.js --jql "project = ACANDMAU AND issuetype = Test"\n'
    + '\nOptions:\n'
    + '  --output <dir>   output directory (default: OUTPUT_DIR in .env or ./output)\n'
    + '  --no-steps       skip Xray step capture\n'
    + '\nOr set JIRA_ISSUE_KEY in .env for single-ticket mode.',
  );
  process.exit(1);
}

// ── Env ───────────────────────────────────────────────────────────────────────

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
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

  // ── 1. Fetch Jira ticket(s) via REST API ───────────────────────────────────

  if (parsed.mode === 'single') {
    const { issueKey } = parsed;
    console.log(`\nExporting ${issueKey}\n`);
    console.log('Fetching Jira ticket…');

    let raw;
    try { raw = await jira.getIssue(issueKey); }
    catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.errorMessages?.join(', ') ?? err.message;
      console.error(`Jira API error (${status ?? 'network'}): ${msg}`);
      process.exit(1);
    }

    tickets = [JiraClient.summarize(raw)];
    label   = issueKey;
    console.log(`  Found: [${tickets[0].issueType}] ${tickets[0].summary} — ${tickets[0].status}`);

  } else {
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

    try { tickets = await jira.searchIssues(jql); }
    catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.errorMessages?.join(', ') ?? err.message;
      console.error(`Jira API error (${status ?? 'network'}): ${msg}`);
      process.exit(1);
    }

    console.log(`  Found ${tickets.length} ticket(s)`);
  }

  // ── 2. Capture Xray test steps via Playwright ──────────────────────────────

  let steps = [];

  if (parsed.noSteps) {
    console.log('\n(Skipping Xray steps — --no-steps flag set)');
  } else {
    // Only attempt step capture for "Test" issue types
    const testTickets = tickets.filter(
      (t) => t.issueType?.toLowerCase().includes('test'),
    );

    if (testTickets.length === 0) {
      console.log('\nNo Test-type tickets found — skipping Xray step capture.');
    } else {
      console.log(`\nCapturing Xray test steps for ${testTickets.length} ticket(s) via Playwright…`);
      console.log('(Make sure Chrome is running with debug port: sh start-chrome-debug.sh)\n');

      for (const ticket of testTickets) {
        console.log(`\n[${ticket.key}] ${ticket.summary}`);
        try {
          const ticketSteps = await captureXraySteps({
            jiraBaseUrl: JIRA_BASE_URL,
            issueKey:    ticket.key,
          });
          steps.push(...ticketSteps);
        } catch (err) {
          console.warn(`  Warning: could not capture steps for ${ticket.key} — ${err.message}`);
          console.warn('  Continuing with next ticket…');
        }
      }

      console.log(`\nTotal steps captured: ${steps.length}`);
    }
  }

  // ── 3. Export to CSV ───────────────────────────────────────────────────────

  console.log(`\nWriting CSV files to ${OUTPUT_DIR}/…`);
  const { ticketFile, stepsFile } = await exportToCsv({
    tickets,
    steps,
    outputDir: OUTPUT_DIR,
    label,
  });

  console.log('\nDone.');
  console.log(`  Tickets : ${ticketFile}  (${tickets.length} row(s))`);
  console.log(`  Steps   : ${stepsFile}  (${steps.length} row(s))`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

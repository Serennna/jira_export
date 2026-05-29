import 'dotenv/config';
import { readFile } from 'fs/promises';
import { JiraClient } from './src/jiraClient.js';
import { ensureJiraImportSession, importXraySteps } from './src/playwright/importSteps.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    filePath: args.find((arg) => !arg.startsWith('--')) ?? 'testcase_to_import.json',
    dryRun: args.includes('--dry-run'),
    continueOnError: !args.includes('--fail-fast'),
    debug: args.includes('--debug'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  console.log(
    'Usage:\n'
    + '  node import-tests.js\n'
    + '  node import-tests.js testcase_to_import.json\n'
    + '  node import-tests.js testcase_to_import.json --dry-run\n'
    + '  node import-tests.js testcase_to_import.json --fail-fast\n'
    + '  node import-tests.js testcase_to_import.json --debug\n'
    + '\nJSON format:\n'
    + '  [\n'
    + '    {\n'
    + '      "testKey": "ACIOSMAU-2061",\n'
    + '      "projectKey": "ACIOSMAU",\n'
    + '      "summary": "Manual test title",\n'
    + '      "description": "Optional description",\n'
    + '      "labels": ["regression", "smoke"],\n'
    + '      "steps": [\n'
    + '        { "action": "Open app", "data": "", "result": "App opens" }\n'
    + '      ]\n'
    + '    }\n'
    + '  ]\n'
    + '\nExecution order per record: create/use issue -> transition to "Ready for Review" -> import steps.'
    + '\nDefault mode is continue-on-error; use --fail-fast to stop on first error.'
    + '\nDebug screenshots are disabled by default; use --debug to write output/import-debug.',
  );
}

function asString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function normalizeLabels(labels, recordLabel) {
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) {
    throw new Error(`${recordLabel}: "labels" must be an array of strings`);
  }

  return labels
    .map((label) => asString(label).trim())
    .filter(Boolean);
}

function normalizeSteps(steps, recordLabel) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${recordLabel}: "steps" must be a non-empty array`);
  }

  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${recordLabel}: step ${index + 1} must be an object`);
    }

    return {
      action: asString(step.action).trim(),
      data: asString(step.data).trim(),
      result: asString(step.result).trim(),
    };
  });
}

function normalizeRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Record ${index + 1} must be an object`);
  }

  const recordLabel = `Record ${index + 1}`;
  const testKey = asString(record.testKey).trim();
  const projectKey = asString(record.projectKey).trim();
  const summary = asString(record.summary).trim();
  const description = asString(record.description).trim();
  const labels = normalizeLabels(record.labels, recordLabel);
  const steps = normalizeSteps(record.steps, recordLabel);

  if (!testKey && !projectKey) throw new Error(`${recordLabel}: "projectKey" is required when creating a new Test`);
  if (!testKey && !summary) throw new Error(`${recordLabel}: "summary" is required when creating a new Test`);

  return {
    testKey,
    projectKey,
    summary,
    description,
    labels,
    steps,
  };
}

async function loadRecords(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const records = Array.isArray(parsed) ? parsed : [parsed];

  if (records.length === 0) {
    throw new Error('Import file is empty');
  }

  return records.map(normalizeRecord);
}

async function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.help) {
    printUsage();
    return;
  }

  const records = await loadRecords(parsed.filePath);
  console.log(`Loaded ${records.length} test definition(s) from ${parsed.filePath}`);

  if (parsed.dryRun) {
    for (const [index, record] of records.entries()) {
      console.log(
        `  [${index + 1}] ${record.testKey ? `import into ${record.testKey}` : `create Test in ${record.projectKey} · ${record.summary}`} · `
        + `${record.steps.length} step(s) · labels: ${record.labels.join(', ') || '(none)'}`,
      );
    }
    console.log('\nDry run only. No changes were sent to Jira/Xray.');
    return;
  }

  const {
    JIRA_BASE_URL,
    JIRA_EMAIL,
    JIRA_API_TOKEN,
  } = process.env;

  for (const [name, value] of Object.entries({ JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN })) {
    if (!value) {
      throw new Error(`Missing environment variable ${name}. Add it to .env before importing tests.`);
    }
  }

  const jira = new JiraClient({
    baseUrl: JIRA_BASE_URL,
    email: JIRA_EMAIL,
    apiToken: JIRA_API_TOKEN,
  });

  const results = [];
  let failedCount = 0;

  console.log('\nChecking Jira browser session for UI step import...');
  await ensureJiraImportSession(JIRA_BASE_URL);
  console.log('Jira browser session is ready.');

  for (const [index, record] of records.entries()) {
    let issueKey = record.testKey || '';
    let issueId = '';

    try {
      let currentStatus = '';
      if (record.testKey) {
        console.log(`\n[${index + 1}/${records.length}] Using existing Jira Test ${record.testKey}…`);
        const existing = await jira.getIssue(record.testKey);
        issueKey = existing.key;
        issueId = existing.id;
        currentStatus = existing.fields?.status?.name ?? '';
      } else {
        console.log(`\n[${index + 1}/${records.length}] Creating Jira Test…`);
        const created = await jira.createIssue({
          projectKey: record.projectKey,
          issueTypeName: 'Test',
          summary: record.summary,
          description: record.description,
          labels: record.labels,
        });

        issueKey = created.key;
        issueId = created.id;
        console.log(`  Created ${issueKey}`);
      }

      if (currentStatus.trim().toLowerCase() === 'ready for review') {
        console.log(`  ${issueKey} is already in "Ready for Review"; skipping transition.`);
      } else {
        console.log(`  Transitioning ${issueKey} to "Ready for Review"…`);
        await jira.transitionIssueToStatus(issueKey, 'Ready for Review');
        console.log('  Transition complete.');
      }

      const importedSteps = await importXraySteps({
        jiraBaseUrl: JIRA_BASE_URL,
        issueKey,
        issueId,
        steps: record.steps,
        debug: parsed.debug,
        captureFinalScreenshot: true,
      });

      results.push({
        key: issueKey,
        steps: importedSteps.length,
        labels: record.labels,
        ok: true,
      });
    } catch (error) {
      failedCount += 1;
      const itemKey = issueKey || `record-${index + 1}`;
      const message = error?.message || String(error);
      console.error(`  Failed ${itemKey}: ${message}`);
      results.push({
        key: itemKey,
        steps: 0,
        labels: record.labels,
        ok: false,
        error: message,
      });

      if (!parsed.continueOnError) {
        throw error;
      }
    }
  }

  console.log('\nImport complete.');
  for (const result of results) {
    if (result.ok) {
      console.log(
        `  OK    ${result.key} · ${result.steps} step(s) · labels: ${result.labels.join(', ') || '(none)'}`,
      );
    } else {
      console.log(
        `  FAIL  ${result.key} · ${result.error}`,
      );
    }
  }

  if (failedCount > 0) {
    console.log(`\nCompleted with ${failedCount} failure(s).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
});

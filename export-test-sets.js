/**
 * Export all Test Sets from a Jira/Xray project, together with the Tests
 * they contain and each Test's step-by-step instructions.
 *
 * Prerequisites:
 *   Run "node login.js" once to save your Jira session.
 *
 * Usage:
 *   # Default: all Test Sets in ACIOSMAU
 *   node export-test-sets.js
 *
 *   # Different project
 *   node export-test-sets.js --project ACANDMAU
 *
 *   # Custom JQL
 *   node export-test-sets.js --jql "project = ACIOSMAU AND issuetype = 'Test Set'"
 *
 *   # Custom output directory
 *   node export-test-sets.js --output ./output/ios
 *
 *   # Filter by summary tag (substring match, case-insensitive)
 *   node export-test-sets.js --filter "[NS]"
 *   node export-test-sets.js --filter "[NR]"
 *   node export-test-sets.js --filter "[NS],[NR]"   # multiple, comma-separated
 *
 *   # Skip step capture (just map Test Sets → Tests)
 *   node export-test-sets.js --no-steps
 *
 * Output:
 *   <outputDir>/ACIOSMAU_TestSets_mapping.csv   — TestSet → Test mapping
 *   <outputDir>/ACIOSMAU_TestSets_steps.csv     — one row per step
 *   <outputDir>/ACIOSMAU_TestSets_merged.xlsx   — hierarchical Excel
 *     Columns: Test Set Key | Test Set Summary | Test Set Status
 *              | Test Key | Test Summary | Test Status | Test Type
 *              | Step # | Action | Test Data | Expected Result
 */

import 'dotenv/config';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import ExcelJS from 'exceljs';

import { JiraClient }           from './src/jiraClient.js';
import { captureTestSetTests }  from './src/playwright/captureTestSetTests.js';
import { captureXraySteps }     from './src/playwright/captureSteps.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);

  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };

  return {
    project:   get('--project') ?? 'ACIOSMAU',
    jql:       get('--jql')     ?? null,
    outputDir: get('--output')  ?? null,
    filter:    get('--filter')  ?? null,   // e.g. "[NS]" or "[NS],[NR]"
    noSteps:   args.includes('--no-steps'),
  };
}

const parsed = parseArgs(process.argv);

// ── Env ───────────────────────────────────────────────────────────────────────

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  OUTPUT_DIR: OUTPUT_DIR_ENV = './output',
} = process.env;

for (const [name, val] of Object.entries({ JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN })) {
  if (!val) {
    console.error(`Error: missing environment variable ${name}. Check your .env file.`);
    process.exit(1);
  }
}

const OUTPUT_DIR = parsed.outputDir ?? OUTPUT_DIR_ENV;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const jira = new JiraClient({
    baseUrl:  JIRA_BASE_URL,
    email:    JIRA_EMAIL,
    apiToken: JIRA_API_TOKEN,
  });

  // ── 1. Fetch Test Set issues via Jira REST API ─────────────────────────────

  const jql = parsed.jql
    ?? `project = ${parsed.project} AND issuetype = "Test Set" ORDER BY created DESC`;

  console.log(`\nFetching Test Sets…`);
  console.log(`JQL: ${jql}\n`);

  let testSets;
  try {
    testSets = await jira.searchIssues(jql);
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.errorMessages?.join(', ') ?? err.message;
    console.error(`Jira API error (${status ?? 'network'}): ${msg}`);
    process.exit(1);
  }

  console.log(`Found ${testSets.length} Test Set(s) total`);

  // ── Filter by summary tag (--filter flag) ──────────────────────────────────
  if (parsed.filter) {
    const tags = parsed.filter.split(',').map((t) => t.trim()).filter(Boolean);
    const beforeFilter = testSets.length;
    testSets = testSets.filter((ts) =>
      tags.some((tag) => ts.summary.toLowerCase().includes(tag.toLowerCase())),
    );
    console.log(`Kept ${testSets.length}/${beforeFilter} matching filter: ${tags.join(', ')}\n`);
  } else {
    console.log('(No --filter applied — exporting all Test Sets)\n');
  }

  if (testSets.length === 0) {
    console.log('Nothing to export.');
    return;
  }

  // ── 2. For each Test Set, capture the contained Test keys via Playwright ───

  // Map: testSetKey → string[]
  const setToTests = new Map();
  const allTestKeys = new Set();

  console.log('Capturing Tests per Test Set via Playwright…');
  console.log('(Requires a valid session — run "node login.js" if needed)\n');

  for (const ts of testSets) {
    console.log(`\n[${ts.key}] ${ts.summary}`);
    try {
      const { keys, rawIds } = await captureTestSetTests({
        jiraBaseUrl: JIRA_BASE_URL,
        issueKey:    ts.key,
        waitMs:      15_000,   // extra wait after networkidle for lazy Xray iframe
      });

      // Resolve any raw numeric IDs to Jira issue keys
      const resolvedFromIds = [];
      for (const id of rawIds) {
        try {
          const raw = await jira.getIssue(id);
          resolvedFromIds.push(raw.key);
        } catch {
          console.warn(`  ⚠ Could not resolve issueId ${id} to a key — skipping`);
        }
      }

      const combined = [...new Set([...keys, ...resolvedFromIds])];
      setToTests.set(ts.key, combined);
      for (const k of combined) allTestKeys.add(k);

      console.log(`  → ${combined.length} test(s): ${combined.slice(0, 5).join(', ')}${combined.length > 5 ? '…' : ''}`);
    } catch (err) {
      console.warn(`  ⚠ Could not capture tests for ${ts.key} — ${err.message}`);
      setToTests.set(ts.key, []);
    }
  }

  console.log(`\nTotal unique tests across all sets: ${allTestKeys.size}`);

  // ── 3. Fetch Test ticket data from Jira ────────────────────────────────────

  console.log('\nFetching Test ticket data from Jira…');

  // Map: testKey → summarized ticket object
  const testTickets = new Map();

  for (const key of allTestKeys) {
    try {
      const raw = await jira.getIssue(key);
      testTickets.set(key, JiraClient.summarize(raw));
    } catch (err) {
      const status = err.response?.status;
      console.warn(`  ⚠ Could not fetch ${key} (${status ?? err.message}) — skipping`);
    }
  }

  console.log(`  Fetched ${testTickets.size}/${allTestKeys.size} test ticket(s)`);

  // ── 4. Capture steps per Test ──────────────────────────────────────────────

  // Map: testKey → step[]
  const testSteps = new Map();

  if (parsed.noSteps) {
    console.log('\n(Skipping step capture — --no-steps flag set)');
  } else {
    console.log(`\nCapturing Xray steps for ${testTickets.size} test(s)…\n`);

    // Retry delays (ms) between attempts 1→2, 2→3
    const RETRY_DELAYS = [3_000, 6_000];

    for (const [key, ticket] of testTickets) {
      console.log(`\n[${key}] ${ticket.summary}`);
      let steps = [];

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          steps = await captureXraySteps({ jiraBaseUrl: JIRA_BASE_URL, issueKey: key });
          if (steps.length > 0) break;

          if (attempt < 3) {
            const delay = RETRY_DELAYS[attempt - 1];
            console.log(`  (attempt ${attempt}: 0 steps — retrying in ${delay / 1000}s…)`);
            await sleep(delay);
          }
        } catch (err) {
          console.warn(`  ⚠ Attempt ${attempt} failed: ${err.message}`);
          if (attempt < 3) {
            const delay = RETRY_DELAYS[attempt - 1];
            console.log(`  ↻ Retrying in ${delay / 1000}s…`);
            await sleep(delay);
          }
        }
      }

      if (steps.length === 0) console.warn(`  ⚠ No steps captured after 3 attempts`);
      testSteps.set(key, steps);
    }
  }

  // ── 4.5. Write per-ticket CSV files ──────────────────────────────────────────

  console.log(`\nWriting per-ticket CSV files to ${OUTPUT_DIR}/…`);

  const TICKET_CSV_HEADER = [
    { id: 'key',         title: 'Key'         },
    { id: 'summary',     title: 'Summary'     },
    { id: 'issueType',   title: 'Issue Type'  },
    { id: 'status',      title: 'Status'      },
    { id: 'priority',    title: 'Priority'    },
    { id: 'assignee',    title: 'Assignee'    },
    { id: 'reporter',    title: 'Reporter'    },
    { id: 'labels',      title: 'Labels'      },
    { id: 'description', title: 'Description' },
    { id: 'url',         title: 'URL'         },
  ];

  const STEPS_CSV_HEADER = [
    { id: 'testKey',   title: 'Test Key'        },
    { id: 'stepIndex', title: 'Step #'          },
    { id: 'action',    title: 'Action'          },
    { id: 'data',      title: 'Test Data'       },
    { id: 'result',    title: 'Expected Result' },
  ];

  let perTicketWritten = 0;
  for (const [key, ticket] of testTickets) {
    // Individual ticket info CSV
    const ticketCsvPath = path.join(OUTPUT_DIR, `${key}_tickets.csv`);
    const ticketWriter = createObjectCsvWriter({ path: ticketCsvPath, header: TICKET_CSV_HEADER });
    await ticketWriter.writeRecords([ticket]);

    // Individual steps CSV
    const steps = testSteps.get(key) ?? [];
    const stepsCsvPath = path.join(OUTPUT_DIR, `${key}_steps.csv`);
    const stepsWriter = createObjectCsvWriter({ path: stepsCsvPath, header: STEPS_CSV_HEADER });
    await stepsWriter.writeRecords(steps.map((s) => ({
      testKey:   key,
      stepIndex: s.stepIndex,
      action:    s.action,
      data:      s.data,
      result:    s.result,
    })));

    perTicketWritten++;
  }
  console.log(`  Wrote ${perTicketWritten} ticket CSV pair(s)`);

  // ── 5. Build flat rows for output ─────────────────────────────────────────

  /**
   * Each row:
   * { testSetKey, testSetSummary, testSetStatus,
   *   testKey, testSummary, testStatus, testType,
   *   stepIndex, action, data, result }
   */
  const rows = [];

  for (const ts of testSets) {
    const containedKeys = setToTests.get(ts.key) ?? [];

    if (containedKeys.length === 0) {
      // Emit one row for the Test Set with no test / step data
      rows.push({
        testSetKey:     ts.key,
        testSetSummary: ts.summary,
        testSetStatus:  ts.status,
        testKey:        '',
        testSummary:    '',
        testStatus:     '',
        testType:       '',
        stepIndex:      '',
        action:         '',
        data:           '',
        result:         '',
      });
      continue;
    }

    for (const testKey of containedKeys) {
      const ticket = testTickets.get(testKey);
      if (!ticket) continue;

      const steps = testSteps.get(testKey) ?? [];

      if (steps.length === 0) {
        rows.push({
          testSetKey:     ts.key,
          testSetSummary: ts.summary,
          testSetStatus:  ts.status,
          testKey:        ticket.key,
          testSummary:    ticket.summary,
          testStatus:     ticket.status,
          testType:       ticket.issueType,
          priority:       ticket.priority    ?? '',
          assignee:       ticket.assignee    ?? '',
          reporter:       ticket.reporter    ?? '',
          labels:         ticket.labels      ?? '',
          description:    ticket.description ?? '',
          url:            ticket.url         ?? '',
          stepIndex:      '',
          action:         '',
          data:           '',
          result:         '',
        });
      } else {
        for (const s of steps) {
          rows.push({
            testSetKey:     ts.key,
            testSetSummary: ts.summary,
            testSetStatus:  ts.status,
            testKey:        ticket.key,
            testSummary:    ticket.summary,
            testStatus:     ticket.status,
            testType:       ticket.issueType,
            priority:       ticket.priority    ?? '',
            assignee:       ticket.assignee    ?? '',
            reporter:       ticket.reporter    ?? '',
            labels:         ticket.labels      ?? '',
            description:    ticket.description ?? '',
            url:            ticket.url         ?? '',
            stepIndex:      s.stepIndex,
            action:         s.action,
            data:           s.data,
            result:         s.result,
          });
        }
      }
    }
  }

  // ── 6. Write output files ──────────────────────────────────────────────────

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const label       = parsed.jql ? 'TestSets_export' : `${parsed.project}_TestSets`;
  const mappingFile = path.join(OUTPUT_DIR, `${label}_mapping.csv`);
  const stepsFile   = path.join(OUTPUT_DIR, `${label}_steps.csv`);
  const excelFile   = path.join(OUTPUT_DIR, `${label}_merged.xlsx`);

  // Mapping CSV (one row per TestSet→Test relationship)
  {
    const writer = createObjectCsvWriter({
      path: mappingFile,
      header: [
        { id: 'testSetKey',     title: 'Test Set Key'     },
        { id: 'testSetSummary', title: 'Test Set Summary' },
        { id: 'testSetStatus',  title: 'Test Set Status'  },
        { id: 'testKey',        title: 'Test Key'         },
        { id: 'testSummary',    title: 'Test Summary'     },
        { id: 'testStatus',     title: 'Test Status'      },
        { id: 'testType',       title: 'Test Type'        },
      ],
    });
    // Deduplicate to one row per unique TestSet→Test pair
    const mappingRows = [];
    const seen = new Set();
    for (const r of rows) {
      const k = `${r.testSetKey}§${r.testKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      mappingRows.push(r);
    }
    await writer.writeRecords(mappingRows);
  }

  // Steps CSV
  {
    const stepsRows = rows.filter((r) => r.stepIndex !== '');
    const writer = createObjectCsvWriter({
      path: stepsFile,
      header: [
        { id: 'testSetKey',  title: 'Test Set Key'   },
        { id: 'testKey',     title: 'Test Key'        },
        { id: 'testSummary', title: 'Test Summary'    },
        { id: 'stepIndex',   title: 'Step'            },
        { id: 'action',      title: 'Action'          },
        { id: 'data',        title: 'Test Data'       },
        { id: 'result',      title: 'Expected Result' },
      ],
    });
    await writer.writeRecords(stepsRows);
  }

  // Merged Excel
  await writeExcel(rows, excelFile);

  // ── 7. Summary ─────────────────────────────────────────────────────────────

  const totalStepRows = rows.filter((r) => r.stepIndex !== '').length;
  const uniqueTests   = new Set(rows.map((r) => r.testKey).filter(Boolean)).size;

  console.log('\n── Done ─────────────────────────────────────────────────────');
  console.log(`  Test Sets : ${testSets.length}`);
  console.log(`  Tests     : ${uniqueTests}`);
  console.log(`  Steps     : ${totalStepRows}`);
  console.log(`  Mapping   : ${mappingFile}`);
  console.log(`  Steps CSV : ${stepsFile}`);
  console.log(`  Excel     : ${excelFile}`);
}

// ── Excel writer ──────────────────────────────────────────────────────────────

async function writeExcel(rows, filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'jira-xray-exporter';
  wb.created = new Date();

  const ws = wb.addWorksheet('Test Sets');

  const COLUMNS = [
    { header: 'Test Set Key',     key: 'testSetKey',     width: 18 },
    { header: 'Test Set Summary', key: 'testSetSummary', width: 50 },
    { header: 'Test Set Status',  key: 'testSetStatus',  width: 16 },
    { header: 'Test Key',         key: 'testKey',        width: 18 },
    { header: 'Test Summary',     key: 'testSummary',    width: 50 },
    { header: 'Test Status',      key: 'testStatus',     width: 16 },
    { header: 'Test Type',        key: 'testType',       width: 14 },
    { header: 'Priority',         key: 'priority',       width: 12 },
    { header: 'Assignee',         key: 'assignee',       width: 20 },
    { header: 'Reporter',         key: 'reporter',       width: 20 },
    { header: 'Labels',           key: 'labels',         width: 25 },
    { header: 'Description',      key: 'description',    width: 60 },
    { header: 'URL',              key: 'url',            width: 40 },
    { header: 'Step',             key: 'stepIndex',      width:  7 },
    { header: 'Action',           key: 'action',         width: 50 },
    { header: 'Test Data',        key: 'data',           width: 30 },
    { header: 'Expected Result',  key: 'result',         width: 40 },
  ];

  ws.columns = COLUMNS;

  // Freeze header row — no autoFilter
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Header row ─────────────────────────────────────────────────────────────

  const headerRow = ws.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C5F8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } } };
  });

  // ── Styles ─────────────────────────────────────────────────────────────────

  const thin   = (c = 'FFB8CCE4') => ({ style: 'thin',   color: { argb: c } });
  const medium = (c = 'FF1F4E79') => ({ style: 'medium', color: { argb: c } });

  const thinAll    = { top: thin(), left: thin(), bottom: thin(), right: thin() };
  const setBorder  = { ...thinAll, top: medium() };         // thick top = new Test Set
  const testBorder = { ...thinAll, top: thin('FF6FA8D0') }; // tinted top = new Test

  // Column key groups used for merging
  const SET_COL_KEYS  = ['testSetKey', 'testSetSummary', 'testSetStatus'];
  const TEST_COL_KEYS = ['testKey', 'testSummary', 'testStatus', 'testType', 'priority', 'assignee', 'reporter', 'labels', 'description', 'url'];

  // Helper: merge a column group vertically over [startRow, endRow]
  function applyMerge(startRow, endRow, colKeys) {
    if (startRow >= endRow) return;  // single row — nothing to merge
    for (const key of colKeys) {
      const colNum = ws.getColumn(key).number;
      ws.mergeCells(startRow, colNum, endRow, colNum);
      ws.getCell(startRow, colNum).alignment = { vertical: 'top', wrapText: true };
    }
  }

  // ── Data rows — no fill; set/test columns on first row only, then merged ──

  let prevSetKey  = null;
  let prevTestKey = null;
  let setStart    = 2;   // Excel row where current Test Set group begins
  let testStart   = 2;   // Excel row where current Test group begins
  let excelRowNum = 2;

  for (const r of rows) {
    const isNewSet  = r.testSetKey !== prevSetKey;
    const isNewTest = isNewSet || r.testKey !== prevTestKey;

    // Close previous groups before starting new ones
    if (isNewTest && prevTestKey !== null) {
      applyMerge(testStart, excelRowNum - 1, TEST_COL_KEYS);
      testStart = excelRowNum;
    }
    if (isNewSet && prevSetKey !== null) {
      applyMerge(setStart, excelRowNum - 1, SET_COL_KEYS);
      setStart = excelRowNum;
    }

    const row = ws.addRow([
      isNewSet  ? r.testSetKey     : '',
      isNewSet  ? r.testSetSummary : '',
      isNewSet  ? r.testSetStatus  : '',
      isNewTest ? r.testKey        : '',
      isNewTest ? r.testSummary    : '',
      isNewTest ? r.testStatus     : '',
      isNewTest ? r.testType       : '',
      isNewTest ? r.priority       : '',
      isNewTest ? r.assignee       : '',
      isNewTest ? r.reporter       : '',
      isNewTest ? r.labels         : '',
      isNewTest ? r.description    : '',
      isNewTest ? r.url            : '',
      r.stepIndex, r.action, r.data, r.result,
    ]);
    row.height = 18;

    const border = isNewSet ? setBorder : (isNewTest ? testBorder : thinAll);
    row.eachCell((cell) => {
      cell.font      = { size: 10 };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border    = border;
    });
    row.getCell('stepIndex').alignment = { vertical: 'top', horizontal: 'center' };

    prevSetKey  = r.testSetKey;
    prevTestKey = r.testKey;
    excelRowNum++;
  }

  // Close the final groups
  applyMerge(testStart, excelRowNum - 1, TEST_COL_KEYS);
  applyMerge(setStart,  excelRowNum - 1, SET_COL_KEYS);

  await wb.xlsx.writeFile(filePath);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

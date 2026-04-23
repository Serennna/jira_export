import { createObjectCsvWriter } from 'csv-writer';
import { mkdirSync } from 'fs';
import path from 'path';

const TICKET_HEADER = [
  { id: 'key',         title: 'Key' },
  { id: 'summary',     title: 'Summary' },
  { id: 'issueType',   title: 'Issue Type' },
  { id: 'status',      title: 'Status' },
  { id: 'priority',    title: 'Priority' },
  { id: 'assignee',    title: 'Assignee' },
  { id: 'reporter',    title: 'Reporter' },
  { id: 'created',     title: 'Created' },
  { id: 'updated',     title: 'Updated' },
  { id: 'labels',      title: 'Labels' },
  { id: 'components',  title: 'Components' },
  { id: 'fixVersions', title: 'Fix Versions' },
  { id: 'description', title: 'Description' },
  { id: 'url',         title: 'URL' },
];

const STEPS_HEADER = [
  { id: 'stepIndex',   title: 'Step #' },
  { id: 'testKey',     title: 'Test Key' },
  { id: 'testSummary', title: 'Test Summary' },
  { id: 'testType',    title: 'Test Type' },
  { id: 'action',      title: 'Action' },
  { id: 'data',        title: 'Test Data' },
  { id: 'result',      title: 'Expected Result' },
];

/**
 * Write ticket(s) + Xray test steps to CSV files.
 *
 * @param {object}   opts
 * @param {Array}    opts.tickets    array of summarized ticket objects
 * @param {Array}    opts.steps      array of test step objects
 * @param {string}   opts.outputDir  directory to write files into
 * @param {string}   opts.label      filename prefix, e.g. "ACANDMAU-499" or "ACIOSMAU_Test"
 */
export async function exportToCsv({ tickets, steps, outputDir = './output', label }) {
  mkdirSync(outputDir, { recursive: true });

  // ── Ticket CSV ───────────────────────────────────────────────────────────────
  const ticketFile = path.join(outputDir, `${label}_tickets.csv`);
  const ticketWriter = createObjectCsvWriter({ path: ticketFile, header: TICKET_HEADER });
  await ticketWriter.writeRecords(tickets);
  console.log(`  Tickets → ${ticketFile}  (${tickets.length} row${tickets.length !== 1 ? 's' : ''})`);

  // ── Steps CSV ────────────────────────────────────────────────────────────────
  const stepsFile = path.join(outputDir, `${label}_steps.csv`);
  const stepsWriter = createObjectCsvWriter({ path: stepsFile, header: STEPS_HEADER });
  await stepsWriter.writeRecords(steps);

  if (steps.length > 0) {
    console.log(`  Steps   → ${stepsFile}  (${steps.length} step${steps.length !== 1 ? 's' : ''})`);
  } else {
    console.log(`  Steps   → ${stepsFile}  (no test steps found)`);
  }

  return { ticketFile, stepsFile };
}

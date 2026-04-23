/**
 * Merge tickets CSV + steps CSV into a single Excel file.
 *
 * Layout:
 *   - One row per test step.
 *   - Ticket-level columns (Key → URL) are repeated on every step row for
 *     easy filtering/sorting — tickets are visually grouped with a medium
 *     top border and alternating step-row colours.
 *   - Tickets with no steps get a single row with empty step columns.
 *
 * Usage:
 *   node merge-to-excel.js                          ← uses JIRA_ISSUE_KEY from .env
 *   node merge-to-excel.js ACANDMAU-1538
 *   node merge-to-excel.js --label ACANDMAU_Test    ← bulk label (no _tickets / _steps suffix)
 *   node merge-to-excel.js --tickets ./output/foo_tickets.csv --steps ./output/foo_steps.csv
 *   node merge-to-excel.js --tickets ./output/foo_tickets.csv --steps ./output/foo_steps.csv --out ./output/merged.xlsx
 */

import 'dotenv/config';
import ExcelJS  from 'exceljs';
import { parse } from 'csv-parse/sync';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

// ── Parse CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';

let ticketsFile, stepsFile, outFile;

if (flag('--tickets')) {
  ticketsFile = flag('--tickets');
  stepsFile   = flag('--steps')  ?? ticketsFile.replace('_tickets.csv', '_steps.csv');
  outFile     = flag('--out')    ?? ticketsFile.replace('_tickets.csv', '_merged.xlsx');
} else {
  const label = flag('--label')
    ?? args.find((a) => !a.startsWith('--'))
    ?? process.env.JIRA_ISSUE_KEY;

  if (!label) {
    console.error(
      'Usage:\n'
      + '  node merge-to-excel.js ACANDMAU-1538\n'
      + '  node merge-to-excel.js --label ACANDMAU_Test\n'
      + '  node merge-to-excel.js --tickets ./output/foo_tickets.csv [--steps ...] [--out ...]\n'
      + '\nOr set JIRA_ISSUE_KEY in .env.',
    );
    process.exit(1);
  }

  ticketsFile = path.join(OUTPUT_DIR, `${label}_tickets.csv`);
  stepsFile   = path.join(OUTPUT_DIR, `${label}_steps.csv`);
  outFile     = path.join(OUTPUT_DIR, `${label}_merged.xlsx`);
}

for (const f of [ticketsFile, stepsFile]) {
  if (!existsSync(f)) {
    console.error(`File not found: ${f}`);
    process.exit(1);
  }
}

// ── Load CSVs ─────────────────────────────────────────────────────────────────

const tickets = parse(readFileSync(ticketsFile, 'utf8'), { columns: true, skip_empty_lines: true });
const steps   = parse(readFileSync(stepsFile,   'utf8'), { columns: true, skip_empty_lines: true });

// Group steps by Test Key
const stepsByKey = new Map();
for (const step of steps) {
  const key = step['Test Key'];
  if (!stepsByKey.has(key)) stepsByKey.set(key, []);
  stepsByKey.get(key).push(step);
}

// ── Column layout ─────────────────────────────────────────────────────────────

const TICKET_COLS = [
  { header: 'Key',          key: 'Key',          width: 18 },
  { header: 'Summary',      key: 'Summary',       width: 55 },
  { header: 'Issue Type',   key: 'Issue Type',    width: 12 },
  { header: 'Status',       key: 'Status',        width: 16 },
  { header: 'Priority',     key: 'Priority',      width: 10 },
  { header: 'Assignee',     key: 'Assignee',      width: 22 },
  { header: 'Reporter',     key: 'Reporter',      width: 22 },
  { header: 'Labels',       key: 'Labels',        width: 20 },
  { header: 'Description',  key: 'Description',   width: 45 },
  { header: 'URL',          key: 'URL',           width: 50 },
];

const STEP_COLS = [
  { header: 'Step #',          key: 'Step #',          width: 8  },
  { header: 'Action',          key: 'Action',          width: 50 },
  { header: 'Test Data',       key: 'Test Data',       width: 30 },
  { header: 'Expected Result', key: 'Expected Result', width: 50 },
];

const ALL_COLS = [...TICKET_COLS, ...STEP_COLS];

// ── Build Excel ───────────────────────────────────────────────────────────────

const wb = new ExcelJS.Workbook();
wb.creator  = 'jira-xray-exporter';
wb.created  = new Date();

const ws = wb.addWorksheet('Test Cases', {
  views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],  // freeze header row
});

// Set columns
ws.columns = ALL_COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

// ── Style helpers ─────────────────────────────────────────────────────────────

const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };

const BORDER_THIN = {
  top:    { style: 'thin', color: { argb: 'FFB8CCE4' } },
  left:   { style: 'thin', color: { argb: 'FFB8CCE4' } },
  bottom: { style: 'thin', color: { argb: 'FFB8CCE4' } },
  right:  { style: 'thin', color: { argb: 'FFB8CCE4' } },
};

const BORDER_TICKET = {   // thicker left border to visually separate tickets
  top:    { style: 'medium', color: { argb: 'FF1F4E79' } },
  left:   { style: 'medium', color: { argb: 'FF1F4E79' } },
  bottom: { style: 'thin',   color: { argb: 'FFB8CCE4' } },
  right:  { style: 'thin',   color: { argb: 'FFB8CCE4' } },
};

// Style the header row
const headerRow = ws.getRow(1);
headerRow.eachCell((cell) => {
  cell.fill      = HEADER_FILL;
  cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border    = { ...BORDER_THIN, bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } } };
});
headerRow.height = 30;

// ── Write rows ────────────────────────────────────────────────────────────────

let excelRow = 2;   // 1-indexed; row 1 = header

for (let ti = 0; ti < tickets.length; ti++) {
  const ticket    = tickets[ti];
  const ticketKey = ticket['Key'];
  const mySteps   = stepsByKey.get(ticketKey) ?? [];
  const rowCount  = Math.max(mySteps.length, 1);   // at least one row even with no steps
  const firstRow  = excelRow;
  const lastRow   = excelRow + rowCount - 1;

  for (let si = 0; si < rowCount; si++) {
    const step = mySteps[si];
    const row  = ws.getRow(excelRow);
    row.height = 22;

    // Ticket columns (only fill on first step row; merging handles display)
    for (const col of TICKET_COLS) {
      const cell = row.getCell(col.key);
      cell.value     = si === 0 ? (ticket[col.key] ?? '') : '';
      cell.alignment = { vertical: 'middle', wrapText: true,
                         horizontal: col.key === 'Key' ? 'center' : 'left' };
      cell.border    = si === 0 ? BORDER_TICKET : BORDER_THIN;
      cell.font      = { size: 10 };
    }

    // Step columns
    for (const col of STEP_COLS) {
      const cell = row.getCell(col.key);
      cell.value     = step ? (step[col.header] ?? step[col.key] ?? '') : '';
      cell.alignment = { vertical: 'middle', wrapText: true,
                         horizontal: col.key === 'Step #' ? 'center' : 'left' };
      cell.border    = BORDER_THIN;
      cell.font      = { size: 10 };
    }

    // Hyperlink on URL column (first row only)
    if (si === 0 && ticket['URL']) {
      const urlCell = row.getCell('URL');
      urlCell.value = { text: ticketKey, hyperlink: ticket['URL'] };
      urlCell.font  = { size: 10, color: { argb: 'FF0563C1' }, underline: true };
    }

    excelRow++;
  }

  // Bottom border on the last row of this ticket (visual separator between tickets)
  const lastExcelRow = ws.getRow(lastRow);
  lastExcelRow.eachCell((cell) => {
    cell.border = { ...cell.border, bottom: { style: 'medium', color: { argb: 'FF1F4E79' } } };
  });

  // Merge ticket columns vertically across all step rows of this ticket
  if (rowCount > 1) {
    for (const col of TICKET_COLS) {
      const colNum = ws.getColumn(col.key).number;
      ws.mergeCells(firstRow, colNum, lastRow, colNum);
      const master = ws.getCell(firstRow, colNum);
      master.alignment = { vertical: 'top', wrapText: true,
                           horizontal: col.key === 'Key' ? 'center' : 'left' };
    }
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

await wb.xlsx.writeFile(outFile);

const totalRows  = excelRow - 2;
const totalSteps = steps.length;
console.log(`\nMerged Excel → ${outFile}`);
console.log(`  ${tickets.length} ticket(s)  ·  ${totalSteps} step(s)  ·  ${totalRows} data row(s)`);

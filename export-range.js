/**
 * Export a row range from an existing tickets CSV, capture Xray steps for
 * each ticket via Playwright, and merge everything into a single Excel file.
 *
 * Usage:
 *   node export-range.js                                    ← prompts for everything
 *   node export-range.js output/ACIOSMAU_Test_tickets.csv   ← prompts for row range
 *   node export-range.js output/ACIOSMAU_Test_tickets.csv 1 10
 *
 * Row numbers are 1-based and refer to data rows (excluding the header).
 */

import 'dotenv/config';
import readline      from 'readline';
import { parse }     from 'csv-parse/sync';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import path          from 'path';
import ExcelJS       from 'exceljs';
import { captureXraySteps } from './src/playwright/captureSteps.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;

if (!JIRA_BASE_URL) {
  console.error('Error: JIRA_BASE_URL not set. Check your .env file.');
  process.exit(1);
}

// ── Readline helper ───────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((res) => rl.question(question, res));

// ── Parse CLI args ────────────────────────────────────────────────────────────

let [, , csvArg, startArg, endArg] = process.argv;

// ── 1. Pick the tickets CSV ───────────────────────────────────────────────────

if (!csvArg) {
  csvArg = await ask('Tickets CSV path (e.g. output/ACIOSMAU_Test_tickets.csv): ');
  csvArg = csvArg.trim();
}

if (!existsSync(csvArg)) {
  console.error(`File not found: ${csvArg}`);
  rl.close();
  process.exit(1);
}

// ── 2. Load the CSV ───────────────────────────────────────────────────────────

const allTickets = parse(readFileSync(csvArg, 'utf8'), {
  columns: true,
  skip_empty_lines: true,
});

const total = allTickets.length;
console.log(`\nLoaded ${total} ticket(s) from ${csvArg}`);
console.log('Row numbers are 1-based (1 = first data row).\n');

// ── 3. Ask for row range ──────────────────────────────────────────────────────

let startRow, endRow;

if (startArg && endArg) {
  startRow = parseInt(startArg, 10);
  endRow   = parseInt(endArg,   10);
} else {
  const startInput = await ask(`  Start row [1–${total}] (default: 1): `);
  const endInput   = await ask(`  End   row [1–${total}] (default: 10): `);
  startRow = parseInt(startInput.trim() || '1',  10);
  endRow   = parseInt(endInput.trim()   || '10', 10);
}

rl.close();

// Validate
if (isNaN(startRow) || isNaN(endRow) || startRow < 1 || endRow < startRow || endRow > total) {
  console.error(`Invalid range: ${startRow}–${endRow} (valid: 1–${total})`);
  process.exit(1);
}

const selectedTickets = allTickets.slice(startRow - 1, endRow);
console.log(`\nSelected rows ${startRow}–${endRow}: ${selectedTickets.length} ticket(s)`);
selectedTickets.forEach((t, i) =>
  console.log(`  ${startRow + i}. [${t['Key']}] ${t['Summary']?.slice(0, 70)}`),
);

// ── 4. Capture Xray steps for each ticket ────────────────────────────────────

console.log('\n── Capturing Xray test steps ────────────────────────────────────');

const stepsByKey = new Map();
let totalSteps = 0;

for (let i = 0; i < selectedTickets.length; i++) {
  const ticket = selectedTickets[i];
  const key    = ticket['Key'];
  console.log(`\n[${i + 1}/${selectedTickets.length}] ${key} — ${ticket['Summary']?.slice(0, 60)}`);

  try {
    const steps = await captureXraySteps({ jiraBaseUrl: JIRA_BASE_URL, issueKey: key });
    stepsByKey.set(key, steps);
    totalSteps += steps.length;
    if (steps.length === 0) console.log('  (no steps found)');
  } catch (err) {
    console.warn(`  Warning: ${err.message.slice(0, 120)}`);
    stepsByKey.set(key, []);
  }
}

console.log(`\nTotal steps captured: ${totalSteps}`);

// ── 5. Build Excel ────────────────────────────────────────────────────────────

console.log('\n── Building Excel ───────────────────────────────────────────────');

const baseName  = path.basename(csvArg, '_tickets.csv');
const outName   = `${baseName}_rows${startRow}-${endRow}_merged.xlsx`;
const outFile   = path.join(OUTPUT_DIR, outName);
mkdirSync(OUTPUT_DIR, { recursive: true });

// Column definitions
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

// Styles
const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
const TICKET_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4F0' } };
const STEP_FILL_A  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
const STEP_FILL_B  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F7FB' } };

const BORDER_THIN  = {
  top:    { style: 'thin',   color: { argb: 'FFB8CCE4' } },
  left:   { style: 'thin',   color: { argb: 'FFB8CCE4' } },
  bottom: { style: 'thin',   color: { argb: 'FFB8CCE4' } },
  right:  { style: 'thin',   color: { argb: 'FFB8CCE4' } },
};
const BORDER_TICKET_TOP = {
  top:    { style: 'medium', color: { argb: 'FF1F4E79' } },
  left:   { style: 'thin',   color: { argb: 'FFB8CCE4' } },
  bottom: { style: 'thin',   color: { argb: 'FFB8CCE4' } },
  right:  { style: 'thin',   color: { argb: 'FFB8CCE4' } },
};

const wb = new ExcelJS.Workbook();
wb.creator = 'jira-xray-exporter';
wb.created = new Date();

const ws = wb.addWorksheet('Test Cases', {
  views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
});

ws.columns = ALL_COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

// Style header row
const headerRow = ws.getRow(1);
headerRow.height = 30;
headerRow.eachCell((cell) => {
  cell.fill      = HEADER_FILL;
  cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border    = { ...BORDER_THIN, bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } } };
});

// Write data rows
let excelRow = 2;

for (let ti = 0; ti < selectedTickets.length; ti++) {
  const ticket    = selectedTickets[ti];
  const key       = ticket['Key'];
  const mySteps   = stepsByKey.get(key) ?? [];
  const rowCount  = Math.max(mySteps.length, 1);
  const firstRow  = excelRow;
  const lastRow   = excelRow + rowCount - 1;
  const evenTicket = ti % 2 === 0;

  for (let si = 0; si < rowCount; si++) {
    const step = mySteps[si];
    const row  = ws.getRow(excelRow);
    row.height = 22;

    // Ticket columns
    for (const col of TICKET_COLS) {
      const cell = row.getCell(col.key);
      cell.value     = si === 0 ? (ticket[col.key] ?? '') : '';
      cell.fill      = TICKET_FILL;
      cell.border    = si === 0 ? BORDER_TICKET_TOP : BORDER_THIN;
      cell.font      = { size: 10 };
      cell.alignment = {
        vertical:   'middle',
        horizontal: col.key === 'Key' ? 'center' : 'left',
        wrapText:   true,
      };
    }

    // Hyperlink on URL cell (first row only)
    if (si === 0 && ticket['URL']) {
      const urlCell = row.getCell('URL');
      urlCell.value = { text: key, hyperlink: ticket['URL'] };
      urlCell.font  = { size: 10, color: { argb: 'FF0563C1' }, underline: true };
    }

    // Step columns
    for (const col of STEP_COLS) {
      const cell = row.getCell(col.key);
      cell.value     = step ? (step[col.header] ?? step[col.key] ?? '') : '';
      cell.fill      = evenTicket ? STEP_FILL_A : STEP_FILL_B;
      cell.border    = BORDER_THIN;
      cell.font      = { size: 10 };
      cell.alignment = {
        vertical:   'middle',
        horizontal: col.key === 'Step #' ? 'center' : 'left',
        wrapText:   true,
      };
    }

    excelRow++;
  }

  // Merge ticket columns vertically across all step rows
  if (rowCount > 1) {
    for (const col of TICKET_COLS) {
      const colNum = ws.getColumn(col.key).number;
      ws.mergeCells(firstRow, colNum, lastRow, colNum);
      const cell = ws.getCell(firstRow, colNum);
      cell.alignment = {
        vertical:   'middle',
        horizontal: col.key === 'Key' ? 'center' : 'left',
        wrapText:   true,
      };
    }
  }

  // Thick bottom border to separate tickets
  for (let r = firstRow; r <= lastRow; r++) {
    const xlRow = ws.getRow(r);
    xlRow.eachCell((cell) => {
      cell.border = {
        ...cell.border,
        bottom: r === lastRow
          ? { style: 'medium', color: { argb: 'FF1F4E79' } }
          : cell.border?.bottom ?? BORDER_THIN.bottom,
      };
    });
  }
}

ws.autoFilter = {
  from: { row: 1, column: 1 },
  to:   { row: 1, column: ALL_COLS.length },
};

await wb.xlsx.writeFile(outFile);

console.log(`\nDone → ${outFile}`);
console.log(`  ${selectedTickets.length} ticket(s)  ·  ${totalSteps} step(s)  ·  ${excelRow - 2} data row(s)`);

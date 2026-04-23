/**
 * Scan a folder for *_tickets.csv + *_steps.csv pairs, deduplicate by ticket
 * Key (newer file wins), and write a single merged Excel file.
 *
 * Usage:
 *   node merge-folder.js                        ← uses ./output as folder
 *   node merge-folder.js ./output/ios
 *   node merge-folder.js ./output/ios --out ./output/ios_merged.xlsx
 *
 * Duplicate handling:
 *   If the same ticket Key appears in multiple files the record from the
 *   most-recently-modified file is kept (steps are replaced in full too).
 */

import 'dotenv/config';
import ExcelJS        from 'exceljs';
import { parse }      from 'csv-parse/sync';
import {
  readdirSync, readFileSync, statSync, mkdirSync,
} from 'fs';
import path           from 'path';

// ── CLI ───────────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const folderArg  = args.find((a) => !a.startsWith('--')) ?? './output';
const outFlagIdx = args.indexOf('--out');
const outFlag    = outFlagIdx !== -1 ? args[outFlagIdx + 1] : null;

const folder  = path.resolve(folderArg);
const outFile = outFlag
  ? path.resolve(outFlag)
  : path.join(folder, `${path.basename(folder)}_merged.xlsx`);

// ── Scan folder for CSV pairs ─────────────────────────────────────────────────

const files = readdirSync(folder).filter((f) => f.endsWith('_tickets.csv'));

if (files.length === 0) {
  console.error(`No *_tickets.csv files found in: ${folder}`);
  process.exit(1);
}

// Sort by file mtime ascending so newer files overwrite older ones
files.sort((a, b) => {
  const mtimeA = statSync(path.join(folder, a)).mtimeMs;
  const mtimeB = statSync(path.join(folder, b)).mtimeMs;
  return mtimeA - mtimeB;   // oldest first → newest processed last → wins
});

console.log(`\nFound ${files.length} ticket file(s) in ${folder}`);

// ── Load & deduplicate ────────────────────────────────────────────────────────
// Map<ticketKey, { ticket, steps, mtime }>

const records = new Map();   // key → { ticket, steps, mtime }

for (const ticketFile of files) {
  const ticketPath = path.join(folder, ticketFile);
  const stepsFile  = ticketFile.replace('_tickets.csv', '_steps.csv');
  const stepsPath  = path.join(folder, stepsFile);

  const mtime = statSync(ticketPath).mtimeMs;

  let tickets, steps;
  try {
    tickets = parse(readFileSync(ticketPath, 'utf8'), { columns: true, skip_empty_lines: true });
  } catch (e) {
    console.warn(`  ⚠ Could not parse ${ticketFile}: ${e.message}`);
    continue;
  }

  try {
    steps = parse(readFileSync(stepsPath, 'utf8'), { columns: true, skip_empty_lines: true });
  } catch {
    steps = [];  // steps file missing or empty — tolerated
  }

  for (const ticket of tickets) {
    const key     = ticket['Key'];
    const existing = records.get(key);

    if (!existing || mtime >= existing.mtime) {
      // Newer file → replace (or first time we see this key)
      const mySteps = steps.filter((s) => s['Test Key'] === key);
      if (existing) {
        console.log(`  ↻ Replace duplicate: ${key}  (${new Date(mtime).toLocaleString()})`);
      }
      records.set(key, { ticket, steps: mySteps, mtime });
    }
  }
}

const allTickets = [...records.values()].map((r) => r.ticket);
const stepsByKey = new Map([...records.entries()].map(([k, r]) => [k, r.steps]));
const totalSteps = [...stepsByKey.values()].reduce((s, v) => s + v.length, 0);

console.log(`\n  ${allTickets.length} unique ticket(s)  ·  ${totalSteps} total step(s)`);

// ── Build Excel ───────────────────────────────────────────────────────────────

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
  { header: 'URL',          key: 'URL',           width: 12 },
];

const STEP_COLS = [
  { header: 'Step #',          key: 'Step #',          width: 8  },
  { header: 'Action',          key: 'Action',          width: 55 },
  { header: 'Test Data',       key: 'Test Data',       width: 30 },
  { header: 'Expected Result', key: 'Expected Result', width: 55 },
];

const ALL_COLS = [...TICKET_COLS, ...STEP_COLS];

// ── Styles ────────────────────────────────────────────────────────────────────

const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };

const BORDER = (style, color = 'FFB8CCE4') => ({ style, color: { argb: color } });

const thinBorder   = { top: BORDER('thin'), left: BORDER('thin'), bottom: BORDER('thin'), right: BORDER('thin') };
const ticketBorder = { ...thinBorder, top: BORDER('medium', 'FF1F4E79') };
const thickBottom  = { style: 'medium', color: { argb: 'FF1F4E79' } };

// ── Workbook ──────────────────────────────────────────────────────────────────

const wb = new ExcelJS.Workbook();
wb.creator = 'jira-xray-exporter';
wb.created = new Date();

const ws = wb.addWorksheet('Test Cases', {
  views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
});

ws.columns = ALL_COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

// Header row
const headerRow = ws.getRow(1);
headerRow.height = 30;
headerRow.eachCell((cell) => {
  cell.fill      = HEADER_FILL;
  cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border    = { ...thinBorder, bottom: BORDER('medium', 'FFFFFFFF') };
});

// ── Data rows ─────────────────────────────────────────────────────────────────

let excelRow = 2;

for (let ti = 0; ti < allTickets.length; ti++) {
  const ticket    = allTickets[ti];
  const key       = ticket['Key'];
  const mySteps   = stepsByKey.get(key) ?? [];
  const rowCount  = Math.max(mySteps.length, 1);
  const firstRow  = excelRow;
  const lastRow   = excelRow + rowCount - 1;

  for (let si = 0; si < rowCount; si++) {
    const step = mySteps[si];
    const row  = ws.getRow(excelRow);
    row.height = 22;

    // Ticket columns (only populated on first step row)
    for (const col of TICKET_COLS) {
      const cell = row.getCell(col.key);
      cell.value     = si === 0 ? (ticket[col.key] ?? '') : '';
      cell.border    = si === 0 ? ticketBorder : thinBorder;
      cell.font      = { size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: col.key === 'Key' ? 'center' : 'left', wrapText: true };
    }

    // URL as hyperlink (first row only)
    if (si === 0 && ticket['URL']) {
      const c = row.getCell('URL');
      c.value = { text: key, hyperlink: ticket['URL'] };
      c.font  = { size: 10, color: { argb: 'FF0563C1' }, underline: true };
    }

    // Step columns
    for (const col of STEP_COLS) {
      const cell = row.getCell(col.key);
      cell.value     = step ? (step[col.header] ?? '') : '';
      cell.border    = thinBorder;
      cell.font      = { size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: col.key === 'Step #' ? 'center' : 'left', wrapText: true };
    }

    excelRow++;
  }

    // Thick bottom border on last row of each ticket (visual separator)
    for (let r = firstRow; r <= lastRow; r++) {
      ws.getRow(r).eachCell((cell) => {
        cell.border = {
          ...cell.border,
          bottom: r === lastRow ? thickBottom : (cell.border?.bottom ?? thinBorder.bottom),
        };
      });
    }

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

mkdirSync(path.dirname(outFile), { recursive: true });
await wb.xlsx.writeFile(outFile);

console.log(`\nDone → ${outFile}`);
console.log(`  ${allTickets.length} ticket(s)  ·  ${totalSteps} step(s)  ·  ${excelRow - 2} data row(s)`);

// Download formats for a computed report.
//
// Keyed on the format name, never on a report name — the same seam as the UI's
// form-renderer map, so every registered template is downloadable the moment it
// exists and a new format is one entry here plus its serializer.
//
// The serializers take exactly the payload the rows endpoint returns, so a
// downloaded file can never disagree with what the screen showed: same columns,
// same rows, same `generatedAt`.
//
// CONTEXT BEYOND THE ROWS. A run produces two things a plain table cannot hold:
// its NOTICES (what the numbers were computed from, which of them is a summary,
// when they stop being trustworthy) and its CONSTANT COLUMNS (keys the run
// declares hold one value throughout — the application a review is about, say).
// Both belong above the table, not in it.
//
// That used to be framed as "a download is the rows", which was really a
// statement about CSV: a CSV *is* a table, so anything above the header row
// breaks every parser that reads it. A workbook has room above the table and a
// reader who expects context there. So the decision is the format's, declared
// here as `carriesContext`; routes/reports.js strips both fields for every
// format that does not claim them, and csv and json stay byte-for-byte what they
// were. Generic on purpose — a future format (pdf, html) opts in the same way.
//
// The flag was called "carriesNotices" while notices were the only such field.
// It gates two now, so it is named for the category rather than for the first
// member of it.

import ExcelJS from 'exceljs';
import { addPivotTables, withoutFields } from './xlsxPivots.js';

const FILENAME_PREFIX = 'identity-atlas';

// Excel/CSV formula-injection guard (security finding M-05, the same rule the
// UI applies in utils/excelHelpers.js). Report rows carry crawled display names
// and descriptions, so a cell starting with = + - @ (or a leading tab/CR) would
// be executed as a formula when the file is opened in a spreadsheet app. A
// leading apostrophe forces the text to stay text.
function safeCell(text) {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

// One RFC-4180 field: always quoted, embedded quotes doubled. null/undefined
// become an empty field rather than the strings "null"/"undefined".
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${safeCell(text).replace(/"/g, '""')}"`;
}

// Column labels as the header row, then one line per row, read through the
// report's own column keys — the file has the same shape as the table.
function toCsv({ columns = [], rows = [] }) {
  const lines = [columns.map(col => csvField(col.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(col => csvField(row[col.key])).join(','));
  }
  return lines.join('\r\n');
}

// The whole payload, metadata included — the machine-readable counterpart to
// the CSV, for feeding a report into another tool.
function toJson(report) {
  return JSON.stringify(report, null, 2);
}

// ─── xlsx ─────────────────────────────────────────────────────────────────

// Excel's own limit. A report that stops at its own cap is already flagged
// `truncated`; this is the floor under a template that has no cap at all.
const SHEET_ROW_LIMIT = 1048575;
// Column widths are derived from content, then clamped: a description column
// sized to its longest value would be hundreds of characters wide.
const MIN_WIDTH = 10;
const MAX_WIDTH = 60;
const WIDTH_SAMPLE = 200;

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
const HEADER_FONT = { bold: true, size: 11, color: { argb: 'FF374151' } };
const MUTED_FONT = { size: 10, color: { argb: 'FF6B7280' } };

/** Excel rejects these in a sheet name, and caps it at 31 characters. */
function sheetName(displayName) {
  return String(displayName || 'Report').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Report';
}

/**
 * A column's width from the header and the first rows — enough to read the
 * table without opening it, without sizing the sheet to one outlier. Only the
 * first `WIDTH_SAMPLE` rows are measured: the width is cosmetic and a report can
 * be 50,000 rows long.
 */
function columnWidth(column, rows) {
  let longest = String(column.label ?? '').length;
  for (let i = 0; i < rows.length && i < WIDTH_SAMPLE; i++) {
    const value = rows[i]?.[column.key];
    if (value !== null && value !== undefined) longest = Math.max(longest, String(value).length);
  }
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest + 2));
}

/**
 * The columns a run declared constant, paired with their label and the value
 * they hold — and the columns left to tabulate.
 *
 * The value is read from the first row because the run asserted there is only
 * one; it is not checked against the others, and deliberately so. A run that
 * declares a column constant and is wrong has a bug in the report, and silently
 * "correcting" it here by keeping the column would hide that. A key the report
 * does not declare as a column is ignored.
 *
 * Nothing is dropped when dropping would leave no table: a sheet of nothing but
 * a header is worse than a repeated column.
 */
export function splitConstantColumns(columns, rows, constantColumns) {
  const wanted = new Set(Array.isArray(constantColumns) ? constantColumns : []);
  if (wanted.size === 0 || rows.length === 0) return { header: [], body: columns };

  const order = constantColumns.filter(key => columns.some(c => c.key === key));
  const body = columns.filter(c => !wanted.has(c.key));
  if (body.length === 0) return { header: [], body: columns };

  const header = order.map(key => ({
    key,
    label: columns.find(c => c.key === key).label,
    value: rows[0][key],
  }));
  return { header, body };
}

/**
 * The block above the table: what this is, when it was computed, whatever the
 * run declared constant, and every notice the report returned — which is where
 * a summary lives now that a download can hold one. Returns the row index the
 * table starts on.
 */
function writeSummary(sheet, { displayName, generatedAt, total, notices = [], truncated, header = [] }) {
  sheet.getCell('A1').value = String(displayName ?? 'Report');
  sheet.getCell('A1').font = { bold: true, size: 14 };

  const counted = Number.isFinite(total) ? total : 0;
  sheet.getCell('A2').value = `${counted.toLocaleString('en-US')} row(s) · generated ${generatedAt ?? ''}`.trim();
  sheet.getCell('A2').font = MUTED_FONT;

  let row = 4;
  for (const entry of header) {
    // Label and value in two cells rather than one string, so the block can be
    // read, sorted and copied as data. An empty value still gets its label: a
    // field that exists and is unfilled is a finding, and silence is not.
    sheet.getCell(`A${row}`).value = entry.label;
    sheet.getCell(`A${row}`).font = { bold: true };
    sheet.getCell(`B${row}`).value = entry.value === undefined ? null : entry.value;
    row += 1;
  }
  if (header.length) row += 1;

  if (truncated) {
    // Louder than a notice, because it changes what the file IS: the first N
    // rows of an answer, presented as a file, read as the whole answer.
    sheet.getCell(`A${row}`).value = 'This export stops at the report\'s row cap and is NOT the complete result.';
    sheet.getCell(`A${row}`).font = { bold: true, color: { argb: 'FF991B1B' } };
    row += 1;
  }
  for (const notice of notices) {
    sheet.getCell(`A${row}`).value = String(notice?.text ?? '');
    if (notice?.severity === 'warning') sheet.getCell(`A${row}`).font = { color: { argb: 'FF92400E' } };
    row += 1;
  }
  return row + 1; // one blank row between the summary and the table
}

/**
 * The whole report as one worksheet: the summary block, then the same table the
 * CSV holds.
 *
 * Cell values are written RAW — no leading-apostrophe guard, deliberately. The
 * CSV guard (M-05) exists because a CSV cell has no type: a spreadsheet decides
 * what `=cmd|calc` means when it opens the file. An xlsx cell is typed, and a
 * string written here is stored as a string, never as a `<f>` formula, so the
 * apostrophe would be a character of corruption rather than a defence. The
 * invariant that actually matters is pinned by the tests, which assert the cell
 * round-trips with its exact original text AND with cell type String.
 *
 * A report that declares `pivots` gets each one on its own tab after the data,
 * over that same table — see xlsxPivots.js.
 */
async function toXlsx({
  displayName, columns: declared = [], rows = [], notices, total, generatedAt, truncated, constantColumns, pivots = [],
} = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Identity Atlas';
  workbook.created = new Date();

  // The sheet's columns are this RUN's, not the report's: a value the run holds
  // constant is stated once above the table instead of repeated down every row.
  // `columns` in the payload is untouched — the screen still shows all of them.
  const { header, body: columns } = splitConstantColumns(declared, rows, constantColumns);

  const sheet = workbook.addWorksheet(sheetName(displayName));
  const headerRow = writeSummary(sheet, { displayName, generatedAt, total, notices, truncated, header });

  columns.forEach((column, i) => { sheet.getColumn(i + 1).width = columnWidth(column, rows); });

  const labelRow = sheet.getRow(headerRow);
  columns.forEach((column, i) => {
    const cell = labelRow.getCell(i + 1);
    cell.value = column.label;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
  });
  labelRow.commit?.();

  const capped = rows.length > SHEET_ROW_LIMIT - headerRow ? rows.slice(0, SHEET_ROW_LIMIT - headerRow) : rows;
  capped.forEach((row, i) => {
    const target = sheet.getRow(headerRow + 1 + i);
    columns.forEach((column, c) => {
      const value = row[column.key];
      target.getCell(c + 1).value = value === undefined ? null : value;
    });
  });

  if (columns.length) {
    // Freeze everything above and including the header, so scrolling a
    // 39,000-row review keeps both the summary anchor and the column names.
    sheet.views = [{ state: 'frozen', ySplit: headerRow }];
    sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: columns.length } };
  }

  // A pivot over no rows has no items to show, so an empty report gets none. A
  // column this run moved into the header is not in the table either; the pivot
  // drops it too — one value is one item, a level that says nothing.
  const inHeader = header.map(h => h.key);
  const pivotSheets = capped.length && columns.length
    ? pivots.map(pivot => ({
      sheetId: workbook.addWorksheet(sheetName(pivot.name)).id,
      pivot: withoutFields(pivot, inHeader),
    }))
    : [];
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const lastColumn = sheet.getColumn(columns.length || 1).letter;
  return addPivotTables(buffer, {
    sheet: sheet.name,
    ref: `A${headerRow}:${lastColumn}${headerRow + capped.length}`,
    columns,
    rows: capped,
  }, pivotSheets);
}

// Order is the order the UI offers them in, and the first is the default.
const SERIALIZERS = {
  csv: { contentType: 'text/csv; charset=utf-8', serialize: toCsv },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // The one format with room for them. See NOTICES at the top of this file.
    carriesContext: true,
    serialize: toXlsx,
  },
  json: { contentType: 'application/json; charset=utf-8', serialize: toJson },
};

// A format's name doubles as its file extension — `?format=json` downloads a
// `.json` — so it is written once rather than as two strings that can drift.
//
// Write a format name as an object key, never as a bare quoted string: `csv` is
// also a crawler type (`tools/crawlers/csv/`), and the crawler-manifest CI gate
// greps `app/api/src` and `app/ui/src` for quoted crawler-type literals so that
// core can't hardcode crawler behaviour.
export const EXPORT_FORMATS = Object.fromEntries(
  Object.entries(SERIALIZERS).map(([name, format]) => [
    name, { extension: name, carriesContext: false, ...format },
  ]),
);

/** Format names offered for download, in the order the UI should show them. */
export const EXPORT_FORMAT_NAMES = Object.keys(EXPORT_FORMATS);

/** The format a request gets when it names none — the first one offered. */
export const DEFAULT_EXPORT_FORMAT = EXPORT_FORMAT_NAMES[0];

/**
 * The format a `?format=` query parameter names, or null when it isn't one we
 * offer. `Object.hasOwn` so a request can never dispatch on an inherited
 * Object.prototype member (`constructor`, `toString`, …).
 */
export function resolveExportFormat(format) {
  return Object.hasOwn(EXPORT_FORMATS, format) ? EXPORT_FORMATS[format] : null;
}

/**
 * The filename offered to the browser: product, report and the day the content
 * was computed, so a folder of downloads stays self-describing. The report name
 * is slugged rather than trusted verbatim — it ends up inside a quoted
 * Content-Disposition header.
 */
export function exportFilename(reportName, extension, generatedAt) {
  const slug = String(reportName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'report';
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(generatedAt ?? ''))?.[0];
  return `${FILENAME_PREFIX}-${slug}${day ? `-${day}` : ''}.${extension}`;
}

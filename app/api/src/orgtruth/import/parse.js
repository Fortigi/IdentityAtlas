// Organisation truth — read an uploaded list (xlsx or csv) into columns + rows.
//
//   parseList(buffer, { fileName, mimeType }) → Promise<{ columns: string[], rows: object[], headerRow: number }>
//
// `headerRow` is the 1-based row of the file (xlsx row number / csv record)
// that was taken as the header: the first row with at least two filled cells,
// or for a one-column list the first non-empty row.
// `rows` are plain objects keyed by the column names, every value a string
// ('' for an empty cell), in file order. Row N of `rows` is "data row N"
// (1-based) everywhere else in the import (sourceLocator `row:N`).
//
// xlsx: the first worksheet. Cell values
// become strings: dates as ISO 8601, formulas by their cached result, rich text
// joined, hyperlinks by their text.
// csv: UTF-8 (BOM stripped); the delimiter is whichever of `;` `,` TAB occurs
// most on the header line; RFC 4180 quoting (quoted delimiters, quoted line
// breaks, "" for a quote).
// Both: empty or repeated header cells are renamed `Column <n>` (n = 1-based
// position); fully empty rows at the end are dropped (empty rows in between are
// kept so row numbers keep matching the file); more than MAX_ROWS data rows is
// refused.
//
// Every refusal throws a ListParseError whose message is a sentence for the
// person who uploaded the file (the route answers 400 with it).
import ExcelJS from 'exceljs';

export const MAX_ROWS = 200_000;
// While reading, stop early (memory) once the raw row count passes the cap by
// more than room for a header and blank lines; the exact check runs on the
// data rows afterwards.
const SLACK = 1000;
const DELIMITERS = [';', ',', '\t'];

export class ListParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ListParseError';
  }
}

export async function parseList(buffer, { fileName = '', mimeType = '' } = {}) {
  if (!buffer || buffer.length === 0) throw new ListParseError('The file is empty.');
  const format = detectFormat(buffer, fileName, mimeType);
  const matrix = format === 'xlsx' ? await readXlsx(buffer) : readCsv(buffer);
  return toTable(matrix);
}

// ─── Format detection ────────────────────────────────────────────────────
const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b) => b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

export function detectFormat(buffer, fileName = '', mimeType = '') {
  if (isOle(buffer) || /\.xls$/i.test(fileName)) {
    throw new ListParseError('This is an old-style .xls workbook; save it as .xlsx or .csv and upload it again.');
  }
  if (isZip(buffer)) return 'xlsx';
  if (/\.xlsx$/i.test(fileName) || /spreadsheetml/i.test(mimeType)) {
    throw new ListParseError('The file is named as an Excel workbook but is not one; save it again as .xlsx or .csv.');
  }
  return 'csv';
}

// ─── xlsx ────────────────────────────────────────────────────────────────
async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw new ListParseError(`The Excel workbook could not be read (${err.message}); save it again as .xlsx or .csv.`);
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ListParseError('The Excel workbook has no worksheet.');
  if (ws.rowCount > MAX_ROWS + SLACK) throw tooManyRows();
  const matrix = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellToString(row.getCell(c).value));
    matrix.push(cells);
  }
  return matrix;
}

// One ExcelJS cell value → string. Exported for its own tests: the shapes are
// many and a workbook fixture per shape would be slow.
export function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if ('result' in value || 'formula' in value || 'sharedFormula' in value) return cellToString(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(t => t.text ?? '').join('');
  if ('text' in value) return cellToString(value.text);
  if ('error' in value) return String(value.error);
  return '';
}

// ─── csv ─────────────────────────────────────────────────────────────────
function readCsv(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return parseCsv(text, sniffDelimiter(text));
}

// The delimiter that occurs most on the first non-empty line (outside quotes).
// Ties go to the earlier one in `;` `,` TAB; none at all means a one-column list.
export function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim() !== '') ?? '';
  const unquoted = firstLine.replace(/"[^"]*"/g, '');
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = unquoted.split(d).length - 1;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

// RFC 4180 state machine. Returns an array of rows, each an array of strings.
export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length > MAX_ROWS + SLACK) throw tooManyRows();
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new ListParseError('The CSV file ends inside a quoted value; a closing quote (") is missing.');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ─── Shared: header + rows ───────────────────────────────────────────────
const isBlankRow = (cells) => cells.every(c => c.trim() === '');

const filledCells = (cells) => cells.filter(c => c.trim() !== '').length;

// The header is the first row with at least two filled cells, so a title line
// above the table ("Projects per 1 October") is skipped. A one-column list has
// no such row: then the first non-empty row is the header.
export function findHeaderIndex(matrix) {
  const wide = matrix.findIndex(cells => filledCells(cells) >= 2);
  return wide >= 0 ? wide : matrix.findIndex(cells => filledCells(cells) > 0);
}

function toTable(matrix) {
  const headerAt = findHeaderIndex(matrix);
  if (headerAt < 0) throw new ListParseError('The file has no header row: every row is empty.');
  const columns = headerNames(matrix[headerAt]);
  const data = matrix.slice(headerAt + 1);
  while (data.length > 0 && isBlankRow(data[data.length - 1])) data.pop();
  if (data.length > MAX_ROWS) throw tooManyRows();
  const rows = data.map(cells => Object.fromEntries(columns.map((name, i) => [name, cells[i] ?? ''])));
  return { columns, rows, headerRow: headerAt + 1 };
}

// Trailing empty header cells are dropped; an empty or repeated name in
// between becomes `Column <position>` (with a suffix in the rare case that
// name is taken too).
export function headerNames(cells) {
  const trimmed = cells.map(c => c.trim());
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  const taken = new Set(trimmed.filter(Boolean));
  const seen = new Set();
  return trimmed.map((name, i) => {
    if (name !== '' && !seen.has(name)) { seen.add(name); return name; }
    let candidate = `Column ${i + 1}`;
    for (let n = 2; taken.has(candidate) || seen.has(candidate); n++) candidate = `Column ${i + 1} (${n})`;
    seen.add(candidate);
    return candidate;
  });
}

function tooManyRows() {
  return new ListParseError(`The list has more than ${MAX_ROWS.toLocaleString('en-US')} data rows, the maximum. Split it into smaller lists and import them as delta runs.`);
}

// Context upload — read an uploaded list (xlsx or csv) into columns + rows.
//
//   parseList(buffer, { fileName }) → Promise<{ columns: string[], rows: object[] }>
//
// Ported from the Org Info prototype (orgtruth/import/parse.js), narrowed to what
// an upload needs: a header row is required (the first row with at least two
// filled cells; a one-column list's first non-empty row).
//
// xlsx: the first worksheet, read with exceljs (already the API's workbook
// library — the report export writes with it). Cell values become strings:
// dates as ISO 8601, formulas by their cached result, rich text joined,
// hyperlinks by their text.
// csv: UTF-8 with or without a BOM; the delimiter is whichever of `;` `,` TAB
// occurs most on the first non-empty line; RFC 4180 quoting (quoted delimiters,
// quoted line breaks, "" for a quote).
// Both: an empty or repeated header cell becomes `Column <n>`; blank rows are
// dropped; more than MAX_ROWS data rows is refused.
//
// Every refusal throws a ListParseError whose message is a sentence for the
// person who uploaded the file (the route answers 400 with it).
import ExcelJS from 'exceljs';

// Not a file-size cap (the large-file policy holds): a row count, so a list that
// is really an export of everything is refused with a sentence instead of
// building a tree of a million units in one request.
export const MAX_ROWS = 50_000;
const DELIMITERS = [';', ',', '\t'];

export class ListParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ListParseError';
  }
}

export async function parseList(buffer, { fileName = '' } = {}) {
  if (!buffer || buffer.length === 0) throw new ListParseError('The file is empty.');
  const matrix = detectFormat(buffer, fileName) === 'xlsx' ? await readXlsx(buffer) : readCsv(buffer);
  return toTable(matrix);
}

// ─── Format detection ────────────────────────────────────────────────────
const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b) => b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

export function detectFormat(buffer, fileName = '') {
  if (isOle(buffer) || /\.xls$/i.test(fileName)) {
    throw new ListParseError('This is an old-style .xls workbook; save it as .xlsx or .csv and upload it again.');
  }
  if (isZip(buffer)) return 'xlsx';
  if (/\.xlsx$/i.test(fileName)) {
    throw new ListParseError('The file is named as an Excel workbook but is not one; save it again as .xlsx or .csv.');
  }
  return 'delimited';
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
  const matrix = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellToString(row.getCell(c).value));
    matrix.push(cells);
    if (matrix.length > MAX_ROWS + 1) throw tooManyRows();
  }
  return matrix;
}

// One ExcelJS cell value → string.
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
function endField(st) { st.row.push(st.field); st.field = ''; }
function endRow(st) {
  endField(st); st.rows.push(st.row); st.row = [];
  if (st.rows.length > MAX_ROWS + 1) throw tooManyRows();
}
// Inside quotes: a doubled quote is a literal quote (returns the extra char consumed).
function quotedChar(st, ch, next) {
  if (ch !== '"') { st.field += ch; return 0; }
  if (next === '"') { st.field += '"'; return 1; }
  st.inQuotes = false;
  return 0;
}

export function parseCsv(text, delimiter) {
  // Only ever a decoded string: the loop below walks its characters, so an
  // array or an object with a made-up length must never reach it.
  if (typeof text !== 'string') throw new ListParseError('The CSV file could not be read as text.');
  const st ={ rows: [], row: [], field: '', inQuotes: false };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (st.inQuotes) { i += quotedChar(st, ch, next); continue; }
    if (ch === '"') st.inQuotes = true;
    else if (ch === delimiter) endField(st);
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && next === '\n') i++; endRow(st); }
    else st.field += ch;
  }
  if (st.inQuotes) throw new ListParseError('The CSV file ends inside a quoted value; a closing quote (") is missing.');
  if (st.field !== '' || st.row.length > 0) { st.row.push(st.field); st.rows.push(st.row); }
  return st.rows;
}

// ─── Shared: header + rows ───────────────────────────────────────────────
const filledCells = (cells) => cells.filter(c => c.trim() !== '').length;

// The header is the first row with at least two filled cells, so a title line
// above the table is skipped. A one-column list has no such row: then the first
// non-empty row is the header.
export function findHeaderIndex(matrix) {
  const wide = matrix.findIndex(cells => filledCells(cells) >= 2);
  return wide >= 0 ? wide : matrix.findIndex(cells => filledCells(cells) > 0);
}

function toTable(matrix) {
  const headerAt = findHeaderIndex(matrix);
  if (headerAt < 0) throw new ListParseError('The file has no header row: every row is empty.');
  const columns = headerNames(matrix[headerAt]);
  const data = matrix.slice(headerAt + 1).filter(cells => filledCells(cells) > 0);
  if (data.length > MAX_ROWS) throw tooManyRows();
  const rows = data.map(cells => Object.fromEntries(columns.map((name, i) => [name, (cells[i] ?? '').trim()])));
  return { columns, rows };
}

// Trailing empty header cells are dropped; an empty or repeated name in
// between becomes `Column <position>` (with a suffix when that name is taken).
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
  return new ListParseError(`The list has more than ${MAX_ROWS.toLocaleString('en-US')} data rows, the maximum for an upload. Split it into smaller lists.`);
}

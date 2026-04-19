// Excel workbook generator for the Power Query data export.
//
// MVP shape (v1): the workbook is a self-contained, opens-anywhere file
// with the API URL and read token already embedded in the Settings sheet
// and the M code for every object type printed verbatim on its own sheet.
// User opens the file → sees clear instructions → pastes the M code into
// Power Query Editor (Data → Get Data → Other Sources → Blank Query) →
// clicks Refresh. Token rotation = update one cell on the Settings sheet,
// no edits to the M code required.
//
// Why M-as-text instead of fully-embedded queries: hand-crafting the
// xl/queries/queries.xml that Excel auto-loads from is brittle without a
// real Excel install to validate against. A follow-up PR will swap this
// generator for a hand-built template + token-stamp approach so the user
// experience becomes a single Refresh click. The infrastructure (token
// auth, bulk endpoints, admin UI, download endpoint) is identical.

import ExcelJS from 'exceljs';
import { QUERIES } from './queryTemplates.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true, size: 12 };
const TOKEN_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
const M_FONT      = { name: 'Consolas', size: 10 };

// Build the workbook with `BaseUrl` + `AuthToken` baked into the Settings
// sheet as defined names. Returns a Buffer ready to send as the response.
export async function generateWorkbook({ apiBaseUrl, token }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Identity Atlas';
  wb.created = new Date();

  buildReadMeSheet(wb);
  buildSettingsSheet(wb, apiBaseUrl, token);
  for (const q of QUERIES) {
    buildQuerySheet(wb, q);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildReadMeSheet(wb) {
  const sheet = wb.addWorksheet('README');
  sheet.columns = [{ width: 110 }];

  const lines = [
    { text: 'Identity Atlas — Excel Power Query Workbook', style: { font: HEADER_FONT, fill: HEADER_FILL, alignment: { vertical: 'middle' } } },
    { text: '' },
    { text: 'How to use this workbook', style: { font: { bold: true, size: 12 } } },
    { text: '' },
    { text: '1. Check the Settings sheet — your API URL and read API key are already filled in.' },
    { text: '   If you ever need to point this workbook at a different deployment, or rotate the' },
    { text: '   token, edit those two cells. The named ranges feed every query automatically.' },
    { text: '' },
    { text: '2. For each data tab (Principals, Resources, Assignments, ...) the Power Query M' },
    { text: '   code is printed in cell A1. To turn it into live data:' },
    { text: '     - Open the Data tab on the Excel ribbon.' },
    { text: '     - Get Data → From Other Sources → Blank Query.' },
    { text: '     - In Power Query Editor: Home → Advanced Editor.' },
    { text: '     - Paste the M code from the sheet, then click Done → Close & Load.' },
    { text: '     - The query name in Power Query becomes the table name on this sheet.' },
    { text: '' },
    { text: '3. Refresh: Data → Refresh All. Or right-click a query → Refresh.' },
    { text: '' },
    { text: 'Security notes', style: { font: { bold: true, size: 12 } } },
    { text: '' },
    { text: 'The token in the Settings sheet is a read-only API key. It can only call read' },
    { text: 'endpoints (GET) and cannot reach any admin function. If the workbook is shared,' },
    { text: 'treat the token like a password and rotate it (Admin → Data → Read API Tokens).' },
  ];

  lines.forEach((line, i) => {
    const cell = sheet.getCell(i + 1, 1);
    cell.value = line.text;
    if (line.style?.font) cell.font = line.style.font;
    if (line.style?.fill) cell.fill = line.style.fill;
    if (line.style?.alignment) cell.alignment = line.style.alignment;
  });
  sheet.getRow(1).height = 30;
}

function buildSettingsSheet(wb, apiBaseUrl, token) {
  const sheet = wb.addWorksheet('Settings');
  sheet.columns = [{ width: 18 }, { width: 80 }];

  // Header row
  const header = sheet.getRow(1);
  header.values = ['Setting', 'Value'];
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.height = 22;

  // BaseUrl
  sheet.getCell('A2').value = 'BaseUrl';
  sheet.getCell('A2').font = { bold: true };
  sheet.getCell('B2').value = apiBaseUrl;
  sheet.getCell('B2').fill = TOKEN_FILL;

  // AuthToken
  sheet.getCell('A3').value = 'AuthToken';
  sheet.getCell('A3').font = { bold: true };
  sheet.getCell('B3').value = token;
  sheet.getCell('B3').fill = TOKEN_FILL;

  // Instructions
  sheet.getCell('A5').value = 'Notes';
  sheet.getCell('A5').font = { bold: true };
  sheet.getCell('B5').value = 'Edit the BaseUrl / AuthToken cells above to retarget this workbook. The named ranges feed every Power Query in the file.';
  sheet.getCell('B5').alignment = { wrapText: true };
  sheet.getRow(5).height = 40;

  // Defined names — these are what the M code references via
  // Excel.CurrentWorkbook(){[Name="BaseUrl"]}[Content]{0}[Column1].
  // Defined names targeting a single cell return a one-row table with one
  // column called Column1; that's why the M code uses [Column1] explicitly.
  wb.definedNames.add(`'Settings'!$B$2`, 'BaseUrl');
  wb.definedNames.add(`'Settings'!$B$3`, 'AuthToken');
}

function buildQuerySheet(wb, query) {
  const sheet = wb.addWorksheet(query.sheet);
  sheet.columns = [{ width: 110 }];

  // Header
  const header = sheet.getRow(1);
  header.values = [`${query.sheet} — Power Query M code`];
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.height = 22;

  // Endpoint hint row
  sheet.getCell('A2').value = `Endpoint: GET ${query.endpoint}    (paginated, returns { data, total })`;
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

  // Instructions
  sheet.getCell('A4').value = 'Paste the M code below into Power Query: Data → Get Data → Other Sources → Blank Query → Advanced Editor.';
  sheet.getCell('A4').alignment = { wrapText: true };
  sheet.getRow(4).height = 36;

  // The M code itself, in a single cell with monospace font and wrap
  const mCell = sheet.getCell('A6');
  mCell.value = query.m;
  mCell.font = M_FONT;
  mCell.alignment = { vertical: 'top', wrapText: true };

  // Approximate row height by line count — exceljs can't auto-size based on
  // wrapped content, so a fixed height with vertical-top alignment is the
  // pragmatic compromise.
  const lineCount = query.m.split('\n').length;
  sheet.getRow(6).height = Math.max(15, lineCount * 13);
}

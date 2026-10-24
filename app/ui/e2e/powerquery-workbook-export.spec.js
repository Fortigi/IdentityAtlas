// @ts-check
//
// Excel Power Query workbook export — the reporter path for #819.
//
// Every query in the generated workbook reads BaseUrl / AuthToken out of the
// workbook's named ranges and feeds them to Web.Contents, so Power Query's
// Formula Firewall raises "Information is required about data privacy" the
// first time a pasted query evaluates, and the query returns no data until
// privacy levels are ignored for that workbook. That step is mandatory, and
// the workbook's own instructions used to omit it — so a user following them
// hit an undocumented modal and concluded the export was broken.
//
// Playwright can't drive Excel, so this walks the part of the path that is
// ours: Admin → Data → Excel Power Query Workbook → "Generate token &
// download workbook", then opens the downloaded .xlsx and checks that the
// instructions a user reads — the README sheet, and the paste instruction on
// each query sheet, which is what's on screen when the prompt fires — walk
// them through the privacy dialog. It also replays what the M code does
// (bearer token → read endpoint) to prove the workbook works once the dialog
// is cleared.
import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

// "Ignore the Privacy Levels…" is the checkbox the user has to tick; the
// prompt itself is titled "Information is required about data privacy".
const MENTIONS_PRIVACY = /privacy/i;
const MENTIONS_IGNORE_STEP = /ignore.*privacy level/i;

async function openDataAdminTab(page) {
  await page.goto(`${BASE}/#admin?sub=data`);
  await page.waitForLoadState('networkidle');
  const button = page.getByRole('button', { name: /Generate token & download workbook/i });
  if (!(await button.isVisible({ timeout: 15000 }).catch(() => false))) {
    test.skip(true, 'Power Query export section not available to this user (needs data.export.ui)');
  }
  return button;
}

async function downloadWorkbook(page) {
  const button = await openDataAdminTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    button.click(),
  ]);
  const filePath = await download.path();
  expect(filePath, 'no workbook file was downloaded').toBeTruthy();
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

function sheetText(sheet) {
  const parts = [];
  sheet.eachRow((row) => row.eachCell((cell) => parts.push(String(cell.value ?? ''))));
  return parts.join('\n');
}

test.describe('Excel Power Query workbook export', () => {
  test.setTimeout(120000);

  test('the downloaded workbook documents the mandatory privacy-level step', async ({ page }) => {
    const wb = await downloadWorkbook(page);

    const readme = wb.getWorksheet('README');
    expect(readme, 'the workbook has no README sheet').toBeTruthy();
    const readmeText = sheetText(readme);
    expect(readmeText, 'the README never mentions the data-privacy prompt').toMatch(MENTIONS_PRIVACY);
    expect(readmeText, 'the README never tells the user to ignore privacy levels').toMatch(MENTIONS_IGNORE_STEP);
    // The safe setting is the per-workbook one — the global switch would turn
    // privacy checking off for every file the user opens.
    expect(readmeText).toMatch(/current workbook/i);

    // The prompt fires while the user is looking at a query sheet (they've just
    // pasted its M code), so each of those sheets has to say so too.
    const querySheets = wb.worksheets.filter(ws => !['README', 'Settings'].includes(ws.name));
    expect(querySheets.length, 'the workbook has no query sheets').toBeGreaterThan(0);
    for (const sheet of querySheets) {
      const instructions = String(sheet.getCell('A4').value ?? '');
      expect(instructions, `${sheet.name}: paste instructions omit the privacy prompt`).toMatch(MENTIONS_PRIVACY);
      expect(instructions, `${sheet.name}: paste instructions omit the ignore step`).toMatch(MENTIONS_IGNORE_STEP);
    }
  });

  test('the embedded token reads the API the way the M code does', async ({ page, request }) => {
    // Proves the documented dialog is the only thing standing between the user
    // and their data: same bearer token, same read endpoint the Systems tab's
    // M code hits (the tab in the bug report).
    const wb = await downloadWorkbook(page);

    const settings = wb.getWorksheet('Settings');
    expect(settings, 'the workbook has no Settings sheet').toBeTruthy();
    const baseUrl = String(settings.getCell('B2').value ?? '');
    const token = String(settings.getCell('B3').value ?? '');
    expect(baseUrl, 'BaseUrl cell is not an /api base').toMatch(/\/api$/);
    expect(token, 'AuthToken cell holds no read token').toMatch(/^fgr_/);

    const res = await request.get(`${BASE}/api/systems`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), 'the workbook token cannot read /api/systems').toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

// @ts-check
import { test, expect } from '@playwright/test';
import fs from 'fs';
import ExcelJS from 'exceljs';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

test.describe('Export validation', () => {
  test('matrix export button triggers download', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Look for an export button on the matrix/home page
    const exportBtn = page.locator('button:has-text("Export"), button[title*="Export"]').first();
    if (await exportBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        exportBtn.click(),
      ]);
      const path = await download.path();
      expect(path).toBeTruthy();
      // Verify the file has content and starts with PK (ZIP/XLSX magic bytes)
      const buf = fs.readFileSync(path);
      expect(buf.length).toBeGreaterThan(0);
      expect(buf[0]).toBe(0x50); // P
      expect(buf[1]).toBe(0x4B); // K
    } else {
      test.skip();
    }
  });

  test('curated JSON export returns valid shape', async ({ request }) => {
    const API = `${BASE}/api`;
    // This endpoint may or may not exist -- skip if 404
    const res = await request.get(`${API}/admin/export/curated`);
    if (res.status() === 404) {
      test.skip();
      return;
    }
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty('exportedAt');
    }
  });
});

// ─── Matrix Excel export mirrors the grid (#942) ──────────────────────────────
//
// The exported access-package columns must carry the same badge letter the
// on-screen matrix shows for every containment. They didn't: the export still
// applied a retired pre-v5 owner filter, so an access package that grants a
// group's *Owner* role exported an empty column while the grid rendered a 'D'.
// The demo dataset seeds exactly that shape (BR-Engineering-Tools grants
// SG-VPN-Access with roleName='Owner'), so this walks the real Export Excel
// button and diffs the file against the DOM.
test.describe('Matrix Excel export — access-package columns match the grid', () => {
  test.setTimeout(120000);

  const allDataFilter = {
    rowType: 'principal',
    orientation: 'rows-as-resources',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
  };

  // A resource name is NOT unique in the matrix: a group and the GroupOwnership
  // resource named after it are two separate rows, and a tenant may hold two
  // like-named resources of different types. Rows are therefore keyed by
  // name + resource type, and same-key rows are paired up in row order — which
  // the export preserves, writing the on-screen rows top to bottom.
  const rowKey = (name, type) => JSON.stringify([name, type]);

  // Every matrix row the grid renders, in order, with its access-package cells:
  // { resource, type, cells: [{ package, letter, title }] }. AP columns are the
  // header cells that name their catalog; body rows use the same column order,
  // so the header index doubles as the cell index.
  function readGridApRows(page) {
    return page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return [];
      const headerRow = [...table.querySelectorAll('thead tr')].pop();
      const headers = [...headerRow.querySelectorAll('th')];
      const apCols = headers
        .map((th, index) => ({ index, title: th.getAttribute('title') || '', name: th.innerText.trim() }))
        .filter(h => h.title.includes('Catalog:'));

      const rows = [];
      for (const tr of table.querySelectorAll('tbody tr')) {
        const tds = [...tr.querySelectorAll('td')];
        if (tds.length !== headers.length) continue; // spacer / message row
        // The name cell carries an expander glyph for expandable rows; the
        // export writes the bare display name.
        const resource = (tds[1]?.innerText || '').replace(/^[▶▼]\s*/, '').trim();
        const type = (tds[headers.length - 2]?.innerText || '').trim();
        const cells = [];
        for (const col of apCols) {
          const letter = tds[col.index]?.innerText.trim();
          if (letter) cells.push({ package: col.name, letter, title: tds[col.index].getAttribute('title') || '' });
        }
        rows.push({ resource, type, cells });
      }
      return rows;
    });
  }

  // Read the exported sheet back into the same shape, in the same row order.
  async function readWorkbookApRows(filePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.getWorksheet('Role Mining Matrix');
    expect(ws, 'the export has no matrix sheet').toBeTruthy();

    // The names row is the one whose first cell is the Resource Name header;
    // how many attribute levels sit above it depends on the matrix's sort.
    let namesRow = 0;
    for (let r = 1; r <= 6 && !namesRow; r++) {
      if (ws.getCell(r, 1).text === 'Resource Name') namesRow = r;
    }
    expect(namesRow, 'no "Resource Name" header row in the export').toBeGreaterThan(0);

    // The AP block sits between the user columns and the trailing meta columns,
    // under the banner on the first header row. Locating it by span — rather
    // than by "header name that isn't a meta label" — keeps a user whose display
    // name matches an access package out of the comparison.
    let apColStart = 0;
    let metaColStart = 0;
    ws.getRow(namesRow).eachCell((cell, col) => {
      if (cell.text?.trim() === '#' && !metaColStart) metaColStart = col;
    });
    ws.getRow(1).eachCell((cell, col) => {
      if (cell.text?.trim() === 'Governed (via Business Roles)' && !apColStart) apColStart = col;
    });
    expect(metaColStart, 'no "#" meta column in the export').toBeGreaterThan(0);

    const apColumns = new Map(); // package name -> column index
    for (let col = apColStart; col > 0 && col < metaColStart; col++) {
      const name = ws.getCell(namesRow, col).text?.trim();
      if (name) apColumns.set(name, col);
    }

    const rows = [];
    for (let r = namesRow + 1; r <= ws.rowCount; r++) {
      const resource = ws.getCell(r, 1).text?.trim();
      if (!resource) continue;
      const type = ws.getCell(r, metaColStart + 1).text?.trim();
      const cells = new Map();
      for (const [name, col] of apColumns) {
        const letter = ws.getCell(r, col).text?.trim();
        if (letter) cells.set(name, letter);
      }
      rows.push({ resource, type, cells });
    }
    return rows;
  }

  // Pair each grid row with the export row for the same resource, matching
  // repeats of a name+type key in row order.
  function pairRows(gridRows, exportRows) {
    const byKey = new Map();
    for (const row of exportRows) {
      const key = rowKey(row.resource, row.type);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }
    return gridRows.map(gridRow => ({
      gridRow,
      exportRow: byKey.get(rowKey(gridRow.resource, gridRow.type))?.shift() || null,
    }));
  }

  test('every badge in the grid is in the exported file, owner role scopes included', async ({ page }) => {
    await page.goto('/#matrix?filter=' + encodeURIComponent(JSON.stringify(allDataFilter)));
    await page.waitForLoadState('networkidle');

    const table = page.locator('table').first();
    try {
      await expect(table).toBeVisible({ timeout: 60000 });
    } catch {
      test.skip(true, 'matrix grid did not render (no data) — cannot compare the export');
    }

    const gridRows = await readGridApRows(page);
    const gridCellCount = gridRows.reduce((n, row) => n + row.cells.length, 0);
    test.skip(gridCellCount === 0, 'this dataset has no governed access-package columns in the matrix');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.getByRole('button', { name: /Export Excel/i }).first().click(),
    ]);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const exportRows = await readWorkbookApRows(filePath);
    const paired = pairRows(gridRows, exportRows);

    // 1. The two must agree cell for cell, in both directions: nothing the grid
    // badges may be missing from (or differ in) the file, and the file may not
    // badge a cell the grid leaves empty.
    const disagreements = [];
    for (const { gridRow, exportRow } of paired) {
      const label = `${gridRow.resource} (${gridRow.type})`;
      if (!exportRow) {
        disagreements.push(`${label}: row missing from the export`);
        continue;
      }
      const seen = new Set();
      for (const cell of gridRow.cells) {
        seen.add(cell.package);
        const letter = exportRow.cells.get(cell.package);
        if (letter !== cell.letter) {
          disagreements.push(`${label} × ${cell.package}: grid '${cell.letter}', export '${letter ?? '(empty)'}'`);
        }
      }
      for (const [pkg, letter] of exportRow.cells) {
        if (!seen.has(pkg)) disagreements.push(`${label} × ${pkg}: grid '(empty)', export '${letter}'`);
      }
    }
    expect(disagreements, 'exported access-package cells disagree with the grid').toEqual([]);

    // 2. The specific regression: a containment whose role scope is Owner.
    // The demo dataset seeds one; a tenant without one still gets check 1.
    const ownerCells = paired.flatMap(({ gridRow, exportRow }) =>
      gridRow.cells.filter(c => /\(owner\)/i.test(c.title)).map(cell => ({ gridRow, exportRow, cell })));
    for (const { gridRow, exportRow, cell } of ownerCells) {
      expect(cell.letter, `the grid badges the owner role scope on ${gridRow.resource} as Direct`).toBe('D');
      expect(exportRow?.cells.get(cell.package), `the export badges the owner role scope on ${gridRow.resource} as Direct`).toBe('D');
    }
  });

  test('the demo dataset keeps an owner-role access-package containment', async ({ request }) => {
    // Guards the fixture that makes the check above meaningful: if this role
    // scope is dropped from the demo data, the regression stops being covered.
    const res = await request.get(`${BASE}/api/access-package-groups`);
    test.skip(!res.ok(), 'access-package mapping endpoint unavailable');
    const rows = await res.json();
    test.skip(!Array.isArray(rows) || rows.length === 0, 'no governance data loaded');

    const owned = rows.filter(r => /owner/i.test(r.roleName || ''));
    expect(owned.length, 'demo data no longer contains an Owner role scope (see DemoGovernance.ps1)')
      .toBeGreaterThan(0);
  });
});

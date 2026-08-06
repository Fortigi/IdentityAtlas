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

  // Every access-package cell the grid renders, as { resource, package, letter }.
  // AP columns are the header cells that name their catalog; the body rows use
  // the same column order, so the header index doubles as the cell index.
  function readGridApCells(page) {
    return page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return [];
      const namesRow = [...table.querySelectorAll('thead tr')].pop();
      const headers = [...namesRow.querySelectorAll('th')];
      const apCols = headers
        .map((th, index) => ({ index, title: th.getAttribute('title') || '', name: th.innerText.trim() }))
        .filter(h => h.title.includes('Catalog:'));

      const cells = [];
      for (const row of table.querySelectorAll('tbody tr')) {
        const tds = [...row.querySelectorAll('td')];
        if (tds.length !== headers.length) continue; // spacer / message row
        const resource = tds[1]?.innerText.trim();
        for (const col of apCols) {
          const letter = tds[col.index]?.innerText.trim();
          if (letter) cells.push({ resource, package: col.name, letter, title: tds[col.index].getAttribute('title') || '' });
        }
      }
      return cells;
    });
  }

  // Read the exported sheet back into the same { resource → package → letter } shape.
  async function readWorkbookApCells(filePath) {
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

    const meta = new Set(['Resource Name', 'Contexts', 'GUID', '#', 'Type', 'Description']);
    const apColumns = new Map(); // package name -> column index
    ws.getRow(namesRow).eachCell((cell, col) => {
      const name = cell.text?.trim();
      if (name && !meta.has(name)) apColumns.set(name, col);
    });

    const byResource = new Map(); // resource -> Map(package -> letter)
    for (let r = namesRow + 1; r <= ws.rowCount; r++) {
      const resource = ws.getCell(r, 1).text?.trim();
      if (!resource) continue;
      const perAp = new Map();
      for (const [name, col] of apColumns) {
        const letter = ws.getCell(r, col).text?.trim();
        if (letter) perAp.set(name, letter);
      }
      byResource.set(resource, perAp);
    }
    return byResource;
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

    const gridCells = await readGridApCells(page);
    test.skip(gridCells.length === 0, 'this dataset has no governed access-package columns in the matrix');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.getByRole('button', { name: /Export Excel/i }).first().click(),
    ]);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const exported = await readWorkbookApCells(filePath);

    // 1. Nothing the grid shows may be missing from — or differ in — the file.
    const missing = [];
    for (const cell of gridCells) {
      const letter = exported.get(cell.resource)?.get(cell.package);
      if (letter !== cell.letter) {
        missing.push(`${cell.resource} × ${cell.package}: grid '${cell.letter}', export '${letter ?? '(empty)'}'`);
      }
    }
    expect(missing, 'exported access-package cells disagree with the grid').toEqual([]);

    // 2. The specific regression: a containment whose role scope is Owner.
    // The demo dataset seeds one; a tenant without one still gets check 1.
    const ownerCells = gridCells.filter(c => /\(owner\)/i.test(c.title));
    if (ownerCells.length > 0) {
      for (const cell of ownerCells) {
        expect(cell.letter, 'the grid badges an owner role scope as Direct').toBe('D');
        expect(exported.get(cell.resource)?.get(cell.package)).toBe('D');
      }
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

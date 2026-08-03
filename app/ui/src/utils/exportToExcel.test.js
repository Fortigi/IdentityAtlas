// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { exportToExcel } from './exportToExcel.js';

// ---- Download-path stubs ---------------------------------------------------
// exportToExcel() builds the workbook then triggers a browser download via
// URL.createObjectURL + an <a>.click(). jsdom implements neither, so we stub
// them and capture the produced blob so we can re-parse the workbook.

let capturedBlob;
let clickCount;
let createdUrl;
let revokedUrl;

beforeEach(() => {
  capturedBlob = null;
  clickCount = 0;
  createdUrl = null;
  revokedUrl = null;

  // jsdom's Blob doesn't implement .arrayBuffer(), so stub Blob to retain the
  // raw buffer parts the export passes in (new Blob([buffer], { type })).
  vi.stubGlobal('Blob', class {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = opts?.type;
    }
  });

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn((blob) => {
      capturedBlob = blob;
      createdUrl = 'blob:mock-url';
      return createdUrl;
    }),
    revokeObjectURL: vi.fn((url) => {
      revokedUrl = url;
    }),
  });

  // Spy on createElement so the anchor's click() is a no-op we can count.
  // Capture the original via mockRestore's saved reference by grabbing it from
  // the prototype, avoiding self-recursion when the spy calls through.
  const realCreate = Document.prototype.createElement;
  vi.spyOn(document, 'createElement').mockImplementation((tag) => {
    const el = realCreate.call(document, tag);
    if (tag === 'a') {
      el.click = vi.fn(() => { clickCount += 1; });
    }
    return el;
  });
});

// Re-parse the downloaded blob back into a workbook for assertions.
function capturedBuffer() {
  expect(capturedBlob).not.toBeNull();
  return capturedBlob.parts[0];
}

async function loadCapturedWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(capturedBuffer());
  return wb;
}

function baseInput(overrides = {}) {
  return {
    users: [],
    orderedGroups: [],
    memberships: new Map(),
    managedApMap: new Map(),
    apIdToIndex: new Map(),
    activeFilters: [],
    filterFields: [],
    accessPackages: [],
    apGroupMap: new Map(),
    shareUrl: undefined,
    sortAttributes: [],
    ...overrides,
  };
}

describe('exportToExcel', () => {
  it('builds a workbook and triggers a download (empty data)', async () => {
    await exportToExcel(baseInput());

    expect(clickCount).toBe(1);
    expect(createdUrl).toBe('blob:mock-url');
    expect(revokedUrl).toBe('blob:mock-url');
    expect(capturedBlob.type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  });

  it('produces a real .xlsx (zip "PK" signature) with the two expected sheets', async () => {
    await exportToExcel(baseInput());
    const buffer = capturedBuffer();
    const head = Buffer.from(buffer.slice(0, 2)).toString('latin1');
    expect(head).toBe('PK');

    const wb = await loadCapturedWorkbook();
    expect(wb.getWorksheet('Role Mining Matrix')).toBeTruthy();
    expect(wb.getWorksheet('Legend')).toBeTruthy();
  });

  it('writes the info-column headers and a default attribute header row', async () => {
    await exportToExcel(baseInput());
    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Role Mining Matrix');

    // No sortAttributes => one default header level ('department') on row 1,
    // names row on row 2.
    expect(ws.getCell(2, 1).value).toBe('Resource Name');
    expect(ws.getCell(2, 2).value).toBe('Type');
    expect(ws.getCell(2, 3).value).toBe('GUID');
    // Default attribute label is the friendly form of 'department'.
    expect(ws.getCell(1, 1).value).toBe('Department');
  });

  it('lays out user columns, group rows and membership letters', async () => {
    const users = [
      { id: 'u1', displayName: 'Alice', sortKeys: ['HR'] },
      { id: 'u2', displayName: 'Bob', sortKeys: ['Finance'] },
    ];
    const orderedGroups = [
      { id: 'g1', displayName: 'Admins', groupType: 'Security', realGroupId: 'g1', description: 'desc', memberCount: 5 },
    ];
    const memberships = new Map([
      ['g1|u1', new Set(['Direct'])],
      ['g1|u2', new Set(['Indirect', 'Eligible'])],
    ]);

    await exportToExcel(baseInput({ users, orderedGroups, memberships }));
    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Role Mining Matrix');

    const namesRow = 2; // one default attribute level
    // User name headers
    expect(ws.getCell(namesRow, 4).value).toBe('Alice');
    expect(ws.getCell(namesRow, 5).value).toBe('Bob');

    // Group row (first data row = namesRow + 1)
    const dataRow = namesRow + 1;
    expect(ws.getCell(dataRow, 1).value).toBe('Admins');
    expect(ws.getCell(dataRow, 2).value).toBe('Security');
    expect(ws.getCell(dataRow, 3).value).toBe('g1');
    expect(ws.getCell(dataRow, 6).value).toBe(5); // # (meta col, metaColStart = 3+2+1 = 6)

    // Single membership => first letter of the type.
    expect(ws.getCell(dataRow, 4).value).toBe('D');
    // Multi membership => rich text with one entry per type.
    const multi = ws.getCell(dataRow, 5).value;
    expect(multi.richText.map((rt) => rt.text)).toEqual(['I', 'E']);
  });

  it('writes a Contexts meta column listing every context, untruncated', async () => {
    const users = [{ id: 'u1', displayName: 'Alice', sortKeys: ['HR'] }];
    const orderedGroups = [
      {
        id: 'g1', displayName: 'Admins', groupType: 'Security', description: 'desc', memberCount: 1,
        contexts: [
          { id: 'c1', displayName: 'Finance' },
          { id: 'c2', displayName: 'Microsoft 365' },
          { id: 'c3', displayName: 'Cluster-A' },
        ],
      },
      { id: 'g2', displayName: 'Readers', groupType: 'Security', description: 'desc', memberCount: 1 },
    ];

    await exportToExcel(baseInput({ users, orderedGroups }));
    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Role Mining Matrix');

    const namesRow = 2;                 // one default attribute level
    const metaColStart = 3 + 1 + 1;     // 3 info cols + 1 user col + 1 (1-based), no APs
    expect(ws.getCell(namesRow, metaColStart).value).toBe('#');
    expect(ws.getCell(namesRow, metaColStart + 1).value).toBe('Contexts');
    expect(ws.getCell(namesRow, metaColStart + 2).value).toBe('Description');

    // All three contexts are exported — the on-screen "+N" cap doesn't apply.
    expect(ws.getCell(namesRow + 1, metaColStart + 1).value).toBe('Finance, Microsoft 365, Cluster-A');
    expect(ws.getCell(namesRow + 1, metaColStart + 2).value).toBe('desc');
    // A resource with no contexts exports an empty cell, not "undefined".
    expect(ws.getCell(namesRow + 2, metaColStart + 1).value ?? '').toBe('');
  });

  it('fills managed intersection cells with an AP color (indexed and fallback)', async () => {
    const users = [
      { id: 'u1', displayName: 'Alice', sortKeys: ['HR'] },
      { id: 'u2', displayName: 'Bob', sortKeys: ['HR'] },
    ];
    const orderedGroups = [
      { id: 'g1', displayName: 'Grp', groupType: '', description: '', memberCount: 1 },
    ];
    // managedApMap keys are lowercase `${groupId}|${userId}`.
    const managedApMap = new Map([
      ['g1|u1', ['apA']], // has an index -> palette color
      ['g1|u2', ['apB']], // no index -> fallback blue
    ]);
    const apIdToIndex = new Map([['apA', 0]]); // apB intentionally absent

    await exportToExcel(baseInput({ users, orderedGroups, managedApMap, apIdToIndex }));
    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Role Mining Matrix');

    const dataRow = 3; // namesRow(2) + 1
    const indexedFill = ws.getCell(dataRow, 4).fill;
    const fallbackFill = ws.getCell(dataRow, 5).fill;
    expect(indexedFill.fgColor.argb).toBe('FFFDE68A'); // AP_COLORS[0] -> argb
    expect(fallbackFill.fgColor.argb).toBe('FFDBEAFE'); // fallback blue
  });

  it('respects custom sortAttributes (multiple header levels)', async () => {
    const users = [
      { id: 'u1', displayName: 'Alice', sortKeys: ['Eng', 'Backend'] },
    ];
    const sortAttributes = [{ attribute: 'department' }, { attribute: 'ext.team' }];

    await exportToExcel(baseInput({ users, sortAttributes }));
    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Role Mining Matrix');

    // Two header levels => names row is row 3.
    expect(ws.getCell(1, 1).value).toBe('Department');
    expect(ws.getCell(2, 1).value).toBe('Team'); // 'ext.' stripped, friendly
    expect(ws.getCell(3, 1).value).toBe('Resource Name');
    // Per-level sort keys for the user.
    expect(ws.getCell(1, 4).value).toBe('Eng');
    expect(ws.getCell(2, 4).value).toBe('Backend');
  });

  it('renders access-package columns and a banner', async () => {
    const accessPackages = [
      { id: 'ap1', displayName: 'Package One' },
      { id: 'ap2', displayName: 'Package Two' },
    ];
    const orderedGroups = [
      { id: 'g1', displayName: 'Grp', groupType: '', description: '', memberCount: 1 },
    ];
    // apGroupMap key: `${lookupGid.toUpperCase()}|${ap.id.toLowerCase()}`
    const apGroupMap = new Map([
      ['G1|ap1', 'Some Group (Member)'],
    ]);

    await exportToExcel(baseInput({ accessPackages, orderedGroups, apGroupMap }));
    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Role Mining Matrix');

    const namesRow = 2;
    const apColStart = 3 + 0 + 1; // infoColCount + userCount + 1
    expect(ws.getCell(namesRow, apColStart).value).toBe('Package One');
    expect(ws.getCell(namesRow, apColStart + 1).value).toBe('Package Two');

    // Banner on row 1 over the AP block.
    expect(ws.getCell(1, apColStart).value).toBe('Governed (via Business Roles)');

    // Non-owner row shows a Member role letter 'D' in the matching AP column.
    const dataRow = namesRow + 1;
    expect(ws.getCell(dataRow, apColStart).value).toBe('D');
  });

  it('populates the Legend sheet with all membership types', async () => {
    await exportToExcel(baseInput());
    const wb = await loadCapturedWorkbook();
    const legend = wb.getWorksheet('Legend');

    expect(legend.getCell(1, 1).value).toBe('Membership Type');
    // First type row is 'Direct' with letter 'D'.
    expect(legend.getCell(2, 1).value).toBe('Direct');
    expect(legend.getCell(2, 2).value).toBe('D');
  });

  it('lists ONLY the three current membership types — no retired badge rows', async () => {
    await exportToExcel(baseInput());
    const wb = await loadCapturedWorkbook();
    const legend = wb.getWorksheet('Legend');

    // Membership-type rows are contiguous from row 2 to the first blank row.
    const typeRows = [];
    for (let r = 2; legend.getCell(r, 1).value; r++) {
      typeRows.push(legend.getCell(r, 1).value);
    }
    expect([...typeRows].sort()).toEqual(['Direct', 'Eligible', 'Indirect']);

    const retired = ['Owner', 'Governed', 'OAuth2Grant', 'AppRole', 'AppRoleViaGroup', 'DirectoryRole', 'DirectoryRoleEligible'];
    for (const t of retired) {
      expect(typeRows, `retired '${t}' must not appear in the Excel legend`).not.toContain(t);
    }
  });

  it('writes active filters and a shareable link into the Legend', async () => {
    const activeFilters = [{ field: 'dept', value: 'HR' }];
    const filterFields = [{ key: 'dept', label: 'Department' }];
    const shareUrl = 'https://example.test/matrix?x=1';

    await exportToExcel(baseInput({ activeFilters, filterFields, shareUrl }));
    const wb = await loadCapturedWorkbook();
    const legend = wb.getWorksheet('Legend');

    // Filter value should appear somewhere in the legend sheet.
    let foundFilter = false;
    let foundLink = false;
    legend.eachRow((row) => {
      row.eachCell((cell) => {
        const v = cell.value;
        if (v === 'HR') foundFilter = true;
        if (v && typeof v === 'object' && v.hyperlink === shareUrl) foundLink = true;
      });
    });
    expect(foundFilter).toBe(true);
    expect(foundLink).toBe(true);
  });

  it('names the download file using the active filter values and ISO date', async () => {
    const activeFilters = [{ field: 'dept', value: 'HR' }];
    const filterFields = [{ key: 'dept', label: 'Department' }];

    const realCreate = document.createElement.getMockImplementation();
    let downloadName;
    document.createElement.mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', { set(v) { downloadName = v; }, configurable: true });
      }
      return el;
    });

    await exportToExcel(baseInput({ activeFilters, filterFields }));
    expect(downloadName).toMatch(/^role-mining-HR-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});

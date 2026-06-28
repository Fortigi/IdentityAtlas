// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { exportAccessPackagesToExcel } from './exportAccessPackagesToExcel.js';

// ---- Download-path stubs ---------------------------------------------------
let capturedBlob;
let clickCount;
let revokedUrl;

beforeEach(() => {
  capturedBlob = null;
  clickCount = 0;
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
      return 'blob:mock-url';
    }),
    revokeObjectURL: vi.fn((url) => {
      revokedUrl = url;
    }),
  });

  const realCreate = Document.prototype.createElement;
  vi.spyOn(document, 'createElement').mockImplementation((tag) => {
    const el = realCreate.call(document, tag);
    if (tag === 'a') el.click = vi.fn(() => { clickCount += 1; });
    return el;
  });
});

function capturedBuffer() {
  expect(capturedBlob).not.toBeNull();
  return capturedBlob.parts[0];
}

async function loadCapturedWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(capturedBuffer());
  return wb;
}

// Build an authFetch mock from a package list and a per-AP resource-roles map.
function makeAuthFetch(packages, rolesById = {}) {
  return vi.fn((path) => {
    if (path.startsWith('/api/access-packages?')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: packages }) });
    }
    const m = path.match(/^\/api\/access-package\/([^/]+)\/resource-roles$/);
    if (m) {
      const roles = rolesById[m[1]] ?? [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(roles) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
}

const HEADERS = [
  'Name', 'Catalog', 'Category', 'Type', 'Assignments',
  'Review Status', 'Review Date', 'Reviewed By', 'Description', 'Group', 'Role',
];

describe('exportAccessPackagesToExcel', () => {
  it('builds the workbook, writes headers and triggers a download (empty data)', async () => {
    const authFetch = makeAuthFetch([]);
    await exportAccessPackagesToExcel({ authFetch, categoryFilter: null });

    expect(clickCount).toBe(1);
    expect(revokedUrl).toBe('blob:mock-url');
    expect(capturedBlob.type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Business Roles');
    expect(ws).toBeTruthy();
    expect(ws.getRow(1).values.slice(1)).toEqual(HEADERS);
  });

  it('produces a real .xlsx (zip "PK" signature)', async () => {
    const authFetch = makeAuthFetch([]);
    await exportAccessPackagesToExcel({ authFetch, categoryFilter: null });
    const buffer = capturedBuffer();
    expect(Buffer.from(buffer.slice(0, 2)).toString('latin1')).toBe('PK');
  });

  it('writes one row per package with no resource roles', async () => {
    const packages = [
      {
        id: 'ap1', displayName: 'Finance Access', catalogName: 'Cat A',
        category: { name: 'Finance' }, assignmentType: 'Direct', totalAssignments: 7,
        complianceStatus: 'Compliant', lastReviewDate: null, lastReviewedBy: 'Wim',
        description: 'Finance package',
      },
    ];
    const authFetch = makeAuthFetch(packages, { ap1: [] });
    await exportAccessPackagesToExcel({ authFetch, categoryFilter: null });

    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Business Roles');
    const r = ws.getRow(2).values;
    expect(r[1]).toBe('Finance Access');
    expect(r[2]).toBe('Cat A');
    expect(r[3]).toBe('Finance');
    expect(r[4]).toBe('Direct');
    expect(r[5]).toBe(7);
    expect(r[6]).toBe('Compliant');
    expect(r[8]).toBe('Wim');
    expect(r[9]).toBe('Finance package');
  });

  it('expands a package into one row per resource role and splits "Group (Role)"', async () => {
    const packages = [
      { id: 'ap1', displayName: 'Pkg', assignmentType: 'Direct', totalAssignments: 2 },
    ];
    const rolesById = {
      ap1: [
        { groupDisplayName: 'Admins', roleDisplayName: 'Owner' },
        { groupDisplayName: 'Readers', roleDisplayName: 'Member' },
        { scopeDisplayName: 'SiteX' }, // no role -> just the name
      ],
    };
    const authFetch = makeAuthFetch(packages, rolesById);
    await exportAccessPackagesToExcel({ authFetch, categoryFilter: null });

    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Business Roles');

    // Three role rows, all sharing the same AP detail values.
    expect(ws.getRow(2).values[1]).toBe('Pkg');
    expect(ws.getRow(3).values[1]).toBe('Pkg');
    expect(ws.getRow(4).values[1]).toBe('Pkg');

    // Group (col 10) and Role (col 11) are split from "Group (Role)".
    expect(ws.getRow(2).values[10]).toBe('Admins');
    expect(ws.getRow(2).values[11]).toBe('Owner');
    expect(ws.getRow(3).values[10]).toBe('Readers');
    expect(ws.getRow(3).values[11]).toBe('Member');
    // Role-less entry: whole string in Group, empty Role.
    expect(ws.getRow(4).values[10]).toBe('SiteX');
    expect(ws.getRow(4).values[11] || '').toBe('');
  });

  it('applies the client-side type filter', async () => {
    const packages = [
      { id: 'ap1', displayName: 'Keep', assignmentType: 'Direct' },
      { id: 'ap2', displayName: 'Drop', assignmentType: 'Eligible' },
    ];
    const authFetch = makeAuthFetch(packages, { ap1: [], ap2: [] });
    await exportAccessPackagesToExcel({ authFetch, categoryFilter: null, typeFilter: 'Direct' });

    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Business Roles');
    expect(ws.getRow(2).values[1]).toBe('Keep');
    // Only the one matching package => no row 3 data.
    expect(ws.getRow(3).values[1]).toBeUndefined();
  });

  it('falls back to review-config defaults and reports progress', async () => {
    const packages = [
      { id: 'ap1', displayName: 'NeedsReview', hasReviewConfigured: true },
      { id: 'ap2', displayName: 'NoReview', hasReviewConfigured: false },
    ];
    const authFetch = makeAuthFetch(packages, { ap1: [], ap2: [] });
    const onProgress = vi.fn();
    await exportAccessPackagesToExcel({ authFetch, categoryFilter: null, onProgress });

    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Business Roles');
    expect(ws.getRow(2).values[6]).toBe('Pending first review');
    expect(ws.getRow(3).values[6]).toBe('Not required');

    expect(onProgress).toHaveBeenCalledWith('Fetching business roles...');
    expect(onProgress).toHaveBeenCalledWith('Building Excel file...');
  });

  it('passes search and category params to the packages endpoint', async () => {
    const authFetch = makeAuthFetch([]);
    await exportAccessPackagesToExcel({
      authFetch, search: 'foo', categoryFilter: 'uncategorized',
      sortCol: 'name', sortDir: 'asc',
    });

    const url = authFetch.mock.calls[0][0];
    expect(url).toContain('search=foo');
    expect(url).toContain('uncategorized=true');
    expect(url).toContain('sortCol=name');
    expect(url).toContain('sortDir=asc');
  });

  it('throws when the packages fetch fails', async () => {
    const authFetch = vi.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    );
    await expect(
      exportAccessPackagesToExcel({ authFetch, categoryFilter: null })
    ).rejects.toThrow('Failed to fetch business roles');
  });

  it('tolerates a failing resource-roles fetch (treats as no roles)', async () => {
    const packages = [{ id: 'ap1', displayName: 'Pkg' }];
    const authFetch = vi.fn((path) => {
      if (path.startsWith('/api/access-packages?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: packages }) });
      }
      // resource-roles endpoint rejects.
      return Promise.reject(new Error('boom'));
    });
    await exportAccessPackagesToExcel({ authFetch, categoryFilter: null });

    const wb = await loadCapturedWorkbook();
    const ws = wb.getWorksheet('Business Roles');
    expect(ws.getRow(2).values[1]).toBe('Pkg');
    // No roles => Group/Role cells stay empty.
    expect(ws.getRow(2).values[10]).toBeUndefined();
  });
});

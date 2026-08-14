import { describe, it, expect } from 'vitest';
import {
  buildApValues,
  splitGroupRole,
  roleFont,
  writeApCells,
  writeGroupRoleCells,
  writeEmptyResourceCells,
} from './exportAccessPackagesToExcel.helpers.js';

// Minimal worksheet stand-in: getCell returns a persistent plain object per (row,col).
function fakeWs() {
  const cells = {};
  return {
    cells,
    getCell(row, col) {
      const key = `${row}:${col}`;
      cells[key] ??= {};
      return cells[key];
    },
  };
}

describe('buildApValues', () => {
  it('maps package fields with fallbacks and keeps compliance status when present', () => {
    const vals = buildApValues({
      displayName: 'Finance', catalogName: 'Cat A', category: { name: 'Finance' },
      assignmentType: 'Direct', totalAssignments: 7, complianceStatus: 'Compliant',
      lastReviewDate: null, lastReviewedBy: 'Wim', description: 'desc',
    });
    expect(vals).toEqual([
      'Finance', 'Cat A', 'Finance', 'Direct', 7, 'Compliant', '', 'Wim', 'desc',
    ]);
  });

  it('falls back to "Pending first review" when a review is configured but no status', () => {
    const vals = buildApValues({ displayName: 'X', hasReviewConfigured: true });
    expect(vals[5]).toBe('Pending first review');
  });

  it('falls back to "Not required" when no review is configured', () => {
    const vals = buildApValues({ displayName: 'X', hasReviewConfigured: false });
    expect(vals[5]).toBe('Not required');
  });

  it('defaults missing string/number fields to empty strings', () => {
    const vals = buildApValues({});
    expect(vals).toEqual(['', '', '', '', '', 'Not required', '', '', '']);
  });
});

describe('splitGroupRole', () => {
  it('splits "Group (Role)" into group and role', () => {
    expect(splitGroupRole('Admins (Owner)')).toEqual({ groupName: 'Admins', roleName: 'Owner' });
  });

  it('returns the whole string as group when there is no parenthesis', () => {
    expect(splitGroupRole('SiteX')).toEqual({ groupName: 'SiteX', roleName: '' });
  });

  it('does not split when a " (" is present but the entry does not end in ")"', () => {
    expect(splitGroupRole('Group (partial')).toEqual({ groupName: 'Group (partial', roleName: '' });
  });
});

describe('roleFont', () => {
  it('colors Owner purple', () => {
    expect(roleFont('Owner')).toEqual({ size: 11, color: { argb: 'FF6B21A8' } });
  });

  it('colors Member blue', () => {
    expect(roleFont('Member')).toEqual({ size: 11, color: { argb: 'FF1D4ED8' } });
  });

  it('leaves other roles the default font', () => {
    expect(roleFont('')).toEqual({ size: 11 });
    expect(roleFont('Reader')).toEqual({ size: 11 });
  });
});

describe('writeApCells', () => {
  it('center-aligns the Assignments column (index 4) and wraps the Description column (index 8)', () => {
    const ws = fakeWs();
    writeApCells(ws, 2, ['a', 'b', 'c', 'd', 5, 'f', 'g', 'h', 'i']);

    // Assignments column (0-based 4 -> cell col 5)
    expect(ws.cells['2:5'].alignment).toEqual({ horizontal: 'center', vertical: 'top' });
    // Description column (0-based 8 -> cell col 9) wraps
    expect(ws.cells['2:9'].alignment).toEqual({ vertical: 'top', wrapText: true });
    // A regular column does not wrap
    expect(ws.cells['2:1'].alignment).toEqual({ vertical: 'top', wrapText: false });
    expect(ws.cells['2:1'].value).toBe('a');
    expect(ws.cells['2:1'].font).toEqual({ size: 11 });
  });

  it('escapes formula-injection values via safeCell', () => {
    const ws = fakeWs();
    writeApCells(ws, 3, ['=SUM(A1)', '', '', '', '', '', '', '', '']);
    expect(ws.cells['3:1'].value).toBe("'=SUM(A1)");
  });
});

describe('writeGroupRoleCells', () => {
  it('writes group and role cells and colors a known role', () => {
    const ws = fakeWs();
    writeGroupRoleCells(ws, 2, 9, 'Admins (Owner)');
    expect(ws.cells['2:10'].value).toBe('Admins');
    expect(ws.cells['2:11'].value).toBe('Owner');
    expect(ws.cells['2:11'].font).toEqual({ size: 11, color: { argb: 'FF6B21A8' } });
    expect(ws.cells['2:10'].border).toBeTruthy();
  });

  it('leaves the role cell empty for a role-less entry', () => {
    const ws = fakeWs();
    writeGroupRoleCells(ws, 2, 9, 'SiteX');
    expect(ws.cells['2:10'].value).toBe('SiteX');
    expect(ws.cells['2:11'].value).toBe('');
    expect(ws.cells['2:11'].font).toEqual({ size: 11 });
  });
});

describe('writeEmptyResourceCells', () => {
  it('borders every cell in the range without setting a value', () => {
    const ws = fakeWs();
    writeEmptyResourceCells(ws, 2, 9, 11);
    expect(ws.cells['2:10'].border).toBeTruthy();
    expect(ws.cells['2:11'].border).toBeTruthy();
    expect(ws.cells['2:10'].value).toBeUndefined();
  });
});

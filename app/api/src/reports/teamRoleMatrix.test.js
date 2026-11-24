import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { teamRoleMatrix, unitRoleMatrices, MATRIX_NOTE } from './teamRoleMatrix.js';
import { EXPORT_FORMATS } from './export.js';
import { TEAM_ACCOUNTS_SQL, TEAM_HOLDINGS_SQL, MAX_TEAM } from '../contexts/teamOverview.js';

const PEOPLE = [
  { id: 'a', displayName: 'Ann Vos', ungoverned: 4 },
  { id: 'b', displayName: 'Bob Kok', ungoverned: 0 },
  { id: 'c', displayName: 'Cas Dam', ungoverned: 2 },
];
const ROLES = [{
  id: 'r1', displayName: 'Finance', holders: ['a', 'b', 'c'],
  origins: { a: { origin: 'Automatic' }, b: { origin: 'Requested' }, c: { origin: null } },
}, { id: 'r2', displayName: 'Audit', holders: ['b'], origins: { b: { origin: 'Discovered' } } }];

describe('teamRoleMatrix', () => {
  it('says per person how each role was assigned, and leaves the rest empty', () => {
    const m = teamRoleMatrix('CTO', { people: PEOPLE, roles: ROLES });
    expect(m.title).toBe('Business roles: CTO');
    expect(m.columns).toEqual(['Ann Vos', 'Bob Kok', 'Cas Dam']);
    expect(m.rows[0]).toEqual({ label: 'Finance', cells: [
      { value: 'Automatic', tone: 'automatic' }, { value: 'By hand', tone: 'manual' }, { value: 'Not recorded', tone: 'unknown' },
    ] });
    expect(m.rows[1].cells).toEqual([null, { value: 'Not recorded', tone: 'unknown' }, null]);
    expect(m.footer).toEqual([{ label: 'Ungoverned permissions', cells: [4, 0, 2] }]);
  });
});

describe('unitRoleMatrices', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  const unit = { id: 'u', displayName: 'CTO' };

  it('builds no tab for a unit without members', async () => {
    const db = { query: vi.fn() };
    expect(await unitRoleMatrices(db, unit, 'Principal', [{ id: null }, { id: 'x', markedFormer: true }])).toEqual({ matrices: [], notices: [] });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('leaves out someone marked former and reads the rest', async () => {
    const db = { query: vi.fn(async (sql) => {
      if (sql === TEAM_ACCOUNTS_SQL) return { rows: [{ memberId: 'a', accountId: 'a', identityId: null }] };
      if (sql === TEAM_HOLDINGS_SQL) return { rows: [{ memberId: 'a', permissions: 3, ungoverned: 1, roles: [{ id: 'r', displayName: 'Finance', origin: 'Automatic' }] }] };
      return { rows: [] };
    }) };
    const { matrices } = await unitRoleMatrices(db, unit, 'Principal', [{ id: 'a', displayName: 'Ann' }, { id: 'z', displayName: 'Zed', markedFormer: true }]);
    expect(matrices[0].columns).toEqual(['Ann']);
    expect(matrices[0].rows[0].cells).toEqual([{ value: 'Automatic', tone: 'automatic' }]);
    expect(matrices[0].footer[0].cells).toEqual([1]);
    expect(db.query.mock.calls[0][1]).toEqual([['a', 'z'].slice(0, 1)]);
  });

  it('builds the tab at exactly the team cap and says so one past it', async () => {
    const members = n => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, displayName: `M${i}` }));
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect((await unitRoleMatrices(db, unit, 'Principal', members(MAX_TEAM))).matrices).toHaveLength(1);
    const over = await unitRoleMatrices(db, unit, 'Principal', members(MAX_TEAM + 1));
    expect(over.matrices).toEqual([]);
    expect(over.notices[0].text).toMatch(/left out/);
  });

  it('a failed read costs the tab, with a warning, not the report', async () => {
    const db = { query: vi.fn(async () => { throw new Error('boom'); }) };
    const out = await unitRoleMatrices(db, unit, 'Principal', [{ id: 'a', displayName: 'Ann' }]);
    expect(out.matrices).toEqual([]);
    expect(out.notices).toEqual([{ severity: 'warning', text: 'The Team roles tab could not be built for this download.' }]);
  });
});

describe('the Team roles tab in the workbook', () => {
  it('comes right after the Summary, with the marks and counts in their cells', async () => {
    const matrix = teamRoleMatrix('CTO', { people: PEOPLE, roles: ROLES });
    const buffer = await EXPORT_FORMATS.xlsx.serialize({
      displayName: 'Unit report', columns: [{ key: 'n', label: 'Name' }], rows: [{ n: 'Ann' }], total: 1, matrices: [matrix],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map(s => s.name)).toEqual(['Summary', 'Team roles', 'Data']);
    const s = wb.getWorksheet('Team roles');
    expect(s.getCell('A1').value).toBe('Business roles: CTO');
    expect(s.getCell('A2').value).toBe(MATRIX_NOTE);
    expect(s.getRow(4).values.slice(1)).toEqual(['Business role', 'Ann Vos', 'Bob Kok', 'Cas Dam']);
    expect(s.getRow(5).values.slice(1)).toEqual(['Finance', 'Automatic', 'By hand', 'Not recorded']);
    expect(s.getCell('B6').value).toBeNull();
    expect(s.getCell('C6').value).toBe('Not recorded');
    expect(s.getRow(7).values.slice(1)).toEqual(['Ungoverned permissions', 4, 0, 2]);
    expect(s.getCell('C5').fill.fgColor.argb).toBe('FFFEF3C7');
  });

  it('a report without a matrix keeps its tabs', async () => {
    const buffer = await EXPORT_FORMATS.xlsx.serialize({ displayName: 'R', columns: [], rows: [] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map(s => s.name)).toEqual(['Summary', 'Data']);
  });
});

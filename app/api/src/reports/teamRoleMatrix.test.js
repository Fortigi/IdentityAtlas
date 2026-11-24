import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { teamRoleMatrix, unitRoleMatrices, reviewCell, MATRIX_NOTE } from './teamRoleMatrix.js';
import { EXPORT_FORMATS } from './export.js';
import { TEAM_ACCOUNTS_SQL, TEAM_HOLDINGS_SQL, MAX_TEAM } from '../contexts/teamOverview.js';
import { ROLE_CONTROL_SQL } from '../lib/businessRoleAccessModel.js';

const PEOPLE = [
  { id: 'a', displayName: 'Ann Vos', ungoverned: 4 },
  { id: 'b', displayName: 'Bob Kok', ungoverned: 0 },
  { id: 'c', displayName: 'Cas Dam', ungoverned: 2 },
];
const ROLES = [{
  id: 'r1', displayName: 'Finance', holders: ['a', 'c'], origins: {},
  accessModel: { control: 'Manual' }, review: { complianceStatus: 'Missed', daysOverdue: 12 },
}, {
  id: 'r2', displayName: 'Audit', holders: ['b'], origins: {},
  accessModel: { control: 'Automatic' }, review: { complianceStatus: null, hasReviewConfigured: false },
}, { id: 'r3', displayName: 'Old', holders: ['a'], origins: {} }];

const TICK = { value: '✓', tone: 'held' };

describe('teamRoleMatrix', () => {
  it('gives each role its type and review once, and ticks who holds it', () => {
    const m = teamRoleMatrix('CTO', { people: PEOPLE, roles: ROLES });
    expect(m.title).toBe('Business roles: CTO');
    expect(m.columns).toEqual(['Type', 'Review status', 'Ann Vos', 'Bob Kok', 'Cas Dam']);
    expect(m.rows[0]).toEqual({ label: 'Finance', cells: [
      { value: 'Manual', tone: 'manual' }, { value: 'Missed (12d ago)', tone: 'missed' }, TICK, null, TICK,
    ] });
    expect(m.rows[1].cells).toEqual([{ value: 'Rule based', tone: 'automatic' }, { value: 'Not required' }, null, TICK, null]);
    expect(m.rows[2].cells.slice(0, 2)).toEqual([{ value: 'Unknown', tone: 'unknown' }, { value: 'Not required' }]);
    expect(m.footer).toEqual([{ label: 'Ungoverned permissions', cells: [null, null, 4, 0, 2] }]);
  });
});

describe('reviewCell', () => {
  it.each([
    [{ complianceStatus: 'Missed', daysOverdue: 3 }, { value: 'Missed (3d ago)', tone: 'missed' }],
    [{ complianceStatus: 'Missed', daysOverdue: 0 }, { value: 'Missed', tone: 'missed' }],
    [{ complianceStatus: 'Compliant' }, { value: 'Compliant' }],
    [{ complianceStatus: null, hasReviewConfigured: true }, { value: 'Pending first review' }],
    [{ complianceStatus: null, hasReviewConfigured: false }, { value: 'Not required' }],
    [undefined, { value: 'Not required' }],
  ])('%j → %j', (review, cell) => expect(reviewCell(review)).toEqual(cell));
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
      if (sql === ROLE_CONTROL_SQL) return { rows: [{ resourceId: 'r', policyCount: 1, inRule: true, outRule: true }] };
      return { rows: [] };
    }) };
    const { matrices } = await unitRoleMatrices(db, unit, 'Principal', [{ id: 'a', displayName: 'Ann' }, { id: 'z', displayName: 'Zed', markedFormer: true }]);
    expect(matrices[0].columns).toEqual(['Type', 'Review status', 'Ann']);
    expect(matrices[0].rows[0].cells).toEqual([{ value: 'Rule based', tone: 'automatic' }, { value: 'Not required' }, TICK]);
    expect(matrices[0].footer[0].cells).toEqual([null, null, 1]);
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
  it('comes right after the Summary, with the type, review, ticks and counts in their cells', async () => {
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
    expect(s.getRow(4).values.slice(1)).toEqual(['Business role', 'Type', 'Review status', 'Ann Vos', 'Bob Kok', 'Cas Dam']);
    expect(s.getRow(5).values.slice(1)).toEqual(['Finance', 'Manual', 'Missed (12d ago)', '✓', undefined, '✓']);
    expect(s.getCell('E5').value).toBeNull();
    expect(s.getCell('B6').value).toBe('Rule based');
    expect(s.getRow(8).values.slice(4)).toEqual([4, 0, 2]);
    expect(s.getCell('B5').fill.fgColor.argb).toBe('FFFEF3C7');
    expect(s.getCell('B6').fill.fgColor.argb).toBe('FFDCFCE7');
    expect(s.getCell('C5').fill.fgColor.argb).toBe('FFFEE2E2');
    expect(s.getCell('D5').fill.fgColor.argb).toBe('FFDBEAFE');
  });

  it('a report without a matrix keeps its tabs', async () => {
    const buffer = await EXPORT_FORMATS.xlsx.serialize({ displayName: 'R', columns: [], rows: [] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map(s => s.name)).toEqual(['Summary', 'Data']);
  });
});

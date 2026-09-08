// The `label` channel on the column-discovery endpoints (issue #872).
//
// The filter menus and the matrix attribute picker must SHOW the clean name and
// keep SENDING the raw stored key — the reject criterion is "a filter that worked
// before now returns nothing because the label got swapped in where the key was
// needed". So every case here asserts BOTH halves: the label the user reads and
// the untouched `column` value the request will carry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const APP_A = '8ce8d3db3b314def88d829e15494e83f';
const APP_B = '1f2e3d4c5b6a79880011223344556677';
const TEAM_KEY = `extension_${APP_A}_sfTeamID`;
const DEPT_KEY = `extension_${APP_A}_sfDepartmentName`;

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';

const columnCache = {
  getPrincipalColumns: vi.fn(async () => [{ name: 'department', rawName: 'department', type: 'text' }]),
  getResourceColumns: vi.fn(async () => [{ name: 'displayName', rawName: 'displayName', type: 'text' }]),
  getPrincipalColumnValuesMeta: vi.fn(async () => ({
    values: { department: ['HR'], [`ext.${DEPT_KEY}`]: ['Sales'], 'ext.userType': ['Member'] },
    truncated: {},
  })),
  getResourceColumnValuesMeta: vi.fn(async () => ({ values: {}, truncated: {} })),
  getPrincipalOrUserColumnValues: vi.fn(async () => ({
    department: ['HR'], [`ext.${TEAM_KEY}`]: ['T-1'], 'ext.userType': ['Member'],
  })),
  getPrincipalOrUserColumns: vi.fn(async () => []),
  getResourceColumnValues: vi.fn(async () => ({})),
  getResourceCols: vi.fn(async () => []),
  searchColumnValues: vi.fn(),
};
vi.mock('../db/columnCache.js', () => ({
  ...columnCache,
  getGroupColumns: columnCache.getResourceColumns,
  getGroupColumnValues: columnCache.getResourceColumnValues,
  VALUE_SEARCH_LIMIT: 50,
}));
vi.mock('../lib/referenceFilters.js', () => ({
  discoverReferenceFields: vi.fn(async () => []),
  extractRelFilters: () => ({ relFilters: {}, rest: {} }),
  buildRelationshipWhere: () => '',
}));
vi.mock('./tags/shared.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureTagTables: vi.fn(async () => {}),
}));

import { clearAttributeLabelCache } from '../lib/attributeLabels.js';
const { default: entitiesRouter } = await import('./tags/entities.js');
const { default: matrixRouter } = await import('./matrix.js');

const usersApp = mountRouter(entitiesRouter);
const matrixApp = mountRouter(matrixRouter);

// The label lookup issues: (1) the stamped-map read, (2) one key scan per table.
// Everything the handler itself asks for is answered with an empty recordset.
function stageLabels({ overrides = [], keys = [] } = {}) {
  query.mockImplementation(async (sql) => {
    if (String(sql).includes('attributeDisplayNames')) return { rows: overrides.map(m => ({ m })) };
    if (String(sql).includes('jsonb_object_keys')) return { rows: keys.map(k => ({ k })) };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  clearAttributeLabelCache();
});
afterEach(() => clearAttributeLabelCache());

describe('GET /user-columns-page — Users filter menu (AC8)', () => {
  it('labels the extension key while leaving the filter key byte-identical', async () => {
    stageLabels({ keys: [TEAM_KEY, 'userType'] });

    const res = await request(usersApp).get('/api/user-columns-page');

    const byCol = Object.fromEntries(res.body.map(c => [c.column, c]));
    // What the user reads…
    expect(byCol[`ext.${TEAM_KEY}`].label).toBe('sfTeamID');
    // …and what the request will carry: unchanged, prefix and all.
    expect(byCol[`ext.${TEAM_KEY}`].column).toBe(`ext.${TEAM_KEY}`);
    expect(byCol[`ext.${TEAM_KEY}`].values).toEqual(['T-1']);
  });

  it('leaves a non-extension ext key without a label so it still reads "(ext)" (AC3)', async () => {
    stageLabels({ keys: [TEAM_KEY, 'userType'] });

    const res = await request(usersApp).get('/api/user-columns-page');

    const userType = res.body.find(c => c.column === 'ext.userType');
    expect(userType).toBeDefined();
    expect(userType).not.toHaveProperty('label');
  });

  it('leaves real columns untouched', async () => {
    stageLabels({ keys: [TEAM_KEY] });

    const res = await request(usersApp).get('/api/user-columns-page');

    expect(res.body.find(c => c.column === 'department')).toEqual({ column: 'department', values: ['HR'] });
  });
});

describe('GET /matrix/columns — sort / roll-up picker (AC9)', () => {
  it('gives the option a clean label and keeps ext.<rawKey> as its value', async () => {
    stageLabels({ keys: [DEPT_KEY] });

    const res = await request(matrixApp).get('/api/matrix/columns?entity=Principal');

    const dept = res.body.find(c => c.column === `ext.${DEPT_KEY}`);
    expect(dept.label).toBe('sfDepartmentName');
    expect(dept.column).toBe(`ext.${DEPT_KEY}`);
  });

  it('keeps two same-named attributes from different apps distinguishable (AC6)', async () => {
    const a = `extension_${APP_A}_employeeID`;
    const b = `extension_${APP_B}_employeeID`;
    columnCache.getPrincipalColumnValuesMeta.mockResolvedValueOnce({
      values: { [`ext.${a}`]: ['E1'], [`ext.${b}`]: ['E2'] },
      truncated: {},
    });
    stageLabels({ keys: [a, b] });

    const res = await request(matrixApp).get('/api/matrix/columns?entity=Principal');

    const byCol = Object.fromEntries(res.body.map(c => [c.column, c]));
    expect(byCol[`ext.${a}`].label).toBe(`employeeID (${APP_A.slice(0, 8)})`);
    expect(byCol[`ext.${b}`].label).toBe(`employeeID (${APP_B.slice(0, 8)})`);
    // Distinct values still hang off their own distinct keys.
    expect(byCol[`ext.${a}`].values).toEqual(['E1']);
    expect(byCol[`ext.${b}`].values).toEqual(['E2']);
  });

  it('serves the plain column list when the label lookup fails (AC11)', async () => {
    query.mockRejectedValue(new Error('boom'));

    const res = await request(matrixApp).get('/api/matrix/columns?entity=Principal');

    expect(res.status).toBe(200);
    const dept = res.body.find(c => c.column === `ext.${DEPT_KEY}`);
    expect(dept).toBeDefined();
    expect(dept).not.toHaveProperty('label');
  });

  it('adds no label to the schema-only fast path (no values, no lookup)', async () => {
    stageLabels({ keys: [DEPT_KEY] });

    const res = await request(matrixApp).get('/api/matrix/columns?entity=Principal&schema=true');

    expect(res.body.every(c => !('label' in c))).toBe(true);
  });
});

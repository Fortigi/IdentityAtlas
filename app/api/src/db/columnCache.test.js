// Regression tests for columnCache.js.
//
// The filter dropdown on the Users / Resources pages is populated from column
// discovery against information_schema. The v5 Postgres migration creates
// quoted-PascalCase tables ("Principals", "Resources") with camelCase columns;
// Postgres is case-sensitive on quoted identifiers, so a lowercase lookup
// silently returns zero rows and the UI dropdown collapses to just the
// synthetic tag field. These tests pin the casing so that regression can't
// slip back in.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We mock `./connection.js` with a query spy that each test can program.
// Vitest hoists vi.mock() above imports, so this runs before columnCache
// loads its `db` dependency.
const queryMock = vi.fn();
vi.mock('./connection.js', () => ({
  query: (...args) => queryMock(...args),
}));

// Helper: load a *fresh* copy of columnCache so the module-scoped caches
// don't leak state between tests.
async function freshModule() {
  vi.resetModules();
  return await import('./columnCache.js');
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('discoverColumns — table/column casing pinned to migrations', () => {
  it('queries information_schema with PascalCase "Principals"', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();
    await mod.getPrincipalColumns();

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['Principals']);
  });

  it('queries information_schema with PascalCase "Resources"', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();
    await mod.getResourceColumns();

    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['Resources']);
  });

  it('excludes the camelCase system columns (not snake_case)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();
    await mod.getPrincipalColumns();

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/column_name NOT IN \('id', 'systemId', 'extendedAttributes'\)/);
    expect(sql).not.toMatch(/system_id|extended_attributes/);
  });

  it('returns column metadata with camelCase names (no snake→camel conversion)', async () => {
    queryMock.mockResolvedValue({
      rows: [
        { column_name: 'displayName', data_type: 'text' },
        { column_name: 'jobTitle',    data_type: 'text' },
      ],
    });
    const mod = await freshModule();
    const cols = await mod.getPrincipalColumns();

    expect(cols).toEqual([
      { name: 'displayName', rawName: 'displayName', type: 'text' },
      { name: 'jobTitle',    rawName: 'jobTitle',    type: 'text' },
    ]);
  });
});

describe('discoverColumnValues — emits correctly-quoted PascalCase table name', () => {
  // Each call to get{Principal,Resource}ColumnValues makes two queries:
  //   1. discoverColumns (information_schema)
  //   2. the UNION ALL over distinct values
  // We program both responses in order.
  function programSchemaThenValues(columns, valueRows) {
    queryMock
      .mockResolvedValueOnce({ rows: columns.map(c => ({ column_name: c.name, data_type: c.type })) })
      .mockResolvedValueOnce({ rows: valueRows });
  }

  it('Principals: SELECTs FROM "Principals" with double-quoted PascalCase', async () => {
    programSchemaThenValues(
      [{ name: 'department', type: 'text' }],
      [{ col: 'department', val: 'Sales' }],
    );
    const mod = await freshModule();
    const grouped = await mod.getPrincipalColumnValues();

    const valuesSql = queryMock.mock.calls[1][0];
    expect(valuesSql).toMatch(/FROM "Principals"/);
    expect(valuesSql).not.toMatch(/FROM "principals"/);
    expect(grouped).toEqual({ department: ['Sales'] });
  });

  it('Resources: SELECTs FROM "Resources" with double-quoted PascalCase', async () => {
    programSchemaThenValues(
      [{ name: 'resourceType', type: 'text' }],
      [{ col: 'resourceType', val: 'Group' }],
    );
    const mod = await freshModule();
    await mod.getResourceColumnValues();

    const valuesSql = queryMock.mock.calls[1][0];
    expect(valuesSql).toMatch(/FROM "Resources"/);
    expect(valuesSql).not.toMatch(/FROM "resources"/);
  });

  it('skips columns whose type is not in FILTERABLE_TYPES (e.g. jsonb, uuid)', async () => {
    programSchemaThenValues(
      [
        { name: 'displayName',        type: 'text' },
        { name: 'extendedAttributes', type: 'jsonb' },
        { name: 'id',                 type: 'uuid'  },
      ],
      [],
    );
    const mod = await freshModule();
    await mod.getPrincipalColumnValues();

    const valuesSql = queryMock.mock.calls[1][0];
    expect(valuesSql).toMatch(/"displayName"/);
    expect(valuesSql).not.toMatch(/"extendedAttributes"/);
    expect(valuesSql).not.toMatch(/\buuid\b/);
  });
});

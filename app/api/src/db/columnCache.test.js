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
  // Each call to get{Principal,Resource}ColumnValues makes three queries in
  // this order:
  //   1. discoverColumns (information_schema)
  //   2. discoverColumnValues (UNION ALL over filterable columns)
  //   3. discoverExtendedAttrValues — key discovery on the JSONB column
  //   4. (optional) distinct-value UNION ALL over the ext keys from step 3
  // Tests program as many responses as they inspect; unused ones can be
  // left as empty rows.
  function programQueries(columnRows, valueRows, extKeyRows = [], extValueRows = []) {
    queryMock
      .mockResolvedValueOnce({ rows: columnRows })
      .mockResolvedValueOnce({ rows: valueRows })
      .mockResolvedValueOnce({ rows: extKeyRows });
    if (extKeyRows.length > 0) {
      queryMock.mockResolvedValueOnce({ rows: extValueRows });
    }
  }

  it('Principals: SELECTs FROM "Principals" with double-quoted PascalCase', async () => {
    programQueries(
      [{ column_name: 'department', data_type: 'text' }],
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
    programQueries(
      [{ column_name: 'resourceType', data_type: 'text' }],
      [{ col: 'resourceType', val: 'Group' }],
    );
    const mod = await freshModule();
    await mod.getResourceColumnValues();

    const valuesSql = queryMock.mock.calls[1][0];
    expect(valuesSql).toMatch(/FROM "Resources"/);
    expect(valuesSql).not.toMatch(/FROM "resources"/);
  });

  it('skips columns whose type is not in FILTERABLE_TYPES (e.g. jsonb, uuid)', async () => {
    programQueries(
      [
        { column_name: 'displayName',        data_type: 'text' },
        { column_name: 'extendedAttributes', data_type: 'jsonb' },
        { column_name: 'id',                 data_type: 'uuid'  },
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

describe('discoverExtendedAttrValues — surfaces JSONB keys as ext.<key>', () => {
  it('enumerates scalar JSONB keys and emits distinct values under ext.<key>', async () => {
    queryMock
      // discoverColumns — keep tiny so we reach the ext phase quickly
      .mockResolvedValueOnce({ rows: [{ column_name: 'department', data_type: 'text' }] })
      // discoverColumnValues — base UNION ALL
      .mockResolvedValueOnce({ rows: [{ col: 'department', val: 'Sales' }] })
      // ext key discovery
      .mockResolvedValueOnce({ rows: [{ key: 'userType' }, { key: 'onPremisesSyncEnabled' }] })
      // ext value UNION ALL
      .mockResolvedValueOnce({ rows: [
        { col: 'ext.userType', val: 'Member' },
        { col: 'ext.userType', val: 'Guest' },
        { col: 'ext.onPremisesSyncEnabled', val: 'true' },
      ]});

    const mod = await freshModule();
    const grouped = await mod.getPrincipalColumnValues();

    expect(grouped['department']).toEqual(['Sales']);
    expect(grouped['ext.userType']).toEqual(['Member', 'Guest']);
    expect(grouped['ext.onPremisesSyncEnabled']).toEqual(['true']);

    // Ext key-discovery SQL must restrict to scalar jsonb types — that's what
    // excludes objects (signInActivity) and arrays (groupTypes) from the list.
    const keyDiscoverySql = queryMock.mock.calls[2][0];
    expect(keyDiscoverySql).toMatch(/jsonb_typeof.*IN \('string', 'number', 'boolean'\)/);
    expect(keyDiscoverySql).toMatch(/FROM "Principals"/);

    // Ext value SQL must use the ->>'<key>' form on the extendedAttributes
    // column. If anyone changes it back to `->` (returning jsonb) string
    // equality breaks for booleans/numbers.
    const extValuesSql = queryMock.mock.calls[3][0];
    expect(extValuesSql).toMatch(/"extendedAttributes"->>'userType'/);
    expect(extValuesSql).toMatch(/"extendedAttributes"->>'onPremisesSyncEnabled'/);
  });

  it('drops keys whose name contains unsafe characters (no SQL-injection vector)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })       // discoverColumns — empty is fine
      // No base values query because filterableCols is empty → discoverColumnValues returns {}
      // Actually it WILL issue the UNION ALL only when filterableCols.length > 0, so skip it.
      // But we still hit the ext key query:
      .mockResolvedValueOnce({ rows: [
        { key: 'userType' },
        { key: "badKey'; DROP TABLE--" },
        { key: 'extension_deadbeef_sAMAccountName' },
      ]})
      .mockResolvedValueOnce({ rows: [
        { col: 'ext.userType', val: 'Member' },
        { col: 'ext.extension_deadbeef_sAMAccountName', val: 'jdoe' },
      ]});

    const mod = await freshModule();
    await mod.getPrincipalColumnValues();

    // Call sequence with an empty column list: schema, ext-key-discovery,
    // ext-value UNION. The base-values query is skipped.
    const extValuesSql = queryMock.mock.calls[2][0];
    expect(extValuesSql).toMatch(/'userType'/);
    expect(extValuesSql).toMatch(/'extension_deadbeef_sAMAccountName'/);
    expect(extValuesSql).not.toMatch(/DROP TABLE/);
  });
});

// ─── #928 — deterministic, flagged truncation ──────────────────────
//
// The distinct-value preload is capped. It used to be capped with a bare
// `LIMIT 500` and no ORDER BY, so Postgres served an ARBITRARY page of the
// distinct values and the matrix wizard's value list had unpredictable holes.
// The fix: order inside the subquery, fetch one extra row as an overflow probe,
// serve the first page and flag the column truncated.

describe('distinct-value pages are ordered and flagged when truncated (#928)', () => {
  function rows(col, n, offset = 0) {
    return Array.from({ length: n }, (_, i) => ({ col, val: `v${String(i + offset).padStart(4, '0')}` }));
  }

  it('orders inside the subquery and fetches one row past the page size', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ column_name: 'description', data_type: 'text' }] })
      .mockResolvedValueOnce({ rows: rows('description', 3) })
      .mockResolvedValueOnce({ rows: [] });

    const mod = await freshModule();
    await mod.getResourceColumnValues();

    const valuesSql = queryMock.mock.calls[1][0];
    expect(valuesSql).toMatch(/ORDER BY val\s+LIMIT 501/);
    expect(mod.VALUE_PAGE_SIZE).toBe(500);
  });

  it('flags a column that overflows the page and trims it to the page size', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ column_name: 'description', data_type: 'text' }] })
      .mockResolvedValueOnce({ rows: rows('description', 501) })
      .mockResolvedValueOnce({ rows: [] });

    const mod = await freshModule();
    const { values, truncated } = await mod.getResourceColumnValuesMeta();

    expect(values.description).toHaveLength(500);
    expect(values.description[0]).toBe('v0000');
    expect(values.description[499]).toBe('v0499');
    expect(truncated.description).toBe(true);
  });

  it('leaves a column that fits unflagged', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ column_name: 'description', data_type: 'text' }] })
      .mockResolvedValueOnce({ rows: rows('description', 500) })
      .mockResolvedValueOnce({ rows: [] });

    const mod = await freshModule();
    const { values, truncated } = await mod.getResourceColumnValuesMeta();

    expect(values.description).toHaveLength(500);
    expect(truncated.description).toBeUndefined();
  });

  it('flags an overflowing ext.<key> the same way', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ key: 'costCenter' }] })
      .mockResolvedValueOnce({ rows: rows('ext.costCenter', 501) });

    const mod = await freshModule();
    const { values, truncated } = await mod.getPrincipalColumnValuesMeta();

    expect(values['ext.costCenter']).toHaveLength(500);
    expect(truncated['ext.costCenter']).toBe(true);
    expect(queryMock.mock.calls[2][0]).toMatch(/ORDER BY val\s+LIMIT 501/);
  });

  it('clearColumnCaches() forces a re-query', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();
    await mod.getResourceColumns();
    await mod.getResourceColumns();
    expect(queryMock).toHaveBeenCalledTimes(1); // cached

    mod.clearColumnCaches();
    await mod.getResourceColumns();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('searchColumnValues — the escape hatch past a truncated page (#928)', () => {
  it('binds the needle and matches case-insensitively on a real column', async () => {
    queryMock.mockResolvedValue({ rows: [{ val: 'Finance team' }] });
    const mod = await freshModule();

    const found = await mod.searchColumnValues(
      'Resources', 'description', 'FINANCE', new Set(['description']),
    );

    expect(found).toEqual(['Finance team']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['FINANCE']);
    expect(sql).toMatch(/FROM "Resources"/);
    expect(sql).toMatch(/strpos\(lower\("description"::text\), lower\(\$1\)\)/);
    expect(sql).toMatch(/ORDER BY val\s+LIMIT 50/);
    // The needle must never be interpolated — a wildcard typed by the user is
    // a literal character, and an apostrophe must not reach the SQL text.
    expect(sql).not.toMatch(/FINANCE/);
  });

  it('uses the JSON-path form for an ext.<key> column', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();

    await mod.searchColumnValues('Principals', 'ext.costCenter', 'EU', new Set(['ext.costCenter']));

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/"extendedAttributes"->>'costCenter'/);
    expect(sql).toMatch(/"extendedAttributes" \? 'costCenter'/);
  });

  it('refuses a column that is not in the allowlist', async () => {
    const mod = await freshModule();
    await expect(
      mod.searchColumnValues('Resources', 'password"; DROP TABLE "Resources', 'x', new Set(['description'])),
    ).rejects.toThrow(/Unknown column/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('refuses an unsafe table name', async () => {
    const mod = await freshModule();
    await expect(
      mod.searchColumnValues('Resources"; DROP', 'description', 'x', new Set(['description'])),
    ).rejects.toThrow(/Invalid table name/);
  });

  it('refuses an allowlisted-but-unsafe column name', async () => {
    const mod = await freshModule();
    await expect(
      mod.searchColumnValues('Resources', 'bad name', 'x', new Set(['bad name'])),
    ).rejects.toThrow(/Invalid column name/);
  });
});

describe('value caches', () => {
  it('serves a second call from the cache and re-queries after clearColumnCaches()', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();

    await mod.getPrincipalColumnValuesMeta();
    await mod.getResourceColumnValuesMeta();
    const afterFirst = queryMock.mock.calls.length;

    await mod.getPrincipalColumnValuesMeta();
    await mod.getResourceColumnValuesMeta();
    expect(queryMock).toHaveBeenCalledTimes(afterFirst);

    mod.clearColumnCaches();
    await mod.getPrincipalColumnValuesMeta();
    expect(queryMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

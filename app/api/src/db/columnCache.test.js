// Regression tests for columnCache.js.
//
// The filter dropdown on the Users / Resources pages is populated from column
// discovery against information_schema. The v5 Postgres migration creates
// quoted-PascalCase tables ("Principals", "Resources") with camelCase columns;
// Postgres is case-sensitive on quoted identifiers, so a lowercase lookup
// silently returns zero rows and the UI dropdown collapses to just the
// synthetic tag field. These tests pin the casing so that regression can't
// slip back in.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// A value-discovery pass now issues four KINDS of query, and which of them run
// depends on the data (a table with no stats row for a column routes it
// differently from one that has). Tests therefore answer by SQL shape rather
// than by call index, and assert on the query of the kind they care about.
function route({ schema = [], stats = [], values = [], ext = [] } = {}) {
  queryMock.mockImplementation(async (sql) => {
    if (/information_schema/.test(sql)) return { rows: schema };
    if (/pg_stats/.test(sql))           return { rows: stats };
    if (/jsonb_each/.test(sql))         return { rows: ext };
    return { rows: values };
  });
}

// The SQL of the last query matching `re`, or undefined when none was issued.
function sqlMatching(re) {
  const hit = [...queryMock.mock.calls].reverse().find(([sql]) => re.test(sql));
  return hit && hit[0];
}
const valuesSql = () => sqlMatching(/SELECT DISTINCT|LATERAL \(VALUES/);
const extSql    = () => sqlMatching(/jsonb_each/);

describe('discoverColumnValues — emits correctly-quoted PascalCase table name', () => {
  it('Principals: SELECTs FROM "Principals" with double-quoted PascalCase', async () => {
    route({
      schema: [{ column_name: 'department', data_type: 'text' }],
      values: [{ col: 'department', val: 'Sales' }],
    });
    const mod = await freshModule();
    const grouped = await mod.getPrincipalColumnValues();

    expect(valuesSql()).toMatch(/FROM "Principals"/);
    expect(valuesSql()).not.toMatch(/FROM "principals"/);
    expect(grouped).toEqual({ department: ['Sales'] });
  });

  it('Resources: SELECTs FROM "Resources" with double-quoted PascalCase', async () => {
    route({
      schema: [{ column_name: 'resourceType', data_type: 'text' }],
      values: [{ col: 'resourceType', val: 'Group' }],
    });
    const mod = await freshModule();
    await mod.getResourceColumnValues();

    expect(valuesSql()).toMatch(/FROM "Resources"/);
    expect(valuesSql()).not.toMatch(/FROM "resources"/);
  });

  it('skips columns whose type is not in FILTERABLE_TYPES (e.g. jsonb, uuid)', async () => {
    route({
      schema: [
        { column_name: 'displayName',        data_type: 'text' },
        { column_name: 'extendedAttributes', data_type: 'jsonb' },
        { column_name: 'id',                 data_type: 'uuid'  },
      ],
    });
    const mod = await freshModule();
    await mod.getPrincipalColumnValues();

    expect(valuesSql()).toMatch(/"displayName"/);
    expect(valuesSql()).not.toMatch(/"extendedAttributes"::text/);
    expect(valuesSql()).not.toMatch(/\buuid\b/);
  });

  it('asks pg_stats for the table it is discovering, and only that table', async () => {
    route({ schema: [{ column_name: 'department', data_type: 'text' }] });
    const mod = await freshModule();
    await mod.getResourceColumnValues();

    const [sql, params] = queryMock.mock.calls.find(([s]) => /pg_stats/.test(s));
    expect(sql).toMatch(/n_distinct/);
    expect(params).toEqual(['Resources']);
  });

  it('still discovers values when pg_stats is unreadable — hints are not correctness', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/information_schema/.test(sql)) return { rows: [{ column_name: 'department', data_type: 'text' }] };
      if (/pg_stats/.test(sql)) throw new Error('permission denied for view pg_stats');
      if (/jsonb_each/.test(sql)) return { rows: [] };
      return { rows: [{ col: 'department', val: 'Sales' }] };
    });
    const mod = await freshModule();
    expect(await mod.getPrincipalColumnValues()).toEqual({ department: ['Sales'] });
  });
});

describe('planColumnValueQueries — pg_stats routing (a hint, never correctness)', () => {
  let mod;
  const col = (name) => ({ name, rawName: name, type: 'text' });
  const cols = (...names) => names.map(col);
  const names = (list) => list.map(c => c.name).sort();

  beforeEach(async () => { mod = await freshModule(); });

  it('reads a negative n_distinct as a fraction of the row count', () => {
    // -1 is "unique": 1000 rows ⇒ 1000 distinct, not 1.
    expect(mod.estimateDistinct(-1, 1000)).toBe(1000);
    expect(mod.estimateDistinct(-0.25, 1000)).toBe(250);
  });

  it('reads a positive n_distinct as an absolute count, independent of the row count', () => {
    expect(mod.estimateDistinct(7, 1000)).toBe(7);
    expect(mod.estimateDistinct(7, 10_000_000)).toBe(7);
  });

  it('distinguishes "all NULL" (0 distinct) from "no stats at all" (unknown)', () => {
    expect(mod.estimateDistinct(0, 1000)).toBe(0);
    expect(mod.estimateDistinct(undefined, 1000)).toBeNull();
    expect(mod.estimateDistinct(-1, 0)).toBeNull();   // no usable row count
  });

  it('shares the narrow columns and gives each wide one its own branch', () => {
    const stats = new Map([['department', 44], ['jobTitle', 1200], ['displayName', -1]]);
    const plan = mod.planColumnValueQueries(cols('department', 'jobTitle', 'displayName'), stats, 176_789);
    expect(names(plan.shared)).toEqual(['department', 'jobTitle']);
    expect(names(plan.separate)).toEqual(['displayName']);
  });

  it('gives a column with no stats row its own branch — unknown is treated as wide', () => {
    const stats = new Map([['department', 44], ['jobTitle', 1200]]);
    const plan = mod.planColumnValueQueries(cols('department', 'jobTitle', 'mystery'), stats, 1000);
    expect(names(plan.separate)).toEqual(['mystery']);
  });

  it('keeps an all-NULL column on the shared pass — it costs the aggregate nothing', () => {
    const stats = new Map([['department', 44], ['jobTitle', 12], ['photoContentType', 0]]);
    const plan = mod.planColumnValueQueries(cols('department', 'jobTitle', 'photoContentType'), stats, 1000);
    expect(names(plan.shared)).toEqual(['department', 'jobTitle', 'photoContentType']);
    expect(plan.separate).toEqual([]);
  });

  it('sheds the widest candidates first once the shared budget is spent', () => {
    // Narrow/medium/wide, budget big enough for the first two only.
    const stats = new Map([['a', 10], ['b', 100], ['c', 900]]);
    const plan = mod.planColumnValueQueries(cols('a', 'b', 'c'), stats, 1000, 5000, 200);
    expect(names(plan.shared)).toEqual(['a', 'b']);
    expect(names(plan.separate)).toEqual(['c']);
  });

  it('does not build a shared pass for a single column — that is just a branch', () => {
    const stats = new Map([['department', 44], ['displayName', -1]]);
    const plan = mod.planColumnValueQueries(cols('department', 'displayName'), stats, 1_000_000);
    expect(plan.shared).toEqual([]);
    expect(names(plan.separate)).toEqual(['department', 'displayName']);
  });

  it('emits one scan for the shared columns and a capped page per column', () => {
    const sql = mod.sharedColumnPass('Principals', cols('department', 'jobTitle'), 500);
    expect(sql).toMatch(/FROM "Principals",\s*\n?\s*LATERAL \(VALUES/);
    expect(sql).toContain(`('department', "department"::text)`);
    expect(sql).toContain(`('jobTitle', "jobTitle"::text)`);
    expect(sql).toMatch(/PARTITION BY col ORDER BY val/);
    expect(sql).toMatch(/rn <= 501/);
    // One scan, not one per column.
    expect(sql.match(/FROM "Principals"/g)).toHaveLength(1);
  });
});

describe('discoverExtendedAttrValues — surfaces JSONB keys as ext.<key>', () => {
  it('enumerates scalar JSONB keys and emits distinct values under ext.<key>', async () => {
    route({
      schema: [{ column_name: 'department', data_type: 'text' }],
      values: [{ col: 'department', val: 'Sales' }],
      ext: [
        { col: 'ext.userType', val: 'Member' },
        { col: 'ext.userType', val: 'Guest' },
        { col: 'ext.onPremisesSyncEnabled', val: 'true' },
      ],
    });

    const mod = await freshModule();
    const grouped = await mod.getPrincipalColumnValues();

    expect(grouped['department']).toEqual(['Sales']);
    expect(grouped['ext.userType']).toEqual(['Member', 'Guest']);
    expect(grouped['ext.onPremisesSyncEnabled']).toEqual(['true']);

    // Must restrict to scalar jsonb types — that's what excludes objects
    // (signInActivity) and arrays (groupTypes) from the list.
    expect(extSql()).toMatch(/jsonb_typeof\(e\.value\) IN \('string', 'number', 'boolean'\)/);
    expect(extSql()).toMatch(/FROM "Principals" t/);
    // `#>> '{}'` renders a scalar as text exactly as `->>` did. If anyone
    // changes it to `->` (which keeps jsonb) every boolean and number comes
    // back quoted and string equality against a filter value breaks.
    expect(extSql()).toMatch(/e\.value #>> '\{\}'/);
    // Keys and values come out of ONE pass — not a key query and then one
    // query per key, which is what made this the slowest part of discovery.
    expect(queryMock.mock.calls.filter(([s]) => /jsonb_each|jsonb_object_keys/.test(s))).toHaveLength(1);
  });

  it('skips a row whose extendedAttributes is not an object instead of failing the whole pass', async () => {
    route({ schema: [] });
    const mod = await freshModule();
    await mod.getPrincipalColumnValues();
    // jsonb_each() raises "cannot call jsonb_each on a non-object" on an array
    // or a bare scalar, and that error would take the entire filter bar down —
    // so the row is filtered out BEFORE the function is called, inside the
    // LATERAL, where a WHERE clause would be too late.
    expect(extSql()).toMatch(/jsonb_each\(\s*CASE WHEN jsonb_typeof\(t\."extendedAttributes"\) = 'object'/);
  });

  it('never interpolates a discovered key into SQL — the key set is found IN the query', async () => {
    route({
      schema: [],
      // A key named like an injection attempt comes back as DATA in the
      // result. The old two-step form put the discovered key names straight
      // back into the next query's text; this one never does, so a key can
      // only ever end up in a response body.
      ext: [
        { col: 'ext.userType', val: 'Member' },
        { col: "ext.badKey'; DROP TABLE--", val: 'x' },
      ],
    });

    const mod = await freshModule();
    const grouped = await mod.getPrincipalColumnValues();

    expect(grouped["ext.badKey'; DROP TABLE--"]).toEqual(['x']);
    for (const [sql] of queryMock.mock.calls) expect(sql).not.toMatch(/DROP TABLE/);
    // The safe-identifier guard lives in the query itself.
    expect(extSql()).toContain("e.key ~ '^[a-zA-Z0-9_]+$'");
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
    route({
      schema: [{ column_name: 'description', data_type: 'text' }],
      values: rows('description', 3),
    });

    const mod = await freshModule();
    await mod.getResourceColumnValues();

    expect(valuesSql()).toMatch(/ORDER BY val\s+LIMIT 501/);
    expect(mod.DEFAULT_VALUE_PAGE_SIZE).toBe(500);
  });

  it('caps the shared pass at the same page size + 1 probe row', async () => {
    const mod = await freshModule();
    const cols = ['a', 'b'].map(n => ({ name: n, rawName: n, type: 'text' }));
    expect(mod.sharedColumnPass('Principals', cols, 500)).toMatch(/rn <= 501/);
    expect(mod.sharedColumnPass('Principals', cols, 10)).toMatch(/rn <= 11/);
  });

  it('flags a column that overflows the page and trims it to the page size', async () => {
    route({
      schema: [{ column_name: 'description', data_type: 'text' }],
      values: rows('description', 501),
    });

    const mod = await freshModule();
    const { values, truncated } = await mod.getResourceColumnValuesMeta();

    expect(values.description).toHaveLength(500);
    expect(values.description[0]).toBe('v0000');
    expect(values.description[499]).toBe('v0499');
    expect(truncated.description).toBe(true);
  });

  it('leaves a column that fits unflagged', async () => {
    route({
      schema: [{ column_name: 'description', data_type: 'text' }],
      values: rows('description', 500),
    });

    const mod = await freshModule();
    const { values, truncated } = await mod.getResourceColumnValuesMeta();

    expect(values.description).toHaveLength(500);
    expect(truncated.description).toBeUndefined();
  });

  it('flags an overflowing ext.<key> the same way', async () => {
    route({ schema: [], ext: rows('ext.costCenter', 501) });

    const mod = await freshModule();
    const { values, truncated } = await mod.getPrincipalColumnValuesMeta();

    expect(values['ext.costCenter']).toHaveLength(500);
    expect(truncated['ext.costCenter']).toBe(true);
    expect(extSql()).toMatch(/p\.rn <= 501/);
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

// ─── #928 follow-up — the page size is a deployment setting ────────
//
// The capped path only shows up once a column has more distinct values than the
// page holds. A deployment with a few hundred resources never reaches 500, so
// MATRIX_VALUE_PAGE_SIZE lowers the threshold to make that path reachable (and
// testable) on a small dataset.

describe('MATRIX_VALUE_PAGE_SIZE (#928)', () => {
  function rows(col, n) {
    return Array.from({ length: n }, (_, i) => ({ col, val: `v${String(i).padStart(4, '0')}` }));
  }

  const original = process.env.MATRIX_VALUE_PAGE_SIZE;
  afterEach(() => {
    if (original === undefined) delete process.env.MATRIX_VALUE_PAGE_SIZE;
    else process.env.MATRIX_VALUE_PAGE_SIZE = original;
  });

  // What the setting itself parses to is pinned in db/valueCache.test.js;
  // these cases are about what discovery does with it.

  it('pages and flags a small column when the size is lowered', async () => {
    process.env.MATRIX_VALUE_PAGE_SIZE = '5';
    route({
      schema: [{ column_name: 'description', data_type: 'text' }],
      values: rows('description', 6),
    });

    const mod = await freshModule();
    const { values, truncated, pageSize } = await mod.getResourceColumnValuesMeta();

    expect(valuesSql()).toMatch(/ORDER BY val\s+LIMIT 6/);
    expect(values.description).toEqual(['v0000', 'v0001', 'v0002', 'v0003', 'v0004']);
    expect(truncated.description).toBe(true);
    expect(pageSize).toBe(5);
  });

  it('re-discovers instead of serving a cached page cut to the old size', async () => {
    process.env.MATRIX_VALUE_PAGE_SIZE = '2';
    route({
      schema: [{ column_name: 'description', data_type: 'text' }],
      values: rows('description', 3),
    });

    const mod = await freshModule();
    expect((await mod.getResourceColumnValuesMeta()).values.description).toHaveLength(2);
    const afterFirst = queryMock.mock.calls.length;

    // Same size → cached.
    await mod.getResourceColumnValuesMeta();
    expect(queryMock).toHaveBeenCalledTimes(afterFirst);

    // A different page size is a different answer, so the cached one is not
    // even usable as a stale stand-in: the caller must wait for a fresh page.
    process.env.MATRIX_VALUE_PAGE_SIZE = '10';
    const { values, truncated } = await mod.getResourceColumnValuesMeta();

    expect(queryMock.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(values.description).toHaveLength(3);
    expect(truncated.description).toBeUndefined();
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

// ─── SEC-2026-09 L-16 — the discovered extendedAttributes key set is capped ───

describe('discoverExtendedAttrValues — key cap', () => {
  it('keeps the most frequent safe keys, capped, ranked by how many rows carry them', async () => {
    queryMock.mockResolvedValue({ rows: [{ col: 'ext.userType', val: 'Member' }] });
    const mod = await freshModule();
    await mod.discoverExtendedAttrValues('Principals', 10, 25);

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/ORDER BY sum\(rows\) DESC, col/);
    expect(sql).toMatch(/k\.krank <= 25/);
    expect(sql).toMatch(/p\.rn <= 11/);
    expect(sql).toContain("e.key ~ '^[a-zA-Z0-9_]+$'");
  });

  it('defaults the cap to MAX_EXTENDED_ATTR_KEYS (300)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();
    expect(mod.MAX_EXTENDED_ATTR_KEYS).toBe(300);
    await mod.discoverExtendedAttrValues('Resources');
    expect(queryMock.mock.calls[0][0]).toMatch(/k\.krank <= 300/);
  });

  it('falls back to the default cap rather than emitting a nonsense one', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const mod = await freshModule();
    for (const bad of [0, -5, 1.5, 'lots', null]) {
      queryMock.mockClear();
      await mod.discoverExtendedAttrValues('Resources', 500, bad);
      expect(queryMock.mock.calls[0][0]).toMatch(/k\.krank <= 300/);
    }
  });

  it('refuses an unsafe table name', async () => {
    const mod = await freshModule();
    await expect(mod.discoverExtendedAttrValues('Resources"; DROP')).rejects.toThrow(/Invalid table name/);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

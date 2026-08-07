// Unit tests for the Identity half of column-value discovery in matrix/shared.js.
//
// It now delegates to the same db/columnCache.js helpers the Principal and
// Resource sides use — one ordered page per column/ext key plus a `truncated`
// flag (#928) — instead of its own hand-rolled UNION ALL with a global 5000-row
// cap across all ext keys.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbQuery, discoverCols, discoverExt, pageSize } = vi.hoisted(() => ({
  dbQuery: vi.fn(async () => ({ rows: [] })),
  discoverCols: vi.fn(async () => ({ values: {}, truncated: {} })),
  discoverExt: vi.fn(async () => ({ values: {}, truncated: {} })),
  pageSize: vi.fn(() => 500),
}));

vi.mock('../../db/connection.js', () => ({ query: (...a) => dbQuery(...a), queryOne: vi.fn(), getPool: vi.fn() }));
vi.mock('../../perf/sqlTimer.js', () => ({ timedQuery: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../../db/columnCache.js', () => ({
  getPrincipalColumns: async () => [],
  getResourceColumns: async () => [],
  discoverColumnValues: (...a) => discoverCols(...a),
  discoverExtendedAttrValues: (...a) => discoverExt(...a),
  mergeValueSets: (base, ext) => ({
    values:    { ...base.values,    ...ext.values },
    truncated: { ...base.truncated, ...ext.truncated },
  }),
  valuePageSize: (...a) => pageSize(...a),
}));

// A fresh module per test — the identity caches are module-scoped with a
// 5-minute TTL.
async function freshModule() {
  vi.resetModules();
  return await import('./shared.js');
}

beforeEach(() => {
  pageSize.mockReset().mockReturnValue(500);
  dbQuery.mockReset().mockResolvedValue({ rows: [{ column_name: 'department', data_type: 'text' }] });
  discoverCols.mockReset().mockResolvedValue({ values: { department: ['Sales'] }, truncated: {} });
  discoverExt.mockReset().mockResolvedValue({ values: { 'ext.costCenter': ['EU-1'] }, truncated: { 'ext.costCenter': true } });
});

describe('getIdentityColumnValues', () => {
  it('discovers real columns and ext keys off the "Identities" table', async () => {
    const mod = await freshModule();
    const { values, truncated } = await mod.getIdentityColumnValuesMeta();

    expect(discoverCols).toHaveBeenCalledWith('Identities', [
      { name: 'department', rawName: 'department', type: 'text' },
    ], 500);
    expect(discoverExt).toHaveBeenCalledWith('Identities', 500);
    expect(values).toEqual({ department: ['Sales'], 'ext.costCenter': ['EU-1'] });
    expect(truncated).toEqual({ 'ext.costCenter': true });
  });

  it('caches the discovered values for the TTL', async () => {
    const mod = await freshModule();
    await mod.getIdentityColumnValuesMeta();
    await mod.getIdentityColumnValuesMeta();
    expect(discoverCols).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('re-discovers when the configured page size changes (#928)', async () => {
    const mod = await freshModule();
    await mod.getIdentityColumnValuesMeta();

    pageSize.mockReturnValue(5);
    await mod.getIdentityColumnValuesMeta();

    expect(discoverCols).toHaveBeenCalledTimes(2);
    expect(discoverCols.mock.calls[1][2]).toBe(5);
  });

  it('still serves real columns when the schema has no extendedAttributes column', async () => {
    discoverExt.mockRejectedValue(new Error('column "extendedAttributes" does not exist'));
    const mod = await freshModule();
    const { values } = await mod.getIdentityColumnValuesMeta();
    expect(values).toEqual({ department: ['Sales'] });
  });
});

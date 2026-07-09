// Unit tests for the extracted entity-detail helpers (routes/details/shared.js).
//
// These were pulled out of details.js when the fat controller was split (C1).
// The route handlers exercise them indirectly, but the ValidFrom/ValidTo
// synthesis in fetchHistory (the "next newer row" branch) only runs when there
// is real multi-row history — which the mocked route tests never stage. Testing
// the helper directly pins that contract and covers the branch. DB is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbQuery = vi.fn();
vi.mock('../../db/connection.js', () => ({
  query: (...a) => dbQuery(...a),
}));

const { cleanRow, getPermissionTable, fetchHistory, countHistory } = await import('./shared.js');

beforeEach(() => dbQuery.mockReset());

describe('cleanRow', () => {
  it('drops the temporal system columns, keeps everything else', () => {
    expect(cleanRow({ id: 'a', displayName: 'X', SysStartTime: 1, SysEndTime: 2 }))
      .toEqual({ id: 'a', displayName: 'X' });
  });

  it('returns an empty object for an all-system row', () => {
    expect(cleanRow({ SysStartTime: 1, SysEndTime: 2 })).toEqual({});
  });
});

describe('getPermissionTable', () => {
  it('always resolves the unified view (no materialized fallback in v5)', async () => {
    expect(await getPermissionTable({})).toBe('"vw_ResourceUserPermissionAssignments"');
  });
});

describe('fetchHistory', () => {
  it('synthesises ValidFrom/ValidTo newest-first and leaves the newest row current', async () => {
    // Newest first: row[0].ValidTo is null (still current); each older row's
    // ValidTo is the next-newer row's changedAt.
    dbQuery.mockResolvedValueOnce({ rows: [
      { operation: 'UPDATE', changedAt: 't3', rowData: { name: 'v3' } },
      { operation: 'UPDATE', changedAt: 't2', rowData: { name: 'v2' } },
      { operation: 'INSERT', changedAt: 't1', rowData: { name: 'v1' } },
    ] });

    const rows = await fetchHistory('Principals', 'id-1');

    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('"_history"'), ['Principals', 'id-1']);
    expect(rows).toEqual([
      { name: 'v3', ValidFrom: 't3', ValidTo: null, _operation: 'UPDATE' },
      { name: 'v2', ValidFrom: 't2', ValidTo: 't3', _operation: 'UPDATE' },
      { name: 'v1', ValidFrom: 't1', ValidTo: 't2', _operation: 'INSERT' },
    ]);
  });

  it('tolerates a null rowData by treating it as an empty snapshot', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ operation: 'DELETE', changedAt: 't1', rowData: null }] });
    const [row] = await fetchHistory('Resources', 'id-2');
    expect(row).toEqual({ ValidFrom: 't1', ValidTo: null, _operation: 'DELETE' });
  });
});

describe('countHistory', () => {
  it('returns the counted rows', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ cnt: 7 }] });
    expect(await countHistory('Resources', 'id-3')).toBe(7);
  });

  it('falls back to 0 when the audit table yields no count row', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    expect(await countHistory('Resources', 'id-4')).toBe(0);
  });
});

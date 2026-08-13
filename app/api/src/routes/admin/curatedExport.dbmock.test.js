// DB-mocked unit tests for the export fetch wrappers in curatedExport.js
// (#1030). The pure grouping is covered by curatedData.helpers.test.js; these
// pin the table-existence guard and the query→group wiring. SQL is mock-blind
// (real SQL is the contract test's job).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js'); // picks up src/db/__mocks__/connection.js
import { query } from '../../db/connection.js';
import { tableExists, fetchExportTags, fetchExportCategories } from './curatedExport.js';

beforeEach(() => { query.mockReset(); });

describe('tableExists', () => {
  it('is true when to_regclass returns an oid', async () => {
    query.mockResolvedValueOnce({ rows: [{ oid: 'x' }] });
    expect(await tableExists({}, 'GraphTags')).toBe(true);
  });
  it('is false when to_regclass returns null', async () => {
    query.mockResolvedValueOnce({ rows: [{ oid: null }] });
    expect(await tableExists({}, 'Missing')).toBe(false);
  });
});

describe('fetchExportTags', () => {
  it('returns [] when the tag table is absent', async () => {
    query.mockResolvedValueOnce({ rows: [{ oid: null }] });
    expect(await fetchExportTags({})).toEqual([]);
  });
  it('queries then groups when the table exists', async () => {
    query.mockResolvedValueOnce({ rows: [{ oid: 'x' }] }); // tableExists
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 'VIP', color: '#fff', entityType: 'user', entityId: 'u1', entityDisplayName: 'Ann', resourceType: null },
    ] });
    expect(await fetchExportTags({})).toEqual([
      { name: 'VIP', color: '#fff', entityType: 'user', assignments: [{ entityId: 'u1', displayName: 'Ann', resourceType: null }] },
    ]);
  });
});

describe('fetchExportCategories', () => {
  it('returns [] when the category table is absent', async () => {
    query.mockResolvedValueOnce({ rows: [{ oid: null }] });
    expect(await fetchExportCategories({})).toEqual([]);
  });
  it('queries then groups when the table exists', async () => {
    query.mockResolvedValueOnce({ rows: [{ oid: 'x' }] });
    query.mockResolvedValueOnce({ rows: [
      { id: 'c1', name: 'Fin', color: '#111', resourceId: 'ap1', businessRoleDisplayName: 'Finance' },
    ] });
    expect(await fetchExportCategories({})).toEqual([
      { name: 'Fin', color: '#111', assignments: [{ accessPackageId: 'ap1', accessPackageDisplayName: 'Finance' }] },
    ]);
  });
});

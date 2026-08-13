// DB-mocked unit tests for the resolve/category import helpers in
// curatedImport.js (#1030). The tag-import path is covered through
// admin.coverage.test.js; these pin the entity resolution and the
// category-assignment matching that the endpoint test doesn't exercise. SQL is
// mock-blind (contract tests cover real SQL) — here we only assert control flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js'); // picks up src/db/__mocks__/connection.js
import { query } from '../../db/connection.js';
import { resolveEntity, importCuratedCategory } from './curatedImport.js';

beforeEach(() => { query.mockReset(); });

const newStats = () => ({
  catsInserted: 0, catAssignInserted: 0, catAssignSkipped: 0,
  catAssignSoftMatched: 0, catAssignNotFound: 0,
});

describe('resolveEntity', () => {
  it('returns an upper-cased id on an exact GUID match', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    expect(await resolveEntity('abc-123', 'user')).toEqual({ id: 'ABC-123', softMatched: false });
  });

  it('soft-matches a user by displayName when the GUID misses', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] });        // GUID miss
    query.mockResolvedValueOnce({ rows: [{ id: 'USER-ID' }] }); // displayName hit
    expect(await resolveEntity('x', 'user', 'Ann')).toEqual({ id: 'USER-ID', softMatched: true });
  });

  it('soft-matches a resource by displayName + resourceType', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'RES-ID' }] });
    expect(await resolveEntity('x', 'group', 'Admins', 'Security')).toEqual({ id: 'RES-ID', softMatched: true });
  });

  it('returns null when the GUID misses and there is no displayName', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    expect(await resolveEntity('x', 'user')).toBeNull();
  });

  it('swallows a missing-table error on the GUID query and still soft-matches', async () => {
    query.mockRejectedValueOnce(new Error('relation does not exist')); // GUID query throws
    query.mockResolvedValueOnce({ rows: [{ id: 'RES-ID' }] });          // soft-match hit
    expect(await resolveEntity('x', 'resource', 'Vault')).toEqual({ id: 'RES-ID', softMatched: true });
  });
});

describe('importCuratedCategory', () => {
  it('skips a category with no name and touches no stats', async () => {
    const stats = newStats();
    await importCuratedCategory({ color: '#fff' }, stats);
    expect(stats.catsInserted).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('inserts a category and a GUID-matched AP assignment', async () => {
    const stats = newStats();
    query.mockResolvedValueOnce({ rows: [{ id: 'cat1' }] });      // category upsert
    query.mockResolvedValueOnce({ rows: [{ id: 'ap1' }] });       // AP GUID match
    query.mockResolvedValueOnce({ rows: [{ inserted: 1 }] });     // assignment insert
    await importCuratedCategory({ name: 'Finance', assignments: [{ accessPackageId: 'AP1' }] }, stats);
    expect(stats).toMatchObject({ catsInserted: 1, catAssignInserted: 1, catAssignNotFound: 0 });
  });

  it('soft-matches an AP assignment by displayName', async () => {
    const stats = newStats();
    query.mockResolvedValueOnce({ rows: [{ id: 'cat1' }] });      // category upsert
    query.mockResolvedValueOnce({ rows: [] });                    // GUID miss
    query.mockResolvedValueOnce({ rows: [{ id: 'ap2' }] });       // displayName hit
    query.mockResolvedValueOnce({ rows: [{ inserted: 1 }] });     // insert
    await importCuratedCategory(
      { name: 'Finance', assignments: [{ accessPackageId: 'AP2', accessPackageDisplayName: 'Finance Role' }] },
      stats,
    );
    expect(stats).toMatchObject({ catAssignInserted: 1, catAssignSoftMatched: 1 });
  });

  it('counts an unresolvable AP assignment as not-found', async () => {
    const stats = newStats();
    query.mockResolvedValueOnce({ rows: [{ id: 'cat1' }] });      // category upsert
    query.mockResolvedValueOnce({ rows: [] });                    // GUID miss, no displayName
    await importCuratedCategory({ name: 'Finance', assignments: [{ accessPackageId: 'nope' }] }, stats);
    expect(stats).toMatchObject({ catsInserted: 1, catAssignNotFound: 1, catAssignInserted: 0 });
  });
});

// SQL-blind unit tests (the SQL is the contract test's): which parameters each
// read sends, and what it makes of the rows.
import { describe, it, expect, vi } from 'vitest';
import {
  findList, findListByName, listLists, existingContexts, syncMembershipsOf, recordUpload, uploadProvenance,
  systemNameFor, UPLOAD_SYSTEM_TYPE,
} from './lists.js';

const dbWith = ({ one = null, rows = [] } = {}) => ({ queryOne: vi.fn().mockResolvedValue(one), query: vi.fn().mockResolvedValue({ rows }) });

describe('lists', () => {
  it('names a list\'s system "<name> (upload)"', () => {
    expect(systemNameFor('Klanten')).toBe('Klanten (upload)');
  });

  it.each([[0], [-1], ['abc'], [1.5], [null]])('findList(%j) does not query', async (id) => {
    const db = dbWith();
    expect(await findList(db, id)).toBeNull();
    expect(db.queryOne).not.toHaveBeenCalled();
  });

  it('findList asks only for upload systems', async () => {
    const db = dbWith({ one: { id: 3 } });
    expect(await findList(db, '3')).toEqual({ id: 3 });
    expect(db.queryOne.mock.calls[0][1]).toEqual([3, UPLOAD_SYSTEM_TYPE]);
  });

  it('findListByName looks the system name up, then reads the list', async () => {
    const db = { queryOne: vi.fn().mockResolvedValueOnce({ id: 4 }).mockResolvedValueOnce({ id: 4, displayName: 'Klanten (upload)' }) };
    expect(await findListByName(db, 'Klanten')).toEqual({ id: 4, displayName: 'Klanten (upload)' });
    expect(db.queryOne.mock.calls[0][1]).toEqual([UPLOAD_SYSTEM_TYPE, 'Klanten (upload)']);
    expect(db.queryOne.mock.calls[1][1]).toEqual([4, UPLOAD_SYSTEM_TYPE]);
  });

  it('findListByName is null without a match', async () => {
    expect(await findListByName(dbWith(), 'Nope')).toBeNull();
  });

  it('listLists and existingContexts return the rows; existingContexts of no list does not query', async () => {
    const db = dbWith({ rows: [{ id: 1 }] });
    expect(await listLists(db)).toEqual([{ id: 1 }]);
    expect(await existingContexts(db, 5)).toEqual([{ id: 1 }]);
    expect(db.query.mock.calls[1][1]).toEqual([5]);
    expect(await existingContexts(db, null)).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('syncMembershipsOf returns membership records marked as sync, and skips the query for none', async () => {
    const db = dbWith({ rows: [{ contextId: 'c', memberId: 'm', memberType: 'Principal' }] });
    expect(await syncMembershipsOf(db, [])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
    expect(await syncMembershipsOf(db, ['c'])).toEqual([{ contextId: 'c', memberId: 'm', memberType: 'Principal', addedBy: 'sync' }]);
  });

  it('recordUpload sends the mapping as JSON and the counts in column order', async () => {
    const db = dbWith({ one: { id: 'u1' } });
    await recordUpload(db, {
      systemId: 1, rootContextId: 'r', fileName: 'k.csv', template: 'OrganizationalUnit', keyColumn: 'Code',
      mapping: { a: 1 }, rowCount: 9, created: 2, updated: 3, unchanged: 4, removed: 5, unmatchedMembers: 6, uploadedBy: 'me',
    });
    expect(db.queryOne.mock.calls[0][1]).toEqual([1, 'r', 'k.csv', 'OrganizationalUnit', 'Code', '{"a":1}', 9, 2, 3, 4, 5, 6, 'me']);
  });

  it('uploadProvenance: the first upload says where it came from, the last when it was updated', async () => {
    const first = { which: 'first', fileName: 'k.csv', uploadedBy: 'a', uploadedAt: '2026-10-01' };
    const last = { which: 'last', fileName: 'k2.csv', uploadedBy: 'b', uploadedAt: '2026-10-20' };
    expect(await uploadProvenance(dbWith({ rows: [first, last] }), 3)).toEqual({
      uploadedFrom: 'k.csv', uploadedAt: '2026-10-01', uploadedBy: 'a',
      lastUploadFile: 'k2.csv', lastUploadAt: '2026-10-20', lastUploadBy: 'b',
    });
  });

  it('uploadProvenance is null for a system without uploads, and does not query without a system', async () => {
    expect(await uploadProvenance(dbWith({ rows: [] }), 3)).toBeNull();
    const db = dbWith();
    expect(await uploadProvenance(db, null)).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

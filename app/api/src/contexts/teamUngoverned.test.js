import { describe, it, expect, vi } from 'vitest';
import { toUngoverned, loadUngoverned, UNGOVERNED_SQL, MAX_UNGOVERNED } from './teamUngoverned.js';
import { TEAM_ACCOUNTS_SQL } from './teamOverview.js';

const row = (over) => ({ id: 'r', displayName: 'R', resourceType: 'Group', direct: false, indirect: false, ...over });

describe('toUngoverned', () => {
  it.each([
    [{ direct: true, indirect: true }, 'Direct'],
    [{ direct: true }, 'Direct'],
    [{ indirect: true }, 'Indirect'],
    [{}, 'Eligible'],
  ])('%o is held %s', (flags, how) => {
    expect(toUngoverned([row(flags)]).items).toEqual([{ id: 'r', displayName: 'R', resourceType: 'Group', how }]);
  });

  it('is complete at exactly the cap and partial one past it', () => {
    expect(toUngoverned([row(), row()], 2)).toMatchObject({ truncated: false });
    const over = toUngoverned([row(), row(), row()], 2);
    expect(over.truncated).toBe(true);
    expect(over.items).toHaveLength(2);
  });
});

describe('loadUngoverned', () => {
  it('reads nothing further for someone without accounts', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await loadUngoverned(db, 'm')).toEqual({ items: [], truncated: false });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('reads all of a person\'s accounts, one past the cap', async () => {
    const db = { query: vi.fn(async (sql) => (sql === TEAM_ACCOUNTS_SQL
      ? { rows: [{ memberId: 'm', accountId: 'a1', identityId: 'm' }, { memberId: 'm', accountId: 'a2', identityId: 'm' }] }
      : { rows: [row({ direct: true })] })) };
    const out = await loadUngoverned(db, 'm');
    expect(db.query.mock.calls[0][1]).toEqual([['m']]);
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toBe(UNGOVERNED_SQL);
    expect(params).toEqual([['m', 'm'], ['a1', 'a2'], ['m', 'm'], MAX_UNGOVERNED + 1]);
    expect(out.items[0].how).toBe('Direct');
  });
});

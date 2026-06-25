import { describe, it, expect, vi } from 'vitest';
import { purgeExpiredTombstones, PURGE_ORDER } from './tombstonePurge.js';

describe('purgeExpiredTombstones', () => {
  it('hard-deletes from each soft-delete table, assignments before entities', async () => {
    const seen = [];
    const db = {
      query: vi.fn(async (sql, params) => {
        seen.push({ sql, days: params[0] });
        return { rowCount: 1 };
      }),
    };
    const { purged } = await purgeExpiredTombstones(db, 180);
    // One DELETE per table, in the safe order.
    expect(db.query).toHaveBeenCalledTimes(PURGE_ORDER.length);
    expect(seen.map((s) => PURGE_ORDER.find((t) => s.sql.includes(`"${t}"`)))).toEqual(PURGE_ORDER);
    expect(seen.every((s) => s.days === 180)).toBe(true);
    // Only deletes rows whose deletedAt is past the window.
    expect(seen.every((s) => /deletedAt" IS NOT NULL/.test(s.sql) && /deletedAt" <\s*now\(\)/.test(s.sql))).toBe(true);
    expect(purged).toEqual({ ResourceAssignments: 1, Principals: 1, Resources: 1 });
  });

  it('is a no-op when retention is 0, negative, or non-integer (purge disabled)', async () => {
    const db = { query: vi.fn() };
    for (const d of [0, -5, 1.5, NaN, undefined]) {
      const { purged } = await purgeExpiredTombstones(db, d);
      expect(purged).toEqual({});
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('omits tables that purged nothing from the result', async () => {
    const db = { query: vi.fn(async () => ({ rowCount: 0 })) };
    const { purged } = await purgeExpiredTombstones(db, 30);
    expect(purged).toEqual({});
  });
});

// What store.js sends, not whether PostgreSQL accepts it — that is
// contract-tests/contextActivity.contract.test.js. These pin the write order
// (replace before insert, in one transaction), the chunking and the parameters.
import { describe, it, expect, vi } from 'vitest';
import { writeUpload, deleteUpload, replacedBy, latestActivityDate, namesOf, latestUploadOf, listUploads, MAX_HISTORY } from './store.js';

function txDb(results = {}) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('DELETE FROM "ContextActivity"')) return { rowCount: results.replaced ?? 0, rows: [] };
      if (sql.includes('INSERT INTO "ContextActivityUploads"')) return { rows: [{ id: 'U-new', uploadedAt: 'now' }] };
      return { rows: [], rowCount: params?.[2]?.length ?? 0 };
    }),
  };
  return { calls, db: { tx: vi.fn(async (fn) => fn(client)) } };
}

const run = {
  contextId: 'C', fileName: 'export.csv', sourceLabel: 'Clockify', mapping: { a: 1 }, period: { start: '2026-01-02', end: '2026-03-31' },
  rowCount: 7, matchedRows: 5, unmatchedRows: 2, uploadedBy: 'analyst@example.org', unit: 'hours',
};
const row = (i) => ({ contextId: 'C', principalId: null, identityId: `I${i}`, subjectName: 'Vera', subjectEmail: null, date: '2026-01-02', amount: i, kind: null, attributes: i === 1 ? { Note: 'x' } : null });

describe('writeUpload', () => {
  it('deletes the replaced period first, then records the run, then inserts the rows in chunks', async () => {
    const { db, calls } = txDb({ replaced: 4 });
    const out = await writeUpload(db, run, [row(1), row(2), row(3)], 2);
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(calls.map(c => c.sql.match(/(DELETE FROM|INSERT INTO) "(\w+)"/).slice(1).join(' '))).toEqual([
      'DELETE FROM ContextActivity', 'INSERT INTO ContextActivityUploads', 'INSERT INTO ContextActivity', 'INSERT INTO ContextActivity',
    ]);
    expect(calls[0].params).toEqual(['C', 'Clockify', '2026-01-02', '2026-03-31']);
    expect(calls[1].params).toEqual(['C', 'export.csv', 'Clockify', '{"a":1}', '2026-01-02', '2026-03-31', 7, 5, 2, 'analyst@example.org']);
    // The first chunk: upload id, unit, then the column arrays (identityId third, attributes as JSON text).
    expect(calls[2].params[0]).toBe('U-new');
    expect(calls[2].params[1]).toBe('hours');
    expect(calls[2].params[4]).toEqual(['I1', 'I2']);
    expect(calls[2].params[10]).toEqual(['{"Note":"x"}', null]);
    expect(calls[3].params[4]).toEqual(['I3']);
    expect(out).toEqual({ uploadId: 'U-new', uploadedAt: 'now', replaced: 4, inserted: 3 });
  });

  it('without a period nothing is replaced and no delete is sent', async () => {
    const { db, calls } = txDb();
    const out = await writeUpload(db, { ...run, period: null }, []);
    expect(calls.map(c => c.sql.includes('DELETE'))).toEqual([false]);
    expect(calls[0].params[4]).toBeNull();
    expect(out.replaced).toBe(0);
  });
});

describe('reads', () => {
  it('replacedBy asks nothing without a period, and compares the source case-insensitively', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ id: 'U1', rows: 3 }] })) };
    expect(await replacedBy(db, 'C', 'Clockify', null)).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
    expect(await replacedBy(db, 'C', 'Clockify', { start: '2026-01-01', end: '2026-02-01' })).toEqual([{ id: 'U1', rows: 3 }]);
    expect(db.query.mock.calls[0][0]).toMatch(/lower\(u."sourceLabel"\) = lower\(\$2\)/);
  });

  it('deleteUpload returns null when there is no such upload on this context', async () => {
    expect(await deleteUpload({ queryOne: vi.fn(async () => null) }, 'C', 'U')).toBeNull();
    const db = { queryOne: vi.fn(async () => ({ id: 'U', rows: 12 })) };
    expect(await deleteUpload(db, 'C', 'U')).toEqual({ id: 'U', rows: 12 });
    expect(db.queryOne.mock.calls[0][1]).toEqual(['C', 'U']);
  });

  it('latestActivityDate is null without activity', async () => {
    expect(await latestActivityDate({ queryOne: vi.fn(async () => ({ latest: null })) }, ['C'])).toBeNull();
    expect(await latestActivityDate({ queryOne: vi.fn(async () => null) }, ['C'])).toBeNull();
    expect(await latestActivityDate({ queryOne: vi.fn(async () => ({ latest: '2026-04-18' })) }, ['C'])).toBe('2026-04-18');
  });

  it('namesOf asks only for the kinds it was given', async () => {
    const db = { query: vi.fn(async (sql) => ({ rows: sql.includes('"Identities"') ? [{ id: 'I1', displayName: 'Vera' }] : [{ id: 'P1', displayName: 'vera.x' }] })) };
    expect([...(await namesOf(db, ['I1'], []))]).toEqual([['I1', 'Vera']]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect([...(await namesOf(db, ['I1'], ['P1']))]).toEqual([['I1', 'Vera'], ['P1', 'vera.x']]);
    expect((await namesOf(db, [], [])).size).toBe(0);
  });

  it('latestUploadOf passes the source, or null for any source', async () => {
    const db = { queryOne: vi.fn(async () => null) };
    await latestUploadOf(db, 'C');
    await latestUploadOf(db, 'C', 'Clockify');
    expect(db.queryOne.mock.calls.map(c => c[1])).toEqual([['C', null], ['C', 'Clockify']]);
  });

  it('listUploads asks for this context, newest first, at most MAX_HISTORY', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ id: 'U1' }] })) };
    expect(await listUploads(db, 'C')).toEqual([{ id: 'U1' }]);
    expect(db.query.mock.calls[0][1]).toEqual(['C']);
    expect(db.query.mock.calls[0][0]).toContain(`LIMIT ${MAX_HISTORY}`);
    expect(MAX_HISTORY).toBe(100);
  });
});

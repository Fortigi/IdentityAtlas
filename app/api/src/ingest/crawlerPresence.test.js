import { describe, it, expect, vi } from 'vitest';
import { normalizePresenceQuery, lookupCrawlerPresence } from './crawlerPresence.js';

describe('normalizePresenceQuery', () => {
  it('keeps a string tenantId and string ids', () => {
    expect(normalizePresenceQuery({ tenantId: 't1', ids: ['a', 'b'] }))
      .toEqual({ tenantId: 't1', ids: ['a', 'b'] });
  });

  it('nulls a blank/missing tenantId and drops non-string ids', () => {
    expect(normalizePresenceQuery({ tenantId: '', ids: ['a', 2, null, 'b', {}] }))
      .toEqual({ tenantId: null, ids: ['a', 'b'] });
    expect(normalizePresenceQuery({ ids: 'not-an-array' }))
      .toEqual({ tenantId: null, ids: [] });
    expect(normalizePresenceQuery(undefined))
      .toEqual({ tenantId: null, ids: [] });
  });
});

describe('lookupCrawlerPresence', () => {
  it('reports availability and the ids the crawler has loaded', async () => {
    const db = {
      queryOne: vi.fn(async () => ({ available: true })),
      query: vi.fn(async () => ({ rows: [{ id: 'in-entra-1' }, { id: 'group-1' }] })),
    };
    const out = await lookupCrawlerPresence(db, 'tenant-1', ['in-entra-1', 'group-1', 'orphan-1']);
    expect(out).toEqual({ present: ['in-entra-1', 'group-1'], crawlerDataAvailable: true });
    expect(db.query).toHaveBeenCalledOnce();
  });

  it('skips the presence query when there are no ids but still reports availability', async () => {
    const db = {
      queryOne: vi.fn(async () => ({ available: false })),
      query: vi.fn(),
    };
    const out = await lookupCrawlerPresence(db, 'tenant-1', []);
    expect(out).toEqual({ present: [], crawlerDataAvailable: false });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('coerces a null availability row to crawlerDataAvailable=false', async () => {
    const db = {
      queryOne: vi.fn(async () => null),
      query: vi.fn(async () => ({ rows: [] })),
    };
    const out = await lookupCrawlerPresence(db, 'tenant-1', ['x']);
    expect(out).toEqual({ present: [], crawlerDataAvailable: false });
  });
});

// A key restricted to specific systems may only learn about presence in those
// systems (SEC-2026-09 M-05).
describe('lookupCrawlerPresence — restricted to the caller\'s systems', () => {
  it('adds the system filter to both queries and binds the allow-list', async () => {
    const db = {
      queryOne: vi.fn(async () => ({ available: true })),
      query: vi.fn(async () => ({ rows: [] })),
    };
    await lookupCrawlerPresence(db, 'tenant-1', ['a'], [7]);
    const [availSql, availParams] = db.queryOne.mock.calls[0];
    expect(availSql.match(/AND s\.id = ANY\(\$2::int\[\]\)/g)).toHaveLength(2);
    expect(availParams).toEqual(['tenant-1', [7]]);
    const [idsSql, idsParams] = db.query.mock.calls[0];
    expect(idsSql.match(/AND s\.id = ANY\(\$3::int\[\]\)/g)).toHaveLength(2);
    expect(idsParams).toEqual([['a'], 'tenant-1', [7]]);
  });

  it('leaves both queries tenant-wide for an unrestricted caller', async () => {
    const db = {
      queryOne: vi.fn(async () => ({ available: true })),
      query: vi.fn(async () => ({ rows: [] })),
    };
    await lookupCrawlerPresence(db, 'tenant-1', ['a']);
    expect(db.queryOne.mock.calls[0][0]).not.toContain('s.id = ANY');
    expect(db.queryOne.mock.calls[0][1]).toEqual(['tenant-1']);
    expect(db.query.mock.calls[0][1]).toEqual([['a'], 'tenant-1']);
  });
});

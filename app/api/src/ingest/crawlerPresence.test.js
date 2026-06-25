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

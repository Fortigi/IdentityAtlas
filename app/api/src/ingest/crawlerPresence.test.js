import { describe, it, expect, vi } from 'vitest';
import { normalizePresenceQuery, resolveDirectorySystemIds, lookupCrawlerPresence } from './crawlerPresence.js';

// A fake database that answers by MEANING rather than by SQL text: it keeps a
// directory link per system, an EntraID-system list per tenant, and the object ids
// each system holds. Asserting against this catches a lookup that reads the wrong
// system — which is the whole bug (#1247) — where asserting on generated SQL only
// catches a reworded query.
function makeDb({ links = {}, entraByTenant = {}, idsBySystem = {} } = {}) {
  const idsIn = (systems) => new Set(systems.flatMap((s) => idsBySystem[s] || []));
  return {
    queryOne: vi.fn(async (sql, params) => {
      if (sql.includes('"directorySystemId" FROM "Systems"')) {
        return { directorySystemId: links[params[0]] ?? null };
      }
      return { available: idsIn(params[0]).size > 0 };
    }),
    query: vi.fn(async (sql, params) => {
      if (sql.includes("'EntraID'")) {
        return { rows: (entraByTenant[params[0]] || []).map((id) => ({ id })) };
      }
      const [wanted, systems] = params;
      const have = idsIn(systems);
      return { rows: wanted.filter((x) => have.has(x)).map((id) => ({ id })) };
    }),
  };
}

describe('normalizePresenceQuery', () => {
  it('keeps a string tenantId, string ids and an integer systemId', () => {
    expect(normalizePresenceQuery({ tenantId: 't1', ids: ['a', 'b'], systemId: 33 }))
      .toEqual({ tenantId: 't1', ids: ['a', 'b'], systemId: 33 });
  });

  it('nulls a blank/missing tenantId and drops non-string ids', () => {
    expect(normalizePresenceQuery({ tenantId: '', ids: ['a', 2, null, 'b', {}] }))
      .toEqual({ tenantId: null, ids: ['a', 'b'], systemId: null });
    expect(normalizePresenceQuery({ ids: 'not-an-array' }))
      .toEqual({ tenantId: null, ids: [], systemId: null });
    expect(normalizePresenceQuery(undefined))
      .toEqual({ tenantId: null, ids: [], systemId: null });
  });

  it('nulls a systemId that is not an integer, so it never reaches a query', () => {
    expect(normalizePresenceQuery({ tenantId: 't1', systemId: '33' }).systemId).toBeNull();
    expect(normalizePresenceQuery({ tenantId: 't1', systemId: 3.5 }).systemId).toBeNull();
  });
});

describe('resolveDirectorySystemIds', () => {
  it('follows the caller\'s declared directory link', async () => {
    const db = makeDb({ links: { 33: 1 }, entraByTenant: { 't1': [99] } });
    // The tenant scan would answer 99; the link says 1, and the link wins.
    expect(await resolveDirectorySystemIds(db, 't1', 33)).toEqual([1]);
  });

  it('falls back to the tenant scan when the caller declares no directory', async () => {
    const db = makeDb({ links: { 33: null }, entraByTenant: { 't1': [1] } });
    expect(await resolveDirectorySystemIds(db, 't1', 33)).toEqual([1]);
  });

  it('falls back to the tenant scan when no caller system is supplied', async () => {
    const db = makeDb({ entraByTenant: { 't1': [1, 2] } });
    expect(await resolveDirectorySystemIds(db, 't1', null)).toEqual([1, 2]);
  });

  it('narrows the directory to what a restricted key may see', async () => {
    const db = makeDb({ links: { 33: 1 } });
    expect(await resolveDirectorySystemIds(db, 't1', 33, [1, 33])).toEqual([1]);
    expect(await resolveDirectorySystemIds(db, 't1', 33, [33])).toEqual([]);
  });

  it('returns nothing when neither the link nor the tenant resolves a directory', async () => {
    const db = makeDb({ entraByTenant: {} });
    expect(await resolveDirectorySystemIds(db, 'unknown-tenant', 33)).toEqual([]);
  });
});

describe('lookupCrawlerPresence', () => {
  it('reports the ids the directory holds, not the ones the caller holds', async () => {
    // The regression this exists for: the Azure RM crawler had stamped its own
    // systemId onto `stamped-user`, so a lookup that reads the CALLER's system would
    // call it present and one that reads the directory would not. Only the directory
    // is authoritative, and `azure-only-sp` must stay absent so it is still flagged
    // or dropped as an orphan.
    const db = makeDb({
      links: { 33: 1 },
      idsBySystem: { 1: ['in-directory-user', 'group-1'], 33: ['azure-only-sp', 'stamped-user'] },
    });
    const out = await lookupCrawlerPresence(
      db, 't1', ['in-directory-user', 'group-1', 'azure-only-sp', 'stamped-user'], null, 33,
    );
    expect(out).toEqual({ present: ['in-directory-user', 'group-1'], crawlerDataAvailable: true });
  });

  it('skips the presence query when there are no ids but still reports availability', async () => {
    const db = makeDb({ links: { 33: 1 }, idsBySystem: { 1: ['someone'] } });
    const out = await lookupCrawlerPresence(db, 't1', [], null, 33);
    expect(out).toEqual({ present: [], crawlerDataAvailable: true });
    // The link resolved the directory, so neither the tenant scan nor the presence
    // query ran — only the two queryOne calls (link + availability).
    expect(db.query).not.toHaveBeenCalled();
    expect(db.queryOne).toHaveBeenCalledTimes(2);
  });

  it('reports crawlerDataAvailable=false when the directory has loaded nothing yet', async () => {
    // An Azure-RM-first run. The caller must NOT treat every principal as an orphan.
    const db = makeDb({ links: { 33: 1 }, idsBySystem: { 33: ['azure-only-sp'] } });
    const out = await lookupCrawlerPresence(db, 't1', ['azure-only-sp'], null, 33);
    expect(out).toEqual({ present: [], crawlerDataAvailable: false });
  });

  it('coerces a null availability row to crawlerDataAvailable=false', async () => {
    const db = makeDb({ links: { 33: 1 } });
    db.queryOne.mockImplementation(async (sql, params) => (
      sql.includes('"directorySystemId" FROM "Systems"') ? { directorySystemId: 1 } : null
    ));
    const out = await lookupCrawlerPresence(db, 't1', ['x'], null, 33);
    expect(out).toEqual({ present: [], crawlerDataAvailable: false });
  });

  it('reports nothing available when no directory resolves at all', async () => {
    const db = makeDb({});
    const out = await lookupCrawlerPresence(db, 'unknown-tenant', ['x'], null, 33);
    expect(out).toEqual({ present: [], crawlerDataAvailable: false });
    // Bailed before asking about rows: link lookup + tenant scan only.
    expect(db.queryOne).toHaveBeenCalledOnce();
    expect(db.query).toHaveBeenCalledOnce();
  });
});

// A key restricted to specific systems may only learn about presence in those
// systems (SEC-2026-09 M-05).
describe('lookupCrawlerPresence — restricted to the caller\'s systems', () => {
  it('still answers when the directory is inside the allow-list', async () => {
    const db = makeDb({ links: { 33: 1 }, idsBySystem: { 1: ['a'] } });
    expect(await lookupCrawlerPresence(db, 't1', ['a'], [1, 33], 33))
      .toEqual({ present: ['a'], crawlerDataAvailable: true });
  });

  it('tells a key that cannot see the directory that no data is available', async () => {
    // Not "present: []" with data available — that would read as "everyone is an
    // orphan" and the crawler would drop every grant it holds.
    const db = makeDb({ links: { 33: 1 }, idsBySystem: { 1: ['a'] } });
    expect(await lookupCrawlerPresence(db, 't1', ['a'], [33], 33))
      .toEqual({ present: [], crawlerDataAvailable: false });
  });
});

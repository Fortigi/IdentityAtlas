import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../db/connection.js';
import { getSyncVersion } from '../lib/syncVersion.js';

vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../lib/syncVersion.js', () => ({ getSyncVersion: vi.fn() }));

const { getHolders, resolveForPrincipalOnResource, effectiveAccess, clearCache } = await import('./engine.js');

// Fixture graph. membership: principal -> groups it is a direct member of.
const membership = {
  user1: ['gA'],
  gA: ['gB'],
  gB: ['gA'], // cycle gA <-> gB
};
// grants on a resource: resourceId -> [{ holder, effect }]
const grants = {
  R_direct: [{ holder: 'user1', effect: 'allow' }],
  R_viagroup: [{ holder: 'gA', effect: 'allow' }],
  R_deny: [{ holder: 'gA', effect: 'deny' }],
};

function wireDb() {
  db.query.mockImplementation((sql, params) => {
    if (sql.includes('JOIN "Resources"')) {
      const frontier = params[0];
      const gids = new Set();
      for (const p of frontier) for (const g of membership[p] || []) gids.add(g);
      return Promise.resolve({ rows: [...gids].map((gid) => ({ gid })) });
    }
    if (sql.includes('AS holder')) {
      const [resourceId, holderArr] = params;
      const rows = (grants[resourceId] || []).filter((g) => holderArr.includes(g.holder));
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  wireDb();
  getSyncVersion.mockResolvedValue(1);
});

describe('getHolders', () => {
  it('collects the principal plus transitive groups, cycle-safe', async () => {
    const { holders, truncated } = await getHolders('user1');
    expect([...holders].sort()).toEqual(['gA', 'gB', 'user1']);
    expect(truncated).toBe(false);
  });

  it('truncates at the cap and reports it', async () => {
    const { holders, truncated } = await getHolders('user1', { maxHolders: 2 });
    expect(truncated).toBe(true);
    expect(holders.size).toBe(2);
  });
});

describe('resolveForPrincipalOnResource', () => {
  it('Direct when the principal holds the grant themself', async () => {
    const r = await resolveForPrincipalOnResource('R_direct', 'user1');
    expect(r.effective).toBe('allow');
    expect(r.badge).toBe('Direct');
  });

  it('Indirect via group membership, with viaGroupId set', async () => {
    const r = await resolveForPrincipalOnResource('R_viagroup', 'user1');
    expect(r.effective).toBe('allow');
    expect(r.badge).toBe('Indirect');
    expect(r.decisiveAce.viaGroupId).toBe('gA');
  });

  it('AdditiveAllow ignores a deny-only grant', async () => {
    const r = await resolveForPrincipalOnResource('R_deny', 'user1');
    expect(r.effective).toBe('none');
    expect(r.badge).toBeNull();
  });

  it('no access on a resource with no matching grant', async () => {
    const r = await resolveForPrincipalOnResource('R_none', 'user1');
    expect(r.effective).toBe('none');
  });
});

describe('effectiveAccess (cache)', () => {
  it('serves the second identical call from cache (no extra DB calls)', async () => {
    await effectiveAccess('R_direct', 'user1');
    const callsAfterFirst = db.query.mock.calls.length;
    await effectiveAccess('R_direct', 'user1');
    expect(db.query.mock.calls.length).toBe(callsAfterFirst); // no new queries
  });

  it('recomputes when the sync version changes (cache invalidation)', async () => {
    await effectiveAccess('R_direct', 'user1');
    const callsAfterFirst = db.query.mock.calls.length;
    getSyncVersion.mockResolvedValue(2); // a sync completed
    await effectiveAccess('R_direct', 'user1');
    expect(db.query.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

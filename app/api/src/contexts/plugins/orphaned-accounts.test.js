// Unit tests for the orphaned-accounts context plugin.
// Uses vi.doMock to inject a stub db + classifier so no real database is needed.
// Mirrors the db-mock + ctx pattern from department-from-principal.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORPHANS = [
  { id: 'p1', displayName: 'Alice (adm)', email: 'adm-alice@x', extendedAttributes: {} },
  { id: 'p2', displayName: 'Bob (adm)',   email: 'adm-bob@x',   extendedAttributes: {} },
  { id: 'p3', displayName: 'Guest Gail',  email: 'gail@ext',    extendedAttributes: {} },
  { id: 'p4', displayName: 'Svc Account', email: 'svc@x',       extendedAttributes: {} },
];

// classifyAccount stub: map principal id → accountType so the test is fully
// deterministic and independent of the real rule engine.
const TYPE_BY_ID = { p1: 'Admin', p2: 'Admin', p3: 'Guest', p4: 'Service' };

// Load the plugin with a stubbed db (query returns `rows`) and a stubbed
// classifier. `queryOne` (loadRules) returns null so DEFAULT_RULES is used.
async function loadPlugin(rows) {
  vi.resetModules();
  vi.doMock('../../db/connection.js', () => ({
    query: vi.fn(async () => ({ rows })),
    queryOne: vi.fn(async () => null),
  }));
  vi.doMock('../../accountlinking/classifier.js', () => ({
    classifyAccount: vi.fn((p) => ({ accountType: TYPE_BY_ID[p.id] || 'Secondary' })),
  }));
  const mod = await import('./orphaned-accounts.js');
  return mod.default;
}

describe('orphaned-accounts plugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('emits only the root context when there are no orphans', async () => {
    const plugin = await loadPlugin([]);
    const out = await plugin.run({}, {});
    expect(out.contexts).toHaveLength(1);
    expect(out.contexts[0]).toMatchObject({ externalId: 'orphaned-accounts', contextType: 'OrphanedAccounts' });
    expect(out.contexts[0].parentExternalId).toBeUndefined();
    expect(out.members).toHaveLength(0);
  });

  it('emits the root + one child per distinct accountType (deduped)', async () => {
    const plugin = await loadPlugin(ORPHANS);
    const out = await plugin.run({}, {});

    // root + Admin + Guest + Service = 4 contexts (Admin deduped across p1/p2).
    const children = out.contexts.filter(c => c.parentExternalId === 'orphaned-accounts');
    expect(out.contexts.filter(c => c.externalId === 'orphaned-accounts')).toHaveLength(1);
    expect(children.map(c => c.externalId).sort()).toEqual([
      'orphaned-accounts:Admin',
      'orphaned-accounts:Guest',
      'orphaned-accounts:Service',
    ]);
    // Child display names + contextType.
    const admin = children.find(c => c.externalId === 'orphaned-accounts:Admin');
    expect(admin).toMatchObject({ displayName: 'Orphaned — Admin', contextType: 'OrphanedAccounts' });
  });

  it('emits one member per orphan under the correct child', async () => {
    const plugin = await loadPlugin(ORPHANS);
    const out = await plugin.run({}, {});

    // One member per orphan — total equals the orphan rows.
    expect(out.members).toHaveLength(ORPHANS.length);
    expect(out.members.map(m => m.memberId).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);

    // Each member is filed under its accountType child.
    const admins = out.members.filter(m => m.contextExternalId === 'orphaned-accounts:Admin').map(m => m.memberId).sort();
    expect(admins).toEqual(['p1', 'p2']);
    expect(out.members.find(m => m.memberId === 'p3').contextExternalId).toBe('orphaned-accounts:Guest');
    expect(out.members.find(m => m.memberId === 'p4').contextExternalId).toBe('orphaned-accounts:Service');
  });

  it('queries Principals left-joined against IdentityMembers for orphans', async () => {
    vi.resetModules();
    const mockQuery = vi.fn(async () => ({ rows: [] }));
    vi.doMock('../../db/connection.js', () => ({
      query: mockQuery,
      queryOne: vi.fn(async () => null),
    }));
    vi.doMock('../../accountlinking/classifier.js', () => ({
      classifyAccount: vi.fn(() => ({ accountType: 'Secondary' })),
    }));
    const mod = await import('./orphaned-accounts.js');
    await mod.default.run({}, {});
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toMatch(/IdentityMembers/);
    expect(sql).toMatch(/IS NULL/);
  });

  it('calls ctx.log with the orphan / type counts', async () => {
    const plugin = await loadPlugin(ORPHANS);
    const log = vi.fn();
    await plugin.run({}, { log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/4 orphan account\(s\) across 3 type\(s\)/);
  });
});

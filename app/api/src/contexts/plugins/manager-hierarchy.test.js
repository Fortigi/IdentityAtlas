// Integration test for the manager-hierarchy plugin. Uses vi.doMock to
// inject a stub db module — the plugin imports `db` at the top of the
// file so we need the mock to be in place before the plugin loads.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fixed principal rows for deterministic tests.
// Shape mirrors the SELECT in manager-hierarchy.js.
const PRINCIPALS = {
  //  CEO (top — no manager)
  ceo:   { id: 'ceo-uuid',   displayName: 'Alice CEO',       managerId: null,        department: 'Executive' },
  //  VP under CEO
  vp:    { id: 'vp-uuid',    displayName: 'Bob VP',          managerId: 'ceo-uuid',  department: 'Engineering' },
  //  Real manager under VP
  mgr:   { id: 'mgr-uuid',   displayName: 'Carol Manager',   managerId: 'vp-uuid',   department: 'Engineering' },
  //  IC reporting to Carol
  ic1:   { id: 'ic1-uuid',   displayName: 'Dave IC',         managerId: 'mgr-uuid',  department: 'Engineering' },
  ic2:   { id: 'ic2-uuid',   displayName: 'Eve IC',          managerId: 'mgr-uuid',  department: 'Engineering' },
  //  External consultant with internal admin-management chain (the case
  //  we want to exclude)
  ext:   { id: 'ext-uuid',   displayName: 'Rick (Quanza)',   managerId: 'vp-uuid',   department: '' },
  c1:    { id: 'c1-uuid',    displayName: 'Sam (Quanza)',    managerId: 'ext-uuid',  department: 'Dev' },
  c2:    { id: 'c2-uuid',    displayName: 'Tom (Quanza)',    managerId: 'ext-uuid',  department: 'Ops' },
};

async function loadPluginWithRows(rows) {
  vi.resetModules();
  vi.doMock('../../db/connection.js', () => ({
    query: vi.fn(async () => ({ rows })),
  }));
  const mod = await import('./manager-hierarchy.js');
  return mod.default;
}

describe('manager-hierarchy plugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('requires scopeSystemId', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    await expect(plugin.run({}, {})).rejects.toThrow(/scopeSystemId/);
  });

  it('produces one context per manager plus synthetic root', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, rootName: 'Org' }, {});
    const externalIds = out.contexts.map(c => c.externalId);
    // Root + CEO + VP + real manager + external "manager".
    expect(externalIds).toEqual(expect.arrayContaining(['root', 'ceo-uuid', 'vp-uuid', 'mgr-uuid', 'ext-uuid']));
    // ICs should NOT become manager nodes.
    expect(externalIds).not.toContain('ic1-uuid');
    expect(externalIds).not.toContain('ic2-uuid');
  });

  it('uses "<Department> (<Name>)" as displayName when department is set', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    const mgr = out.contexts.find(c => c.externalId === 'mgr-uuid');
    expect(mgr.displayName).toBe('Engineering (Carol Manager)');
  });

  it('falls back to bare name when department is empty', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    const ext = out.contexts.find(c => c.externalId === 'ext-uuid');
    // Rick has no department, so displayName is just the raw name.
    expect(ext.displayName).toBe('Rick (Quanza)');
  });

  it('routes ICs to the correct manager\'s members list', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    const mgrMembers = out.members.filter(m => m.contextExternalId === 'mgr-uuid').map(m => m.memberId);
    expect(mgrMembers.sort()).toEqual(['ic1-uuid', 'ic2-uuid']);
  });

  it('excludeNamePatterns removes the matching principal from manager nodes', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run(
      { scopeSystemId: 1, excludeNamePatterns: ['\\(Quanza\\)'] },
      {},
    );
    const externalIds = out.contexts.map(c => c.externalId);
    // Rick (Quanza) should no longer be a manager node.
    expect(externalIds).not.toContain('ext-uuid');
    // CEO, VP, Carol are unaffected.
    expect(externalIds).toEqual(expect.arrayContaining(['ceo-uuid', 'vp-uuid', 'mgr-uuid']));
  });

  it('excluded manager\'s reports fall back to the root context', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run(
      { scopeSystemId: 1, excludeNamePatterns: ['\\(Quanza\\)'] },
      {},
    );
    const rootMembers = out.members
      .filter(m => m.contextExternalId === 'root')
      .map(m => m.memberId);
    // The two Quanza consultants whose manager was excluded now land on root.
    expect(rootMembers).toEqual(expect.arrayContaining(['c1-uuid', 'c2-uuid']));
  });

  it('excluded principal still becomes a regular member of their own manager\'s context', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run(
      { scopeSystemId: 1, excludeNamePatterns: ['\\(Quanza\\)'] },
      {},
    );
    // Rick (Quanza) reports to Bob VP. With Rick excluded from manager nodes,
    // Rick should still be a member of Bob's context.
    const vpMembers = out.members
      .filter(m => m.contextExternalId === 'vp-uuid')
      .map(m => m.memberId);
    expect(vpMembers).toContain('ext-uuid');
  });

  it('throws a clear error on invalid regex in excludeNamePatterns', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    await expect(
      plugin.run({ scopeSystemId: 1, excludeNamePatterns: ['[invalid'] }, {}),
    ).rejects.toThrow(/excludeNamePatterns\[0\]/);
  });

  it('empty dataset returns empty output', async () => {
    const plugin = await loadPluginWithRows([]);
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    expect(out).toEqual({ contexts: [], members: [] });
  });
});

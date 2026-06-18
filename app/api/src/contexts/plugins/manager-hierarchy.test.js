// Integration test for the manager-hierarchy plugin. Uses vi.doMock to inject
// stub db + columnCache modules — the plugin imports them at the top of the
// file so the mocks must be in place before the plugin loads.
//
// The plugin issues two queries: one for the extendedAttributes key whitelist
// (matched by the `jsonb_object_keys` text) and one for the principal rows. The
// stub routes by SQL text so naming-by-attribute can be exercised without a DB.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fixed principal rows for deterministic tests. Shape mirrors the columns the
// plugin SELECTs (department / jobTitle are real columns; costCenter is an
// extendedAttributes key, surfaced here as a flat property because the stub
// can't actually evaluate `extendedAttributes ->> 'costCenter'`).
const PRINCIPALS = {
  ceo: { id: 'ceo-uuid', displayName: 'Alice CEO',     managerId: null,       department: 'Executive',   jobTitle: 'CEO',     costCenter: 'CC-100' },
  vp:  { id: 'vp-uuid',  displayName: 'Bob VP',        managerId: 'ceo-uuid', department: 'Engineering', jobTitle: 'VP Eng',  costCenter: 'CC-200' },
  mgr: { id: 'mgr-uuid', displayName: 'Carol Manager', managerId: 'vp-uuid',  department: 'Engineering', jobTitle: 'EM',      costCenter: 'CC-210' },
  ic1: { id: 'ic1-uuid', displayName: 'Dave IC',       managerId: 'mgr-uuid', department: 'Engineering', jobTitle: 'SWE',     costCenter: 'CC-210' },
  ic2: { id: 'ic2-uuid', displayName: 'Eve IC',        managerId: 'mgr-uuid', department: 'Engineering', jobTitle: 'SWE',     costCenter: 'CC-210' },
  ext: { id: 'ext-uuid', displayName: 'Rick (Quanza)', managerId: 'vp-uuid',  department: '',            jobTitle: '',        costCenter: '' },
  c1:  { id: 'c1-uuid',  displayName: 'Sam (Quanza)',  managerId: 'ext-uuid', department: 'Dev',         jobTitle: 'Consultant', costCenter: '' },
  c2:  { id: 'c2-uuid',  displayName: 'Tom (Quanza)',  managerId: 'ext-uuid', department: 'Ops',         jobTitle: 'Consultant', costCenter: '' },
};

const DEFAULT_COLUMNS = ['id', 'displayName', 'managerId', 'department', 'jobTitle', 'companyName'];

async function loadPluginWithRows(rows, { columns = DEFAULT_COLUMNS, extKeys = [], overrides = [] } = {}) {
  vi.resetModules();
  vi.doMock('../../db/columnCache.js', () => ({
    getPrincipalColumns: vi.fn(async () => columns.map(name => ({ name }))),
  }));
  vi.doMock('../../db/connection.js', () => ({
    query: vi.fn(async (sql) => {
      if (/jsonb_object_keys/.test(sql)) return { rows: extKeys.map(k => ({ k })) };
      if (/ManagerHierarchyOverrides/.test(sql)) return { rows: overrides };
      return { rows };
    }),
  }));
  const mod = await import('./manager-hierarchy.js');
  return mod.default;
}

describe('manager-hierarchy plugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps the manager-hierarchy name (drop-in replacement)', async () => {
    const plugin = await loadPluginWithRows([]);
    expect(plugin.name).toBe('manager-hierarchy');
    expect(plugin.targetType).toBe('Principal');
  });

  it('requires scopeSystemId', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    await expect(plugin.run({}, {})).rejects.toThrow(/scopeSystemId/);
  });

  it('produces one context per manager plus synthetic root', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, rootName: 'Org' }, {});
    const externalIds = out.contexts.map(c => c.externalId);
    expect(externalIds).toEqual(expect.arrayContaining(['root', 'ceo-uuid', 'vp-uuid', 'mgr-uuid', 'ext-uuid']));
    expect(externalIds).not.toContain('ic1-uuid');
    expect(externalIds).not.toContain('ic2-uuid');
  });

  it('contexts use the ManagerHierarchy contextType', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    expect(out.contexts.every(c => c.contextType === 'ManagerHierarchy')).toBe(true);
  });

  // ── Default naming (backward-compatible with the old plugin) ──────────────
  it('defaults to "<Department> (<Name>)" naming', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    const mgr = out.contexts.find(c => c.externalId === 'mgr-uuid');
    expect(mgr.displayName).toBe('Engineering (Carol Manager)');
  });

  it('falls back to bare name when the chosen attribute is empty', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    const ext = out.contexts.find(c => c.externalId === 'ext-uuid');
    expect(ext.displayName).toBe('Rick (Quanza)');
  });

  // ── Configurable naming (new) ─────────────────────────────────────────────
  it('names nodes by a different real column (jobTitle)', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, nameFields: ['jobTitle'] }, {});
    const mgr = out.contexts.find(c => c.externalId === 'mgr-uuid');
    expect(mgr.displayName).toBe('EM (Carol Manager)');
  });

  it('joins multiple name fields with the separator', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, nameFields: ['department', 'jobTitle'], nameSeparator: ' / ', includeManagerName: false }, {});
    const mgr = out.contexts.find(c => c.externalId === 'mgr-uuid');
    expect(mgr.displayName).toBe('Engineering / EM');
  });

  it('omits the manager name when includeManagerName is false', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, includeManagerName: false }, {});
    const mgr = out.contexts.find(c => c.externalId === 'mgr-uuid');
    expect(mgr.displayName).toBe('Engineering');
  });

  it('names nodes by an extendedAttributes key', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS), { extKeys: ['costCenter'] });
    const out = await plugin.run({ scopeSystemId: 1, nameFields: ['costCenter'], includeManagerName: false }, {});
    const mgr = out.contexts.find(c => c.externalId === 'mgr-uuid');
    expect(mgr.displayName).toBe('CC-210');
  });

  it('drops an unknown field and falls back to department', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, nameFields: ['notAColumn'] }, {});
    const mgr = out.contexts.find(c => c.externalId === 'mgr-uuid');
    expect(mgr.displayName).toBe('Engineering (Carol Manager)');
  });

  // ── Membership + exclusion (unchanged behaviour) ──────────────────────────
  it('routes ICs to the correct manager\'s members list', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    const mgrMembers = out.members.filter(m => m.contextExternalId === 'mgr-uuid').map(m => m.memberId);
    expect(mgrMembers.sort()).toEqual(['ic1-uuid', 'ic2-uuid']);
  });

  it('excludeNamePatterns removes the matching principal from manager nodes', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, excludeNamePatterns: ['\\(Quanza\\)'] }, {});
    const externalIds = out.contexts.map(c => c.externalId);
    expect(externalIds).not.toContain('ext-uuid');
    expect(externalIds).toEqual(expect.arrayContaining(['ceo-uuid', 'vp-uuid', 'mgr-uuid']));
  });

  it('excluded manager\'s reports fall back to the root context', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS));
    const out = await plugin.run({ scopeSystemId: 1, excludeNamePatterns: ['\\(Quanza\\)'] }, {});
    const rootMembers = out.members.filter(m => m.contextExternalId === 'root').map(m => m.memberId);
    expect(rootMembers).toEqual(expect.arrayContaining(['c1-uuid', 'c2-uuid']));
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

  // ── Analyst manager overrides (drag-a-member-to-another-team) ──────────────
  const memberOf = (out, memberId) =>
    out.members.filter(m => m.memberId === memberId).map(m => m.contextExternalId);

  it('an override moves a member from their source manager to the target manager', async () => {
    // ic1 reports to mgr in the source data; override → report to vp instead.
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS), {
      overrides: [{ principalId: 'ic1-uuid', managerPrincipalId: 'vp-uuid' }],
    });
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    expect(memberOf(out, 'ic1-uuid')).toEqual(['vp-uuid']);          // moved
    expect(memberOf(out, 'ic1-uuid')).not.toContain('mgr-uuid');     // no longer under source
    expect(memberOf(out, 'ic2-uuid')).toEqual(['mgr-uuid']);         // sibling unaffected
  });

  it('an override target with no source reports still becomes a manager node', async () => {
    // ic2 has no reports in the source, so it is not normally a manager node.
    // Overriding ic1 to report to ic2 must create ic2's node so ic1 has a home.
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS), {
      overrides: [{ principalId: 'ic1-uuid', managerPrincipalId: 'ic2-uuid' }],
    });
    const out = await plugin.run({ scopeSystemId: 1 }, {});
    expect(out.contexts.map(c => c.externalId)).toContain('ic2-uuid');
    expect(memberOf(out, 'ic1-uuid')).toEqual(['ic2-uuid']);
  });

  it('a null override routes the member to the root', async () => {
    const plugin = await loadPluginWithRows(Object.values(PRINCIPALS), {
      overrides: [{ principalId: 'ic1-uuid', managerPrincipalId: null }],
    });
    const out = await plugin.run({ scopeSystemId: 1, rootName: 'Org' }, {});
    expect(memberOf(out, 'ic1-uuid')).toEqual(['root']);
  });
});

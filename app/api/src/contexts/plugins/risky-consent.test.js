// Unit tests for the risky-consent context plugin.
// Uses vi.doMock to inject a stub db so no real database is needed (the query
// returns one row per (principal, permission); the mock ignores the SQL/args).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// p1 holds a High + a Low; p2 a Medium; p3 only Low; p4 a High (via pattern).
const ROWS = [
  { principalId: 'p1', permission: 'Group.ReadWrite.All' },   // High
  { principalId: 'p1', permission: 'User.Read' },             // Low
  { principalId: 'p2', permission: 'Mail.Read' },             // Medium
  { principalId: 'p3', permission: 'openid' },                // Low
  { principalId: 'p4', permission: 'Sites.FullControl.All' }, // High (pattern)
  { principalId: 'p5', permission: null },                    // no permission — ignored
];

async function loadPlugin(rows) {
  vi.resetModules();
  vi.doMock('../../db/connection.js', () => ({
    query: vi.fn(async () => ({ rows })),
  }));
  const mod = await import('./risky-consent.js');
  return mod.default;
}

function membersOf(out, externalId) {
  return out.members.filter(m => m.contextExternalId === externalId).map(m => m.memberId).sort();
}

describe('risky-consent plugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns empty when there are no consents', async () => {
    const plugin = await loadPlugin([]);
    const out = await plugin.run({}, {});
    expect(out.contexts).toHaveLength(0);
    expect(out.members).toHaveLength(0);
  });

  it('emits High + Medium tier contexts by default with the right members', async () => {
    const plugin = await loadPlugin(ROWS);
    const out = await plugin.run({}, {});

    const byName = out.contexts.map(c => c.displayName).sort();
    expect(byName).toEqual(['Risky Consent — High', 'Risky Consent — Medium']);
    expect(out.contexts.every(c => c.contextType === 'RiskyConsent')).toBe(true);

    expect(membersOf(out, 'risky-consent:High')).toEqual(['p1', 'p4']);
    expect(membersOf(out, 'risky-consent:Medium')).toEqual(['p2']);
    // Low is not in the default enabledTiers, so p3 / the Low consents don't surface.
    expect(out.contexts.find(c => c.displayName.includes('Low'))).toBeUndefined();
  });

  it('a principal appears once per tier even with multiple consents at that tier', async () => {
    const plugin = await loadPlugin([
      { principalId: 'p1', permission: 'Group.ReadWrite.All' },
      { principalId: 'p1', permission: 'Application.ReadWrite.All' },
    ]);
    const out = await plugin.run({}, {});
    expect(membersOf(out, 'risky-consent:High')).toEqual(['p1']);
  });

  it('honours enabledTiers (e.g. include Low)', async () => {
    const plugin = await loadPlugin(ROWS);
    const out = await plugin.run({ enabledTiers: ['Low'] }, {});
    expect(out.contexts.map(c => c.displayName)).toEqual(['Risky Consent — Low']);
    // p1 (User.Read) and p3 (openid) hold Low consents.
    expect(membersOf(out, 'risky-consent:Low')).toEqual(['p1', 'p3']);
  });

  it('stamps the tier into extendedAttributes', async () => {
    const plugin = await loadPlugin(ROWS);
    const out = await plugin.run({}, {});
    const high = out.contexts.find(c => c.displayName.endsWith('High'));
    expect(high.extendedAttributes).toEqual({ tier: 'High' });
  });
});

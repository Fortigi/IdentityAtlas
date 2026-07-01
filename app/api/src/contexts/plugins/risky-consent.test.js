// Unit tests for the (merged, Resource-targeted) risky-consent plugin.
// The plugin runs two queries — the grant resources, and the per-app consent
// prevalence — so the mock differentiates by SQL. The OAuthSentry feed module is
// mocked; the risk-map classifier is real (integration).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// r1 High perm; r2 Medium perm; r3 Low perm but a MALICIOUS app; r4 Low perm but
// an UNVERIFIED-publisher app; r5 High perm AppRole (no client app).
const RESOURCES = [
  { resourceId: 'r1', permission: 'Group.ReadWrite.All',    appId: 'app-a',   publisher: 'Acme Ltd' },
  { resourceId: 'r2', permission: 'Mail.Read',              appId: 'app-b',   publisher: 'Acme Ltd' },
  { resourceId: 'r3', permission: 'openid',                 appId: 'app-mal', publisher: 'Acme Ltd' },
  { resourceId: 'r4', permission: 'User.Read',             appId: 'app-unv', publisher: 'Default Directory' },
  { resourceId: 'r5', permission: 'Sites.FullControl.All', appId: null,      publisher: null },
];
// All apps high-prevalence, so low-prevalence never fires — suspicious is unverified-only here.
const PREVALENCE = [
  { appId: 'app-a', principals: '10' },
  { appId: 'app-b', principals: '10' },
  { appId: 'app-mal', principals: '10' },
  { appId: 'app-unv', principals: '10' },
];

async function loadPlugin({ resources = RESOURCES, prevalence = PREVALENCE, malicious = new Set(), feedThrows = false } = {}) {
  vi.resetModules();
  vi.doMock('../../db/connection.js', () => ({
    query: vi.fn(async (sql) => (/count\(distinct/i.test(sql) ? { rows: prevalence } : { rows: resources })),
  }));
  vi.doMock('./riskyAppFeed.js', () => ({
    DEFAULT_FEED_URL: 'http://feed',
    fetchMaliciousAppIds: vi.fn(async () => {
      if (feedThrows) throw new Error('offline');
      return malicious;
    }),
  }));
  return (await import('./risky-consent.js')).default;
}

const membersOf = (out, ext) =>
  out.members.filter(m => m.contextExternalId === ext).map(m => m.memberId).sort();

describe('risky-consent plugin (merged, Resource-targeted)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('targets Resource (members are the grants, not principals)', async () => {
    const plugin = await loadPlugin();
    expect(plugin.targetType).toBe('Resource');
  });

  it('returns empty when there are no grants', async () => {
    const plugin = await loadPlugin({ resources: [] });
    const out = await plugin.run({}, {});
    expect(out.contexts).toHaveLength(0);
    expect(out.members).toHaveLength(0);
  });

  it('emits permission-risk AND app-reputation groups, membered by grant resource', async () => {
    const plugin = await loadPlugin({ malicious: new Set(['app-mal']) });
    const out = await plugin.run({}, {});

    // Permission risk (Low excluded by default).
    expect(membersOf(out, 'risky-consent:High')).toEqual(['r1', 'r5']);
    expect(membersOf(out, 'risky-consent:Medium')).toEqual(['r2']);
    // App reputation.
    expect(membersOf(out, 'risky-app-consent:Malicious')).toEqual(['r3']);
    expect(membersOf(out, 'risky-app-consent:Suspicious')).toEqual(['r4']);

    // Members are grant resource ids; the contexts carry the two dimensions.
    const dims = Object.fromEntries(out.contexts.map(c => [c.externalId, c.extendedAttributes.dimension]));
    expect(dims['risky-consent:High']).toBe('permission');
    expect(dims['risky-app-consent:Malicious']).toBe('app');
  });

  it('a malicious app outranks the suspicious heuristics for the same grant', async () => {
    const plugin = await loadPlugin({
      resources: [{ resourceId: 'rX', permission: 'openid', appId: 'app-mal', publisher: 'Default Directory' }],
      prevalence: [{ appId: 'app-mal', principals: '1' }],
      malicious: new Set(['app-mal']),
    });
    const out = await plugin.run({}, {});
    expect(membersOf(out, 'risky-app-consent:Malicious')).toEqual(['rX']);
    expect(out.contexts.find(c => c.externalId === 'risky-app-consent:Suspicious')).toBeUndefined();
  });

  it('includeAppReputation:false emits only the permission groups', async () => {
    const plugin = await loadPlugin({ malicious: new Set(['app-mal']) });
    const out = await plugin.run({ includeAppReputation: false }, {});
    expect(out.contexts.map(c => c.contextType)).toEqual(['RiskyConsent', 'RiskyConsent']); // High + Medium only
    expect(out.contexts.find(c => c.contextType === 'RiskyAppConsent')).toBeUndefined();
  });

  it('degrades to heuristics when the feed is unavailable', async () => {
    const plugin = await loadPlugin({ feedThrows: true });
    const out = await plugin.run({}, {});
    expect(out.contexts.find(c => c.externalId === 'risky-app-consent:Malicious')).toBeUndefined();
    // r4 still suspicious (unverified publisher); r3's app is not malicious now and is verified+high-prev → clean.
    expect(membersOf(out, 'risky-app-consent:Suspicious')).toEqual(['r4']);
  });

  it('honours enabledTiers (include Low)', async () => {
    const plugin = await loadPlugin();
    const out = await plugin.run({ enabledTiers: ['Low'], includeAppReputation: false }, {});
    expect(membersOf(out, 'risky-consent:Low')).toEqual(['r3', 'r4']); // openid + User.Read
    expect(out.contexts.find(c => c.externalId === 'risky-consent:High')).toBeUndefined();
  });
});

// Unit tests for the risky-app-consent plugin. Mocks both the db (consent rows)
// and the OAuthSentry feed module (malicious appId set / outage).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// p1 → a feed-malicious app; p2 → unverified publisher; p3 → low prevalence (1);
// p4/p5/p6 → a verified, popular app (clean).
const ROWS = [
  { principalId: 'p1', appId: 'mal-app',     publisher: 'Microsoft Services' },
  { principalId: 'p2', appId: 'unver-app',   publisher: 'Default Directory' },
  { principalId: 'p3', appId: 'lonely-app',  publisher: 'Acme Ltd' },
  { principalId: 'p4', appId: 'popular-app', publisher: 'Acme Ltd' },
  { principalId: 'p5', appId: 'popular-app', publisher: 'Acme Ltd' },
  { principalId: 'p6', appId: 'popular-app', publisher: 'Acme Ltd' },
];

async function loadPlugin(rows, maliciousIds = new Set(), feedThrows = false) {
  vi.resetModules();
  vi.doMock('../../db/connection.js', () => ({ query: vi.fn(async () => ({ rows })) }));
  vi.doMock('./riskyAppFeed.js', () => ({
    DEFAULT_FEED_URL: 'http://feed',
    fetchMaliciousAppIds: vi.fn(async () => {
      if (feedThrows) throw new Error('offline');
      return maliciousIds;
    }),
  }));
  return (await import('./risky-app-consent.js')).default;
}

const membersOf = (out, ext) =>
  out.members.filter(m => m.contextExternalId === ext).map(m => m.memberId).sort();

describe('risky-app-consent plugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns empty when there are no consents', async () => {
    const p = await loadPlugin([]);
    const out = await p.run({}, {});
    expect(out.contexts).toHaveLength(0);
    expect(out.members).toHaveLength(0);
  });

  it('flags feed-malicious apps and suspicious-by-heuristic apps', async () => {
    const p = await loadPlugin(ROWS, new Set(['mal-app']));
    const out = await p.run({ lowPrevalenceThreshold: 2 }, {});
    expect(membersOf(out, 'risky-app-consent:Malicious')).toEqual(['p1']);
    // p2 unverified publisher; p3 low prevalence (1 ≤ 2). popular-app (3 > 2, verified) is clean.
    expect(membersOf(out, 'risky-app-consent:Suspicious')).toEqual(['p2', 'p3']);
    expect(out.contexts.every(c => c.contextType === 'RiskyAppConsent')).toBe(true);
  });

  it('a malicious app outranks the suspicious heuristics for the same consent', async () => {
    const p = await loadPlugin([{ principalId: 'pX', appId: 'mal-app', publisher: 'Default Directory' }], new Set(['mal-app']));
    const out = await p.run({}, {});
    expect(membersOf(out, 'risky-app-consent:Malicious')).toEqual(['pX']);
    expect(out.contexts.find(c => c.externalId === 'risky-app-consent:Suspicious')).toBeUndefined();
  });

  it('degrades gracefully to heuristics when the feed is unavailable', async () => {
    const p = await loadPlugin(ROWS, new Set(), /* feedThrows */ true);
    const out = await p.run({ lowPrevalenceThreshold: 2 }, {});
    expect(out.contexts.find(c => c.externalId === 'risky-app-consent:Malicious')).toBeUndefined();
    // No feed → mal-app is judged by heuristics too (prevalence 1) → p1 now suspicious.
    expect(membersOf(out, 'risky-app-consent:Suspicious')).toEqual(['p1', 'p2', 'p3']);
  });

  it('can run feed-only (heuristics disabled)', async () => {
    const p = await loadPlugin(ROWS, new Set(['mal-app']));
    const out = await p.run({ heuristics: false }, {});
    expect(membersOf(out, 'risky-app-consent:Malicious')).toEqual(['p1']);
    expect(out.contexts.find(c => c.externalId === 'risky-app-consent:Suspicious')).toBeUndefined();
  });
});

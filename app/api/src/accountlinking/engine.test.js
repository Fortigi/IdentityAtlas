import { describe, it, expect } from 'vitest';
import { scoreMatch, buildLinks } from './engine.js';
import { DEFAULT_RULES } from './defaultRules.js';

const identity = { id: 'idy-1', displayName: 'John Doe', email: 'jdoe@contoso.com', employeeId: 'E1' };

describe('scoreMatch', () => {
  it('links an admin account via email-prefix + display name', () => {
    const orphan = { id: 'p1', displayName: 'John Doe (Admin)', email: 'adm-jdoe@contoso.com' };
    const { confidence, signals } = scoreMatch(orphan, identity, DEFAULT_RULES);
    expect(confidence).toBeGreaterThanOrEqual(70);
    expect(signals).toContain('emailPrefix');
    expect(signals).toContain('displayName');
  });
  it('links on an exact employeeId match', () => {
    const orphan = { id: 'p2', displayName: 'JD', email: 'unrelated@x.com', employeeId: 'E1' };
    const { confidence, signals } = scoreMatch(orphan, identity, DEFAULT_RULES);
    expect(signals).toContain('employeeId');
    expect(confidence).toBeGreaterThanOrEqual(70);
  });
  it('caps confidence at 100', () => {
    const orphan = { id: 'p3', displayName: 'John Doe', email: 'jdoe@contoso.com', employeeId: 'E1' };
    expect(scoreMatch(orphan, identity, DEFAULT_RULES).confidence).toBe(100);
  });
  it('does not match unrelated accounts', () => {
    const orphan = { id: 'p4', displayName: 'Jane Smith', email: 'jsmith@contoso.com' };
    expect(scoreMatch(orphan, identity, DEFAULT_RULES).confidence).toBeLessThan(70);
  });
});

describe('buildLinks', () => {
  const identities = [identity];

  it('links an admin orphan and skips service + unmatched accounts', () => {
    const orphans = [
      { id: 'p-adm', displayName: 'John Doe (Admin)', email: 'adm-jdoe@contoso.com' },
      { id: 'p-svc', displayName: 'svc-backup', email: 'svc-backup@contoso.com' }, // Service → not a person
      { id: 'p-x', displayName: 'Jane Smith', email: 'jsmith@contoso.com' },        // no identity match
    ];
    const links = buildLinks(orphans, identities, DEFAULT_RULES);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ principalId: 'p-adm', identityId: 'idy-1', accountType: 'Admin' });
    expect(links[0].confidence).toBeGreaterThanOrEqual(70);
  });

  it('returns nothing when no identity matches', () => {
    const links = buildLinks([{ id: 'p-z', displayName: 'Zed Zee', email: 'zzee@contoso.com' }], identities, DEFAULT_RULES);
    expect(links).toHaveLength(0);
  });
});

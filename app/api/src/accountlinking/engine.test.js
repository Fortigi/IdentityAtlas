import { describe, it, expect } from 'vitest';
import { scoreMatch, buildLinks } from './engine.js';
import { DEFAULT_RULES } from './defaultRules.js';

const identity = { id: 'idy-1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };

describe('scoreMatch', () => {
  it('links an admin account via email-prefix + full name', () => {
    const orphan = { id: 'p1', displayName: '(ADM-azure) Doe, John', email: 'adm-jdoe@contoso.com' };
    const { confidence, signals } = scoreMatch(orphan, identity, DEFAULT_RULES);
    expect(confidence).toBeGreaterThanOrEqual(70);
    expect(signals).toContain('emailPrefix');
    expect(signals).toContain('fullName');
  });
  it('links on an exact employeeId match', () => {
    const orphan = { id: 'p2', displayName: 'JD', email: 'unrelated@x.com', employeeId: 'E1' };
    const { confidence, signals } = scoreMatch(orphan, identity, DEFAULT_RULES);
    expect(signals).toContain('employeeId');
    expect(confidence).toBeGreaterThanOrEqual(70);
  });
  it('links a different email convention via name only, at lower confidence', () => {
    // robin.euson vs r.euson — emails differ, but the name still matches.
    const idy = { id: 'i', displayName: 'Euson, Robin', email: 'r.euson@por.com' };
    const orphan = { id: 'o', displayName: 'Euson, Robin (OGD)', email: 'robin.euson@ogd.nl' };
    const { confidence, signals } = scoreMatch(orphan, idy, DEFAULT_RULES);
    expect(signals).toEqual(['fullName']);
    expect(confidence).toBe(60); // name-only → honest, lower confidence
  });
  it('caps confidence at 100', () => {
    const orphan = { id: 'p3', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
    expect(scoreMatch(orphan, identity, DEFAULT_RULES).confidence).toBe(100);
  });
  it('does not match unrelated people', () => {
    const orphan = { id: 'p4', displayName: 'Smith, Jane', email: 'jsmith@contoso.com' };
    expect(scoreMatch(orphan, identity, DEFAULT_RULES).confidence).toBeLessThan(50);
  });
});

describe('buildLinks', () => {
  it('links all of a person’s accounts (admin + alternate-domain) to one identity', () => {
    const identities = [{ id: 'euson', displayName: 'Euson, Robin', email: 'r.euson@por.com', employeeId: 'E9' }];
    const orphans = [
      { id: 'adm', displayName: '(ADM-azure) Euson, Robin', email: 'R.Euson@por.onmicrosoft.com' },
      { id: 'ogd', displayName: 'Euson, Robin (OGD)', email: 'robin.euson@ogd.nl' },
      { id: 'admogd', displayName: '(ADM-azure) Euson, Robin (OGD)', email: 'robin.euson@por.onmicrosoft.com' },
      { id: 'svc', displayName: 'svc-backup', email: 'svc-backup@por.com' }, // service → skipped
    ];
    const links = buildLinks(orphans, identities, DEFAULT_RULES);
    const linkedIds = links.map(l => l.principalId).sort();
    expect(linkedIds).toEqual(['adm', 'admogd', 'ogd']);
    expect(links.every(l => l.identityId === 'euson')).toBe(true);
    // The admin account that shares the email prefix scores highest.
    expect(links.find(l => l.principalId === 'adm').confidence).toBeGreaterThan(
      links.find(l => l.principalId === 'ogd').confidence
    );
  });

  it('does not auto-link an ambiguous name-only match (two identities, same name)', () => {
    const identities = [
      { id: 'a', displayName: 'Jansen, Jan', email: 'jan.jansen@x.com' },
      { id: 'b', displayName: 'Jansen, Jan', email: 'j.jansen@y.com' },
    ];
    const orphan = { id: 'o', displayName: 'Jansen, Jan', email: 'jjansen@z.com' };
    expect(buildLinks([orphan], identities, DEFAULT_RULES)).toHaveLength(0);
  });

  it('returns nothing when no identity matches', () => {
    const identities = [identity];
    const links = buildLinks([{ id: 'p-z', displayName: 'Zee, Zed', email: 'zzee@contoso.com' }], identities, DEFAULT_RULES);
    expect(links).toHaveLength(0);
  });
});

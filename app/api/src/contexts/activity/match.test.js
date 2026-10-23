import { describe, it, expect, vi } from 'vitest';
import { matchContexts, buildContextMatcher, matchSubjects, subjectKey } from './match.js';

const units = [
  { id: 'c1', externalId: 'K-001', displayName: 'Northwind Traders' },
  { id: 'c2', externalId: 'K-002', displayName: 'Contoso Bakery' },
  { id: 'c3', externalId: null, displayName: 'Fabrikam' },
  { id: 'c4', externalId: null, displayName: 'Fabrikam' },
  { id: 'c5', externalId: 'DUP', displayName: 'Alpha' },
  { id: 'c6', externalId: 'dup', displayName: 'Beta' },
];

describe('buildContextMatcher', () => {
  it('matches the key case-insensitively, before the name', () => {
    const match = buildContextMatcher(units);
    expect(match(' k-001 ')).toEqual({ id: 'c1', kind: 'key' });
    // "Contoso Bakery" is c2's name and c7's key: the key wins.
    const withKey = buildContextMatcher([...units, { id: 'c7', externalId: 'Contoso Bakery', displayName: 'Other' }]);
    expect(withKey('Contoso Bakery')).toEqual({ id: 'c7', kind: 'key' });
  });

  it('then the normalised name, then a near miss', () => {
    const match = buildContextMatcher(units);
    expect(match('northwind  TRADERS')).toEqual({ id: 'c1', kind: 'name' });
    expect(match('Contoso Bakeri')).toMatchObject({ id: 'c2', kind: 'fuzzy', matchedName: 'Contoso Bakery' });
  });

  it('two sub-units with the same key or the same name are ambiguous, never a guess', () => {
    const match = buildContextMatcher(units);
    expect(match('dup')).toEqual({ ambiguous: true });
    expect(match('Fabrikam')).toEqual({ ambiguous: true });
    expect(match('Unknown Ltd')).toBeNull();
  });
});

describe('matchContexts', () => {
  it('maps each value to its sub-unit and counts the misses with the rows they hold back', () => {
    const { ids, stats } = matchContexts(units, new Map([['K-001', 4], ['Contoso Bakeri', 2], ['Fabrikam', 3], ['Unknown Ltd', 5]]));
    expect([...ids]).toEqual([['K-001', 'c1'], ['Contoso Bakeri', 'c2']]);
    expect(stats).toMatchObject({ matched: 2, fuzzy: 1, byName: 0, unmatched: 1, ambiguous: 1 });
    expect(stats.unmatchedSamples).toEqual([
      { kind: 'Context', value: 'Fabrikam', reason: 'ambiguous', rows: 3 },
      { kind: 'Context', value: 'Unknown Ltd', reason: 'not found', rows: 5 },
    ]);
    expect(stats.fuzzySamples).toEqual([{ kind: 'Context', value: 'Contoso Bakeri', matched: 'Contoso Bakery' }]);
  });
});

describe('subjectKey', () => {
  it('is the folded address when there is one, else the folded name', () => {
    expect(subjectKey({ subjectEmail: 'Vera@Example.org', subjectName: 'Vera' })).toBe('e:vera@example.org');
    expect(subjectKey({ subjectEmail: null, subjectName: ' Tom Sample ' })).toBe('n:tom sample');
  });
});

// A database that answers the matching queries by the table they read.
function fakeDb({ principals, identities, links = [], primary = {} }) {
  const P = (r) => ({ email: null, upn: null, employeeId: null, externalId: null, principalType: 'User', ...r });
  return {
    query: vi.fn(async (sql) => {
      if (sql.includes('"IdentityMembers"')) return { rows: links };
      if (sql.includes('"primaryPrincipalId"')) return { rows: Object.entries(primary).map(([id, p]) => ({ id, primaryPrincipalId: p })) };
      if (sql.includes('"Principals"')) return { rows: principals.map(P) };
      if (sql.includes('"Identities"')) return { rows: identities.map(r => ({ email: null, employeeId: null, ...r })) };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

describe('matchSubjects', () => {
  const db = () => fakeDb({
    principals: [
      { id: 'P1', email: 'vera@example.org', displayName: 'Vera Example' },
      { id: 'P2', displayName: 'Tom Sample' },
      { id: 'P8', displayName: 'Sam Twin' },
      { id: 'P9', displayName: 'Sam Twin' },
    ],
    identities: [
      { id: 'I1', email: 'vera@example.org', displayName: 'Vera Example' },
      { id: 'I3', email: 'ann@example.org', displayName: 'Ann Other' },
    ],
    links: [{ principalId: 'P2', identityId: 'I2' }],
    primary: { I3: 'P3' },
  });

  it('matches the address first, the name second, and completes the account / person pair', async () => {
    const { resolved, stats } = await matchSubjects(db(), [
      { subjectEmail: 'vera@example.org', subjectName: 'Vera Example' },
      { subjectEmail: null, subjectName: 'Tom Sample' },
      { subjectEmail: 'ann@example.org', subjectName: null },
      { subjectEmail: 'old@example.org', subjectName: 'Vera Example' },
      { subjectEmail: null, subjectName: 'Ghost Person' },
      { subjectEmail: null, subjectName: 'Sam Twin' },
    ]);
    expect(resolved.get('e:vera@example.org')).toEqual({ principalId: 'P1', identityId: 'I1', kind: 'key' });
    // Only an account: its person comes from IdentityMembers.
    expect(resolved.get('n:tom sample')).toEqual({ principalId: 'P2', identityId: 'I2', kind: 'name' });
    // Only a person: its primary account.
    expect(resolved.get('e:ann@example.org')).toEqual({ principalId: 'P3', identityId: 'I3', kind: 'key' });
    // An unknown address falls back to the name.
    expect(resolved.get('e:old@example.org')).toEqual({ principalId: 'P1', identityId: 'I1', kind: 'name' });
    expect(resolved.has('n:ghost person')).toBe(false);
    expect(resolved.has('n:sam twin')).toBe(false);
    expect(stats).toMatchObject({ matched: 4, byName: 2, unmatched: 1, ambiguous: 1 });
    expect(stats.unmatchedSamples).toEqual([
      { kind: 'Identity', value: 'Ghost Person', reason: 'not found' },
      { kind: 'Identity', value: 'Sam Twin', reason: 'ambiguous' },
    ]);
  });

  it('asks nothing when there is nobody to match', async () => {
    const d = db();
    const { resolved, stats } = await matchSubjects(d, []);
    expect(resolved.size).toBe(0);
    expect(stats.matched).toBe(0);
    expect(d.query).not.toHaveBeenCalled();
  });

  it('skips the pair lookups when every match already has both halves', async () => {
    const d = db();
    await matchSubjects(d, [{ subjectEmail: 'vera@example.org', subjectName: null }]);
    const sqls = d.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes('"IdentityMembers"'))).toBe(false);
    expect(sqls.some(s => s.includes('"primaryPrincipalId"'))).toBe(false);
  });
});

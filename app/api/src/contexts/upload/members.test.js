import { describe, it, expect, vi } from 'vitest';
import { buildMatcher, loadCandidates, matchAll, MAX_UNMATCHED_SAMPLES } from './members.js';

const P = (id, fields) => ({ id, email: null, upn: null, employeeId: null, externalId: null, displayName: null, ...fields });

describe('buildMatcher — accounts', () => {
  it('matches e-mail case-insensitively, and the UPN when the mail differs', () => {
    const match = buildMatcher('Principal', [P('p1', { email: 'Jan@X.nl' }), P('p2', { upn: 'kees@x.onmicrosoft.com' })]);
    expect(match('jan@x.nl')).toEqual({ id: 'p1' });
    expect(match('KEES@x.onmicrosoft.com')).toEqual({ id: 'p2' });
  });

  it('an e-mail hit wins over an employeeId hit on another account', () => {
    // "123@x.nl" is nobody's employee number, but the value "E1" below is both.
    const match = buildMatcher('Principal', [P('mail', { email: 'e1' }), P('emp', { employeeId: 'E1' })]);
    expect(match('E1')).toEqual({ id: 'emp' });
    const both = buildMatcher('Principal', [P('mail', { email: 'x@y.nl' }), P('emp', { employeeId: 'x@y.nl' })]);
    expect(both('x@y.nl')).toEqual({ id: 'mail' });
  });

  it('employeeId before externalId before display name', () => {
    const rows = [P('ext', { externalId: 'V1', displayName: 'V2' }), P('emp', { employeeId: 'V1' }), P('dn', { displayName: 'V1' })];
    expect(buildMatcher('Principal', rows)('V1')).toEqual({ id: 'emp' });
    expect(buildMatcher('Principal', rows.slice(0, 1).concat(rows[2]))('V1')).toEqual({ id: 'ext' });
    expect(buildMatcher('Principal', rows)('V2')).toEqual({ id: 'ext' });
  });

  it('two accounts on the deciding step make the value ambiguous, even when a later step is unique', () => {
    const match = buildMatcher('Principal', [P('a', { email: 'j@x.nl' }), P('b', { email: 'J@x.nl' }), P('c', { displayName: 'j@x.nl' })]);
    expect(match('j@x.nl')).toEqual({ ambiguous: true });
  });

  it('a display name is case-sensitive and exact', () => {
    const match = buildMatcher('Principal', [P('a', { displayName: 'Jan Jansen' })]);
    expect(match('jan jansen')).toBeNull();
    expect(match('Jan Jansen')).toEqual({ id: 'a' });
  });
});

describe('buildMatcher — people and resources', () => {
  it('people: e-mail, then employeeId, then display name', () => {
    const match = buildMatcher('Identity', [{ id: 'i1', email: 'A@x.nl', employeeId: '7', displayName: 'An' }]);
    expect([match('a@x.nl'), match('7'), match('An'), match('an')]).toEqual([{ id: 'i1' }, { id: 'i1' }, { id: 'i1' }, null]);
  });

  it('resources: externalId before a duplicated display name', () => {
    const rows = [{ id: 'r1', externalId: 'SG_App', displayName: 'App' }, { id: 'r2', externalId: null, displayName: 'SG_App' }, { id: 'r3', displayName: 'App' }];
    const match = buildMatcher('Resource', rows);
    expect(match('SG_App')).toEqual({ id: 'r1' });
    expect(match('App')).toEqual({ ambiguous: true });
  });

  it('an unknown kind matches nothing', () => {
    expect(buildMatcher('System', [{ id: 1, displayName: 'X' }])('X')).toBeNull();
  });
});

describe('loadCandidates', () => {
  it('sends the distinct values, and only e-mail-shaped ones lower-cased for the address match', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'x' }] }) };
    const rows = await loadCandidates(db, 'Principal', ['A@X.nl', 'A@X.nl', 'Jan']);
    expect(rows).toEqual([{ id: 'x' }]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual([['a@x.nl'], ['A@X.nl', 'Jan']]);
    expect(db.query.mock.calls[0][0]).toMatch(/FROM "Principals"\s+WHERE "deletedAt" IS NULL/);
  });

  it('does not query for no values or an unknown kind', async () => {
    const db = { query: vi.fn() };
    expect(await loadCandidates(db, 'Principal', [])).toEqual([]);
    expect(await loadCandidates(db, 'System', ['x'])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('matchAll', () => {
  it('maps matched values per kind and counts the rest, telling ambiguous from not found', async () => {
    const db = { query: vi.fn(async (sql) => ({
      rows: sql.includes('"Principals"')
        ? [P('p1', { email: 'a@x.nl' }), P('p2', { displayName: 'Twin' }), P('p3', { displayName: 'Twin' })]
        : [{ id: 'r1', externalId: 'G1', displayName: 'G1' }],
    })) };
    const { ids, stats } = await matchAll(db, { Principal: ['a@x.nl', 'Twin', 'ghost'], Resource: ['G1'] });
    expect([...ids.Principal]).toEqual([['a@x.nl', 'p1']]);
    expect([...ids.Resource]).toEqual([['G1', 'r1']]);
    expect(stats).toEqual({
      matched: 2, unmatched: 1, ambiguous: 1,
      unmatchedSamples: [{ kind: 'Principal', value: 'Twin', reason: 'ambiguous' }, { kind: 'Principal', value: 'ghost', reason: 'not found' }],
    });
  });

  it(`keeps at most ${MAX_UNMATCHED_SAMPLES} samples but counts every miss`, async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const values = Array.from({ length: MAX_UNMATCHED_SAMPLES + 1 }, (_, i) => `v${i}`);
    const { stats } = await matchAll(db, { Resource: values });
    expect(stats.unmatched).toBe(MAX_UNMATCHED_SAMPLES + 1);
    expect(stats.unmatchedSamples).toHaveLength(MAX_UNMATCHED_SAMPLES);
  });
});

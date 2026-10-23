import { describe, it, expect, vi } from 'vitest';
import {
  buildMatcher, loadCandidates, matchAll, MAX_UNMATCHED_SAMPLES, MAX_FUZZY_SAMPLES, NAME_CANDIDATES_PER_VALUE,
} from './members.js';

const P = (id, fields) => ({ id, email: null, upn: null, employeeId: null, externalId: null, displayName: null, principalType: 'User', ...fields });

describe('buildMatcher — accounts by key', () => {
  it('matches e-mail case-insensitively, and the UPN when the mail differs', () => {
    const match = buildMatcher('Principal', [P('p1', { email: 'Jan@X.nl' }), P('p2', { upn: 'kees@x.onmicrosoft.com' })]);
    expect(match('jan@x.nl')).toEqual({ id: 'p1', kind: 'key' });
    expect(match('KEES@x.onmicrosoft.com')).toEqual({ id: 'p2', kind: 'key' });
  });

  it('an e-mail hit wins over an employeeId hit on another account', () => {
    const match = buildMatcher('Principal', [P('mail', { email: 'e1' }), P('emp', { employeeId: 'E1' })]);
    expect(match('E1')).toEqual({ id: 'emp', kind: 'key' });
    const both = buildMatcher('Principal', [P('mail', { email: 'x@y.nl' }), P('emp', { employeeId: 'x@y.nl' })]);
    expect(both('x@y.nl')).toEqual({ id: 'mail', kind: 'key' });
  });

  it('employeeId before externalId before the name', () => {
    const rows = [P('ext', { externalId: 'V1', displayName: 'Vera Two' }), P('emp', { employeeId: 'V1' }), P('dn', { displayName: 'V1' })];
    expect(buildMatcher('Principal', rows)('V1')).toEqual({ id: 'emp', kind: 'key' });
    expect(buildMatcher('Principal', [rows[0], rows[2]])('V1')).toEqual({ id: 'ext', kind: 'key' });
    expect(buildMatcher('Principal', rows)('Vera Two')).toEqual({ id: 'ext', kind: 'name' });
  });

  it('two accounts on the deciding step make the value ambiguous, even when the name step is unique', () => {
    const match = buildMatcher('Principal', [P('a', { email: 'j@x.nl' }), P('b', { email: 'J@x.nl' }), P('c', { displayName: 'j@x.nl' })]);
    expect(match('j@x.nl')).toEqual({ ambiguous: true });
  });

  it('an address that matched no address is never matched by name', () => {
    const match = buildMatcher('Principal', [P('a', { displayName: 'ghost@x.nl' })]);
    expect(match('ghost@x.nl')).toBeNull();
  });
});

describe('buildMatcher — accounts by name', () => {
  it('a name matches whatever its case, accents, order or org suffix', () => {
    const match = buildMatcher('Principal', [P('a', { displayName: 'Gerda Brümmel' }), P('b', { displayName: 'Tom Example | Example Org' })]);
    expect(match('gerda brummel')).toEqual({ id: 'a', kind: 'name' });
    expect(match('Brümmel, Gerda')).toEqual({ id: 'a', kind: 'name' });
    expect(match('Tom Example')).toEqual({ id: 'b', kind: 'name' });
  });

  it('a user account wins over a service principal of the same name; two users are ambiguous', () => {
    const rows = [P('sp', { displayName: 'Iris Sample', principalType: 'ServicePrincipal' }), P('u', { displayName: 'Iris Sample' })];
    expect(buildMatcher('Principal', rows)('Iris Sample')).toEqual({ id: 'u', kind: 'name' });
    expect(buildMatcher('Principal', [...rows, P('u2', { displayName: 'iris sample' })])('Iris Sample')).toEqual({ ambiguous: true });
    expect(buildMatcher('Principal', [rows[0]])('Iris Sample')).toEqual({ id: 'sp', kind: 'name' });
  });

  it('a near miss is a fuzzy match naming the account it matched', () => {
    const match = buildMatcher('Principal', [P('a', { displayName: 'John Smith' }), P('b', { displayName: 'Mary Other' })]);
    expect(match('Jon Smith')).toMatchObject({ id: 'a', kind: 'fuzzy', matchedName: 'John Smith' });
  });
});

describe('buildMatcher — people and resources', () => {
  it('people: e-mail, then employeeId, then the name (case-insensitive)', () => {
    const match = buildMatcher('Identity', [{ id: 'i1', email: 'A@x.nl', employeeId: '7', displayName: 'Ann Example' }]);
    expect([match('a@x.nl'), match('7'), match('ann example')])
      .toEqual([{ id: 'i1', kind: 'key' }, { id: 'i1', kind: 'key' }, { id: 'i1', kind: 'name' }]);
  });

  it('resources: externalId before a duplicated display name, which stays exact', () => {
    const rows = [{ id: 'r1', externalId: 'SG_App', displayName: 'App' }, { id: 'r2', externalId: null, displayName: 'SG_App' }, { id: 'r3', displayName: 'App' }];
    const match = buildMatcher('Resource', rows);
    expect(match('SG_App')).toEqual({ id: 'r1', kind: 'key' });
    expect(match('App')).toEqual({ ambiguous: true });
    expect(match('app')).toBeNull();
  });

  it('an unknown kind matches nothing', () => {
    expect(buildMatcher('System', [{ id: 1, displayName: 'X' }])('X')).toBeNull();
  });
});

describe('loadCandidates', () => {
  it('sends the distinct values, only e-mail-shaped ones lower-cased, then the normalised names to the trigram lookup', async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'x' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'x' }, { id: 'y' }] }) };
    const rows = await loadCandidates(db, 'Principal', ['A@X.nl', 'A@X.nl', 'Jansen, Jan', 'Al']);
    expect(rows).toEqual([{ id: 'x' }, { id: 'y' }]);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][1]).toEqual([['a@x.nl'], ['A@X.nl', 'Jansen, Jan', 'Al']]);
    expect(db.query.mock.calls[0][0]).toMatch(/FROM "Principals" p\s+WHERE p\."deletedAt" IS NULL/);
    // "Al" is too short for a trigram lookup; the address is not a name.
    expect(db.query.mock.calls[1][1]).toEqual([['jan jansen']]);
    const nameSql = db.query.mock.calls[1][0];
    expect(nameSql).toContain('FROM unnest($1::text[]) v(name)');
    expect(nameSql).toMatch(/WHERE p\."deletedAt" IS NULL AND v\.name <% p\."displayName"/);
    expect(nameSql).toContain(`LIMIT ${NAME_CANDIDATES_PER_VALUE}`);
  });

  it('people are looked up through the search index expression', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await loadCandidates(db, 'Identity', ['Ann Example']);
    expect(db.query.mock.calls[1][0]).toMatch(/v\.name <% public\.ia_search_text\(ARRAY\[p\."id"::text, p\."displayName"/);
  });

  it('no trigram lookup for resources or for values that are all addresses', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await loadCandidates(db, 'Resource', ['Some Group']);
    await loadCandidates(db, 'Principal', ['a@x.nl']);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('does not query for no values or an unknown kind', async () => {
    const db = { query: vi.fn() };
    expect(await loadCandidates(db, 'Principal', [])).toEqual([]);
    expect(await loadCandidates(db, 'System', ['x'])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('matchAll', () => {
  it('maps matched values per kind and counts key, name, fuzzy, ambiguous and not found apart', async () => {
    const db = { query: vi.fn(async (sql) => ({
      rows: sql.includes('"Principals"')
        ? [P('p1', { email: 'a@x.nl' }), P('p2', { displayName: 'Twin Name' }), P('p3', { displayName: 'Twin Name' }),
          P('p4', { displayName: 'Bea Sample' }), P('p5', { displayName: 'Carl Example' })]
        : [{ id: 'r1', externalId: 'G1', displayName: 'G1' }],
    })) };
    const { ids, stats } = await matchAll(db, { Principal: ['a@x.nl', 'Twin Name', 'ghost', 'bea sample', 'Karl Example'], Resource: ['G1'] });
    expect([...ids.Principal]).toEqual([['a@x.nl', 'p1'], ['bea sample', 'p4'], ['Karl Example', 'p5']]);
    expect([...ids.Resource]).toEqual([['G1', 'r1']]);
    expect(stats).toEqual({
      matched: 4, byName: 1, fuzzy: 1, unmatched: 1, ambiguous: 1,
      unmatchedSamples: [{ kind: 'Principal', value: 'Twin Name', reason: 'ambiguous' }, { kind: 'Principal', value: 'ghost', reason: 'not found' }],
      fuzzySamples: [{ kind: 'Principal', value: 'Karl Example', matched: 'Carl Example' }],
    });
  });

  it(`keeps at most ${MAX_UNMATCHED_SAMPLES} samples but counts every miss`, async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const values = Array.from({ length: MAX_UNMATCHED_SAMPLES + 1 }, (_, i) => `v${i}`);
    const { stats } = await matchAll(db, { Resource: values });
    expect(stats.unmatched).toBe(MAX_UNMATCHED_SAMPLES + 1);
    expect(stats.unmatchedSamples).toHaveLength(MAX_UNMATCHED_SAMPLES);
  });

  it(`keeps at most ${MAX_FUZZY_SAMPLES} fuzzy samples but counts every fuzzy match`, async () => {
    // Twelve pseudo-random letters per account: far from each other; each value
    // is its account with the last letter dropped.
    let seed = 7;
    const letter = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return 'abcdefghijklmnopqrstuvwxyz'[seed % 26]; };
    const names = Array.from({ length: MAX_FUZZY_SAMPLES + 1 }, () => Array.from({ length: 12 }, letter).join(''));
    const db = { query: vi.fn(async () => ({ rows: names.map((n, i) => P(`p${i}`, { displayName: n })) })) };
    const { stats } = await matchAll(db, { Principal: names.map(n => n.slice(0, -1)) });
    expect(stats.matched).toBe(names.length);
    expect(stats.fuzzy).toBe(names.length);
    expect(stats.fuzzySamples).toHaveLength(MAX_FUZZY_SAMPLES);
  });
});

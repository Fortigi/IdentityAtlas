// Who a first name alone is: widening circles around the context, the first that
// decides wins, ambiguity stops the search, org-wide only a unique first name.
import { describe, it, expect } from 'vitest';
import {
  resolveFirstNames, pickFirstName, patternsOf, LOCAL_SQL, CLAIMED_SQL, NEARBY_SQL, ORG_SQL, ORG_ROWS, FIRST_NAME_STEPS,
} from './firstNames.js';

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const row = (id, displayName, holderCol = 'principalId') => ({ id, displayName, holderCol });

// Each step answers with its own rows; the org-wide step with rows tagged by name.
function fakeDb({ local = [], claimed = [], nearby = [], org = [] } = {}) {
  const calls = [];
  const bySql = new Map([[LOCAL_SQL, local], [CLAIMED_SQL, claimed], [NEARBY_SQL, nearby], [ORG_SQL, org]]);
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (!bySql.has(sql)) throw new Error('unexpected SQL');
      return { rows: bySql.get(sql) };
    },
  };
}
const steps = (db) => db.calls.map(c => [LOCAL_SQL, CLAIMED_SQL, NEARBY_SQL, ORG_SQL].indexOf(c.sql));

describe('pickFirstName', () => {
  it('one row is the person, two are ambiguous, none is null — read in both name orders', () => {
    expect(pickFirstName([row('a', 'Ruud Bakker'), row('b', 'Kees Smit')], 'ruud')).toEqual({ row: row('a', 'Ruud Bakker') });
    expect(pickFirstName([row('a', 'Bakker, Ruud')], 'ruud').row.id).toBe('a');
    expect(pickFirstName([row('a', 'Ruud Bakker'), row('b', 'Ruud de Wit')], 'ruud')).toBe('ambiguous');
    expect(pickFirstName([row('a', 'Ruudje Bakker')], 'ruud')).toBeNull();
  });

  it('the same account twice is one person; an account and a person are two', () => {
    expect(pickFirstName([row('a', 'Ruud Bakker'), row('a', 'Ruud Bakker')], 'ruud').row.id).toBe('a');
    expect(pickFirstName([row('a', 'Ruud Bakker'), row('a', 'Ruud Bakker', 'identityId')], 'ruud')).toBe('ambiguous');
  });
});

describe('patternsOf', () => {
  it('both name orders per first name, LIKE wildcards escaped', () => {
    expect(patternsOf(['ruud', '50%'])).toEqual(['ruud %', '%, ruud%', '50\\% %', '%, 50\\%%']);
  });
});

describe('resolveFirstNames', () => {
  it('(a) the context\'s own people decide first; the wider steps are not asked', async () => {
    const db = fakeDb({ local: [row('a', 'Ruud Bakker')], claimed: [row('x', 'Ruud Anders')] });
    const out = await resolveFirstNames(db, CTX, ['ruud']);
    expect(out.get('ruud').id).toBe('a');
    expect(db.calls).toEqual([{ sql: LOCAL_SQL, params: [CTX, ['ruud %', '%, ruud%']] }]);
  });

  it('(b) a name not among the members is found among the people the interviews already name', async () => {
    const db = fakeDb({ claimed: [row('b', 'Ruud Bakker', 'identityId')] });
    const out = await resolveFirstNames(db, CTX, ['ruud']);
    expect(out.get('ruud')).toEqual(row('b', 'Ruud Bakker', 'identityId'));
    expect(steps(db)).toEqual([0, 1]);
  });

  it('(c) then the members of the contexts next to it; (d) then the organisation', async () => {
    const near = fakeDb({ nearby: [row('c', 'Kees Smit')] });
    expect((await resolveFirstNames(near, CTX, ['kees'])).get('kees').id).toBe('c');
    expect(steps(near)).toEqual([0, 1, 2]);

    const org = fakeDb({ org: [{ ...row('d', 'Bram Bakker'), firstName: 'bram' }] });
    expect((await resolveFirstNames(org, CTX, ['bram'])).get('bram').id).toBe('d');
    expect(org.calls[3]).toEqual({ sql: ORG_SQL, params: [['bram'], ['bram %'], ['%, bram%']] });
  });

  it('only the names still open go to the next step, in one statement per step', async () => {
    const db = fakeDb({ local: [row('a', 'Ruud Bakker')], claimed: [row('b', 'Kees Smit')] });
    const out = await resolveFirstNames(db, CTX, ['ruud', 'kees', 'bram']);
    expect([...out].map(([f, r]) => [f, r.id])).toEqual([['ruud', 'a'], ['kees', 'b']]);
    expect(db.calls.map(c => c.params[1])).toEqual([
      ['ruud %', '%, ruud%', 'kees %', '%, kees%', 'bram %', '%, bram%'],
      ['kees %', '%, kees%', 'bram %', '%, bram%'],
      ['bram %', '%, bram%'],
      ['bram %'],
    ]);
  });

  it('two people with that first name at a step is no match, and the wider steps are not asked for it', async () => {
    for (const [i, key] of [[0, 'local'], [1, 'claimed'], [2, 'nearby']]) {
      const db = fakeDb({ [key]: [row('a', 'Ruud Bakker'), row('b', 'Ruud de Wit')], org: [{ ...row('z', 'Ruud Zomaar'), firstName: 'ruud' }] });
      expect((await resolveFirstNames(db, CTX, ['ruud'])).has('ruud'), key).toBe(false);
      expect(steps(db), key).toEqual(Array.from({ length: i + 1 }, (_, k) => k));
    }
  });

  it('org-wide: exactly one live user account; two, or as many rows as the lookup reads, is no match', async () => {
    const two = fakeDb({ org: [{ ...row('a', 'Bram Bakker'), firstName: 'bram' }, { ...row('b', 'Bram de Wit'), firstName: 'bram' }] });
    expect((await resolveFirstNames(two, CTX, ['bram'])).has('bram')).toBe(false);

    const many = Array.from({ length: ORG_ROWS }, (_, i) => ({ ...row(`id-${i}`, i === 0 ? 'Bram Bakker' : `Wit, Brammetje ${i}`), firstName: 'bram' }));
    expect((await resolveFirstNames(fakeDb({ org: many }), CTX, ['bram'])).has('bram')).toBe(false);
    expect((await resolveFirstNames(fakeDb({ org: many.slice(0, ORG_ROWS - 1) }), CTX, ['bram'])).get('bram').id).toBe('id-0');
  });

  it('org-wide rows count only for the name they were found for', async () => {
    const db = fakeDb({ org: [{ ...row('a', 'Bram Bakker'), firstName: 'bram' }, { ...row('k', 'Kees Smit'), firstName: 'kees' }, { ...row('k2', 'Kees de Wit'), firstName: 'kees' }] });
    const out = await resolveFirstNames(db, CTX, ['bram', 'kees']);
    expect([...out.keys()]).toEqual(['bram']);
  });

  it('nothing to look up asks nothing', async () => {
    const db = fakeDb();
    expect((await resolveFirstNames(db, CTX, [])).size).toBe(0);
    expect(db.calls).toEqual([]);
  });
});

describe('the SQL of each circle', () => {
  it('runs (a) to (c) in order; (b) reads claim holders and interviewees; (c) variants, parent and siblings; (d) live user accounts only', () => {
    expect(FIRST_NAME_STEPS).toEqual([LOCAL_SQL, CLAIMED_SQL, NEARBY_SQL]);
    expect(CLAIMED_SQL).toMatch(/FROM "ContextClaims" WHERE "contextId" = \$1::uuid AND "principalId" IS NOT NULL/);
    expect(CLAIMED_SQL).toMatch(/FROM "ContextInterviews" WHERE "contextId" = \$1::uuid AND "identityId" IS NOT NULL/);
    expect(NEARBY_SQL).toMatch(/"relationshipType" = 'SameUnitAs'/);
    expect(NEARBY_SQL).toMatch(/SELECT c."parentContextId" FROM "Contexts" c WHERE c.id = \$1::uuid/);
    expect(NEARBY_SQL).toMatch(/s."parentContextId" = c."parentContextId" AND s.id <> \$1::uuid/);
    expect(ORG_SQL).toMatch(/p."deletedAt" IS NULL AND p."principalType" = 'User'/);
    expect(ORG_SQL).toMatch(new RegExp(`LIMIT ${ORG_ROWS}\\)`));
  });
});

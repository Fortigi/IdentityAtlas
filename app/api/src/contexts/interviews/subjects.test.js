// Who a claim is about: the interviewee, an account the directory names, or a
// first name only the context's own people can resolve.
import { describe, it, expect } from 'vitest';
import {
  resolveSubjects, resolveClaimSubjects, isInterviewee, uniqueFirstName, surnameOf, uniqueSurname, LOCAL_SQL, SURNAME_SQL, SURNAME_ROWS,
} from './subjects.js';
import { CLAIMED_SQL, NEARBY_SQL, ORG_SQL } from './firstNames.js';

const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const PIET_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const YARA = 'aaaaaaaa-0000-4000-8000-000000000004';
const KEES_PERSON = 'bbbbbbbb-0000-4000-8000-000000000005';

const account = (id, displayName, over = {}) => ({ id, displayName, email: null, upn: null, employeeId: null, externalId: null, principalType: 'User', ...over });

// A db that answers the directory lookups with `directory` and the context's
// own people with `local`, and records what it was asked.
// Directory lookups get `directory` — a function of the values asked when the
// answer depends on them — and the surname lookup gets `surname`.
function fakeDb({ directory = [], local = [], surname = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql === LOCAL_SQL) return { rows: local };
      if (sql === SURNAME_SQL) return { rows: surname };
      return { rows: typeof directory === 'function' ? directory(params) : directory };
    },
  };
}

const interviewee = { principalId: ANNA, name: 'Anna Voorbeeld' };

describe('isInterviewee', () => {
  it('reads the reply\'s word for the speaker, their full name in any spelling, and their first name alone', () => {
    for (const n of ['interviewee', 'I', 'ik', 'Self', 'Voorbeeld, Anna', 'ANNA VOORBEELD', 'Anna']) expect(isInterviewee(n, 'Anna Voorbeeld')).toBe(true);
  });

  it('does not take another person with the same first name, or a last name alone', () => {
    expect(isInterviewee('Anna Jansen', 'Anna Voorbeeld')).toBe(false);
    expect(isInterviewee('Voorbeeld', 'Anna Voorbeeld')).toBe(false);
    expect(isInterviewee('Anna', '')).toBe(false);
  });
});

describe('uniqueFirstName', () => {
  it('is the one row with that first name, read in "Last, First" too; two are none', () => {
    const rows = [{ id: PIET, displayName: 'Jansen, Piet', holderCol: 'principalId' }, { id: YARA, displayName: 'Yara Test', holderCol: 'principalId' }];
    expect(uniqueFirstName(rows, 'piet').id).toBe(PIET);
    expect(uniqueFirstName([...rows, { id: KEES_PERSON, displayName: 'Piet Ander', holderCol: 'identityId' }], 'piet')).toBeNull();
    expect(uniqueFirstName([...rows, { id: PIET, displayName: 'Piet Jansen', holderCol: 'principalId' }], 'piet').id).toBe(PIET);
  });
});

describe('resolveSubjects', () => {
  it('maps the speaker to the interviewee without asking the directory', async () => {
    const db = fakeDb();
    const out = await resolveSubjects(db, ['interviewee', 'Anna'], { contextId: 'ctx', interviewee });
    expect(out.get('interviewee')).toEqual({ principalId: ANNA, match: 'interviewee' });
    expect(out.get('Anna')).toEqual({ principalId: ANNA, match: 'interviewee' });
    expect(db.calls).toEqual([]);
  });

  it('an interviewee who is a person gives identityId', async () => {
    const out = await resolveSubjects(fakeDb(), ['ik'], { contextId: 'ctx', interviewee: { identityId: KEES_PERSON, name: 'Kees' } });
    expect(out.get('ik')).toEqual({ identityId: KEES_PERSON, match: 'interviewee' });
  });

  it('a full name the directory knows once is matched by name; a near miss is flagged fuzzy', async () => {
    const db = fakeDb({ directory: [account(YARA, 'Yara Testpersoon')] });
    const out = await resolveSubjects(db, ['Yara Testpersoon', 'Yara Testpersoom'], { contextId: 'ctx', interviewee });
    expect(out.get('Yara Testpersoon')).toEqual({ principalId: YARA, match: 'name' });
    expect(out.get('Yara Testpersoom')).toEqual({ principalId: YARA, match: 'fuzzy' });
  });

  it('a first name alone goes to the context\'s own people, with patterns for both name orders', async () => {
    const db = fakeDb({ directory: [], local: [{ id: PIET, displayName: 'Piet Jansen', holderCol: 'principalId' }] });
    const out = await resolveSubjects(db, ['Piet'], { contextId: 'ctx-1', interviewee });
    expect(out.get('Piet')).toEqual({ principalId: PIET, match: 'firstName' });
    const local = db.calls.find(c => c.sql === LOCAL_SQL);
    expect(local.params).toEqual(['ctx-1', ['piet %', '%, piet%']]);
  });

  it('two people with that first name in the context: unmatched, the raw name kept by the caller', async () => {
    const db = fakeDb({ local: [{ id: PIET, displayName: 'Piet Jansen', holderCol: 'principalId' }, { id: PIET_OTHER, displayName: 'Piet de Vries', holderCol: 'principalId' }] });
    const out = await resolveSubjects(db, ['Piet'], { contextId: 'ctx', interviewee });
    expect(out.get('Piet')).toEqual({ match: null });
  });

  it('a full name nobody has is unmatched and never tried as a first name', async () => {
    const db = fakeDb({ local: [{ id: PIET, displayName: 'Onbekend Persoon', holderCol: 'principalId' }] });
    const out = await resolveSubjects(db, ['Onbekend Mens'], { contextId: 'ctx', interviewee });
    expect(out.get('Onbekend Mens')).toEqual({ match: null });
    expect(db.calls.some(c => c.sql === LOCAL_SQL)).toBe(false);
  });

  it('a former member, no longer in the context, is found among the people its interviews name — flagged firstName', async () => {
    const db = fakeDb({ directory: (params) => (params[0] === 'ctx' && params[1]?.[0] === 'kees %' ? [{ id: KEES_PERSON, displayName: 'Kees Vertrokken', holderCol: 'identityId' }] : []) });
    const out = await resolveSubjects(db, ['Kees'], { contextId: 'ctx', interviewee });
    expect(out.get('Kees')).toEqual({ identityId: KEES_PERSON, match: 'firstName' });
    expect(db.calls.map(c => c.sql).filter(sql => [LOCAL_SQL, CLAIMED_SQL, NEARBY_SQL, ORG_SQL].includes(sql))).toEqual([LOCAL_SQL, CLAIMED_SQL]);
  });

  it('escapes LIKE wildcards in a first name', async () => {
    const db = fakeDb();
    await resolveSubjects(db, ['50%'], { contextId: 'ctx', interviewee });
    expect(db.calls.find(c => c.sql === LOCAL_SQL).params[1]).toEqual(['50\\% %', '%, 50\\%%']);
  });
});

// The directory knows the full name only when it is asked for it, as a real
// lookup would: a truncated name finds nothing.
const knows = (rows) => (params) => {
  const asked = params.flat().map(v => String(v).toLowerCase());
  return rows.filter(r => asked.includes(r.displayName.toLowerCase()));
};

const DE_VRIES = 'cccccccc-0000-4000-8000-000000000006';
const DE_VRIES_OTHER = 'cccccccc-0000-4000-8000-000000000007';
const QUOTE = 'Piet de Vries does most of the day-to-day work there';

describe('surnameOf / uniqueSurname', () => {
  it('a surname alone, with particles in front; a full name or a short word is not one', () => {
    expect(surnameOf('Vries')).toBe('vries');
    expect(surnameOf('van der Berg')).toBe('van der berg');
    expect(surnameOf('Piet Vries')).toBeNull();
    expect(surnameOf('Bo')).toBeNull();
  });

  it('the one account whose name ends in the surname; two are none; a name that merely contains it is not one', () => {
    const rows = [{ id: DE_VRIES, displayName: 'Piet de Vries' }, { id: YARA, displayName: 'Vriesland, Yara' }];
    expect(uniqueSurname(rows, 'vries')).toBe(DE_VRIES);
    expect(uniqueSurname(rows, 'de vries')).toBe(DE_VRIES);
    expect(uniqueSurname([...rows, { id: DE_VRIES_OTHER, displayName: 'de Vries, Anna' }], 'vries')).toBeNull();
    expect(uniqueSurname(rows, 'land')).toBeNull();
  });
});

describe('resolveClaimSubjects', () => {
  const opts = { contextId: 'ctx', interviewee };

  it('a name the model cut short is matched by the full name in its quote, flagged fuzzy, and carries that name', async () => {
    const db = fakeDb({ directory: knows([account(DE_VRIES, 'Piet de Vries')]) });
    const out = await resolveClaimSubjects(db, [{ subjectName: 'de Vries', quote: QUOTE }, { subjectName: 'Vries', quote: `So ${QUOTE}` }], opts);
    expect(out).toEqual([
      { principalId: DE_VRIES, match: 'fuzzy', subjectName: 'Piet de Vries' },
      { principalId: DE_VRIES, match: 'fuzzy', subjectName: 'Piet de Vries' },
    ]);
    expect(db.calls.some(c => c.sql === SURNAME_SQL)).toBe(false);
  });

  it('a full name that resolves directly is kept as it is, and a claim without a person gets no match', async () => {
    const db = fakeDb({ directory: knows([account(YARA, 'Yara Testpersoon')]) });
    const out = await resolveClaimSubjects(db, [{ subjectName: 'Yara Testpersoon', quote: 'Yara Testpersoon is my backup' }, { subjectName: null, quote: 'x' }], opts);
    expect(out).toEqual([{ principalId: YARA, match: 'name', subjectName: 'Yara Testpersoon' }, { match: null, subjectName: null }]);
  });

  it('no name in the quote: a surname that only one live user account ends in is matched, flagged fuzzy', async () => {
    const db = fakeDb({ surname: [{ id: DE_VRIES, displayName: 'Piet de Vries' }, { id: YARA, displayName: 'Yara Vriesema' }] });
    const out = await resolveClaimSubjects(db, [{ subjectName: 'Vries', quote: 'Vries does it all' }], opts);
    expect(out).toEqual([{ principalId: DE_VRIES, match: 'fuzzy', subjectName: 'Vries' }]);
    expect(db.calls.find(c => c.sql === SURNAME_SQL).params).toEqual(['%vries%']);
  });

  it('escapes LIKE wildcards in a surname', async () => {
    const db = fakeDb({ surname: [] });
    await resolveClaimSubjects(db, [{ subjectName: 'Vri%s', quote: 'Vri%s does it' }], opts);
    expect(db.calls.find(c => c.sql === SURNAME_SQL).params).toEqual(['%vri\\%s%']);
  });

  it('two accounts with that surname, or a lookup that hit its limit, is no match', async () => {
    const two = fakeDb({ surname: [{ id: DE_VRIES, displayName: 'Piet de Vries' }, { id: DE_VRIES_OTHER, displayName: 'Anna de Vries' }] });
    expect(await resolveClaimSubjects(two, [{ subjectName: 'de Vries', quote: 'de Vries does it' }], opts)).toEqual([{ match: null, subjectName: 'de Vries' }]);
    const many = Array.from({ length: SURNAME_ROWS }, (_, i) => ({ id: `id-${i}`, displayName: i === 0 ? 'Piet de Vries' : `Vriesema ${i}` }));
    expect(await resolveClaimSubjects(fakeDb({ surname: many }), [{ subjectName: 'Vries', quote: 'Vries does it' }], opts)).toEqual([{ match: null, subjectName: 'Vries' }]);
  });

  it('a full name in the quote that two accounts share is no match: never a guess', async () => {
    const db = fakeDb({ directory: knows([account(DE_VRIES, 'Piet de Vries'), account(DE_VRIES_OTHER, 'Piet de Vries')]), surname: [] });
    const out = await resolveClaimSubjects(db, [{ subjectName: 'Vries', quote: QUOTE }], opts);
    expect(out).toEqual([{ match: null, subjectName: 'Vries' }]);
  });

  it('a full name in the quote that is the interviewee stays the interviewee', async () => {
    const out = await resolveClaimSubjects(fakeDb(), [{ subjectName: 'Voorbeeld', quote: 'Anna Voorbeeld runs it' }], opts);
    expect(out).toEqual([{ principalId: ANNA, match: 'interviewee', subjectName: 'Anna Voorbeeld' }]);
  });

  it('asks the surname lookup once per name, however many claims carry it', async () => {
    const db = fakeDb({ surname: [] });
    await resolveClaimSubjects(db, [{ subjectName: 'Vries', quote: 'Vries does it' }, { subjectName: 'Vries', quote: 'and Vries again' }], opts);
    expect(db.calls.filter(c => c.sql === SURNAME_SQL)).toHaveLength(1);
  });
});

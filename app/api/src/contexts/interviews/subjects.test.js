// Who a claim is about: the interviewee, an account the directory names, or a
// first name only the context's own people can resolve.
import { describe, it, expect } from 'vitest';
import { resolveSubjects, isInterviewee, uniqueFirstName, LOCAL_SQL } from './subjects.js';

const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const PIET_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const YARA = 'aaaaaaaa-0000-4000-8000-000000000004';
const KEES_PERSON = 'bbbbbbbb-0000-4000-8000-000000000005';

const account = (id, displayName, over = {}) => ({ id, displayName, email: null, upn: null, employeeId: null, externalId: null, principalType: 'User', ...over });

// A db that answers the directory lookups with `directory` and the context's
// own people with `local`, and records what it was asked.
function fakeDb({ directory = [], local = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql === LOCAL_SQL) return { rows: local };
      return { rows: directory };
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

  it('escapes LIKE wildcards in a first name', async () => {
    const db = fakeDb();
    await resolveSubjects(db, ['50%'], { contextId: 'ctx', interviewee });
    expect(db.calls.find(c => c.sql === LOCAL_SQL).params[1]).toEqual(['50\\% %', '%, 50\\%%']);
  });
});

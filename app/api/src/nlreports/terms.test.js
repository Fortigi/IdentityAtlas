// Names in a question, and where they occur. What this pins down:
//   • only what is clearly a name is looked up — not the first word of a sentence,
//     not the catalog's own vocabulary, not two-letter words
//   • a name is looked up as a whole word, and only field names come back
//   • a definition "uses" a name when any value or reference contains it
//   • the analyst's answer adds exactly the chosen filter, and drops only the
//     system conditions the confirmation offered to replace
import { describe, it, expect, vi } from 'vitest';
import { validateSpec } from './spec.js';
import {
  applyTermChoice, correctionMessage, findTerms, locateTerms, termConfirmation, termHint,
  ungroundedSystemConditions, unusedTerms, wholeWordPattern,
} from './terms.js';

const VALUES = { userType: ['Guest', 'Member'], principalType: ['User', 'ServicePrincipal'], systemName: ['Azure RM (3c4f204d)', 'Entra ID', 'Omada'] };
const valid = (raw) => {
  const r = validateSpec(raw, VALUES);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.spec;
};
const RDW = { term: 'RDW', places: [{ entity: 'user', field: 'email' }, { entity: 'user', field: 'companyName' }], system: false };
const QUESTION = 'Can you give me a list of all guest accounts from the RDW that have not signed in this month?';

describe('findTerms', () => {
  it('finds an all-caps name, and capitalised names that do not start a sentence', () => {
    expect(findTerms(QUESTION, VALUES)).toEqual(['RDW']);
    expect(findTerms("Can you create a report of groups that Wim has that William doesn't?", VALUES)).toEqual(['Wim', 'William']);
    expect(findTerms('Wim has groups. Sales has more.', VALUES)).toEqual([]);
  });

  it('keeps a name as written, punctuation included, and takes quoted text whole', () => {
    expect(findTerms('users in exactly the same groups as Folkertsma, Sipke', VALUES)).toEqual(['Folkertsma, Sipke']);
    expect(findTerms('groups that contain all members of business role Fortigi - Algemeen - Maten', VALUES)).toEqual(['Fortigi - Algemeen - Maten']);
    expect(findTerms('groups overlapping with the group Fortigi.All', VALUES)).toEqual(['Fortigi.All']);
    expect(findTerms('groups named "sales team west" and users from Maastricht UMC+', VALUES)).toEqual(['sales team west', 'Maastricht UMC+']);
  });

  it('skips vocabulary: catalog words, glossary terms and enum values — but not system names', () => {
    expect(findTerms('show every Guest and Member that is a User', VALUES)).toEqual([]);
    expect(findTerms('all accounts with a ServicePrincipal type', VALUES)).toEqual([]);
    expect(findTerms('list the user accounts that come from Azure RM', VALUES)).toEqual(['Azure RM']);
    expect(findTerms('accounts that come from Omada', VALUES)).toEqual(['Omada']);   // exactly a system name
  });

  it('ignores two-letter words, repeats and anything past four names', () => {
    expect(findTerms('show the AI agents in HR', VALUES)).toEqual([]);
    expect(findTerms('users from RDW and rdw and RDW', VALUES)).toEqual(['RDW']);
    expect(findTerms('users from AAA, BBB, CCC, DDD and EEE', VALUES)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    // a comma next to a code on either side separates; between plain names it joins
    expect(findTerms('users from RDW, Contoso and from Contoso, RDW', VALUES)).toEqual(['RDW', 'Contoso']);
    expect(findTerms('', VALUES)).toEqual([]);
  });
});

describe('wholeWordPattern', () => {
  it('bounds the name by non-alphanumerics and escapes its own punctuation', () => {
    expect(wholeWordPattern('RDW')).toBe('(^|[^[:alnum:]])RDW($|[^[:alnum:]])');
    expect(wholeWordPattern('UMC+ (NL)')).toBe('(^|[^[:alnum:]])UMC\\+ \\(NL\\)($|[^[:alnum:]])');
  });
});

describe('locateTerms', () => {
  it('asks per entity with the name as a LIKE and a whole-word pattern, and keeps only fields that hold it', async () => {
    const query = vi.fn(async (sql) => {
      const clauses = sql.split(/ AS f\d+/).slice(0, -1);
      const hit = (c) => c.includes(`"principalType" = 'User'`) && /"(email|companyName)"/.test(c);
      return { rows: [Object.fromEntries(clauses.map((c, i) => [`f${i}`, hit(c)]))] };
    });
    const located = await locateTerms(['RDW'], query, VALUES);
    expect(located).toEqual([RDW]);
    expect(query.mock.calls[0][1]).toEqual(['%RDW%', wholeWordPattern('RDW')]);
    // accounts and resources exclude what users and groups already reported
    expect(query.mock.calls.some(([sql]) => sql.includes(`"principalType" <> 'User'`))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes(`"resourceType" <> 'Group'`))).toBe(true);
  });

  it('marks a system name, and leaves out a name that occurs nowhere', async () => {
    const query = vi.fn(async () => ({ rows: [{}] }));
    expect(await locateTerms(['Azure', 'MFA'], query, VALUES)).toEqual([{ term: 'Azure', places: [], system: true }]);
  });
});

describe('termHint and correctionMessage', () => {
  it('names fields only, and says when a name is not a system', () => {
    expect(termHint([])).toBe('');
    const hint = termHint([RDW, { term: 'Azure', places: [], system: true }]);
    expect(hint).toMatch(/ONE field that fits/);
    expect(hint).toContain('- "RDW": user.email, user.companyName — not a system name');
    expect(hint).toContain('- "Azure": system\n'.trimEnd());
    expect(hint).not.toMatch(/Azure": system — not/);
  });

  it('tells the model what it left out and where that name occurs', () => {
    expect(correctionMessage([RDW])).toMatch(/mentions "RDW", but your definition does not use it\. "RDW" occurs in: user\.email, user\.companyName/);
    expect(correctionMessage([{ term: 'Azure', places: [], system: true }])).toMatch(/"Azure" occurs in: system/);
  });
});

describe('unusedTerms', () => {
  const spec = (conditions) => ({ entity: 'user', match: 'all', conditions });

  it('counts a name as used in any value or reference, at any depth, ignoring case and punctuation', () => {
    expect(unusedTerms(spec([{ type: 'field', field: 'companyName', op: 'contains', value: 'rdw' }]), [RDW])).toEqual([]);
    expect(unusedTerms(spec([{ type: 'relation', relation: 'memberOf', conditions: [{ type: 'group', conditions: [{ value: 'x RDW y' }] }] }]), [RDW])).toEqual([]);
    const folk = { term: 'Folkertsma, Sipke', places: [] };
    expect(unusedTerms(spec([{ type: 'compare', reference: { name: 'Folkertsma Sipke' } }]), [folk])).toEqual([]);
  });

  it('counts a shorter value that is part of the name as used, but not one under three characters', () => {
    const maten = { term: 'Fortigi - Algemeen - Maten', places: [] };
    expect(unusedTerms(spec([{ value: 'Algemeen' }]), [maten])).toEqual([]);
    expect(unusedTerms(spec([{ value: 'Fo' }]), [maten])).toEqual([maten]);
  });

  it('reports a name only a system condition or a number stands in for', () => {
    const conditions = [{ type: 'field', field: 'system', op: 'eq', value: 'Azure RM (3c4f204d)' }, { value: 30 }];
    expect(unusedTerms(spec(conditions), [RDW])).toEqual([RDW]);
  });
});

describe('ungroundedSystemConditions', () => {
  it('finds a top-level system condition that shares no word with the question', () => {
    const spec = valid({ entity: 'user', conditions: [
      { type: 'field', field: 'userType', op: 'eq', value: 'Guest' },
      { type: 'field', field: 'system', op: 'eq', value: 'Azure RM (3c4f204d)' },
    ] });
    expect(ungroundedSystemConditions(spec, QUESTION)).toEqual([[1]]);
    expect(ungroundedSystemConditions(spec, 'guests that come from azure')).toEqual([]);
  });

  it('does not treat the id in a system name as a word the question could share', () => {
    const spec = valid({ entity: 'user', conditions: [{ type: 'field', field: 'system', op: 'eq', value: 'Azure RM (3c4f204d)' }] });
    expect(ungroundedSystemConditions(spec, 'guests from 3c4f204d')).toEqual([[0]]);
  });
});

describe('termConfirmation', () => {
  const guestsInSystem = () => valid({ entity: 'user', conditions: [
    { type: 'field', field: 'userType', op: 'eq', value: 'Guest' },
    { type: 'field', field: 'system', op: 'eq', value: 'Azure RM (3c4f204d)' },
  ] });

  it('offers each field the name occurs in on the report entity, both together, and replacing the system guess', () => {
    const confirm = termConfirmation(guestsInSystem(), RDW, QUESTION);
    expect(confirm).toEqual({
      kind: 'term', path: [], name: 'RDW', label: 'user',
      choices: [
        { name: 'Email contains “RDW”', fields: ['email'] },
        { name: 'Company contains “RDW”', fields: ['companyName'] },
        { name: 'Email or Company contains “RDW”', fields: ['email', 'companyName'] },
      ],
      drop: [[1]],
      message: '“RDW” is not a system — it appears in Email and Company. Which should the report match? This replaces System is “Azure RM (3c4f204d)”.',
    });
  });

  it('asks without replacing anything when there is no system guess, and offers no "both" for one field', () => {
    const spec = valid({ entity: 'user', conditions: [{ type: 'field', field: 'userType', op: 'eq', value: 'Guest' }] });
    const confirm = termConfirmation(spec, { term: 'RDW', places: [{ entity: 'user', field: 'companyName' }] }, QUESTION);
    expect(confirm.choices).toEqual([{ name: 'Company contains “RDW”', fields: ['companyName'] }]);
    expect(confirm.drop).toEqual([]);
    expect(confirm.message).toBe('The report does not use “RDW” yet. It appears in Company. Which should the report match?');
  });

  it('has nothing to offer when the name only occurs on other entities', () => {
    const places = [{ entity: 'group', field: 'displayName' }, { entity: 'identity', field: 'email' }];
    expect(termConfirmation(guestsInSystem(), { term: 'RDW', places }, QUESTION)).toBeNull();
  });
});

describe('applyTermChoice', () => {
  const guestsInSystem = () => valid({ entity: 'user', conditions: [
    { type: 'field', field: 'system', op: 'eq', value: 'Azure RM (3c4f204d)' },
    { type: 'field', field: 'userType', op: 'eq', value: 'Guest' },
  ] });

  it('drops the offered system condition and adds one contains filter', () => {
    const spec = guestsInSystem();
    expect(applyTermChoice(spec, { term: ' RDW ', fields: ['companyName'], drop: [[0], [0]] })).toBe(true);
    expect(spec.conditions).toEqual([
      { type: 'field', field: 'userType', op: 'eq', value: 'Guest' },
      { type: 'field', field: 'companyName', op: 'contains', value: 'RDW' },
    ]);
    expect(validateSpec(spec, VALUES).ok).toBe(true);
  });

  it('adds several fields as one "any" group', () => {
    const spec = guestsInSystem();
    applyTermChoice(spec, { term: 'RDW', fields: ['email', 'companyName'] });
    expect(spec.conditions).toHaveLength(3);
    expect(spec.conditions[2]).toEqual({ type: 'group', match: 'any', conditions: [
      { type: 'field', field: 'email', op: 'contains', value: 'RDW' },
      { type: 'field', field: 'companyName', op: 'contains', value: 'RDW' },
    ] });
  });

  it('never drops anything but a top-level system condition', () => {
    const spec = guestsInSystem();
    applyTermChoice(spec, { term: 'RDW', fields: ['email'], drop: [[1], [0, 0], ['0'], [7], 'x'] });
    expect(spec.conditions.map(c => c.field)).toEqual(['system', 'userType', 'email']);
  });

  it('changes nothing for "leave it out"', () => {
    const spec = guestsInSystem();
    expect(applyTermChoice(spec, { skip: true, drop: [[0]] })).toBe(true);
    expect(spec).toEqual(guestsInSystem());
  });

  it('refuses a missing or oversized name, no fields, unknown or non-text fields, and inherited keys', () => {
    for (const choice of [
      { term: '', fields: ['email'] },
      { term: 'x'.repeat(61), fields: ['email'] },
      { term: 'RDW', fields: [] },
      { term: 'RDW' },
      { term: 'RDW', fields: ['noSuchField'] },
      { term: 'RDW', fields: ['accountEnabled'] },
      { term: 'RDW', fields: ['__proto__'] },
      { term: 'RDW', fields: [42] },
    ]) {
      const spec = guestsInSystem();
      expect(applyTermChoice(spec, { ...choice, drop: [[0]] })).toBe(false);
      expect(spec).toEqual(guestsInSystem());
    }
  });
});

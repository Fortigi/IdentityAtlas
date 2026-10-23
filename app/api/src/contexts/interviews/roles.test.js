// Role deduction: the fixed rules that turn what was said into a suggestion.
import { describe, it, expect } from 'vitest';
import { suggestionFor, deduceRoles, accountableDoubt, subjectKey, jointNames, splitJointSubjects, withLeftMemberships } from './roles.js';

const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const YARA = 'aaaaaaaa-0000-4000-8000-000000000003';

const role = (attribute, subject, over = {}) => ({ claimKind: 'role', attribute, ...subject, ...over });
const anna = { principalId: ANNA, subjectName: 'interviewee' };
const piet = { principalId: PIET, subjectName: 'Piet' };
const yara = { principalId: YARA, subjectName: 'Yara Test' };

describe('suggestionFor', () => {
  it('owner → Accountable; dayToDay and delegate → Responsible; the rest → nothing', () => {
    expect(['owner', 'dayToDay', 'delegate', 'notOwner', 'member', 'other', undefined].map(suggestionFor))
      .toEqual(['Accountable', 'Responsible', 'Responsible', null, null, null, null]);
  });
});

describe('deduceRoles', () => {
  it('"I own it, but Piet does the day-to-day": the interviewee Accountable, Piet Responsible', () => {
    const out = deduceRoles([role('owner', anna), role('dayToDay', piet)]);
    expect(out.map(c => [c.principalId, c.roleSuggestion])).toEqual([[ANNA, 'Accountable'], [PIET, 'Responsible']]);
  });

  it('"I\'m not the owner, Yara is": Yara Accountable, nothing for the interviewee', () => {
    const out = deduceRoles([role('notOwner', anna), role('owner', yara)]);
    expect(out.map(c => c.roleSuggestion)).toEqual([null, 'Accountable']);
  });

  it('"Piet is my backup": a delegate is Responsible', () => {
    expect(deduceRoles([role('delegate', piet)])[0].roleSuggestion).toBe('Responsible');
  });

  it('a subject who says both that they own it and that they do not gets no Accountable — the claims stay', () => {
    const out = deduceRoles([role('owner', anna), role('notOwner', anna), role('dayToDay', anna)]);
    expect(out.map(c => c.roleSuggestion)).toEqual([null, null, 'Responsible']);
    expect(out).toHaveLength(3);
  });

  it('suggests each role once per subject, and keys an unmatched subject by its spoken name', () => {
    const unmatched = { subjectName: ' Karel ' };
    const out = deduceRoles([role('dayToDay', piet), role('delegate', piet), role('dayToDay', unmatched), role('delegate', { subjectName: 'karel' })]);
    expect(out.map(c => c.roleSuggestion)).toEqual(['Responsible', null, 'Responsible', null]);
  });

  it('only a role claim suggests: roleHistory and description get null', () => {
    const out = deduceRoles([{ claimKind: 'roleHistory', attribute: 'owner', ...piet }, { claimKind: 'description', value: 'x' }]);
    expect(out.map(c => c.roleSuggestion)).toEqual([null, null]);
  });

  it('an identity is a different subject from an account with the same id', () => {
    expect(subjectKey({ identityId: PIET })).not.toBe(subjectKey({ principalId: PIET }));
  });
});

describe('accountableDoubt', () => {
  const claims = [
    role('notOwner', anna, { id: 'c1', status: 'rejected' }),
    role('owner', anna, { id: 'c2', status: 'proposed' }),
    role('notOwner', anna, { id: 'c3', status: 'proposed' }),
  ];

  it('is the first not-rejected notOwner claim about the current Accountable', () => {
    expect(accountableDoubt(claims, { principalId: ANNA }).id).toBe('c3');
  });

  it('is null for another holder, a rejected-only doubt, or no Accountable', () => {
    expect(accountableDoubt(claims, { principalId: PIET })).toBeNull();
    expect(accountableDoubt(claims.slice(0, 2), { principalId: ANNA })).toBeNull();
    expect(accountableDoubt(claims, null)).toBeNull();
    expect(accountableDoubt(claims, {})).toBeNull();
  });
});

describe('jointNames / splitJointSubjects', () => {
  it('two or more names joined by en / and / & are separate people', () => {
    expect(jointNames('Ruud en Kees')).toEqual(['Ruud', 'Kees']);
    expect(jointNames('Ruud and Kees')).toEqual(['Ruud', 'Kees']);
    expect(jointNames('Ruud & Kees de Wit')).toEqual(['Ruud', 'Kees de Wit']);
    expect(jointNames('Ruud, Kees en Bram')).toEqual(['Ruud', 'Kees', 'Bram']);
  });

  it('one person stays one: "Last, First", a particle, a name with "en" inside a word', () => {
    for (const n of ['Jansen, Piet', 'Piet van den Berg', 'Ben Hendriks', 'Kees', '', null]) expect(jointNames(n), String(n)).toBeNull();
  });

  it('a person claim about two names becomes two claims, the rest the same; other kinds are left alone', () => {
    const joint = { claimKind: 'roleHistory', subjectName: 'Ruud en Kees', value: 'worked', quote: 'Ruud en Kees hebben eraan gewerkt' };
    const desc = { claimKind: 'description', subjectName: null, value: 'planning en roosters' };
    const out = splitJointSubjects([joint, desc]);
    expect(out).toEqual([{ ...joint, subjectName: 'Ruud' }, { ...joint, subjectName: 'Kees' }, desc]);
  });
});

describe('withLeftMemberships', () => {
  const left = (subject, over = {}) => ({
    claimKind: 'roleHistory', attribute: 'member', value: 'left', periodText: 'recent', periodFrom: null, periodTo: '2026-06-30',
    quote: 'Bram did that too but recently left', confidence: 0.7, relevance: 'high', roleSuggestion: null, ...subject, ...over,
  });

  it('a role claim that says left adds a membership claim (former) with the same person, quote and period', () => {
    const source = left({ principalId: PIET, subjectName: 'Bram', subjectMatch: 'firstName' });
    const out = withLeftMemberships([source]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(source);
    expect(out[1]).toEqual({
      ...source, claimKind: 'membership', attribute: 'former', roleSuggestion: null, relevance: null,
    });
  });

  it('nothing is added where the model already gave a membership claim for that person, or twice for one person', () => {
    const own = { claimKind: 'membership', attribute: 'left', principalId: PIET, subjectName: 'Bram Bakker' };
    expect(withLeftMemberships([left({ principalId: PIET, subjectName: 'Bram' }), own])).toHaveLength(2);
    const twice = withLeftMemberships([left({ subjectName: 'Ruud' }), left({ subjectName: 'ruud', value: 'worked', periodText: 'inmiddels uitgestroomd' })]);
    expect(twice.filter(c => c.claimKind === 'membership').map(c => c.subjectName)).toEqual(['Ruud']);
  });

  it('a role that does not say left, a notOwner, or a claim without a person adds nothing', () => {
    const claims = [
      left({ subjectName: 'Kees' }, { value: 'developer', periodText: 'early years' }),
      { claimKind: 'role', attribute: 'notOwner', subjectName: 'Kees', value: 'no longer the owner' },
      left({ subjectName: null }),
    ];
    expect(withLeftMemberships(claims)).toEqual(claims);
  });
});

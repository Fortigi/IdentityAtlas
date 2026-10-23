// Role deduction: the fixed rules that turn what was said into a suggestion.
import { describe, it, expect } from 'vitest';
import { suggestionFor, deduceRoles, accountableDoubt, subjectKey } from './roles.js';

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

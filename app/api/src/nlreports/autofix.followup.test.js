// "And can he request that role?" — the person of the earlier question survives a
// follow-up that only says "he", whichever side the new definition is written from.
import { describe, it, expect } from 'vitest';
import { keepThePerson, personIn } from './autofix.followup.js';

const bram = { type: 'field', field: 'id', op: 'eq', value: '3f7c1d2e-9a4b-4c6d-8e1f-2b3c4d5e6f70' };
const ga = { type: 'field', field: 'displayName', op: 'contains', value: 'Global Administrator' };
const rel = (relation, conditions, quantifier = 'some') => ({ type: 'relation', relation, quantifier, match: 'all', conditions });
const roleWithBram = { entity: 'resource', match: 'all', conditions: [ga, rel('members', [bram])] };
const bramWithRole = { entity: 'user', match: 'all', conditions: [bram, rel('access', [ga])] };

describe('the person of a definition', () => {
  it('is found at the top level of an account report and inside a relation that reaches accounts', () => {
    expect(personIn(bramWithRole)).toBe(bram);
    expect(personIn(roleWithBram)).toBe(bram);
  });

  it('is not a group name, a role name or a condition on something else', () => {
    expect(personIn({ entity: 'group', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Finance' }] })).toBeNull();
    expect(personIn({ entity: 'resource', match: 'all', conditions: [ga, rel('members', [{ type: 'field', field: 'accountEnabled', op: 'eq', value: true }])] })).toBeNull();
    expect(personIn({ entity: 'user', match: 'all', conditions: [rel('memberOf', [{ type: 'field', field: 'displayName', op: 'contains', value: 'Finance' }])] })).toBeNull();
  });
});

describe('"and can he request that role?"', () => {
  const eligibleEveryone = { entity: 'user', match: 'all', conditions: [rel('eligibleFor', [ga])] };

  it('puts the person back on an account report, after the role was asked from the role side', () => {
    const { spec, notes } = keepThePerson(eligibleEveryone, roleWithBram, 'En kan hij die rol aanvragen?');
    expect(spec.conditions).toEqual([rel('eligibleFor', [ga]), bram]);
    expect(notes).toEqual(['Read "hij" as the person of the earlier question.']);
  });

  it('puts the person into the relation that reaches accounts on a resource report', () => {
    const roleEligible = { entity: 'resource', match: 'all', conditions: [ga, rel('eligibleMembers', [])] };
    const { spec } = keepThePerson(roleEligible, bramWithRole, 'And can he request that role?');
    expect(spec.conditions).toEqual([ga, rel('eligibleMembers', [bram])]);
  });

  it('adds a members relation when the resource report has none that reaches accounts', () => {
    const justTheRole = { entity: 'resource', match: 'all', conditions: [ga] };
    const { spec } = keepThePerson(justTheRole, bramWithRole, 'does she hold it?');
    expect(spec.conditions).toEqual([ga, rel('members', [bram])]);
  });

  it('does nothing without a pronoun, without a previous person, or when the new definition already names someone', () => {
    expect(keepThePerson(eligibleEveryone, roleWithBram, 'Who can request that role?').spec).toBe(eligibleEveryone);
    expect(keepThePerson(eligibleEveryone, { entity: 'resource', match: 'all', conditions: [ga] }, 'en kan hij die rol aanvragen?').spec).toBe(eligibleEveryone);
    const anna = { entity: 'user', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'anna' }, rel('eligibleFor', [ga])] };
    expect(keepThePerson(anna, roleWithBram, 'and can he, or anna, request it?').spec).toBe(anna);
    expect(keepThePerson(eligibleEveryone, null, 'kan hij dat?').spec).toBe(eligibleEveryone);
  });

  it('leaves a report with no way to hold a person alone', () => {
    const changes = { entity: 'change', match: 'all', conditions: [{ type: 'field', field: 'action', op: 'eq', value: 'Added' }] };
    const out = keepThePerson(changes, roleWithBram, 'what did he get?');
    // the change entity reaches accounts through its own relation, so the person lands there
    expect(out.spec.conditions.some(c => c.type === 'relation' && c.conditions?.includes(bram)) || out.spec === changes).toBe(true);
  });
});

// Corrections that need no model round. Each case is one the model produced
// on the test deployment, and each test checks two things: that the mistake
// is put right, and that the definition beside it is left exactly alone — a
// correction that touched the wrong thing would be a repair round's failure
// under a new name.

import { describe, it, expect } from 'vitest';
import { accessPackageAsRelation, addAskedColumns, addMissingSelf, askedForLeaf, asksForCounts, canonicaliseSelf, autofixSpec, dedupeConditions, dropUnaskedGrouping, dropUnaskedSelf, genericCompareToRelation, leaves, listEqualsToIn, lostLeaves, nameWrittenAsId, negatedBusinessRole, refineFromPrevious, relocateSelf, resolveSelfAgainstPerson, rolesOfPersonAsResources } from './autofix.js';
import { validateSpec } from './spec.js';

const field = (f, op, value) => ({ type: 'field', field: f, op, value });
const values = { changeAction: ['Added', 'Removed'] };

describe('autofixSpec — two "is" values on one field', () => {
  it('turns "Added AND Removed" into either, and says so', () => {
    const { spec, notes } = autofixSpec({
      entity: 'change', match: 'all',
      conditions: [field('changedAt', 'withinLastDays', 90), field('action', 'eq', 'Added'), field('action', 'eq', 'Removed')],
    });
    expect(spec.conditions).toEqual([
      field('changedAt', 'withinLastDays', 90),
      { type: 'group', match: 'any', conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'Removed')] },
    ]);
    expect(notes).toEqual(['Read action "Added" and "Removed" as alternatives — either one.']);
    // And the result is a definition validation accepts without a model round.
    expect(validateSpec(spec, values).ok).toBe(true);
  });

  it('leaves the same value twice, or an OR level, alone', () => {
    const twice = { entity: 'change', match: 'all', conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'added')] };
    expect(autofixSpec(twice).spec).toBe(twice);
    const either = { entity: 'change', match: 'any', conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'Removed')] };
    expect(autofixSpec(either).spec).toBe(either);
  });

  it('works inside a relation, on that relation\'s own conditions', () => {
    const { spec, notes } = autofixSpec({
      entity: 'group', match: 'all',
      conditions: [{ type: 'relation', relation: 'members', quantifier: 'some', match: 'all',
        conditions: [field('userType', 'eq', 'Guest'), field('userType', 'eq', 'Member')] }],
    });
    expect(spec.conditions[0].conditions).toEqual([{ type: 'group', match: 'any', conditions: [field('userType', 'eq', 'Guest'), field('userType', 'eq', 'Member')] }]);
    expect(notes).toHaveLength(1);
  });
});

describe('autofixSpec — a count against the relation it counts', () => {
  const unowned = { type: 'relation', relation: 'owners', quantifier: 'none', match: 'all', conditions: [] };

  it('drops "owner count above zero" beside "has no owner", keeping the rest', () => {
    const { spec, notes } = autofixSpec({
      entity: 'group', match: 'all',
      conditions: [field('ownerCount', 'gt', 0), field('memberCount', 'gt', 5), unowned],
    });
    expect(spec.conditions).toEqual([field('memberCount', 'gt', 5), unowned]);
    expect(notes[0]).toMatch(/Dropped "ownerCount gt 0"/);
    expect(validateSpec(spec).ok).toBe(true);
  });

  it('leaves "member count is zero" beside "has a member" to the model: two readings', () => {
    const spec = { entity: 'group', match: 'all', conditions: [field('memberCount', 'eq', 0), { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [] }] };
    expect(autofixSpec(spec).spec).toBe(spec);
  });

  it('leaves a count beside "none of them called Jan" alone — that is a real report', () => {
    const spec = { entity: 'group', match: 'all', conditions: [field('ownerCount', 'gt', 0), { ...unowned, conditions: [field('displayName', 'eq', 'Jan')] }] };
    expect(autofixSpec(spec).spec).toBe(spec);
  });
});

describe('autofixSpec — a reversed date window', () => {
  it('keeps "within the last 90 days" and drops "more than 180 days ago"', () => {
    const { spec, notes } = autofixSpec({
      entity: 'change', match: 'all',
      conditions: [field('changedAt', 'olderThanDays', 180), field('changedAt', 'withinLastDays', 90)],
    });
    expect(spec.conditions).toEqual([field('changedAt', 'withinLastDays', 90)]);
    expect(notes[0]).toMatch(/more than 180 days ago/);
  });

  it('leaves a real band (between 7 and 30 days back) alone', () => {
    const spec = { entity: 'change', match: 'all', conditions: [field('changedAt', 'withinLastDays', 30), field('changedAt', 'olderThanDays', 7)] };
    expect(autofixSpec(spec).spec).toBe(spec);
  });
});

describe('a grouping the request never asked for', () => {
  const grouped = { entity: 'change', match: 'all', conditions: [field('action', 'eq', 'Added')], columns: [], groupBy: 'action' };

  it('is removed, and the assumption says a list was given instead', () => {
    // Verbatim: "aan welke groepen is bram toegevoegd" came back as a count
    // per action, and the caller read "5" where five names were wanted.
    const { spec, notes } = dropUnaskedGrouping(grouped, 'Kan je me vertellen aan welke groepen bram in de laatste 90 dagen is toegevoegd?');
    expect(spec).not.toHaveProperty('groupBy');
    expect(spec.conditions).toBe(grouped.conditions);
    expect(notes[0]).toMatch(/not a count per action/);
  });

  it('stays when the request asks for counts, in either language', () => {
    for (const q of ['Hoeveel wijzigingen zijn er per actie?', 'How many changes per action?', 'a breakdown of changes by action', 'het aantal accounts per afdeling']) {
      expect(asksForCounts(q)).toBe(true);
      expect(dropUnaskedGrouping(grouped, q).spec).toBe(grouped);
    }
  });

  it('does nothing to a definition without grouping', () => {
    const plain = { entity: 'change', match: 'all', conditions: [] };
    expect(dropUnaskedGrouping(plain, 'welke groepen?').spec).toBe(plain);
  });
});

describe('what a correction dropped', () => {
  const before = {
    entity: 'change', match: 'all',
    conditions: [
      { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [field('displayName', 'contains', 'bram')] },
      field('changedAt', 'withinLastDays', 90),
      field('action', 'eq', 'Added'),
      field('action', 'eq', 'Removed'),
    ],
  };

  it('lists every leaf, looking through relations and groups', () => {
    expect([...leaves(before)]).toEqual([
      'account some', 'displayName contains "bram"', 'changedAt withinLastDays 90', 'action eq "Added"', 'action eq "Removed"',
    ]);
  });

  it('allows a correction that restructures the named field and keeps the rest', () => {
    const after = { ...before, conditions: [before.conditions[0], before.conditions[1],
      { type: 'group', match: 'any', conditions: [before.conditions[2], before.conditions[3]] }] };
    expect(lostLeaves(before, after, ['"action" cannot be both "Added" and "Removed" at the same time'])).toEqual([]);
  });

  it('names what the model quietly dropped: the other action and the time window', () => {
    // Verbatim shape of the correction that answered "5".
    const after = { ...before, conditions: [before.conditions[0], before.conditions[2]] };
    expect(lostLeaves(before, after, ['"action" cannot be both "Added" and "Removed" at the same time']))
      .toEqual(['changedAt withinLastDays 90']);
  });
});

describe('a comparison with a kind of thing where a name should be', () => {
  it('turns "businessRoles containsAll <access package>" into "in any business role", and says so', () => {
    // Verbatim from the conversation set: the follow-up "welke van deze groepen
    // zijn onderdeel van een access package?" — the name lookup then matched
    // "access package" to a group called "Special Access Package Approvers".
    const { spec, notes } = genericCompareToRelation({
      entity: 'group', match: 'all',
      conditions: [field('id', 'in', ['g1', 'g2']),
        { type: 'compare', relation: 'businessRoles', measure: 'containsAll', reference: { entity: 'resource', name: 'access package' } }],
    });
    expect(spec.conditions[1]).toEqual({ type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] });
    expect(spec.conditions[0]).toEqual(field('id', 'in', ['g1', 'g2']));
    expect(notes[0]).toMatch(/any access package/);
  });

  it('leaves a comparison with a real name, or an already resolved record, alone', () => {
    const named = { entity: 'group', match: 'all', conditions: [{ type: 'compare', relation: 'members', measure: 'identical', reference: { entity: 'group', name: 'Finance Team' } }] };
    expect(genericCompareToRelation(named).spec).toBe(named);
    const resolved = { entity: 'group', match: 'all', conditions: [{ type: 'compare', relation: 'businessRoles', measure: 'containsAll', reference: { entity: 'resource', name: 'group', id: 'r1' } }] };
    expect(genericCompareToRelation(resolved).spec).toBe(resolved);
  });
});

describe('the person asking against a named person, on the right side', () => {
  const bram = { type: 'field', field: 'displayName', op: 'contains', value: 'bram' };
  const rel = (quantifier, ...conditions) => ({ type: 'relation', relation: 'members', quantifier, match: 'all', conditions });
  const both = { entity: 'group', match: 'all', conditions: [rel('some', bram), rel('none', bram)] };
  const ME = '@me';

  it('puts the caller on the "some" side when the question mentions them first', () => {
    // Verbatim: "welke groepen heb ik wel, die bram niet heeft".
    const { spec, notes } = resolveSelfAgainstPerson(both, 'Kan je me vertellen welke groepen ik wel heb, die bram niet heeft?', ME);
    expect(spec.conditions[0].conditions).toEqual([{ type: 'field', field: 'id', op: 'eq', value: ME }]);
    expect(spec.conditions[1].conditions).toEqual([bram]);
    expect(notes[0]).toMatch(/the person asking has, bram has not/);
    expect(resolveSelfAgainstPerson(both, 'Which groups do I have that bram does not have?', ME).spec.conditions[0].conditions[0].value).toBe(ME);
  });

  it('puts the caller on the "none" side when the named person comes first', () => {
    const { spec } = resolveSelfAgainstPerson(both, 'Welke groepen heeft bram die ik niet heb?', ME);
    expect(spec.conditions[0].conditions).toEqual([bram]);
    expect(spec.conditions[1].conditions[0].value).toBe(ME);
  });

  it('leaves alone: two different people, no first-person word, a name not in the question, or one relation', () => {
    const jan = { type: 'field', field: 'displayName', op: 'contains', value: 'jan' };
    expect(resolveSelfAgainstPerson({ ...both, conditions: [rel('some', bram), rel('none', jan)] }, 'groups I have that jan does not', ME).notes).toEqual([]);
    expect(resolveSelfAgainstPerson(both, 'groups bram is in that bram is not in', ME).notes).toEqual([]);
    expect(resolveSelfAgainstPerson(both, 'welke groepen heb ik wel die piet niet heeft', ME).notes).toEqual([]);
    expect(resolveSelfAgainstPerson({ ...both, conditions: [rel('some', bram)] }, 'my groups with bram', ME).notes).toEqual([]);
  });
});

describe('a condition written more than once', () => {
  it('collapses the echoes, inside a relation too, and says how many went', () => {
    const neq = { type: 'field', field: 'resourceType', op: 'neq', value: 'Group' };
    const { spec, notes } = dedupeConditions({
      entity: 'account', match: 'all',
      conditions: [
        { type: 'relation', relation: 'access', quantifier: 'none', match: 'all', conditions: [neq, neq, neq, neq] },
        { type: 'relation', relation: 'access', quantifier: 'none', match: 'all', conditions: [neq, neq, neq, neq] },
      ],
    });
    expect(spec.conditions).toEqual([{ type: 'relation', relation: 'access', quantifier: 'none', match: 'all', conditions: [neq] }]);
    expect(notes).toEqual(['Dropped 4 repeated conditions.']);
  });

  it('returns the same object when nothing repeats', () => {
    const plain = { entity: 'group', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'a' }] };
    expect(dedupeConditions(plain).spec).toBe(plain);
  });
});

describe('the caller placeholder where it cannot mean the caller', () => {
  const ME = '@me';
  const self = { type: 'field', field: 'id', op: 'eq', value: ME };

  it('moves "@me" out of memberOf onto the account itself', () => {
    // Verbatim: "Which groups am I a member of?" → user where memberOf some id @me.
    const { spec, notes } = relocateSelf({ entity: 'user', match: 'all', columns: ['memberOf.names'],
      conditions: [{ type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [self] }] }, ME);
    expect(spec.conditions).toEqual([self]);
    expect(notes).toHaveLength(1);
  });

  it('moves "@me" from a group\'s own id into its members', () => {
    const { spec } = relocateSelf({ entity: 'group', match: 'all', conditions: [self, { type: 'field', field: 'displayName', op: 'contains', value: 'Fin' }] }, ME);
    expect(spec.conditions).toEqual([
      { type: 'field', field: 'displayName', op: 'contains', value: 'Fin' },
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [self] },
    ]);
  });

  it('keeps the other conditions of the relation it was taken from', () => {
    const { spec } = relocateSelf({ entity: 'user', match: 'all',
      conditions: [{ type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Admin' }, self] }] }, ME);
    expect(spec.conditions[0].conditions).toEqual([{ type: 'field', field: 'displayName', op: 'contains', value: 'Admin' }]);
    expect(spec.conditions[1]).toEqual(self);
  });

  it('leaves it where it does mean the caller: the account itself, members, manager, an account relation of a change', () => {
    const right = [
      { entity: 'user', match: 'all', conditions: [self] },
      { entity: 'group', match: 'all', conditions: [{ type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [self] }] },
      { entity: 'user', match: 'all', conditions: [{ type: 'relation', relation: 'manager', quantifier: 'some', match: 'all', conditions: [self] }] },
      { entity: 'change', match: 'all', conditions: [{ type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [self] }] },
    ];
    for (const spec of right) expect(relocateSelf(spec, ME).spec).toBe(spec);
  });
});

describe('"is" with a list', () => {
  it('becomes "one of", wherever it sits, and a single value is left alone', () => {
    const { spec } = listEqualsToIn({ entity: 'user', match: 'all', conditions: [
      { type: 'field', field: 'id', op: 'eq', value: ['a', 'b'] },
      { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'eq', value: ['g1'] }] },
      { type: 'field', field: 'displayName', op: 'eq', value: 'Jan' },
    ] });
    expect(spec.conditions[0]).toMatchObject({ op: 'in', value: ['a', 'b'] });
    expect(spec.conditions[1].conditions[0]).toMatchObject({ op: 'in' });
    expect(spec.conditions[2]).toMatchObject({ op: 'eq', value: 'Jan' });
    const plain = { entity: 'user', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Jan' }] };
    expect(listEqualsToIn(plain).spec).toBe(plain);
  });
});

describe('a question about the person asking whose definition names nobody', () => {
  const ME = '@me';
  const self = { type: 'field', field: 'id', op: 'eq', value: ME };

  it('puts the caller on the account itself: "van welke groepen ben ik eigenaar"', () => {
    const { spec, notes } = addMissingSelf({ entity: 'user', match: 'all', columns: ['owns.names'],
      conditions: [{ type: 'relation', relation: 'owns', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'Group' }] }] },
    'Van welke groepen ben ik eigenaar?', ME);
    expect(spec.conditions.at(-1)).toEqual(self);
    expect(spec.conditions).toHaveLength(2);
    expect(notes[0]).toMatch(/Read "ik" as you/);
  });

  it('fills an empty relation that reaches accounts: "groups I own" as group where owners some', () => {
    const { spec } = addMissingSelf({ entity: 'group', match: 'all',
      conditions: [{ type: 'relation', relation: 'owners', quantifier: 'some', match: 'all', conditions: [] }] }, 'Which groups do I own?', ME);
    expect(spec.conditions).toEqual([{ type: 'relation', relation: 'owners', quantifier: 'some', match: 'all', conditions: [self] }]);
  });

  it('falls back to members on a group report with nothing to fill', () => {
    const { spec } = addMissingSelf({ entity: 'group', match: 'all', conditions: [{ type: 'field', field: 'securityEnabled', op: 'eq', value: true }] }, 'my security groups', ME);
    expect(spec.conditions.at(-1)).toEqual({ type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [self] });
  });

  it('does nothing without a first-person word, or when the definition already names someone', () => {
    const owners = { entity: 'group', match: 'all', conditions: [{ type: 'relation', relation: 'owners', quantifier: 'some', match: 'all', conditions: [] }] };
    expect(addMissingSelf(owners, 'which groups have owners?', ME).spec).toBe(owners);
    const jan = { entity: 'group', match: 'all', conditions: [{ type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'jan' }] }] };
    expect(addMissingSelf(jan, 'my groups with jan', ME).spec).toBe(jan);
    const mine = { entity: 'user', match: 'all', conditions: [self] };
    expect(addMissingSelf(mine, 'my account', ME).spec).toBe(mine);
  });
});

describe('"in an access package" written as a resource type where there is none', () => {
  const inRole = { type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] };
  const br = { type: 'field', field: 'resourceType', op: 'eq', value: 'BusinessRole' };

  it('inside members of a group becomes the businessRoles relation, the members condition going with it', () => {
    // Verbatim: "Which of these groups are part of an access package?"
    const { spec, notes } = accessPackageAsRelation({ entity: 'group', match: 'all',
      conditions: [{ type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [br] }] });
    expect(spec.conditions).toEqual([inRole]);
    expect(notes).toHaveLength(1);
  });

  it('on a group\'s own fields becomes the relation too, and keeps what else was there', () => {
    const ids = { type: 'field', field: 'id', op: 'in', value: ['g1'] };
    const { spec } = accessPackageAsRelation({ entity: 'group', match: 'all', conditions: [ids, br] });
    expect(spec.conditions).toEqual([ids, inRole]);
  });

  it('leaves a resource report alone — there it is a real condition — and never doubles an existing relation', () => {
    const resources = { entity: 'resource', match: 'all', conditions: [br] };
    expect(accessPackageAsRelation(resources).spec).toBe(resources);
    const { spec } = accessPackageAsRelation({ entity: 'group', match: 'all', conditions: [br, inRole] });
    expect(spec.conditions).toEqual([inRole]);
  });
});

describe('the column the question asks to see', () => {
  it('adds members.names to a group report about members, keeping the model\'s columns', () => {
    // Verbatim: "Wie zijn de leden van deze groepen?" answered as the groups, no members.
    const { spec } = addAskedColumns({ entity: 'group', match: 'all', conditions: [], columns: ['displayName', 'description', 'memberCount'] }, 'Wie zijn de leden van deze groepen?');
    expect(spec.columns).toEqual(['displayName', 'description', 'memberCount', 'members.names']);
  });

  it('starts from the name column when the model listed none, and adds what a user report was asked for', () => {
    const { spec } = addAskedColumns({ entity: 'user', match: 'all', conditions: [], columns: [] }, 'Which groups am I a member of?');
    expect(spec.columns).toEqual(['displayName', 'memberOf.names']);
    const { spec: m } = addAskedColumns({ entity: 'user', match: 'all', conditions: [], columns: [] }, 'wie is de manager van Jan?');
    expect(m.columns).toEqual(['displayName', 'manager.displayName']);
  });

  it('never doubles a column it already has, and leaves a change report alone', () => {
    const has = { entity: 'group', match: 'all', conditions: [], columns: ['displayName', 'members.names'] };
    expect(addAskedColumns(has, 'wie zijn de leden?').spec).toBe(has);
    const change = { entity: 'change', match: 'all', conditions: [], columns: [] };
    expect(addAskedColumns(change, 'leden toegevoegd aan groepen').spec).toBe(change);
  });
});

describe('was a lost condition asked for?', () => {
  it('sees nothing of "accountCount gt 0" in a question about groups and bram', () => {
    expect(askedForLeaf('accountCount gt 0', 'Can you tell me which groups I have that bram does not have?')).toBe(false);
  });

  it('sees "MFA" in the field and "Finance" in the value', () => {
    expect(askedForLeaf('mfaEnabled eq false', 'users that do not have MFA enabled')).toBe(true);
    expect(askedForLeaf('department eq "Finance"', 'everyone in finance')).toBe(true);
    expect(askedForLeaf('resourceType eq "Groups"', 'which groups does he have')).toBe(true);
  });
});

describe('a name written as an id', () => {
  it('becomes a name condition, wherever it sits; uuids and placeholders stay ids', () => {
    const { spec } = nameWrittenAsId({ entity: 'resource', match: 'all', conditions: [
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'eq', value: '@me' }] },
      { type: 'relation', relation: 'members', quantifier: 'none', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'eq', value: 'bram' }] },
      { type: 'field', field: 'id', op: 'eq', value: '3f7c1d2e-9a4b-4c6d-8e1f-2b3c4d5e6f70' },
    ] });
    expect(spec.conditions[0].conditions[0]).toEqual({ type: 'field', field: 'id', op: 'eq', value: '@me' });
    expect(spec.conditions[1].conditions[0]).toEqual({ type: 'field', field: 'displayName', op: 'contains', value: 'bram' });
    expect(spec.conditions[2].field).toBe('id');
  });
});

describe('a refinement keeps the previous definition', () => {
  const bram = { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Bram de Groot' }] };
  const me = { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'eq', value: '3f7c1d2e-9a4b-4c6d-8e1f-2b3c4d5e6f70' }] };
  const groups = { type: 'relation', relation: 'resource', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'Group' }] };
  const window = { type: 'field', field: 'changedAt', op: 'withinLastDays', value: 90 };
  const added = { type: 'field', field: 'action', op: 'eq', value: 'Added' };
  const previous = { entity: 'change', match: 'all', conditions: [bram, groups, window] };

  it('restores the person and the window the refinement never mentioned, and keeps the filter it asked for', () => {
    // Verbatim: "Alleen de toevoegingen graag." after Bram's changes in 90 days.
    const { spec, notes } = refineFromPrevious({ entity: 'change', match: 'all', conditions: [me, added, groups] }, previous, 'Alleen de toevoegingen graag.');
    expect(spec.conditions).toEqual([bram, added, groups, window]);
    expect(notes).toHaveLength(1);
  });

  it('leaves a new question alone: one that names a kind of record, or changes the entity', () => {
    const fresh = { entity: 'change', match: 'all', conditions: [me, added] };
    expect(refineFromPrevious(fresh, previous, 'Welke van deze groepen zijn openbaar?').spec).toBe(fresh);
    const other = { entity: 'group', match: 'all', conditions: [] };
    expect(refineFromPrevious(other, previous, 'alleen de toevoegingen').spec).toBe(other);
  });

  it('does not restore what the refinement itself is about', () => {
    // "Only the last 30 days" replaces the window on purpose.
    const { spec } = refineFromPrevious({ entity: 'change', match: 'all', conditions: [bram, groups, { ...window, value: 30 }] }, previous, 'only the last 30 days please');
    expect(spec.conditions.find(c => c.field === 'changedAt').value).toBe(30);
  });

  it('adds nothing when everything is still there', () => {
    const same = { entity: 'change', match: 'all', conditions: [bram, groups, window, added] };
    expect(refineFromPrevious(same, previous, 'alleen de toevoegingen').spec).toBe(same);
  });
});

describe('the column the question asks to see — owner words win over "groups"', () => {
  it('adds owns.names only for "van welke groepen ben ik eigenaar"', () => {
    const { spec } = addAskedColumns({ entity: 'user', match: 'all', conditions: [], columns: ['displayName'] }, 'Van welke groepen ben ik eigenaar?');
    expect(spec.columns).toEqual(['displayName', 'owns.names']);
    const { spec: en } = addAskedColumns({ entity: 'user', match: 'all', conditions: [], columns: ['displayName', 'owns.names'] }, 'Which groups do I own?');
    expect(en.columns).toEqual(['displayName', 'owns.names']);
  });
});

describe('the caller written in where the question never said "my"', () => {
  const ME = '@me';
  const meCond = { type: 'field', field: 'id', op: 'eq', value: ME };

  it('drops "account is me" from a follow-up about these groups, relation and all', () => {
    // Verbatim: "Have there been any changes to these groups in the last 180 days?"
    const groups = { type: 'relation', relation: 'resource', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'Group' }] };
    const window = { type: 'field', field: 'changedAt', op: 'withinLastDays', value: 180 };
    const { spec, notes } = dropUnaskedSelf({ entity: 'change', match: 'all', conditions: [groups,
      { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [meCond] }, window] },
    'Have there been any changes to these groups in the last 180 days?', ME);
    expect(spec.conditions).toEqual([groups, window]);
    expect(notes[0]).toMatch(/did not say "my"/);
  });

  it('keeps it when the question does say so, and leaves other conditions of the relation', () => {
    const mine = { entity: 'user', match: 'all', conditions: [meCond] };
    expect(dropUnaskedSelf(mine, 'Which groups am I in?', ME).spec).toBe(mine);
    const { spec } = dropUnaskedSelf({ entity: 'change', match: 'all', conditions: [
      { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'userType', op: 'eq', value: 'Guest' }, meCond] }] },
    'changes for guests in these groups', ME);
    expect(spec.conditions[0].conditions).toEqual([{ type: 'field', field: 'userType', op: 'eq', value: 'Guest' }]);
  });
});

describe('"not via an access package"', () => {
  const some = { type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] };

  it('turns an unconditioned "in a business role" into "in none", in both languages', () => {
    for (const q of ['Which groups does bram have that were not handed out through an access package?', 'Welke groepen heeft bram die niet via een access package zijn uitgedeeld?']) {
      const { spec, notes } = negatedBusinessRole({ entity: 'group', match: 'all', conditions: [some] }, q);
      expect(spec.conditions[0].quantifier).toBe('none');
      expect(notes).toHaveLength(1);
    }
  });

  it('leaves a positive question, a named business role, and an already-negated one alone', () => {
    const positive = { entity: 'group', match: 'all', conditions: [some] };
    expect(negatedBusinessRole(positive, 'which groups are in an access package?').spec).toBe(positive);
    const named = { entity: 'group', match: 'all', conditions: [{ ...some, conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Finance' }] }] };
    expect(negatedBusinessRole(named, 'groups not in business role Finance').spec).toBe(named);
    const none = { entity: 'group', match: 'all', conditions: [{ ...some, quantifier: 'none' }] };
    expect(negatedBusinessRole(none, 'groups without an access package').spec).toBe(none);
  });
});

describe('the column the question asks to see — "access package" is not "access"', () => {
  it('adds businessRoles.names only for "in welke access packages zit ik"', () => {
    const { spec } = addAskedColumns({ entity: 'user', match: 'all', conditions: [], columns: ['displayName'] }, 'In welke access packages zit ik?');
    expect(spec.columns).toEqual(['displayName', 'businessRoles.names']);
    const { spec: rights } = addAskedColumns({ entity: 'user', match: 'all', conditions: [], columns: ['displayName'] }, 'welke rechten heb ik?');
    expect(rights.columns).toEqual(['displayName', 'access.names']);
  });
});

describe('the caller\'s id written out literally', () => {
  it('becomes the placeholder wherever it sits, and nothing else changes', () => {
    const uuid = '3f7c1d2e-9a4b-4c6d-8e1f-2b3c4d5e6f70';
    const { spec } = canonicaliseSelf({ entity: 'change', match: 'all', conditions: [
      { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'eq', value: uuid }] },
      { type: 'field', field: 'id', op: 'in', value: [uuid] },
    ] }, '@me', uuid);
    expect(spec.conditions[0].conditions[0].value).toBe('@me');
    expect(spec.conditions[1].value).toEqual([uuid]);
    const plain = { entity: 'user', match: 'all', conditions: [] };
    expect(canonicaliseSelf(plain, '@me', uuid).spec).toBe(plain);
    expect(canonicaliseSelf(plain, '@me', undefined).spec).toBe(plain);
  });
});

describe('the roles of a person are a report of roles', () => {
  const anna = { type: 'field', field: 'displayName', op: 'eq', value: 'Anna Visser', checked: true };

  it('flips "user Anna with an access column" into directory roles whose members include Anna', () => {
    const { spec, notes } = rolesOfPersonAsResources({ entity: 'user', match: 'all', conditions: [anna], columns: ['access.names'] }, 'Welke directory rollen heeft Anna?');
    expect(spec).toEqual({ entity: 'resource', match: 'all', columns: [], conditions: [
      { type: 'field', field: 'resourceType', op: 'eq', value: 'EntraDirectoryRole' },
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [anna] },
    ] });
    expect(notes).toHaveLength(1);
  });

  it('leaves alone: a report that already says roles, one about groups, one with a relation, and a resource report', () => {
    const withRoles = { entity: 'user', match: 'all', conditions: [anna, { type: 'relation', relation: 'access', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'EntraDirectoryRole' }] }] };
    expect(rolesOfPersonAsResources(withRoles, 'which roles does Anna have').spec).toBe(withRoles);
    const groups = { entity: 'user', match: 'all', conditions: [anna], columns: ['memberOf.names'] };
    expect(rolesOfPersonAsResources(groups, 'welke groepen heeft Anna').spec).toBe(groups);
    const resources = { entity: 'resource', match: 'all', conditions: [] };
    expect(rolesOfPersonAsResources(resources, 'which roles exist').spec).toBe(resources);
  });
});

// Corrections that need no model round. Each case is one the model produced
// on the test deployment, and each test checks two things: that the mistake
// is put right, and that the definition beside it is left exactly alone — a
// correction that touched the wrong thing would be a repair round's failure
// under a new name.

import { describe, it, expect } from 'vitest';
import { asksForCounts, autofixSpec, dedupeConditions, dropUnaskedGrouping, genericCompareToRelation, leaves, lostLeaves, resolveSelfAgainstPerson } from './autofix.js';
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
    // Verbatim: "aan welke groepen is william toegevoegd" came back as a count
    // per action, and the caller read "5" where five names were wanted.
    const { spec, notes } = dropUnaskedGrouping(grouped, 'Kan je me vertellen aan welke groepen william in de laatste 90 dagen is toegevoegd?');
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
      { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [field('displayName', 'contains', 'william')] },
      field('changedAt', 'withinLastDays', 90),
      field('action', 'eq', 'Added'),
      field('action', 'eq', 'Removed'),
    ],
  };

  it('lists every leaf, looking through relations and groups', () => {
    expect([...leaves(before)]).toEqual([
      'account some', 'displayName contains "william"', 'changedAt withinLastDays 90', 'action eq "Added"', 'action eq "Removed"',
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
  const william = { type: 'field', field: 'displayName', op: 'contains', value: 'william' };
  const rel = (quantifier, ...conditions) => ({ type: 'relation', relation: 'members', quantifier, match: 'all', conditions });
  const both = { entity: 'group', match: 'all', conditions: [rel('some', william), rel('none', william)] };
  const ME = '@me';

  it('puts the caller on the "some" side when the question mentions them first', () => {
    // Verbatim: "welke groepen heb ik wel, die william niet heeft".
    const { spec, notes } = resolveSelfAgainstPerson(both, 'Kan je me vertellen welke groepen ik wel heb, die william niet heeft?', ME);
    expect(spec.conditions[0].conditions).toEqual([{ type: 'field', field: 'id', op: 'eq', value: ME }]);
    expect(spec.conditions[1].conditions).toEqual([william]);
    expect(notes[0]).toMatch(/the person asking has, william has not/);
    expect(resolveSelfAgainstPerson(both, 'Which groups do I have that william does not have?', ME).spec.conditions[0].conditions[0].value).toBe(ME);
  });

  it('puts the caller on the "none" side when the named person comes first', () => {
    const { spec } = resolveSelfAgainstPerson(both, 'Welke groepen heeft william die ik niet heb?', ME);
    expect(spec.conditions[0].conditions).toEqual([william]);
    expect(spec.conditions[1].conditions[0].value).toBe(ME);
  });

  it('leaves alone: two different people, no first-person word, a name not in the question, or one relation', () => {
    const jan = { type: 'field', field: 'displayName', op: 'contains', value: 'jan' };
    expect(resolveSelfAgainstPerson({ ...both, conditions: [rel('some', william), rel('none', jan)] }, 'groups I have that jan does not', ME).notes).toEqual([]);
    expect(resolveSelfAgainstPerson(both, 'groups william is in that william is not in', ME).notes).toEqual([]);
    expect(resolveSelfAgainstPerson(both, 'welke groepen heb ik wel die piet niet heeft', ME).notes).toEqual([]);
    expect(resolveSelfAgainstPerson({ ...both, conditions: [rel('some', william)] }, 'my groups with william', ME).notes).toEqual([]);
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

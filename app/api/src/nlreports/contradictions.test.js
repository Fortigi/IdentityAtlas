// Definitions that cannot match anything.
//
// The case this exists for, in full. Asked "Kan je me vertellen of Bram in
// de laatste 180 dagen nog aan groepen toegevoegd is of uit groepen is weg
// gehaald?", the model produced `Action is "Added"` AND `Action is "Removed"`,
// and the bot answered "Hier voldoet niets aan" — for an account with ten
// changes in that window. The SQL was correct; it faithfully asked an
// impossible question, and an impossible question's empty answer is
// indistinguishable from a true one.
//
// The other half of these tests matter just as much: a definition that only
// LOOKS contradictory must be left alone, because rejecting a satisfiable
// report costs the caller a repair round and possibly a worse definition.

import { describe, it, expect } from 'vitest';
import { contradictions } from './contradictions.js';
import { validateSpec } from './spec.js';

const field = (f, op, value) => ({ type: 'field', field: f, op, value });

describe('contradictions', () => {
  it('catches two different values required of one field at once', () => {
    const [message] = contradictions({
      match: 'all',
      conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'Removed')],
    });
    expect(message).toContain('action');
    // The message has to say what to do instead — it is fed straight back to
    // the model as the repair instruction.
    expect(message).toContain('any');
  });

  it('says nothing when either value will do', () => {
    // The corrected form of the same question. If this ever reports a
    // conflict, the repair round would loop.
    expect(contradictions({
      match: 'all',
      conditions: [{
        type: 'group', match: 'any',
        conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'Removed')],
      }],
    })).toEqual([]);
  });

  it('ignores alternatives at the top level when the report itself is an OR', () => {
    expect(contradictions({
      match: 'any',
      conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'Removed')],
    })).toEqual([]);
  });

  it('leaves two conditions on DIFFERENT fields alone', () => {
    expect(contradictions({
      match: 'all',
      conditions: [field('action', 'eq', 'Added'), field('assignmentType', 'eq', 'Direct')],
    })).toEqual([]);
  });

  it('catches is and is-not of the same value, and allows a different one', () => {
    expect(contradictions({
      match: 'all', conditions: [field('action', 'eq', 'Added'), field('action', 'neq', 'Added')],
    })).toHaveLength(1);
    expect(contradictions({
      match: 'all', conditions: [field('action', 'eq', 'Added'), field('action', 'neq', 'Removed')],
    })).toEqual([]);
  });

  it('compares values without caring about case', () => {
    // The model writes "added" as often as "Added", and validation may have
    // canonicalised only one of them.
    expect(contradictions({
      match: 'all', conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'added')],
    })).toEqual([]);
  });

  it('catches empty and not empty at once', () => {
    expect(contradictions({
      match: 'all',
      conditions: [field('email', 'isEmpty', null), field('email', 'isNotEmpty', null)],
    })).toHaveLength(1);
  });

  it('allows a real date window and rejects an impossible one', () => {
    // "within the last 30 days AND more than 7 days ago" is the band between 7
    // and 30 days back — a report someone might genuinely want. Reversing the
    // bounds makes it empty. The boundary case (equal) is empty too.
    expect(contradictions({
      match: 'all',
      conditions: [field('changedAt', 'withinLastDays', 30), field('changedAt', 'olderThanDays', 7)],
    })).toEqual([]);
    expect(contradictions({
      match: 'all',
      conditions: [field('changedAt', 'withinLastDays', 7), field('changedAt', 'olderThanDays', 30)],
    })).toHaveLength(1);
    expect(contradictions({
      match: 'all',
      conditions: [field('changedAt', 'withinLastDays', 30), field('changedAt', 'olderThanDays', 30)],
    })).toHaveLength(1);
  });

  it('finds a conflict whichever order the conditions are written in', () => {
    const a = contradictions({ match: 'all', conditions: [field('e', 'isEmpty'), field('e', 'isNotEmpty')] });
    const b = contradictions({ match: 'all', conditions: [field('e', 'isNotEmpty'), field('e', 'isEmpty')] });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('looks inside an ALL group as well as at the top level', () => {
    expect(contradictions({
      match: 'all',
      conditions: [{
        type: 'group', match: 'all',
        conditions: [field('action', 'eq', 'Added'), field('action', 'eq', 'Removed')],
      }],
    })).toHaveLength(1);
  });

  it('checks a relation on its own subject, not against the outer report', () => {
    // "changes on a group called Finance, for an account called Finance" is
    // odd but perfectly possible: the two conditions are about different
    // records. Comparing across the boundary would reject it.
    expect(contradictions({
      match: 'all',
      conditions: [
        field('displayName', 'eq', 'Finance'),
        { type: 'relation', relation: 'account', quantifier: 'some', match: 'all',
          conditions: [field('displayName', 'eq', 'Jan')] },
      ],
    })).toEqual([]);
    // Inside ONE relation, though, the same rule applies.
    expect(contradictions({
      match: 'all',
      conditions: [{
        type: 'relation', relation: 'account', quantifier: 'some', match: 'all',
        conditions: [field('displayName', 'eq', 'Jan'), field('displayName', 'eq', 'Piet')],
      }],
    })).toHaveLength(1);
  });

  it('survives a spec with nothing in it', () => {
    expect(contradictions({ match: 'all', conditions: [] })).toEqual([]);
    expect(contradictions({})).toEqual([]);
    expect(contradictions(null)).toEqual([]);
  });
});

describe('validateSpec refuses an impossible report', () => {
  const values = { changeAction: ['Added', 'Removed'] };

  it('rejects the definition that answered "nothing matches" for an account with ten changes', () => {
    // Verbatim from BotConversations on the test deployment.
    const { ok, errors } = validateSpec({
      entity: 'change',
      match: 'all',
      conditions: [
        { type: 'relation', relation: 'account', quantifier: 'some',
          conditions: [{ field: 'displayName', op: 'contains', value: 'Bram' }] },
        { type: 'field', field: 'changedAt', op: 'olderThanDays', value: 180 },
        { type: 'field', field: 'action', op: 'eq', value: 'Added' },
        { type: 'field', field: 'action', op: 'eq', value: 'Removed' },
      ],
    }, values);

    expect(ok).toBe(false);
    expect(errors.join(' ')).toContain('cannot be both');
  });

  it('accepts the same question asked properly', () => {
    const { ok } = validateSpec({
      entity: 'change',
      match: 'all',
      conditions: [
        { type: 'field', field: 'changedAt', op: 'withinLastDays', value: 180 },
        { type: 'group', match: 'any', conditions: [
          { field: 'action', op: 'eq', value: 'Added' },
          { field: 'action', op: 'eq', value: 'Removed' },
        ] },
      ],
    }, values);
    expect(ok).toBe(true);
  });

  it('reports the conflict only once the fields themselves are valid', () => {
    // A conflict on a field that does not exist would be a confusing second
    // error to hand the model alongside "no such field".
    const { ok, errors } = validateSpec({
      entity: 'change', match: 'all',
      conditions: [
        { type: 'field', field: 'nosuchfield', op: 'eq', value: 'a' },
        { type: 'field', field: 'nosuchfield', op: 'eq', value: 'b' },
      ],
    }, values);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toContain('not a field');
    expect(errors.join(' ')).not.toContain('cannot be both');
  });
});

describe('a count field against the relation it counts', () => {
  // From the held-out evaluation on the test deployment, verbatim: "groups
  // without owners that have more than 5 members" became owner count above
  // zero AND no owner. It ran, returned nothing, and nothing looked like an
  // answer.
  const unowned = { type: 'relation', relation: 'owners', quantifier: 'none', match: 'all', conditions: [] };

  it('rejects "owner count above zero" together with "has no owner"', () => {
    const { ok, errors } = validateSpec({
      entity: 'group', match: 'all',
      conditions: [field('ownerCount', 'gt', 0), field('memberCount', 'gt', 5), unowned],
    });
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    // The message names both halves, so the model knows which pair to fix.
    expect(errors[0]).toContain('ownerCount');
    expect(errors[0]).toContain('owners');
  });

  it('accepts the same question built properly: no owner, member count above 5', () => {
    // memberCount is a count field too, and > 5 says "some"; there is no
    // members relation beside it, so it must not trip on the owners one.
    const { ok, errors } = validateSpec({
      entity: 'group', match: 'all',
      conditions: [unowned, field('memberCount', 'gt', 5)],
    });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('leaves "has owners, none of them called Jan" alone', () => {
    // quantifier none WITH conditions is not "no owners at all".
    expect(contradictions({
      entity: 'resource', match: 'all',
      conditions: [field('ownerCount', 'gt', 0),
        { type: 'relation', relation: 'owners', quantifier: 'none', match: 'all', conditions: [field('displayName', 'eq', 'Jan')] }],
    })).toEqual([]);
  });

  it('rejects "member count is zero" together with "has a member", with or without conditions on the member', () => {
    expect(contradictions({
      entity: 'resource', match: 'all',
      conditions: [field('memberCount', 'eq', 0), { type: 'relation', relation: 'members', quantifier: 'some', conditions: [] }],
    })).toHaveLength(1);
    expect(contradictions({
      entity: 'resource', match: 'all',
      conditions: [field('memberCount', 'eq', 0),
        { type: 'relation', relation: 'members', quantifier: 'some', conditions: [field('displayName', 'eq', 'Jan')] }],
    })).toHaveLength(1);
    // Zero members and no members agree.
    expect(contradictions({
      entity: 'resource', match: 'all',
      conditions: [field('memberCount', 'eq', 0), { type: 'relation', relation: 'members', quantifier: 'none', conditions: [] }],
    })).toEqual([]);
  });

  it('reads "fewer than 1" as zero and "not 0" as some, and any other bound as neither', () => {
    const none = { type: 'relation', relation: 'memberOf', quantifier: 'none', conditions: [] };
    const some = { type: 'relation', relation: 'memberOf', quantifier: 'some', conditions: [] };
    expect(contradictions({ entity: 'account', match: 'all', conditions: [field('groupCount', 'lt', 1), some] })).toHaveLength(1);
    expect(contradictions({ entity: 'account', match: 'all', conditions: [field('groupCount', 'neq', 0), none] })).toHaveLength(1);
    // "fewer than 5 groups" and "in no group" is satisfiable (0 < 5).
    expect(contradictions({ entity: 'account', match: 'all', conditions: [field('groupCount', 'lt', 5), none] })).toEqual([]);
    // "not exactly 3 groups" and "in a group" is satisfiable.
    expect(contradictions({ entity: 'account', match: 'all', conditions: [field('groupCount', 'neq', 3), some] })).toEqual([]);
  });

  it('is not fooled by an OR level, and finds the pair inside a relation on the target entity', () => {
    expect(contradictions({
      entity: 'resource', match: 'any', conditions: [field('ownerCount', 'gt', 0), unowned],
    })).toEqual([]);
    // "accounts that are in a group that has zero members and has a member":
    // the count field belongs to the group, reached through memberOf.
    expect(contradictions({
      entity: 'account', match: 'all',
      conditions: [{
        type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all',
        conditions: [field('memberCount', 'eq', 0), { type: 'relation', relation: 'members', quantifier: 'some', conditions: [] }],
      }],
    })).toHaveLength(1);
  });

  it('every counts: in the catalog names a relation on its own entity', async () => {
    // A count that points at a relation which does not exist would silently
    // never be checked.
    const { ENTITIES } = await import('./catalog.js');
    // ENTITIES lists aliases (group, user) beside the entities they name, so
    // count by pair, not by key.
    const counted = new Set();
    for (const [ename, e] of Object.entries(ENTITIES)) {
      for (const [fname, f] of Object.entries(e.fields)) {
        if (!f.counts) continue;
        counted.add(`${fname} -> ${f.counts}`);
        expect(e.relations, `${ename}.${fname} counts "${f.counts}"`).toHaveProperty(f.counts);
      }
    }
    expect([...counted].sort()).toEqual(['accountCount -> accounts', 'groupCount -> memberOf', 'memberCount -> members', 'ownerCount -> owners']);
  });
});

describe('the same relation required to have and not have the same records', () => {
  const bram = { type: 'field', field: 'displayName', op: 'eq', value: 'Bram de Groot' };
  const rel = (quantifier, ...conditions) => ({ type: 'relation', relation: 'members', quantifier, match: 'all', conditions });

  it('rejects "members some Bram" beside "members none Bram", and says the fix', () => {
    // Verbatim: "welke groepen heb ik wel, die bram niet heeft" with bram on both sides.
    const { ok, errors } = validateSpec({ entity: 'group', match: 'all', conditions: [rel('some', bram), rel('none', bram)] });
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"members" cannot both have and not have the same records \("Bram de Groot"\)/);
    expect(errors[0]).toMatch(/@me/);
  });

  it('accepts the question asked properly, and two different people, and an OR level', () => {
    const me = { type: 'field', field: 'id', op: 'eq', value: 'u-me' };
    expect(validateSpec({ entity: 'group', match: 'all', conditions: [rel('some', me), rel('none', bram)] }).ok).toBe(true);
    expect(contradictions({ entity: 'group', match: 'any', conditions: [rel('some', bram), rel('none', bram)] })).toEqual([]);
  });

  it('also catches "has members" beside "has no members"', () => {
    expect(contradictions({ entity: 'group', match: 'all', conditions: [rel('some'), rel('none')] })).toHaveLength(1);
  });
});

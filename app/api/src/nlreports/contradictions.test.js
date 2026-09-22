// Definitions that cannot match anything.
//
// The case this exists for, in full. Asked "Kan je me vertellen of William in
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
          conditions: [{ field: 'displayName', op: 'contains', value: 'William' }] },
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

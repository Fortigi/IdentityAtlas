// The shared sentinel walker, tested for the things both callers depend on.
//
// `@me` and `@previous` both ride through here, and both are strings a MODEL
// produced. That is the whole reason this is tested separately from either:
// the keys being looked up are attacker-adjacent, and "only a condition's
// value is substitutable" is a rule that has to hold for shapes the model has
// not invented yet.

import { describe, it, expect } from 'vitest';
import { substituteValues } from './specValues.js';

const ME = new Map([['@me', 'caller-id']]);

describe('substituteValues', () => {
  it('replaces a matching value at any depth', () => {
    const out = substituteValues({
      entity: 'account',
      conditions: [
        { type: 'field', field: 'id', op: 'eq', value: '@me' },
        { type: 'relation', relation: 'manager', conditions: [{ field: 'id', op: 'eq', value: '@me' }] },
      ],
    }, ME);
    expect(out.conditions[0].value).toBe('caller-id');
    expect(out.conditions[1].conditions[0].value).toBe('caller-id');
  });

  it('substitutes ONLY a value — never a field, entity or relation name', () => {
    // A sentinel turning up as a field name is a different bug, and rewriting
    // it here would hide it behind a definition that looks well-formed.
    const out = substituteValues({ entity: '@me', field: '@me', relation: '@me', label: '@me' }, ME);
    expect(out).toEqual({ entity: '@me', field: '@me', relation: '@me', label: '@me' });
  });

  it('replaces the whole value, not part of one', () => {
    // "@me and others" is not a caller reference; rewriting inside it would
    // produce a value nobody wrote.
    const out = substituteValues({ value: 'not @me really' }, ME);
    expect(out.value).toBe('not @me really');
  });

  it('puts a list where the sentinel stood, not a string of one', () => {
    // @previous stands for many records. If this flattened to a string the
    // "in" condition would look for one record with a comma-joined name.
    const out = substituteValues({ value: '@previous' }, new Map([['@previous', ['g1', 'g2']]]));
    expect(out.value).toEqual(['g1', 'g2']);
  });

  it('does not treat an inherited property name as a sentinel', () => {
    // The lookup key comes from a model. With a plain object as the table,
    // a value of "constructor" or "toString" would find a function on the
    // prototype and substitute it into the definition.
    for (const hostile of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(substituteValues({ value: hostile }, ME).value).toBe(hostile);
    }
  });

  it('leaves everything that is not a sentinel exactly as it was', () => {
    const spec = {
      entity: 'resource',
      match: 'all',
      limit: 50,
      conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Finance' }],
      columns: ['displayName'],
      nested: { deep: [1, 'two', true, null] },
    };
    expect(substituteValues(spec, ME)).toEqual(spec);
  });

  it('does not mutate what it was given', () => {
    const spec = { conditions: [{ value: '@me' }] };
    const out = substituteValues(spec, ME);
    expect(spec.conditions[0].value).toBe('@me');
    expect(out.conditions[0].value).toBe('caller-id');
  });

  it('passes scalars and nullish values straight through', () => {
    expect(substituteValues('@me', ME)).toBe('@me');
    expect(substituteValues(null, ME)).toBe(null);
    expect(substituteValues(7, ME)).toBe(7);
  });

  it('applies several sentinels in one pass', () => {
    // The bot substitutes the caller and the previous answer separately today;
    // nothing about the walker should depend on that.
    const out = substituteValues(
      { conditions: [{ value: '@me' }, { value: '@previous' }] },
      new Map([['@me', 'caller-id'], ['@previous', ['g1']]]),
    );
    expect(out.conditions.map(c => c.value)).toEqual(['caller-id', ['g1']]);
  });
});

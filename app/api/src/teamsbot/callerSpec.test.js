import { describe, it, expect } from 'vitest';
import { substituteCaller, mentionsCaller, soundsPossessive, needsScopeCaveat } from './callerSpec.js';
import { validateSpec, CALLER_SENTINEL } from '../nlreports/spec.js';

const ME = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

describe('substituteCaller', () => {
  it('replaces the sentinel inside a nested relation condition — the shape "my direct reports" actually produces', () => {
    const spec = {
      entity: 'user',
      match: 'all',
      conditions: [{
        type: 'relation', relation: 'manager', quantifier: 'some', match: 'all',
        conditions: [{ type: 'field', field: 'id', op: 'eq', value: CALLER_SENTINEL }],
      }],
      columns: ['displayName'],
    };

    const out = substituteCaller(spec, ME);

    // Assert the value at its path, not that "the string appears somewhere":
    // a walker that flattened the tree would also satisfy a substring check.
    expect(out.conditions[0].conditions[0].value).toBe(ME);
    expect(out.conditions[0].relation).toBe('manager');
    expect(out.conditions[0].quantifier).toBe('some');
  });

  it('leaves the caller-free parts of the definition byte-identical', () => {
    const spec = {
      entity: 'group',
      match: 'any',
      conditions: [
        { type: 'field', field: 'displayName', op: 'eq', value: 'Finance' },
        { type: 'field', field: 'memberCount', op: 'gt', value: 0 },
      ],
      columns: ['displayName', 'memberCount'],
      sort: { field: 'displayName', direction: 'asc' },
      limit: 1000,
    };

    expect(substituteCaller(spec, ME)).toEqual(spec);
  });

  it('does not mutate the definition it was given — the original is what gets logged', () => {
    const spec = { entity: 'user', conditions: [{ type: 'field', field: 'id', op: 'eq', value: CALLER_SENTINEL }] };
    const before = structuredClone(spec);

    substituteCaller(spec, ME);

    expect(spec).toEqual(before);
    expect(spec.conditions[0].value).toBe(CALLER_SENTINEL);
  });

  it('substitutes only a condition VALUE, never a name that happens to read the same', () => {
    // A group really called "@me" is absurd, but `name` and `value` are adjacent
    // keys in the same object and a walker keyed on "any string equal to @me"
    // would rewrite both. Only one of these may change.
    const spec = {
      entity: 'group',
      conditions: [{
        type: 'compare', relation: 'members', measure: 'identical',
        reference: { entity: 'resource', name: CALLER_SENTINEL, id: 'r1' },
      }, {
        type: 'field', field: 'id', op: 'eq', value: CALLER_SENTINEL,
      }],
    };

    const out = substituteCaller(spec, ME);

    expect(out.conditions[0].reference.name).toBe(CALLER_SENTINEL);
    expect(out.conditions[1].value).toBe(ME);
  });

  it('leaves a value that merely contains the sentinel alone', () => {
    // "@method" starts with "@me". An `includes`/`startsWith` implementation
    // passes the test above and fails this one.
    const spec = { conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: '@method' }] };
    expect(substituteCaller(spec, ME).conditions[0].value).toBe('@method');
  });

  it('refuses a caller id that is not a uuid, rather than writing junk into a definition', () => {
    const spec = { conditions: [] };
    expect(() => substituteCaller(spec, 'not-a-uuid')).toThrow(TypeError);
    expect(() => substituteCaller(spec, null)).toThrow(TypeError);
    expect(() => substituteCaller(spec, '')).toThrow(TypeError);
  });

  it('produces a definition the real validator accepts, where the un-substituted one is rejected', () => {
    // The two halves of the contract in one test: spec.js must reject a
    // surviving sentinel, and must accept what this pass turns it into.
    const raw = {
      entity: 'user', match: 'all',
      conditions: [{ type: 'field', field: 'id', op: 'eq', value: CALLER_SENTINEL }],
      columns: ['displayName'],
    };

    const rejected = validateSpec(structuredClone(raw), {});
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.join(' ')).toContain(CALLER_SENTINEL);

    const accepted = validateSpec(substituteCaller(raw, ME), {});
    expect(accepted.ok).toBe(true);
    expect(accepted.spec.conditions[0].value).toBe(ME);
  });
});

describe('mentionsCaller', () => {
  it('is true only for the caller\'s own id, not for any uuid in the definition', () => {
    const spec = { conditions: [{ type: 'field', field: 'id', op: 'eq', value: OTHER }] };
    expect(mentionsCaller(spec, OTHER)).toBe(true);
    expect(mentionsCaller(spec, ME)).toBe(false);
  });

  it('survives a null definition instead of throwing', () => {
    expect(mentionsCaller(null, ME)).toBe(false);
  });
});

describe('soundsPossessive', () => {
  it.each([
    ['which of my delegates can reach the share', true],
    ['welke van mijn medewerkers hebben toegang', true],
    ['show me the owners', true],
    ['wat heb ik nodig', true],
  ])('treats %j as a claim about the caller', (question, expected) => {
    expect(soundsPossessive(question)).toBe(expected);
  });

  it.each([
    // Each of these CONTAINS a possessive as a substring and must not match:
    // they are what separates a word-boundary regex from a naive includes().
    ['role mining candidates for finance', 'mine inside mining'],
    ['users at ikea with admin rights', 'ik inside ikea'],
    ['which groups is Jan a member of', 'me inside member'],
    ['onzekere accounts', 'onze inside onzekere'],
  ])('does not fire on %j (%s)', (question) => {
    expect(soundsPossessive(question)).toBe(false);
  });

  it('is false for an empty or missing question', () => {
    expect(soundsPossessive('')).toBe(false);
    expect(soundsPossessive(undefined)).toBe(false);
  });
});

describe('needsScopeCaveat', () => {
  const anchored = { conditions: [{ value: ME }] };
  const unanchored = { conditions: [{ value: 'Finance' }] };

  it('warns only when the question claimed "my" AND the report is not anchored to the caller', () => {
    // All four combinations, because only the AND of the two makes it true —
    // testing one true case cannot tell this apart from either half alone.
    expect(needsScopeCaveat('my direct reports', unanchored, ME)).toBe(true);
    expect(needsScopeCaveat('my direct reports', anchored, ME)).toBe(false);
    expect(needsScopeCaveat('all guest accounts', unanchored, ME)).toBe(false);
    expect(needsScopeCaveat('all guest accounts', anchored, ME)).toBe(false);
  });
});

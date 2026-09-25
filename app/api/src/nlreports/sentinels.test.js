// What the pipeline can say about the placeholders a model wrote.
//
// substituteValues itself is pinned by teamsbot/specValues.test.js through the
// re-export. What is tested here is the part that is new with the move: the
// report of WHICH sentinels a definition used, which an evaluation reads to
// answer "did the model write @me when it was told to" — a question the
// substituted definition can no longer answer, because the sentinel is gone.

import { describe, it, expect } from 'vitest';
import { sentinelsIn, substituteValues } from './sentinels.js';

const ME = new Map([['@me', 'caller-id']]);
const BOTH = new Map([['@me', 'caller-id'], ['@previous', ['g1', 'g2']]]);

describe('sentinelsIn', () => {
  it('names the sentinels a definition uses, once each, in the order met', () => {
    const spec = {
      conditions: [
        { type: 'field', field: 'id', op: 'in', value: '@previous' },
        { type: 'relation', relation: 'owners', conditions: [{ field: 'id', op: 'eq', value: '@me' }] },
        { type: 'field', field: 'id', op: 'eq', value: '@me' },
      ],
    };
    expect(sentinelsIn(spec, BOTH)).toEqual(['@previous', '@me']);
  });

  it('reports nothing for a definition that copied a literal instead', () => {
    // The case the sentinel exists to avoid — and the case an evaluation
    // wants to count, because a copied uuid is right only by luck.
    const spec = { conditions: [{ type: 'field', field: 'id', op: 'eq', value: '3f7c1d2e-9a4b-4c6d-8e1f-2b3c4d5e6f70' }] };
    expect(sentinelsIn(spec, ME)).toEqual([]);
  });

  it('only counts a sentinel in a VALUE, never as a field or entity name', () => {
    expect(sentinelsIn({ entity: '@me', field: '@me', conditions: [] }, ME)).toEqual([]);
  });

  it('ignores sentinels that are not in force this turn', () => {
    // No previous answer was carried, so "@previous" is just a string the
    // model wrote; reporting it would claim a substitution that never happened.
    const spec = { conditions: [{ type: 'field', field: 'id', op: 'in', value: '@previous' }] };
    expect(sentinelsIn(spec, ME)).toEqual([]);
  });

  it('is empty for nothing at all', () => {
    expect(sentinelsIn(null, ME)).toEqual([]);
    expect(sentinelsIn({ conditions: [] }, new Map())).toEqual([]);
    expect(sentinelsIn({ conditions: [] }, undefined)).toEqual([]);
  });
});

describe('substituteValues with nothing in force', () => {
  it('hands the definition back untouched, not copied', () => {
    // The common case on the web builder: no caller, no previous answer. A
    // copy would be harmless but pointless, and identity makes "nothing was
    // substituted" cheap to assert.
    const spec = { conditions: [{ type: 'field', field: 'id', op: 'eq', value: '@me' }] };
    expect(substituteValues(spec, new Map())).toBe(spec);
    expect(substituteValues(spec, undefined)).toBe(spec);
  });
});

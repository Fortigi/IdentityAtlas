import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query } from '../../db/connection.js';
import { linkStats, summarize, SAMPLE_LIMIT } from './stats.js';
import { normalizeLinkRules } from '../contracts.js';

const principals = [
  { id: 'u1', displayName: 'Ann Smith', email: 'ann@contoso.com', principalType: 'User' },
  { id: 'u2', displayName: 'Bob Jones', email: 'bob@contoso.com', principalType: 'User' },
  { id: 'u3', displayName: 'Bob Jones', email: 'bob.j@northwind.com', principalType: 'User' },
  { id: 'u4', displayName: 'Cas Weak', email: 'cas@contoso.com', principalType: 'User' },
];

const rules = normalizeLinkRules([{
  entityType: 'Person', targetType: 'Principal', threshold: 70,
  signals: [
    { attribute: 'email', targetField: 'email', type: 'exact', weight: 90 },
    { attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 },
  ],
}]);

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: principals });
});

const person = (displayName, email) => ({ entityType: 'Person', displayName, canonicalKey: displayName, attributes: email ? { email } : {} });

describe('linkStats', () => {
  it('counts unique, ambiguous (tie + weak) and none per type, adding up to the total', async () => {
    const out = await linkStats([
      person('Ann Smith', 'ann@contoso.com'),   // unique (100)
      person('Bob Jones'),                      // tie 60/60 → under 70: weak, not a tie at threshold
      person('Cas Weak'),                       // 60 < 70 → weak
      person('Dee Nobody', 'dee@contoso.com'),  // none
      { entityType: 'Project', displayName: 'Atlas', attributes: {} },
    ], rules);
    expect(Object.keys(out)).toEqual(['Person']);
    expect(out.Person).toMatchObject({ total: 4, unique: 1, ambiguous: 2, lowConfidence: 2, none: 1 });
    expect(out.Person.samples.none).toEqual([{ displayName: 'Dee Nobody' }]);
    expect(out.Person.samples.ambiguous[0]).toEqual({
      displayName: 'Bob Jones',
      candidates: [
        { targetType: 'Principal', targetId: 'u2', label: 'Bob Jones', confidence: 60 },
        { targetType: 'Principal', targetId: 'u3', label: 'Bob Jones', confidence: 60 },
      ],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a tie at the threshold is ambiguous but not low confidence', async () => {
    const at60 = normalizeLinkRules([{ ...rules[0], threshold: 60, signals: rules[0].signals.map(({ name: _n, order: _o, ...s }) => s) }]);
    const out = await linkStats([person('Bob Jones')], at60);
    expect(out.Person).toMatchObject({ total: 1, ambiguous: 1, lowConfidence: 0 });
  });

  it('reports a ruled type with no entities as zeros without loading targets', async () => {
    const out = await linkStats([{ entityType: 'Project', displayName: 'Atlas', attributes: {} }], rules);
    expect(out.Person).toEqual({ total: 0, unique: 0, ambiguous: 0, none: 0, lowConfidence: 0, samples: { ambiguous: [], none: [] } });
    expect(query).not.toHaveBeenCalled();
  });

  it('reports nothing when there are no rules', async () => {
    expect(await linkStats([person('Ann Smith')], [])).toEqual({});
    expect(await linkStats([person('Ann Smith')], undefined)).toEqual({});
    expect(await linkStats(undefined, rules)).toMatchObject({ Person: { total: 0 } });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('summarize', () => {
  it('keeps at most SAMPLE_LIMIT samples of each kind but counts them all', () => {
    const none = Array.from({ length: SAMPLE_LIMIT + 2 }, (_, i) => ({ entityType: 'Person', decision: 'none', entity: { displayName: `n${i}` } }));
    const amb = Array.from({ length: SAMPLE_LIMIT + 1 }, (_, i) => ({ entityType: 'Person', decision: 'proposed', ambiguous: true, candidates: [], entity: { displayName: `a${i}` } }));
    const out = summarize([...none, ...amb], rules);
    expect(SAMPLE_LIMIT).toBe(10);
    expect(out.Person).toMatchObject({ total: 23, none: 12, ambiguous: 11, lowConfidence: 0 });
    expect(out.Person.samples.none).toHaveLength(10);
    expect(out.Person.samples.ambiguous).toHaveLength(10);
    expect(out.Person.samples.none[9]).toEqual({ displayName: 'n9' });
  });
});

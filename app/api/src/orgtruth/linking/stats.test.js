import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query } from '../../db/connection.js';
import { linkStats, summarize, isEmptyDecision, SAMPLE_LIMIT } from './stats.js';
import { normalizeLinkRules } from '../contracts.js';

const principals = [
  { id: 'u1', displayName: 'Ann Smith', email: 'ann@contoso.com', principalType: 'User' },
  { id: 'u2', displayName: 'Bob Jones', email: 'bob@contoso.com', principalType: 'User' },
  { id: 'u3', displayName: 'Bob Jones', email: 'bob.j@northwind.com', principalType: 'User' },
  { id: 'u4', displayName: 'Cas Weak', email: 'cas@contoso.com', principalType: 'User' },
];

// Linked THROUGH the e-mail attribute; the name signal still fires for an entity without one.
const rules = normalizeLinkRules([{
  entityType: 'Person', targetType: 'Principal', threshold: 70,
  signals: [
    { attribute: 'email', targetField: 'email', type: 'exact', weight: 90 },
    { attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 },
  ],
}]);
const KEY = 'Person → Principal via email';
const NAME_KEY = 'Person → Principal via displayName';
const byName = (threshold) => normalizeLinkRules([{
  entityType: 'Person', targetType: 'Principal', via: 'displayName', threshold,
  signals: [{ attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 }],
}]);

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: principals });
});

const person = (displayName, email) => ({ entityType: 'Person', displayName, canonicalKey: displayName, attributes: email ? { email } : {} });

describe('linkStats', () => {
  it('an entity with an empty linking attribute counts as empty, outside the total', async () => {
    const out = await linkStats([
      person('Ann Smith', 'ann@contoso.com'),   // unique (100)
      person('Bob Jones'),                      // no e-mail: empty, although the name signal would fire
      person('Cas Weak'),                       // no e-mail: empty
      person('Dee Nobody', 'dee@contoso.com'),  // none
      { entityType: 'Project', displayName: 'Atlas', attributes: {} },
    ], rules);
    expect(Object.keys(out)).toEqual([KEY]);
    expect(out[KEY]).toMatchObject({ entityType: 'Person', targetType: 'Principal', via: 'email', total: 2, unique: 1, ambiguous: 0, lowConfidence: 0, none: 1, empty: 2 });
    expect(out[KEY].samples.none).toEqual([{ displayName: 'dee@contoso.com' }]);
    expect(out[KEY].samples.ambiguous).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('counts unique, ambiguous (tie + weak) and none per rule, adding up to the total', async () => {
    const out = await linkStats([
      person('Ann Smith'),   // unique (60 + nothing else) — threshold 50
      person('Bob Jones'),   // tie 60/60
      person('Cas Weak'),    // unique
      person('Dee Nobody'),  // none
    ], byName(50));
    expect(out[NAME_KEY]).toMatchObject({ via: 'displayName', total: 4, unique: 2, ambiguous: 1, lowConfidence: 0, none: 1, empty: 0 });
    expect(out[NAME_KEY].samples.none).toEqual([{ displayName: 'Dee Nobody' }]);
    expect(out[NAME_KEY].samples.ambiguous[0]).toEqual({
      displayName: 'Bob Jones',
      candidates: [
        { targetType: 'Principal', targetId: 'u2', label: 'Bob Jones', confidence: 60 },
        { targetType: 'Principal', targetId: 'u3', label: 'Bob Jones', confidence: 60 },
      ],
    });
  });

  it('a candidate under the threshold is ambiguous and low confidence', async () => {
    const out = await linkStats([person('Cas Weak'), person('Bob Jones')], byName(70));
    expect(out[NAME_KEY]).toMatchObject({ total: 2, unique: 0, ambiguous: 2, lowConfidence: 2, none: 0 });
  });
  it('a cell listing several people is counted per person, under the rule that links through that attribute', async () => {
    const team = normalizeLinkRules([{
      entityType: 'Team', targetType: 'Principal', via: 'members', threshold: 50,
      signals: [{ attribute: 'members', targetField: 'displayName', type: 'exact', weight: 80 }],
    }]);
    const out = await linkStats([{ entityType: 'Team', displayName: 'T1', attributes: { members: 'Ann Smith;#1;#Bob Jones;#2;#Nobody;#3' } }], team);
    expect(out['Team → Principal via members']).toMatchObject({ via: 'members', total: 3, unique: 1, ambiguous: 1, none: 1 });
    expect(out['Team → Principal via members'].samples.none).toEqual([{ displayName: 'Nobody' }]);
  });

  it('two rules on one entity type report two blocks', async () => {
    const two = normalizeLinkRules([
      { entityType: 'Person', targetType: 'Principal', signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] },
      { entityType: 'Person', targetType: 'Principal', via: 'displayName', signals: [{ attribute: 'displayName', targetField: 'displayName', type: 'exact', weight: 80 }] },
    ]);
    const out = await linkStats([person('Ann Smith', 'ann@contoso.com'), person('Zed None', 'zed@contoso.com')], two);
    expect(Object.keys(out)).toEqual(['Person → Principal via email', 'Person → Principal via displayName']);
    expect(out['Person → Principal via email']).toMatchObject({ total: 2, unique: 1, none: 1 });
    expect(out['Person → Principal via displayName']).toMatchObject({ total: 2, unique: 1, none: 1 });
    expect(query).toHaveBeenCalledTimes(1); // one load for the shared target type
  });

  it('a tie at the threshold is ambiguous but not low confidence', async () => {
    const out = await linkStats([person('Bob Jones')], byName(60));
    expect(out[NAME_KEY]).toMatchObject({ total: 1, ambiguous: 1, lowConfidence: 0 });
  });
  it('reports a ruled type with no entities as zeros without loading targets', async () => {
    const out = await linkStats([{ entityType: 'Project', displayName: 'Atlas', attributes: {} }], rules);
    expect(out[KEY]).toEqual({ entityType: 'Person', targetType: 'Principal', via: 'email', total: 0, unique: 0, ambiguous: 0, none: 0, lowConfidence: 0, empty: 0, samples: { ambiguous: [], none: [] } });
    expect(query).not.toHaveBeenCalled();
  });

  it('reports nothing when there are no rules', async () => {
    expect(await linkStats([person('Ann Smith')], [])).toEqual({});
    expect(await linkStats([person('Ann Smith')], undefined)).toEqual({});
    expect(await linkStats(undefined, rules)).toMatchObject({ [KEY]: { total: 0 } });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('summarize', () => {
  it('keeps at most SAMPLE_LIMIT samples of each kind but counts them all', () => {
    const rule = rules[0];
    const none = Array.from({ length: SAMPLE_LIMIT + 2 }, (_, i) => ({ rule, decision: 'none', value: '', entity: { displayName: `n${i}` } }));
    const amb = Array.from({ length: SAMPLE_LIMIT + 1 }, (_, i) => ({ rule, decision: 'proposed', ambiguous: true, candidates: [], value: `a${i}`, entity: { displayName: 'x' } }));
    const out = summarize([...none, ...amb], rules);
    expect(SAMPLE_LIMIT).toBe(10);
    expect(out[KEY]).toMatchObject({ total: 23, none: 12, ambiguous: 11, lowConfidence: 0 });
    expect(out[KEY].samples.none).toHaveLength(10);
    expect(out[KEY].samples.ambiguous).toHaveLength(10);
    expect(out[KEY].samples.none[9]).toEqual({ displayName: 'n9' });
    expect(out[KEY].samples.ambiguous[0].displayName).toBe('a0');
  });
});

describe('isEmptyDecision', () => {
  it('only an empty value of a non-name attribute is empty', () => {
    expect(isEmptyDecision({ via: 'team', value: '' })).toBe(true);
    expect(isEmptyDecision({ via: 'team', value: 'Ann' })).toBe(false);
    expect(Boolean(isEmptyDecision({ via: 'displayName', value: '' }))).toBe(false);
    expect(Boolean(isEmptyDecision({ value: '' }))).toBe(false);
  });
});

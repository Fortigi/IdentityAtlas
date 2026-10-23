import { describe, it, expect } from 'vitest';
import { placeEntries, distributionOf, MAX_DISTRIBUTION_SAMPLES } from './placement.js';

// A customer tree: the root, two clients, a project under one, a team under that
// project, and a name ("Support") at two levels.
const ROOT = { id: 'root', externalId: null, displayName: 'Customers' };
const UNITS = [
  { id: 'c1', externalId: 'K-001', displayName: 'Northwind Traders', depth: 1 },
  { id: 'c2', externalId: null, displayName: 'Contoso Bakery', depth: 1 },
  { id: 'p1', externalId: null, displayName: 'Platform Rebuild', depth: 2 },
  { id: 't1', externalId: null, displayName: 'Night Shift', depth: 3 },
  { id: 's1', externalId: null, displayName: 'Support', depth: 1 },
  { id: 's2', externalId: null, displayName: 'Support', depth: 2 },
];
const entry = (contextValue) => ({ contextValue, subjectName: 'Vera Example', date: '2026-04-01', amount: 1 });
const ON = { contextColumn: 'Client', emptyContext: 'self' };
const placedOn = (r) => r.placed.map(e => e.contextId);

describe('placeEntries', () => {
  const entries = [
    entry('Northwind Traders'), entry('K-001'),   // a child, by name and by key
    entry('Platform Rebuild'),                     // a grandchild
    entry('Night Shift'),                          // level 3
    entry('Customers'),                            // the root's own name
    entry(null), entry(null),                      // no unit in the cell
    entry('Support'), entry('Support'),            // ambiguous across two levels
    entry('Unknown Ltd'),                          // nothing
    entry('Contoso Bakeri'),                       // a near miss
  ];

  it('places each row on the root, a unit at any level, or nowhere', () => {
    const r = placeEntries(entries, ON, ROOT, UNITS);
    expect(placedOn(r)).toEqual(['c1', 'c1', 'p1', 't1', 'root', 'root', 'root', null, null, null, 'c2']);
    expect(r.contexts).toMatchObject({ matched: 6, fuzzy: 1, ambiguous: 1, unmatched: 1, emptyRows: 2 });
  });

  it('reports the distribution: on itself, on units below (how many, how deep), unmatched and ambiguous with samples', () => {
    expect(placeEntries(entries, ON, ROOT, UNITS).distribution).toEqual({
      onSelf: 3, onSubUnits: 5, subUnits: 4, deepestLevel: 3,
      unmatched: 1, ambiguous: 2, empty: 2, emptyTo: 'self',
      unmatchedSamples: [{ value: 'Unknown Ltd', rows: 1 }],
      ambiguousSamples: [{ value: 'Support', rows: 2 }],
    });
  });

  it('rows without a unit are left out when the mapping says so', () => {
    const r = placeEntries(entries, { ...ON, emptyContext: 'skip' }, ROOT, UNITS);
    expect(placedOn(r).slice(4, 7)).toEqual(['root', null, null]);
    expect(r.distribution).toMatchObject({ onSelf: 1, empty: 2, emptyTo: 'skip' });
  });

  it('without a unit column every row lands on the context itself, also on a parent', () => {
    const r = placeEntries(entries, { contextColumn: null, emptyContext: 'skip' }, ROOT, UNITS);
    expect(new Set(placedOn(r))).toEqual(new Set(['root']));
    expect(r.contexts).toBeNull();
    expect(r.distribution).toMatchObject({ onSelf: 11, onSubUnits: 0, subUnits: 0, deepestLevel: 0, unmatched: 0, ambiguous: 0, empty: 0 });
  });
});

describe('distributionOf', () => {
  it('counts rows on units below the context (not on it) and keeps at most MAX_DISTRIBUTION_SAMPLES samples', () => {
    const outcome = new Map(Array.from({ length: MAX_DISTRIBUTION_SAMPLES + 2 }, (_, i) => [`X${i}`, 'unmatched']));
    const counts = new Map([...outcome.keys()].map((v, i) => [v, i + 1]));
    const d = distributionOf({
      placed: [{ contextId: 'a' }, { contextId: 'a' }, { contextId: 'b' }, { contextId: 'root' }, { contextId: null }],
      selfId: 'root', depthOf: new Map([['a', 2], ['b', 1]]), outcome, counts,
    });
    expect(d).toMatchObject({ onSelf: 1, onSubUnits: 3, subUnits: 2, deepestLevel: 2, unmatched: 78, ambiguous: 0, emptyTo: 'self' });
    expect(d.unmatchedSamples).toHaveLength(MAX_DISTRIBUTION_SAMPLES);
    expect(d.unmatchedSamples[1]).toEqual({ value: 'X1', rows: 2 });
  });
});

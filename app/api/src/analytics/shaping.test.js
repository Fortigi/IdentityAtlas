import { describe, it, expect } from 'vitest';
import {
  AnalyticsError, assertWithinRowLimit, deriveGovernedMeasures, suppressSmallCells, namedRows, columnsFor,
} from './shaping.js';
import { getMetric } from './metrics.js';

describe('assertWithinRowLimit', () => {
  it('allows exactly maxRows and refuses maxRows plus 1 with a 422', () => {
    expect(() => assertWithinRowLimit(100, 100)).not.toThrow();
    let err;
    try { assertWithinRowLimit(101, 100); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AnalyticsError);
    expect([err.status, err.code, err.details]).toEqual([422, 'dataset_too_large', { maxRows: 100 }]);
  });
});

describe('deriveGovernedMeasures', () => {
  it('derives ungoverned, unknown and the share to four decimals', () => {
    expect(deriveGovernedMeasures({ pairs: 3, governedPairs: 1, holders: 2 }))
      .toEqual({ pairs: 3, governedPairs: 1, holders: 2, ungovernedPairs: 2, unknownPairs: 0, governedShare: 0.3333 });
  });

  it('reports a null share - not 0 - when there is nothing to divide by', () => {
    expect(deriveGovernedMeasures({ pairs: 0, governedPairs: 0, holders: 0 }).governedShare).toBeNull();
  });
});

describe('suppressSmallCells', () => {
  const opts = { population: 'holders', measures: ['pairs', 'holders'], minGroupSize: 5 };

  it('suppresses populations 1..k-1 and keeps k, without touching dimension values', () => {
    const rows = [
      { dept: 'A', pairs: 40, holders: 4 },
      { dept: 'B', pairs: 50, holders: 5 },
      { dept: 'C', pairs: 1, holders: 1 },
    ];
    const { rows: out, suppressed } = suppressSmallCells(rows, opts);
    expect(suppressed).toBe(2);
    expect(out).toEqual([
      { dept: 'A', pairs: null, holders: null, suppressed: true },
      { dept: 'B', pairs: 50, holders: 5, suppressed: false },
      { dept: 'C', pairs: null, holders: null, suppressed: true },
    ]);
  });

  it('suppresses on the population measure, not on the size of other measures', () => {
    // 900 pairs held by 2 people still describes 2 people.
    const { rows } = suppressSmallCells([{ pairs: 900, holders: 2 }], opts);
    expect(rows[0].suppressed).toBe(true);
  });

  it('suppresses nothing with a minimum group size of 1', () => {
    expect(suppressSmallCells([{ pairs: 1, holders: 1 }], { ...opts, minGroupSize: 1 }).suppressed).toBe(0);
  });
});

describe('namedRows / columnsFor', () => {
  it('renames positional dimensions to field ids in a stable key order', () => {
    const out = namedRows([{ accounts: 3, d1: 'Sales', d0: 'true', period: '2026-09' }], ['Principal.accountEnabled', 'Identity.department'], ['accounts'], ['period']);
    expect(out).toEqual([{ period: '2026-09', 'Principal.accountEnabled': 'true', 'Identity.department': 'Sales', accounts: 3 }]);
    expect(Object.keys(out[0])).toEqual(['period', 'Principal.accountEnabled', 'Identity.department', 'accounts']);
  });

  it('fills a measure the query did not return with null', () => {
    expect(namedRows([{ pairs: 1 }], [], ['pairs', 'governedShare'])).toEqual([{ pairs: 1, governedShare: null }]);
  });

  it('lists leading, dimension, measure and flag columns in that order', () => {
    const cols = columnsFor({
      dimensions: [{ field: 'Principal.accountEnabled', label: 'Status', unknownLabel: '(unknown)', iri: 'x' }],
      metric: getMetric('assignments.governedShare'),
      leading: [{ name: 'period', role: 'time' }],
    });
    expect(cols.map(c => `${c.role}:${c.name}`)).toEqual([
      'time:period', 'dimension:Principal.accountEnabled',
      'measure:pairs', 'measure:governedPairs', 'measure:ungovernedPairs', 'measure:unknownPairs', 'measure:governedShare', 'measure:holders',
      'flag:suppressed',
    ]);
    expect(cols[1]).toMatchObject({ label: 'Status', type: 'text', iri: 'x' });
  });
});

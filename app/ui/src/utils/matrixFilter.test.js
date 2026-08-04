import { describe, it, expect } from 'vitest';
import { DEFAULT_SORT, EMPTY_FILTER, normalizeMatrixFilter } from './matrixFilter';

describe('normalizeMatrixFilter', () => {
  it('returns the empty filter shape for null / undefined / non-objects', () => {
    for (const input of [null, undefined, 'nonsense', 42]) {
      expect(normalizeMatrixFilter(input)).toEqual(EMPTY_FILTER);
    }
  });

  it('fills in every missing field of a partial filter', () => {
    // The shape the demo dataset seeds as the org-wide default matrix.
    const partial = {
      rowType: 'principal',
      orientation: 'rows-as-resources',
      subject: { include: [], exclude: [] },
      resource: { include: [], exclude: [] },
    };
    const out = normalizeMatrixFilter(partial);
    expect(out).toEqual(EMPTY_FILTER);
    expect(out.sortAttributes).toEqual(DEFAULT_SORT);
    expect(out.foldOnLoad).toBe('auto');
  });

  it('keeps the values a complete filter already carries', () => {
    const full = {
      rowType: 'identity',
      orientation: 'rows-as-subjects',
      subject:  { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
      resource: { include: [], exclude: [{ kind: 'attribute', field: 'resourceType', values: ['Group'] }] },
      rollup: 'department',
      rollupContent: 'roles-only',
      rollupMetric: 'percent',
      rollupKind: 'context',
      rollupContextId: 'ctx-1',
      rollupPath: ['a', 'b'],
      rollupExpanded: ['node-1'],
      rollupCollapsed: ['tuple-1'],
      foldAttributes: true,
      sortAttributes: [{ attribute: 'jobTitle', dir: 'desc' }],
      sortHierarchy: { contextId: 'ctx-2' },
      foldOnLoad: true,
    };
    expect(normalizeMatrixFilter(full)).toEqual(full);
  });

  it('falls back to defaults for wrongly-typed or unknown values', () => {
    const out = normalizeMatrixFilter({
      rowType: 'group',
      orientation: 'diagonal',
      subject: 'nope',
      resource: { include: 'nope', exclude: null },
      rollup: 42,
      rollupContent: 'everything',
      rollupMetric: 'ratio',
      rollupKind: 'magic',
      rollupContextId: '',
      rollupPath: 'a,b',
      rollupExpanded: 'node-1',
      rollupCollapsed: null,
      foldAttributes: 'yes',
      sortAttributes: [],
      sortHierarchy: { contextId: 7 },
      foldOnLoad: 'sometimes',
    });
    expect(out).toEqual({ ...EMPTY_FILTER, foldAttributes: true });
    expect(out.subject).toEqual({ include: [], exclude: [] });
    expect(out.resource).toEqual({ include: [], exclude: [] });
  });

  it('caps sortAttributes at six levels', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ attribute: `attr${i}`, dir: 'asc' }));
    expect(normalizeMatrixFilter({ sortAttributes: many }).sortAttributes).toHaveLength(6);
  });

  it('deep-copies the source so wizard edits cannot mutate the applied filter', () => {
    const source = {
      subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
      resource: { include: [], exclude: [] },
      sortAttributes: [{ attribute: 'city', dir: 'asc' }],
      rollupPath: ['a'],
    };
    const out = normalizeMatrixFilter(source);
    out.subject.include[0].values.push('Sales');
    out.sortAttributes[0].dir = 'desc';
    out.rollupPath.push('b');
    expect(source.subject.include[0].values).toEqual(['HR']);
    expect(source.sortAttributes[0].dir).toBe('asc');
    expect(source.rollupPath).toEqual(['a']);
  });

  it('does not share the DEFAULT_SORT array between normalised filters', () => {
    const a = normalizeMatrixFilter(null);
    const b = normalizeMatrixFilter(null);
    a.sortAttributes[0].attribute = 'city';
    expect(b.sortAttributes).toEqual(DEFAULT_SORT);
    expect(DEFAULT_SORT[0].attribute).toBe('department');
  });
});

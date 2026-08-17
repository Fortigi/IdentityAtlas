import { describe, it, expect } from 'vitest';
import { DEFAULT_SORT, EMPTY_FILTER, matrixFilterFingerprint, normalizeMatrixFilter } from './matrixFilter';

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

  it('defaults to department ASCENDING, stated as a literal', () => {
    // `toEqual(DEFAULT_SORT)` above compares the constant to itself: change the
    // direction and both sides change together, so it cannot pin one. The
    // attribute is pinned on the line above; the direction was not, and a
    // matrix that opens sorted the wrong way round is a visible difference.
    expect(DEFAULT_SORT).toEqual([{ attribute: 'department', dir: 'asc' }]);
    expect(normalizeMatrixFilter(null).sortAttributes).toEqual([{ attribute: 'department', dir: 'asc' }]);
  });

  it('accepts every documented rollupContent value', () => {
    // The allowed-value list IS the contract — a value dropped from it doesn't
    // error, it silently reverts the roll-up to 'resources-and-roles'. Only
    // 'roles-only' was covered, so removing either of the other two showed up
    // nowhere.
    for (const value of ['resources-and-roles', 'resources-only', 'roles-only']) {
      expect(normalizeMatrixFilter({ rollupContent: value }).rollupContent).toBe(value);
    }
  });

  it('keeps foldOnLoad: false — "never fold" is not the same as "auto"', () => {
    // 'auto' folds a large matrix; false is the analyst forcing it not to.
    // Collapsing false into the default silently re-folds their view on load.
    expect(normalizeMatrixFilter({ foldOnLoad: false }).foldOnLoad).toBe(false);
    expect(normalizeMatrixFilter({ foldOnLoad: true }).foldOnLoad).toBe(true);
    expect(normalizeMatrixFilter({ foldOnLoad: 'auto' }).foldOnLoad).toBe('auto');
  });
});

describe('matrixFilterFingerprint', () => {
  // What test/demo-dataset/Ingest-DemoDataset.ps1 stores as the org-wide default.
  const seeded = {
    rowType: 'principal',
    orientation: 'rows-as-resources',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
  };

  it('is null for a missing filter', () => {
    for (const input of [null, undefined, 'nonsense']) {
      expect(matrixFilterFingerprint(input)).toBeNull();
    }
  });

  it('matches a stored partial filter to the full one the wizard applies', () => {
    // Adjusting the seeded default without changing anything applies the
    // normalised shape — still the same matrix, so it keeps its saved name.
    expect(matrixFilterFingerprint(normalizeMatrixFilter(seeded)))
      .toBe(matrixFilterFingerprint(seeded));
  });

  it('ignores key order and the managed-state toggle saved alongside the filter', () => {
    const reordered = {
      resource: { exclude: [], include: [] },
      subject: { exclude: [], include: [] },
      orientation: 'rows-as-resources',
      rowType: 'principal',
      managed: 'governed',
    };
    expect(matrixFilterFingerprint(reordered)).toBe(matrixFilterFingerprint(seeded));
  });

  it('ignores view state — folding and drilling do not make it another matrix', () => {
    const drilled = {
      ...seeded,
      rollupExpanded: ['node-1'],
      rollupCollapsed: ['tuple-1'],
      rollupPath: ['node-1', 'node-2'],
      foldAttributes: true,
    };
    expect(matrixFilterFingerprint(drilled)).toBe(matrixFilterFingerprint(seeded));
  });

  it('separates matrices that really differ', () => {
    const base = matrixFilterFingerprint(seeded);
    expect(matrixFilterFingerprint({ ...seeded, rowType: 'identity' })).not.toBe(base);
    expect(matrixFilterFingerprint({ ...seeded, orientation: 'rows-as-subjects' })).not.toBe(base);
    expect(matrixFilterFingerprint({ ...seeded, rollup: 'department' })).not.toBe(base);
    expect(matrixFilterFingerprint({ ...seeded, foldOnLoad: true })).not.toBe(base);
    expect(matrixFilterFingerprint({
      ...seeded, sortAttributes: [{ attribute: 'jobTitle', dir: 'asc' }],
    })).not.toBe(base);
    expect(matrixFilterFingerprint({
      ...seeded, subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
    })).not.toBe(base);
  });

  it('ignores key order INSIDE a condition, not just at the top level', () => {
    // The normaliser rebuilds the TOP-level keys in a fixed order, so the
    // existing key-order test passes even without the sort in `canonical`.
    // Conditions are different: they are deep-copied exactly as they arrive,
    // and a filter that went to Postgres as JSONB and came back can return
    // them with the keys in another order. Unsorted, that is a different
    // fingerprint — the matrix stops matching the saved row it came from, and
    // the summary bar relabels it "Not saved", which is the bug this function
    // was written to fix.
    const a = { ...seeded, subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] } };
    const b = { ...seeded, subject: { include: [{ values: ['HR'], field: 'department', kind: 'attribute' }], exclude: [] } };
    expect(matrixFilterFingerprint(a)).toBe(matrixFilterFingerprint(b));
    // ...and it is still a different matrix from the unfiltered one, so the
    // assertion above can't be satisfied by fingerprinting everything alike.
    expect(matrixFilterFingerprint(a)).not.toBe(matrixFilterFingerprint(seeded));
  });

  it('keeps condition order significant', () => {
    const hr = { kind: 'attribute', field: 'department', values: ['HR'] };
    const it_ = { kind: 'attribute', field: 'department', values: ['IT'] };
    expect(matrixFilterFingerprint({ ...seeded, subject: { include: [hr, it_], exclude: [] } }))
      .not.toBe(matrixFilterFingerprint({ ...seeded, subject: { include: [it_, hr], exclude: [] } }));
  });
});

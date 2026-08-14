import { describe, it, expect } from 'vitest';
import { collectChips, collectContextIds } from './MatrixFilterSummary.helpers';

describe('collectChips', () => {
  it('returns [] for a missing block', () => {
    expect(collectChips(null, new Map())).toEqual([]);
    expect(collectChips(undefined, new Map())).toEqual([]);
  });

  it('builds attribute chips for include and exclude sides', () => {
    const chips = collectChips(
      {
        include: [{ kind: 'attribute', field: 'department', values: ['HR', 'Finance'] }],
        exclude: [{ kind: 'attribute', field: 'accountEnabled', values: ['false'] }],
      },
      new Map(),
    );
    expect(chips).toEqual([
      { side: 'include', label: 'department: HR, Finance', title: 'department in HR, Finance' },
      { side: 'exclude', label: 'accountEnabled: false', title: 'NOT accountEnabled in false' },
    ]);
  });

  it('tolerates an attribute with no values array', () => {
    const chips = collectChips({ include: [{ kind: 'attribute', field: 'city' }] }, new Map());
    expect(chips).toEqual([{ side: 'include', label: 'city: ', title: 'city in ' }]);
  });

  it('resolves context names and marks descendant inclusion', () => {
    const names = new Map([['ctx-1', 'Engineering']]);
    const chips = collectChips(
      { include: [{ kind: 'context', contextId: 'ctx-1', includeChildren: true }], exclude: [] },
      names,
    );
    expect(chips).toEqual([
      { side: 'include', label: 'Engineering +sub', title: 'In context "Engineering" (incl. descendants)' },
    ]);
  });

  it('falls back to a truncated id and omits +sub when children are excluded', () => {
    const chips = collectChips(
      { exclude: [{ kind: 'context', contextId: '0123456789abcdef', includeChildren: false }] },
      new Map(),
    );
    expect(chips).toEqual([
      { side: 'exclude', label: '01234567', title: 'NOT in context "01234567"' },
    ]);
  });

  it('skips conditions of an unknown kind', () => {
    const chips = collectChips({ include: [{ kind: 'mystery' }, null, undefined] }, new Map());
    expect(chips).toEqual([]);
  });
});

describe('collectContextIds', () => {
  it('returns [] for an empty or missing filter', () => {
    expect(collectContextIds(undefined)).toEqual([]);
    expect(collectContextIds({})).toEqual([]);
  });

  it('collects distinct context ids across subject and resource blocks', () => {
    const ids = collectContextIds({
      subject: {
        include: [{ kind: 'context', contextId: 'a' }, { kind: 'attribute', field: 'x', values: [] }],
        exclude: [{ kind: 'context', contextId: 'b' }],
      },
      resource: {
        include: [{ kind: 'context', contextId: 'a' }],
        exclude: [{ kind: 'context', contextId: 123 }, null],
      },
    });
    expect(ids).toEqual(['a', 'b']);
  });
});

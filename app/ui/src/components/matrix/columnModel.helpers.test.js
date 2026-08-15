import { describe, it, expect } from 'vitest';
import { AGG_SENTINEL, collapseKey, makeAccountCol, buildColumns } from './columnModel.js';

// A subject the way MatrixView builds it: id + precomputed sortKeys.
const sub = (id, sortKeys, extra = {}) => ({ id, displayName: id, memberType: 'User', sortKeys, ...extra });

// buildColumns context with sensible empty defaults; override per test.
const ctx = (o = {}) => ({
  collapsedGroups: new Set(),
  memberExpanded: new Map(),
  sortAttrs: [{ attribute: 'department' }],
  expandedIdentities: new Set(),
  accountMatrixCache: new Map(),
  ...o,
});

describe('collapseKey', () => {
  it('length-prefixes each segment up to the level so value sequences cannot collide', () => {
    expect(collapseKey(['Eng'], 0)).toBe('0|3:Eng');
    expect(collapseKey(['Eng', 'SWE'], 1)).toBe('1|3:Eng|3:SWE');
    // "a" + "bc" vs "ab" + "c" must not produce the same key.
    expect(collapseKey(['a', 'bc'], 1)).not.toBe(collapseKey(['ab', 'c'], 1));
  });
  it('tolerates missing sortKeys', () => {
    expect(collapseKey(undefined, 0)).toBe('0|');
  });
});

describe('makeAccountCol', () => {
  it('inherits parent attributes and copies the sort-keys', () => {
    const parent = { id: 'u1', jobTitle: 'Dev', department: 'Eng' };
    const keys = ['Eng'];
    const col = makeAccountCol(parent, { id: 'a1', displayName: 'Acc', isPrimary: true }, keys);
    expect(col).toMatchObject({ id: 'a1', displayName: 'Acc', jobTitle: 'Dev', department: 'Eng', isAccountCol: true, parentId: 'u1', isPrimary: true });
    expect(col.sortKeys).toEqual(['Eng']);
    expect(col.sortKeys).not.toBe(keys); // copied, not shared
  });
  it('falls back to the account id for a missing display name', () => {
    expect(makeAccountCol({ id: 'u1' }, { id: 'a1' }, []).displayName).toBe('a1');
  });
});

describe('buildColumns', () => {
  it('returns the subjects unchanged when nothing is folded', () => {
    const users = [sub('u1', ['Eng']), sub('u2', ['Sales'])];
    const { cols, userToAgg } = buildColumns(users, ctx());
    expect(cols).toEqual(users);
    expect(userToAgg.size).toBe(0);
  });

  it('folds subjects sharing a value into one aggregate column and maps them to it', () => {
    const users = [sub('u1', ['Eng']), sub('u2', ['Eng']), sub('u3', ['Sales'])];
    const key = collapseKey(['Eng'], 0);
    const { cols, userToAgg } = buildColumns(users, ctx({ collapsedGroups: new Set([key]) }));
    expect(cols).toHaveLength(2); // one aggregate (Eng) + u3
    const agg = cols[0];
    expect(agg).toMatchObject({ isAggregateCol: true, level: 0, userCount: 2, displayName: 'Eng', memberType: 'Aggregate' });
    expect(agg.sortKeys[0]).toBe('Eng');
    expect(userToAgg.get('u1')).toBe(agg.id);
    expect(userToAgg.get('u2')).toBe(agg.id);
    expect(cols[1].id).toBe('u3');
  });

  it('stamps a sentinel below the collapse level so two aggregates never fuse', () => {
    const users = [sub('u1', ['Eng', 'A']), sub('u2', ['Eng', 'B'])];
    const key = collapseKey(['Eng', 'A'], 0);
    const { cols } = buildColumns(users, ctx({
      sortAttrs: [{ attribute: 'department' }, { attribute: 'jobTitle' }],
      collapsedGroups: new Set([key]),
    }));
    expect(cols[0].sortKeys[1]).toContain(AGG_SENTINEL);
    expect(cols[0].childCounts[1]).toBe(2); // A and B are two distinct children
  });

  it('member-expanded "all" shows every folded subject as its own column', () => {
    const users = [sub('u1', ['Eng']), sub('u2', ['Eng'])];
    const key = collapseKey(['Eng'], 0);
    const { cols } = buildColumns(users, ctx({
      collapsedGroups: new Set([key]),
      memberExpanded: new Map([[key, 'all']]),
    }));
    expect(cols.map(c => c.id)).toEqual(['u1', 'u2']);
    expect(cols.every(c => c.isMemberCol)).toBe(true);
  });

  it('member-expanded "direct" keeps only subjects whose path ends at the level', () => {
    const users = [sub('u1', ['Eng', 'Deep']), sub('u2', ['Eng', ''])];
    const key = collapseKey(['Eng', 'Deep'], 0);
    const { cols } = buildColumns(users, ctx({
      sortAttrs: [{ attribute: 'department' }, { attribute: 'jobTitle' }],
      collapsedGroups: new Set([key]),
      memberExpanded: new Map([[key, 'direct']]),
    }));
    expect(cols.map(c => c.id)).toEqual(['u2']); // u1 has a deeper level, excluded
  });

  it('splices per-account sub-columns after an expanded identity', () => {
    const users = [sub('u1', ['Eng'], { memberType: 'Identity' })];
    const { cols } = buildColumns(users, ctx({
      expandedIdentities: new Set(['u1']),
      accountMatrixCache: new Map([['u1', { accounts: [{ id: 'a1', displayName: 'Acc 1' }] }]]),
    }));
    expect(cols.map(c => c.id)).toEqual(['u1', 'a1']);
    expect(cols[1].isAccountCol).toBe(true);
  });
});

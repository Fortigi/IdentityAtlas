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
  it('carries the parent subject itself, which the header spans over its accounts', () => {
    // The expanded identity has no column of its own, so this reference is the
    // only way the names row can still draw it.
    const parent = { id: 'u1', displayName: 'Alice', memberType: 'Identity' };
    expect(makeAccountCol(parent, { id: 'a1' }, []).parent).toBe(parent);
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

  it('replaces an expanded identity with one column per linked account', () => {
    // #1212: expanding drills into the accounts — the identity's own combined
    // column is what you get back by collapsing, not an extra column beside them.
    const users = [sub('u1', ['Eng'], { memberType: 'Identity' }), sub('u2', ['Sales'])];
    const { cols } = buildColumns(users, ctx({
      expandedIdentities: new Set(['u1']),
      accountMatrixCache: new Map([['u1', {
        accounts: [{ id: 'a1', displayName: 'Acc 1' }, { id: 'a2', displayName: 'Acc 2' }],
      }]]),
    }));
    expect(cols.map(c => c.id)).toEqual(['a1', 'a2', 'u2']);
    expect(cols.every(c => c.id === 'u2' || c.isAccountCol)).toBe(true);
    expect(cols[0].parent).toBe(users[0]);
  });

  it('keeps an expanded identity that has no linked account as its own column', () => {
    // Otherwise the subject would disappear from the grid entirely on expand.
    const users = [sub('u1', ['Eng'], { memberType: 'Identity' })];
    const { cols } = buildColumns(users, ctx({
      expandedIdentities: new Set(['u1']),
      accountMatrixCache: new Map([['u1', { accounts: [] }]]),
    }));
    expect(cols.map(c => c.id)).toEqual(['u1']);
    expect(cols[0].isAccountCol).toBeUndefined();
  });

  it('keeps an expanded identity whose accounts have not been loaded yet', () => {
    // The cache entry is written before the identity is marked expanded, but a
    // failed load (or a cache dropped on a filter change) can leave the two out
    // of step — the subject must keep its column rather than disappear.
    const users = [sub('u1', ['Eng'], { memberType: 'Identity' })];
    const { cols } = buildColumns(users, ctx({ expandedIdentities: new Set(['u1']) }));
    expect(cols).toEqual(users);
  });

  it('expands a member-exploded identity into its accounts too', () => {
    const users = [sub('u1', ['Eng'], { memberType: 'Identity' }), sub('u2', ['Eng'])];
    const key = collapseKey(['Eng'], 0);
    const { cols } = buildColumns(users, ctx({
      collapsedGroups: new Set([key]),
      memberExpanded: new Map([[key, 'all']]),
      expandedIdentities: new Set(['u1']),
      accountMatrixCache: new Map([['u1', { accounts: [{ id: 'a1', displayName: 'Acc 1' }] }]]),
    }));
    expect(cols.map(c => c.id)).toEqual(['a1', 'u2']);
    // The account inherits the member column's truncated sort-keys, so the
    // merged header span above it stays contiguous.
    expect(cols[0].sortKeys).toEqual(['Eng']);
    expect(cols[0].parent.isMemberCol).toBe(true);
  });
});

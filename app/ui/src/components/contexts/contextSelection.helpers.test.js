import { describe, it, expect } from 'vitest';
import { viewKeyOf, selectedIdFor, forgetView, rootContaining, isMemberMovableTree } from './contextSelection.helpers';

describe('viewKeyOf', () => {
  it('keys Organisation by kind and every other tab by itself', () => {
    expect(viewKeyOf('OrganizationalUnit', 'Principal')).toBe('OrganizationalUnit:Principal');
    expect(viewKeyOf('OrganizationalUnit', 'Identity')).not.toBe(viewKeyOf('OrganizationalUnit', 'Principal'));
    expect(viewKeyOf('Tag', 'Principal')).toBe('Tag');
  });
});

describe('selectedIdFor', () => {
  const roots = [{ id: 'r1' }, { id: 'r2' }];
  it('prefers the remembered context of this view', () => {
    expect(selectedIdFor({ Tag: 'c9', Segment: 'c1' }, 'Tag', roots)).toBe('c9');
  });
  it('falls back to the first root, then to nothing', () => {
    expect(selectedIdFor({ Segment: 'c1' }, 'Tag', roots)).toBe('r1');
    expect(selectedIdFor(null, 'Tag', roots)).toBe('r1');
    expect(selectedIdFor({}, 'Tag', [])).toBeNull();
    expect(selectedIdFor({}, 'Tag', undefined)).toBeNull();
  });
});

describe('forgetView', () => {
  it('drops only this view, without touching the original', () => {
    const remembered = { Tag: 'a', Segment: 'b' };
    expect(forgetView(remembered, 'Tag')).toEqual({ Segment: 'b' });
    expect(remembered).toEqual({ Tag: 'a', Segment: 'b' });
    expect(forgetView(null, 'Tag')).toEqual({});
  });
});

describe('rootContaining', () => {
  const forest = [
    { id: 'r1', children: [{ id: 'a', children: [{ id: 'a1' }] }] },
    { id: 'r2', children: [] },
    { id: 'r3' },
  ];
  it('finds the root of a deep node, of a root itself, and of a childless root', () => {
    expect(rootContaining(forest, 'a1').id).toBe('r1');
    expect(rootContaining(forest, 'r2').id).toBe('r2');
    expect(rootContaining(forest, 'r3').id).toBe('r3');
  });
  it('is null for an unknown or empty id, or no forest', () => {
    expect(rootContaining(forest, 'zz')).toBeNull();
    expect(rootContaining(forest, null)).toBeNull();
    expect(rootContaining(null, 'a')).toBeNull();
  });
});

describe('isMemberMovableTree', () => {
  it('is true only for a tree the manager-hierarchy plugin produced', () => {
    expect(isMemberMovableTree({ sourceAlgorithmName: 'manager-hierarchy' })).toBe(true);
    expect(isMemberMovableTree({ sourceAlgorithmName: 'department-tree', contextType: 'ManagerHierarchy' })).toBe(false);
    expect(isMemberMovableTree(null)).toBe(false);
  });
});

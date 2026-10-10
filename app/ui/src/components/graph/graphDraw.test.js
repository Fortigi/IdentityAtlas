import { describe, it, expect } from 'vitest';
import { NODE_CLASS, nodeClass, truncate, canOpen, nodeAriaLabel, edgeGeometry } from '@ui/components/graph/graphDraw';

describe('nodeClass', () => {
  it('picks the root, open, organisation, cluster and plain palettes', () => {
    expect(nodeClass({ root: true, kind: 'entity', entityKind: 'org-entity' }, true)).toBe(NODE_CLASS.root);
    expect(nodeClass({ kind: 'cluster' }, false)).toBe(NODE_CLASS.cluster);
    expect(nodeClass({ kind: 'more' }, false)).toBe(NODE_CLASS.more);
    expect(nodeClass({ kind: 'entity', entityKind: 'org-entity' }, true)).toBe(NODE_CLASS.open);
    expect(nodeClass({ kind: 'entity', entityKind: 'org-entity' }, false)).toBe(NODE_CLASS.org);
    expect(nodeClass({ kind: 'entity', entityKind: 'user' }, false)).toBe(NODE_CLASS.entity);
    expect(new Set(Object.values(NODE_CLASS)).size).toBe(6);
  });

  it('every palette has a dark-mode fill and stroke', () => {
    for (const cls of Object.values(NODE_CLASS)) {
      expect(cls).toMatch(/dark:fill-/);
      expect(cls).toMatch(/dark:stroke-/);
    }
  });
});

describe('truncate', () => {
  it('cuts with an ellipsis only past the limit', () => {
    expect(truncate('abcdef', 6)).toBe('abcdef');
    expect(truncate('abcdefg', 6)).toBe('abcde…');
    expect(truncate(null, 4)).toBe('');
    expect(truncate(42, 4)).toBe('42');
  });
});

describe('canOpen', () => {
  it('opens other objects that have a detail page, not the page itself, a leaf or a cluster', () => {
    expect(canOpen({ key: 'user:u1', kind: 'entity', entityKind: 'user' }, 'resource:g1')).toBe(true);
    expect(canOpen({ key: 'org-entity:k1', kind: 'entity', entityKind: 'org-entity' }, 'resource:g1')).toBe(true);
    expect(canOpen({ key: 'resource:g1', kind: 'entity', entityKind: 'resource' }, 'resource:g1')).toBe(false);
    expect(canOpen({ key: 'leaf:p1', kind: 'entity', entityKind: 'leaf' }, 'resource:g1')).toBe(false);
    expect(canOpen({ key: 'cluster:x', kind: 'cluster' }, 'resource:g1')).toBe(false);
  });
});

describe('nodeAriaLabel', () => {
  it('says what the node is and what pressing it does', () => {
    expect(nodeAriaLabel({ kind: 'entity', typeLabel: 'Klant', label: 'Northwind' }, false)).toBe('Klant Northwind, press to expand');
    expect(nodeAriaLabel({ kind: 'entity', typeLabel: 'Group', label: 'GRP' }, true)).toBe('Group GRP, expanded, press to collapse');
    expect(nodeAriaLabel({ kind: 'cluster', count: 12, label: 'Direct Members' }, false)).toBe('12 Direct Members, press to show them');
    expect(nodeAriaLabel({ kind: 'more', label: '+5 more in the list below' }, false)).toBe('+5 more in the list below');
  });
});

describe('edgeGeometry', () => {
  it('runs rim to rim, stopping short of the target for the arrowhead, label at the middle', () => {
    expect(edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 30, 20)).toEqual({ x1: 30, y1: 0, x2: 76, y2: 0, mx: 50, my: 0 });
    const g = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: -50 }, 10, 10);
    expect([g.x1, g.y1, g.x2, g.y2, g.my]).toEqual([0, -10, 0, -36, -25]);
  });

  it('copes with two nodes on the same spot', () => {
    expect(edgeGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, 10, 10)).toEqual({ x1: 5, y1: 5, x2: 5, y2: 5, mx: 5, my: 5 });
  });
});

import { describe, it, expect } from 'vitest';
import {
  CLUSTER_THRESHOLD,
  CLUSTER_ITEM_CAP,
  initialGraph,
  expandNode,
  openCluster,
  collapseNode,
  addEdge,
  entityNode,
  typeLabelOf,
  isClustered,
  isExpanded,
  edgeLabel,
  clusterKey,
} from '@ui/components/graph/graphModel';

const item = (entityKind, entityId, extra = {}) => ({ key: `${entityKind}:${entityId}`, label: entityId.toUpperCase(), kind: 'item', entityKind, entityId, ...extra });
const rel = (key, label, dir, items, extra = {}) => ({ key, title: key, label, dir, count: items ? items.length : 0, items, ...extra });
const keys = (state) => Object.keys(state.nodes).sort();
const edgeOf = (state, a, b) => Object.values(state.edges).find(e => (e.from === a && e.to === b) || (e.from === b && e.to === a));

const ROOT = { key: 'resource:g1', entityKind: 'resource', entityId: 'g1', label: 'GRP-Northwind', typeLabel: 'Group' };

describe('the group ↔ organisation entity cycle', () => {
  // The group is linked by name to a customer; the customer's own links lead
  // back to the group. One edge, no second copy of the group.
  const groupSide = [
    rel('members-direct', 'member of', 'in', [item('user', 'u1'), item('user', 'u2')]),
    rel('org:direct|Klant|displayName', 'name', 'out', [item('org-entity', 'k1', { resourceType: 'Klant' })]),
  ];
  const customerSide = [
    rel('link:Resource', 'linked', 'in', [item('resource', 'g1', { resourceType: 'Group' }), item('resource', 'g2')], { generic: true }),
    rel('rel:out:eigenaar', 'eigenaar', 'out', [item('org-entity', 'p1', { resourceType: 'Person' })]),
  ];

  it('draws the organisation entity as a direct neighbour with ONE edge labelled by the link attribute', () => {
    const s = expandNode(initialGraph(ROOT), 'resource:g1', groupSide);
    expect(keys(s)).toEqual(['org-entity:k1', 'resource:g1', 'user:u1', 'user:u2']);
    expect(s.nodes['org-entity:k1']).toMatchObject({ kind: 'entity', typeLabel: 'Klant', origin: 'resource:g1' });
    expect(edgeOf(s, 'resource:g1', 'org-entity:k1')).toMatchObject({ from: 'resource:g1', to: 'org-entity:k1', labels: ['name'] });
    expect(Object.keys(s.edges)).toHaveLength(3);
  });

  it('expanding the customer brings the group back as an EDGE to the existing node, not a second node', () => {
    let s = expandNode(initialGraph(ROOT), 'resource:g1', groupSide);
    s = expandNode(s, 'org-entity:k1', customerSide);
    // g1 once, plus the customer's other group and its owner.
    expect(keys(s)).toEqual(['org-entity:k1', 'org-entity:p1', 'resource:g1', 'resource:g2', 'user:u1', 'user:u2']);
    const cycle = edgeOf(s, 'resource:g1', 'org-entity:k1');
    // The specific "name" stays; the generic "linked" from the customer side does not stack on it.
    expect(cycle).toMatchObject({ from: 'resource:g1', to: 'org-entity:k1', labels: ['name'], by: ['resource:g1', 'org-entity:k1'] });
    expect(Object.values(s.edges).map(e => `${e.from}>${e.to}:${edgeLabel(e)}`).sort()).toEqual([
      'org-entity:k1>org-entity:p1:eigenaar',
      'resource:g1>org-entity:k1:name',
      'resource:g2>org-entity:k1:linked',
      'user:u1>resource:g1:member of',
      'user:u2>resource:g1:member of',
    ]);
    expect(s.expanded).toEqual(['resource:g1', 'org-entity:k1']);
  });

  it('a specific label seen later replaces a generic one, direction included', () => {
    const klant = { key: 'org-entity:k1', entityKind: 'org-entity', entityId: 'k1', label: 'Northwind', typeLabel: 'Klant' };
    let s = expandNode(initialGraph(klant), 'org-entity:k1', customerSide);
    expect(edgeOf(s, 'resource:g1', 'org-entity:k1')).toMatchObject({ from: 'resource:g1', to: 'org-entity:k1', labels: ['linked'], generic: true });
    s = expandNode(s, 'resource:g1', groupSide);
    expect(edgeOf(s, 'resource:g1', 'org-entity:k1')).toMatchObject({ labels: ['name'], generic: false });
    expect(keys(s).filter(k => k === 'org-entity:k1')).toHaveLength(1);
  });
});

describe('addEdge', () => {
  it('keeps one edge per pair, adds a second specific label once, ignores a later generic one', () => {
    let edges = addEdge({}, { from: 'a', to: 'b', label: 'member of' }, 'a');
    edges = addEdge(edges, { from: 'b', to: 'a', label: 'owner' }, 'b');
    edges = addEdge(edges, { from: 'a', to: 'b', label: 'owner' }, 'b');
    edges = addEdge(edges, { from: 'b', to: 'a', label: 'linked', generic: true }, 'c');
    expect(Object.values(edges)).toEqual([
      { key: 'a|b', from: 'a', to: 'b', labels: ['member of', 'owner'], generic: false, by: ['a', 'b', 'c'] },
    ]);
  });

  it('keys the pair the same way round whichever end comes first', () => {
    const edges = addEdge({}, { from: 'z', to: 'a', label: 'x' }, 'z');
    expect(Object.keys(edges)).toEqual(['a|z']);
    expect(edges['a|z']).toMatchObject({ from: 'z', to: 'a' });
  });

  it('a generic edge seen again generically keeps its label', () => {
    let edges = addEdge({}, { from: 'a', to: 'b', label: 'linked', generic: true }, 'a');
    edges = addEdge(edges, { from: 'b', to: 'a', label: 'other', generic: true }, 'b');
    expect(edges['a|b']).toMatchObject({ labels: ['linked'], generic: true, from: 'a', to: 'b' });
  });
});

describe('clusters', () => {
  const users = (n) => Array.from({ length: n }, (_, i) => item('user', `u${i}`));

  it(`draws up to ${CLUSTER_THRESHOLD} objects inline and more as ONE cluster node`, () => {
    const inline = expandNode(initialGraph(ROOT), 'resource:g1', [rel('members-direct', 'member of', 'in', users(CLUSTER_THRESHOLD))]);
    expect(keys(inline)).toHaveLength(CLUSTER_THRESHOLD + 1);
    expect(Object.values(inline.nodes).some(n => n.kind === 'cluster')).toBe(false);

    const many = rel('members-direct', 'member of', 'in', users(CLUSTER_THRESHOLD + 1), { title: 'Direct Members' });
    const clustered = expandNode(initialGraph(ROOT), 'resource:g1', [many]);
    expect(keys(clustered)).toEqual([clusterKey('resource:g1', 'members-direct'), 'resource:g1']);
    expect(clustered.nodes[clusterKey('resource:g1', 'members-direct')]).toMatchObject({
      kind: 'cluster', label: 'Direct Members', count: 9, typeLabel: '9', origin: 'resource:g1',
    });
    expect(Object.values(clustered.edges)).toEqual([expect.objectContaining({
      from: clusterKey('resource:g1', 'members-direct'), to: 'resource:g1', labels: ['member of'],
    })]);
  });

  it('a relation whose objects are not loaded is a cluster with the server count; an empty one is not drawn', () => {
    const s = expandNode(initialGraph(ROOT), 'resource:g1', [
      { key: 'contexts', title: 'Contexts', label: 'in context', dir: 'out', count: 120, items: null },
      { key: 'parents', title: 'Member Of', label: 'member of', dir: 'out', count: 0, items: null },
      rel('business-roles', 'contains', 'in', []),
    ]);
    expect(keys(s)).toEqual(['cluster:resource:g1:contexts', 'resource:g1']);
    expect(s.nodes['cluster:resource:g1:contexts'].count).toBe(120);
    expect(isClustered({ items: null })).toBe(true);
    expect(isClustered({ items: users(CLUSTER_THRESHOLD) })).toBe(false);
    expect(isClustered({ items: users(CLUSTER_THRESHOLD + 1) })).toBe(true);
    // A relation may ask for a cluster however few its objects (organisation relations do).
    expect(isClustered({ items: users(2), cluster: true })).toBe(true);
    expect(isClustered({ items: users(2), cluster: false })).toBe(false);
  });

  it(`opening a cluster replaces it by its first ${CLUSTER_ITEM_CAP} objects plus a "+N more" node`, () => {
    const big = { key: 'members-direct', title: 'Direct Members', label: 'member of', dir: 'in', count: 45, items: null };
    let s = expandNode(initialGraph(ROOT), 'resource:g1', [big]);
    s = openCluster(s, 'cluster:resource:g1:members-direct', users(45));
    expect(s.nodes['cluster:resource:g1:members-direct']).toBeUndefined();
    const kinds = Object.values(s.nodes).map(n => n.kind);
    expect(kinds.filter(k => k === 'entity')).toHaveLength(CLUSTER_ITEM_CAP + 1);
    expect(s.nodes['more:cluster:resource:g1:members-direct']).toMatchObject({ kind: 'more', label: '+5 more in the list below' });
    // Every object hangs off the cluster's source and belongs to its expansion.
    expect(edgeOf(s, 'user:u0', 'resource:g1')).toMatchObject({ from: 'user:u0', to: 'resource:g1', by: ['resource:g1'] });
    expect(edgeOf(s, 'user:u40', 'resource:g1')).toBeUndefined();
  });

  it('exactly the cap needs no "+N more" node; an unknown cluster key changes nothing', () => {
    const big = { key: 'm', title: 'M', label: 'member of', dir: 'in', count: CLUSTER_ITEM_CAP, items: null };
    let s = expandNode(initialGraph(ROOT), 'resource:g1', [big]);
    s = openCluster(s, 'cluster:resource:g1:m', users(CLUSTER_ITEM_CAP));
    expect(Object.values(s.nodes).some(n => n.kind === 'more')).toBe(false);
    expect(openCluster(s, 'cluster:nope', users(3))).toBe(s);
  });
});

describe('collapse', () => {
  const A = item('user', 'a');
  const B = item('user', 'b');
  const C = item('context', 'c');
  function opened() {
    let s = expandNode(initialGraph(ROOT), 'resource:g1', [rel('members-direct', 'member of', 'in', [A, B])]);
    // a's expansion reaches c, and b, which the root already holds.
    s = expandNode(s, 'user:a', [rel('contexts', 'in context', 'out', [C]), rel('owners', 'owner', 'in', [B])]);
    return s;
  }

  it('removes only the neighbours nothing else holds', () => {
    const s = collapseNode(opened(), 'user:a');
    expect(keys(s)).toEqual(['resource:g1', 'user:a', 'user:b']);
    expect(edgeOf(s, 'user:a', 'user:b')).toBeUndefined();
    expect(edgeOf(s, 'user:b', 'resource:g1')).toMatchObject({ labels: ['member of'] });
    expect(s.expanded).toEqual(['resource:g1']);
    expect(isExpanded(s, 'user:a')).toBe(false);
  });

  it('an edge drawn by two expansions survives collapsing one of them', () => {
    let s = expandNode(opened(), 'user:b', [rel('owners', 'owner', 'out', [A])]);
    s = collapseNode(s, 'user:a');
    expect(edgeOf(s, 'user:a', 'user:b')).toMatchObject({ by: ['user:b'] });
    expect(keys(s)).toEqual(['resource:g1', 'user:a', 'user:b']);
  });

  it('collapsing the root drops everything cut off from it, open nodes included', () => {
    const s = collapseNode(opened(), 'resource:g1');
    expect(keys(s)).toEqual(['resource:g1']);
    expect(s.edges).toEqual({});
    expect(s.expanded).toEqual([]);
  });
});

describe('expandNode edge cases', () => {
  it('draws "in" relations item → source and "out" relations source → item', () => {
    const s = expandNode(initialGraph(ROOT), 'resource:g1', [
      rel('members-direct', 'member of', 'in', [item('user', 'u1')]),
      rel('parents', 'member of', 'out', [item('resource', 'p1')]),
    ]);
    expect(edgeOf(s, 'user:u1', 'resource:g1')).toMatchObject({ from: 'user:u1', to: 'resource:g1' });
    expect(edgeOf(s, 'resource:p1', 'resource:g1')).toMatchObject({ from: 'resource:g1', to: 'resource:p1' });
  });

  it('uses a per-object edge label when there is one, and never links an object to itself', () => {
    const s = expandNode(initialGraph(ROOT), 'resource:g1', [
      rel('parents', 'member of', 'out', [item('resource', 'g1'), item('resource', 'o1', { edgeLabel: 'owner' })]),
    ]);
    expect(keys(s)).toEqual(['resource:g1', 'resource:o1']);
    expect(edgeOf(s, 'resource:g1', 'resource:o1').labels).toEqual(['owner']);
  });

  it('ignores an unknown source and records an expansion once', () => {
    const s0 = initialGraph(ROOT);
    expect(expandNode(s0, 'user:ghost', [rel('x', 'x', 'out', [item('user', 'u1')])])).toBe(s0);
    const twice = expandNode(expandNode(s0, 'resource:g1', []), 'resource:g1', []);
    expect(twice.expanded).toEqual(['resource:g1']);
  });

  it('keeps the first drawing of a node it meets again', () => {
    let s = expandNode(initialGraph(ROOT), 'resource:g1', [rel('m', 'member of', 'in', [item('user', 'u1')])]);
    s = expandNode(s, 'user:u1', [rel('mgr', 'reports to', 'out', [item('user', 'u2')])]);
    s = expandNode(s, 'user:u2', [rel('rep', 'reports to', 'in', [item('user', 'u1', { label: 'Renamed' })])]);
    expect(s.nodes['user:u1']).toMatchObject({ label: 'U1', origin: 'resource:g1' });
  });
});

describe('node shapes', () => {
  it('names the type: the resource type first, else the entity kind, else Item', () => {
    expect(typeLabelOf({ entityKind: 'resource', resourceType: 'Group' })).toBe('Group');
    expect(typeLabelOf({ entityKind: 'org-entity', resourceType: 'Klant' })).toBe('Klant');
    expect(typeLabelOf({ entityKind: 'user' })).toBe('User');
    expect(typeLabelOf({ entityKind: 'access-package' })).toBe('Business Role');
    expect(typeLabelOf({ entityKind: 'identity' })).toBe('Identity');
    expect(typeLabelOf({ entityKind: 'context' })).toBe('Context');
    expect(typeLabelOf({ entityKind: 'org-entity' })).toBe('Organisation');
    expect(typeLabelOf({ entityKind: 'resource' })).toBe('Resource');
    expect(typeLabelOf({ entityKind: 'leaf' })).toBe('Item');
  });

  it('keys a node by kind and id whatever key the list item had, and falls back on its label', () => {
    expect(entityNode({ key: 'resource:r1:p9', entityKind: 'resource', entityId: 'r1', label: 'R' }))
      .toEqual({ key: 'resource:r1', kind: 'entity', entityKind: 'resource', entityId: 'r1', label: 'R', typeLabel: 'Resource' });
    expect(entityNode({ entityKind: 'user', entityId: 'u9' }).label).toBe('u9');
    expect(entityNode({ entityKind: 'user', entityId: '' }).label).toBe('(unknown)');
  });

  it('starts with the root alone, marked as root', () => {
    const s = initialGraph(ROOT);
    expect(s).toEqual({ rootKey: 'resource:g1', nodes: { 'resource:g1': { ...ROOT, kind: 'entity', root: true } }, edges: {}, expanded: [] });
  });
});

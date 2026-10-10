// ─── Relationship graph: the model ───────────────────────────────────
// A graph of OBJECTS and labelled EDGES, as shown on every entity detail page.
//
//   node  { key, kind: 'entity' | 'cluster' | 'more', label, typeLabel,
//           entityKind?, entityId?, count?, root?, origin?, cluster? }
//         An entity node is keyed `${entityKind}:${entityId}` and exists ONCE on
//         the canvas, however many relations lead to it — so a relation back to
//         an object already drawn becomes an edge to that node (a cycle shows
//         as a cycle), never a second copy.
//   edge  { key, from, to, labels, generic, by }
//         One edge per pair of nodes. `by` lists the expansions that drew it;
//         `generic` marks a label that only says "linked" (an organisation link
//         seen from the organisation side), which a specific label ("name",
//         "eigenaar") replaces whenever the same link is seen from the system side.
//
// A relation (from graphNeighbours.js) is
//   { key, title, label, dir: 'out' | 'in', count, items: [listItem] | null,
//     generic?, note?, categoryKey?, source? }
// where `dir: 'out'` draws source → item and 'in' item → source, and a list item
// is the shape ExpandedItemsList shows ({ key, label, entityKind, entityId,
// resourceType?, detail?, edgeLabel? }). A relation with more than
// CLUSTER_THRESHOLD objects (or whose objects are not loaded yet) is drawn as
// ONE cluster node; opening it replaces it by its first CLUSTER_ITEM_CAP objects.
//
// Expansion accumulates: several nodes can be open at once. Collapsing a node
// drops the edges its expansion drew and then every node no longer connected to
// the root, so a neighbour another open node still holds stays.

export const CLUSTER_THRESHOLD = 8;
export const CLUSTER_ITEM_CAP = 40;

const TYPE_LABEL = {
  user: 'User',
  resource: 'Resource',
  'access-package': 'Business Role',
  identity: 'Identity',
  context: 'Context',
  'org-entity': 'Organisation',
};

export const nodeKey = (entityKind, entityId) => `${entityKind}:${entityId}`;

export function typeLabelOf(item) {
  return item.resourceType || TYPE_LABEL[item.entityKind] || 'Item';
}

export function entityNode(item) {
  return {
    key: nodeKey(item.entityKind, item.entityId),
    kind: 'entity',
    entityKind: item.entityKind,
    entityId: item.entityId,
    label: item.label || item.entityId || '(unknown)',
    typeLabel: typeLabelOf(item),
  };
}

export function initialGraph(root) {
  return {
    rootKey: root.key,
    nodes: { [root.key]: { ...root, kind: 'entity', root: true } },
    edges: {},
    expanded: [],
  };
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// The labels an existing edge keeps when the same pair is drawn again.
function mergedLabels(prev, label, generic) {
  if (generic) return { labels: prev.labels, generic: prev.generic };
  if (prev.generic) return { labels: [label], generic: false };
  return { labels: prev.labels.includes(label) ? prev.labels : [...prev.labels, label], generic: false };
}

export function addEdge(edges, { from, to, label, generic = false }, owner) {
  const key = pairKey(from, to);
  const prev = edges[key];
  if (!prev) return { ...edges, [key]: { key, from, to, labels: [label], generic, by: [owner] } };
  const merged = mergedLabels(prev, label, generic);
  // A specific label replacing a generic one also brings its direction.
  const direction = prev.generic && !generic ? { from, to } : {};
  const by = prev.by.includes(owner) ? prev.by : [...prev.by, owner];
  return { ...edges, [key]: { ...prev, ...merged, ...direction, by } };
}

function addNode(nodes, node, origin) {
  if (nodes[node.key]) return nodes;
  return { ...nodes, [node.key]: { ...node, origin } };
}

function link(state, sourceKey, relation, node, label) {
  const ends = relation.dir === 'in' ? { from: node.key, to: sourceKey } : { from: sourceKey, to: node.key };
  return {
    ...state,
    nodes: addNode(state.nodes, node, sourceKey),
    edges: addEdge(state.edges, { ...ends, label, generic: relation.generic }, sourceKey),
  };
}

function addItems(state, sourceKey, relation, items) {
  let next = state;
  for (const item of items) {
    const node = entityNode(item);
    if (node.key === sourceKey) continue;
    next = link(next, sourceKey, relation, node, item.edgeLabel || relation.label);
  }
  return next;
}

export const clusterKey = (sourceKey, relationKey) => `cluster:${sourceKey}:${relationKey}`;

function addCluster(state, sourceKey, relation) {
  const count = relation.count ?? relation.items?.length ?? 0;
  const node = {
    key: clusterKey(sourceKey, relation.key),
    kind: 'cluster',
    label: relation.title,
    typeLabel: String(count),
    count,
    cluster: { sourceKey, relation },
  };
  return link(state, sourceKey, relation, node, relation.label);
}

function relationSize(relation) {
  return relation.items ? relation.items.length : Number(relation.count) || 0;
}

// Inline when the objects are loaded and few enough; a cluster otherwise, or
// when the relation asks for one (`cluster: true` — organisation relations
// bundle every entity of one type behind a single node with the count).
export function isClustered(relation) {
  return relation.cluster === true || !relation.items || relation.items.length > CLUSTER_THRESHOLD;
}

export function expandNode(state, sourceKey, relations) {
  if (!state.nodes[sourceKey]) return state;
  let next = state;
  for (const relation of relations) {
    if (relationSize(relation) === 0) continue;
    next = isClustered(relation)
      ? addCluster(next, sourceKey, relation)
      : addItems(next, sourceKey, relation, relation.items);
  }
  const expanded = next.expanded.includes(sourceKey) ? next.expanded : [...next.expanded, sourceKey];
  return { ...next, expanded };
}

function withoutNode(state, key) {
  const nodes = { ...state.nodes };
  delete nodes[key];
  const edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => e.from !== key && e.to !== key));
  return { ...state, nodes, edges };
}

// Replace a cluster by its objects (the first CLUSTER_ITEM_CAP, plus a "+N more"
// node for the rest). The objects belong to the cluster's source expansion, so
// collapsing that source removes them again.
export function openCluster(state, key, items) {
  const cluster = state.nodes[key]?.cluster;
  if (!cluster) return state;
  const { sourceKey, relation } = cluster;
  let next = addItems(withoutNode(state, key), sourceKey, relation, items.slice(0, CLUSTER_ITEM_CAP));
  const rest = items.length - CLUSTER_ITEM_CAP;
  if (rest > 0) {
    const more = { key: `more:${key}`, kind: 'more', label: `+${rest} more in the list below`, typeLabel: `+${rest}` };
    next = link(next, sourceKey, relation, more, relation.label);
  }
  return next;
}

function reachableFrom(rootKey, edges) {
  const adjacent = new Map();
  for (const e of edges) {
    adjacent.set(e.from, [...(adjacent.get(e.from) || []), e.to]);
    adjacent.set(e.to, [...(adjacent.get(e.to) || []), e.from]);
  }
  const seen = new Set([rootKey]);
  const queue = [rootKey];
  while (queue.length > 0) {
    for (const next of adjacent.get(queue.shift()) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

export function collapseNode(state, key) {
  const kept = Object.values(state.edges)
    .map(e => ({ ...e, by: e.by.filter(b => b !== key) }))
    .filter(e => e.by.length > 0);
  const alive = reachableFrom(state.rootKey, kept);
  return {
    ...state,
    nodes: Object.fromEntries(Object.entries(state.nodes).filter(([k]) => alive.has(k))),
    edges: Object.fromEntries(kept.filter(e => alive.has(e.from) && alive.has(e.to)).map(e => [e.key, e])),
    expanded: state.expanded.filter(k => k !== key && alive.has(k)),
  };
}

export const isExpanded = (state, key) => state.expanded.includes(key);

export function edgeLabel(edge) {
  return edge.labels.join(' · ');
}

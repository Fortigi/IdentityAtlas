import { useEffect, useReducer, useRef, useState } from 'react';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';
import { graphReducer, initGraphState } from '@ui/components/graph/graphState';
import { isExpanded, nodeKey } from '@ui/components/graph/graphModel';
import { loadNeighbours, relationItems } from '@ui/components/graph/graphNeighbours';

// ─── useRelationGraph ────────────────────────────────────────────────
// Drives the relationship graph of an entity detail page
// (components/graph/RelationGraph.jsx). The page's own object is the root and
// starts expanded; clicking a node expands it (its neighbours join the canvas)
// or collapses it again; clicking a cluster replaces it by its objects and
// fills the list under the graph with all of them.
//
//   root      { kind, id, label, typeLabel } — the page's object
//   rootCore  the payload the page already loaded (its counts), so the root's
//             relations need no second fetch; null until it is there
//   rootExtras what entityGraphShape's fetchers need beyond the core. Pass a
//             stable (memoised) object: a new one restarts the graph.
//   enabled   false while the graph is not on screen (another tab): nothing is
//             fetched until it is shown once, and it is kept when hidden again
//
// Organisation links are fetched per expanded system object only when the
// orgTruth feature is on.

function rootNodeOf(root) {
  return { key: nodeKey(root.kind, root.id), entityKind: root.kind, entityId: root.id, label: root.label, typeLabel: root.typeLabel };
}

// Async work shared by the effect and the handlers. `ctx.generation` drops an
// answer that arrives after the graph was reset.
async function runExpand(ctx, key, source) {
  const generation = ctx.generation.current;
  ctx.dispatch({ type: 'loading', value: true });
  try {
    const result = await loadNeighbours(source, ctx.authFetch, { orgTruth: ctx.orgTruth });
    if (!result || generation !== ctx.generation.current) return;
    ctx.sources.current.set(key, { kind: source.kind, id: source.id, extras: result.extras });
    ctx.dispatch({ type: 'expand', key, relations: result.relations });
  } finally {
    ctx.dispatch({ type: 'loading', value: false });
  }
}

async function runOpenCluster(ctx, node, sourceLabel) {
  const { sourceKey, relation } = node.cluster;
  const source = ctx.sources.current.get(sourceKey);
  if (!source) return;
  ctx.dispatch({ type: 'loading', value: true });
  try {
    const items = await relationItems(source, relation, ctx.authFetch);
    ctx.dispatch({ type: 'cluster', key: node.key, items });
    ctx.dispatch({ type: 'list', list: { label: `${sourceLabel} → ${relation.title}`, items, note: relation.note || null } });
  } finally {
    ctx.dispatch({ type: 'loading', value: false });
  }
}

export default function useRelationGraph({ root, rootCore, rootExtras, authFetch, enabled = true }) {
  const orgTruth = useFeatureFlags().orgTruth === true;
  const { kind, id, label, typeLabel } = root;
  const rootKey = nodeKey(kind, id);
  const [state, dispatch] = useReducer(graphReducer, root, (r) => initGraphState(rootNodeOf(r)));
  const sources = useRef(new Map());
  const generation = useRef(0);
  const ctx = { dispatch, sources, generation, authFetch, orgTruth };
  // Shown at least once: derived state, set during render (no effect needed).
  const [shown, setShown] = useState(enabled);
  if (enabled && !shown) setShown(true);
  const core = shown ? rootCore : null;

  // (Re)start from the root, expanded, whenever the page's object or its core
  // changes. `ctx` is rebuilt from these same values, so it is not a dep.
  useEffect(() => {
    if (!core) return;
    generation.current += 1;
    sources.current = new Map();
    dispatch({ type: 'reset', root: rootNodeOf({ kind, id, label, typeLabel }) });
    runExpand({ dispatch, sources, generation, authFetch, orgTruth }, nodeKey(kind, id), { kind, id, core, extras: rootExtras });
  }, [kind, id, label, typeLabel, core, rootExtras, authFetch, orgTruth]);

  function sourceOf(node) {
    if (node.key === rootKey) return { kind, id, core: rootCore, extras: rootExtras };
    return { kind: node.entityKind, id: node.entityId };
  }

  function activate(node) {
    if (node.kind === 'cluster') {
      const source = state.nodes[node.cluster.sourceKey];
      return runOpenCluster(ctx, node, source?.label || '');
    }
    if (node.kind !== 'entity') return undefined;
    if (isExpanded(state, node.key)) {
      dispatch({ type: 'collapse', key: node.key });
      return undefined;
    }
    return runExpand(ctx, node.key, sourceOf(node));
  }

  function reset() {
    if (!core) return undefined;
    generation.current += 1;
    dispatch({ type: 'reset', root: rootNodeOf(root) });
    return runExpand(ctx, rootKey, sourceOf({ key: rootKey }));
  }

  return {
    rootKey,
    nodes: Object.values(state.nodes),
    edges: Object.values(state.edges),
    positions: state.positions,
    expanded: state.expanded,
    list: state.list,
    loading: state.loading,
    activate,
    reset,
    move: (key, x, y) => dispatch({ type: 'move', key, x, y }),
    pin: (key, x, y) => dispatch({ type: 'pin', key, x, y }),
  };
}

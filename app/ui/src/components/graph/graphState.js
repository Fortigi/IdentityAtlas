// ─── Relationship graph: the reducer ─────────────────────────────────
// The model (graphModel.js) plus where everything is drawn (graphLayout.js) and
// the list panel under the graph, as one reducer for useRelationGraph. Every
// structural change re-runs the layout from the previous positions, so existing
// nodes stay roughly where they were and new ones settle in beside them.
import { initialGraph, expandNode, openCluster, collapseNode } from './graphModel';
import { layoutGraph } from './graphLayout';

function relayout(state) {
  const positions = layoutGraph(Object.values(state.nodes), Object.values(state.edges), {
    prev: state.positions,
    pinned: state.pinned,
  });
  return { ...state, positions };
}

export function initGraphState(root) {
  return relayout({ ...initialGraph(root), positions: {}, pinned: {}, list: null, loading: false });
}

const HANDLERS = {
  reset: (_state, a) => initGraphState(a.root),
  expand: (state, a) => relayout(expandNode(state, a.key, a.relations)),
  collapse: (state, a) => relayout(collapseNode(state, a.key)),
  cluster: (state, a) => relayout(openCluster(state, a.key, a.items)),
  // While dragging only the dragged node moves; dropping pins it and lets the
  // rest settle around it.
  move: (state, a) => ({ ...state, positions: { ...state.positions, [a.key]: { x: a.x, y: a.y } } }),
  pin: (state, a) => relayout({ ...state, pinned: { ...state.pinned, [a.key]: { x: a.x, y: a.y } } }),
  loading: (state, a) => ({ ...state, loading: a.value }),
  list: (state, a) => ({ ...state, list: a.list }),
};

export function graphReducer(state, action) {
  const handle = HANDLERS[action.type];
  return handle ? handle(state, action) : state;
}

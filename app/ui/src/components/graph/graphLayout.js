// ─── Relationship graph: the layout ──────────────────────────────────
// Force-directed placement with d3-force: springs on the edges, repulsion
// between nodes, a collision radius per node, the root pinned at (0, 0) and a
// weak pull to the centre so a disconnected part cannot drift away.
//
// The simulation always runs to rest synchronously and the result is drawn; the
// motion the user sees is a CSS transition on the node positions, which the
// global prefers-reduced-motion rule switches off. That keeps the result
// deterministic (d3-force's jiggle uses a seeded generator) and testable.
//
// Placement is incremental: a node already on the canvas starts where it was,
// and a new node starts next to the node that introduced it (`origin`), spread
// by the golden angle so siblings do not start on top of each other. A node the
// user dragged is pinned where it was dropped.
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';

export const NODE_RADIUS = { root: 30, entity: 20, cluster: 24, more: 16 };
const SPAWN_DISTANCE = 70;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TICKS = 300;

export function radiusOf(node) {
  return node.root ? NODE_RADIUS.root : NODE_RADIUS[node.kind] || NODE_RADIUS.entity;
}

// Where a node starts: its previous position, else beside the node that
// introduced it, else the centre.
function startOf(node, index, prev) {
  if (prev[node.key]) return prev[node.key];
  const anchor = prev[node.origin] || { x: 0, y: 0 };
  const angle = index * GOLDEN_ANGLE;
  return { x: anchor.x + SPAWN_DISTANCE * Math.cos(angle), y: anchor.y + SPAWN_DISTANCE * Math.sin(angle) };
}

function simNode(node, index, prev, pinned) {
  const start = node.root ? { x: 0, y: 0 } : startOf(node, index, prev);
  const sim = { id: node.key, r: radiusOf(node), x: start.x, y: start.y };
  const fixed = node.root ? { x: 0, y: 0 } : pinned[node.key];
  if (fixed) { sim.fx = fixed.x; sim.fy = fixed.y; }
  return sim;
}

/**
 * nodes: [{ key, kind, root?, origin? }], edges: [{ from, to }]
 * prev: { key: { x, y } } — the positions drawn last time
 * pinned: { key: { x, y } } — nodes the user dropped somewhere
 * → { key: { x, y } }
 */
export function layoutGraph(nodes, edges, { prev = {}, pinned = {}, ticks = TICKS } = {}) {
  const simNodes = nodes.map((n, i) => simNode(n, i, prev, pinned));
  const links = edges.map(e => ({ source: e.from, target: e.to }));
  const settled = nodes.every(n => prev[n.key]);
  const sim = forceSimulation(simNodes)
    .force('link', forceLink(links).id(d => d.id).distance(120).strength(0.6))
    .force('charge', forceManyBody().strength(-420))
    .force('collide', forceCollide(d => d.r + 16))
    .force('x', forceX(0).strength(0.04))
    .force('y', forceY(0).strength(0.04))
    .alpha(settled ? 0.3 : 1)
    .stop();
  for (let i = 0; i < ticks; i++) sim.tick();
  return Object.fromEntries(simNodes.map(n => [n.id, { x: Math.round(n.x), y: Math.round(n.y) }]));
}

const PAD = 70;
const MIN_W = 520;
const MIN_H = 400;

// The viewBox that shows every node with room for its label, never smaller
// than the default canvas (a two-node graph should not be drawn huge).
export function viewBoxOf(positions) {
  const pts = Object.values(positions);
  if (pts.length === 0) return { x: -MIN_W / 2, y: -MIN_H / 2, width: MIN_W, height: MIN_H };
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  const width = Math.max(MIN_W, Math.max(...xs) + PAD - minX);
  const height = Math.max(MIN_H, Math.max(...ys) + PAD - minY);
  const cx = (minX + Math.max(...xs) + PAD) / 2;
  const cy = (minY + Math.max(...ys) + PAD) / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

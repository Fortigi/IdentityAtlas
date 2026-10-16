// ─── Relationship graph: drawing decisions ───────────────────────────
// The pure parts of RelationGraph.jsx: which palette a node gets, what a screen
// reader hears, which nodes open a detail page, and where an edge is drawn.
import { isExpandableItem } from '@ui/components/entityGraphShape';

// Node circles use soft fills (light 50-200, dark 900-950) and a 600-700
// stroke, so a dense graph does not read as a wall of saturated colour.
// Organisation entities are sky, clusters amber, everything else lime.
export const NODE_CLASS = {
  root: 'fill-lime-200 stroke-lime-700 dark:fill-lime-900 dark:stroke-lime-400',
  open: 'fill-lime-100 stroke-lime-700 dark:fill-lime-950 dark:stroke-lime-400',
  entity: 'fill-white stroke-lime-600 dark:fill-gray-800 dark:stroke-lime-500',
  org: 'fill-sky-50 stroke-sky-700 dark:fill-sky-950 dark:stroke-sky-400',
  cluster: 'fill-amber-50 stroke-amber-700 dark:fill-amber-950 dark:stroke-amber-400',
  more: 'fill-gray-50 stroke-gray-500 dark:fill-gray-800 dark:stroke-gray-500',
};
export const DASHED = { cluster: '4 3', more: '2 3' };

export function nodeClass(node, open) {
  if (node.root) return NODE_CLASS.root;
  if (node.kind !== 'entity') return NODE_CLASS[node.kind];
  if (open) return NODE_CLASS.open;
  return node.entityKind === 'org-entity' ? NODE_CLASS.org : NODE_CLASS.entity;
}

export function truncate(s, n) {
  const text = String(s ?? '');
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

// The page's own object is already open; a leaf (a policy row) has no page.
export function canOpen(node, rootKey) {
  return node.kind === 'entity' && node.key !== rootKey && isExpandableItem(node.entityKind);
}

export function nodeAriaLabel(node, open) {
  if (node.kind === 'cluster') return `${node.count} ${node.label}, press to show them`;
  if (node.kind === 'more') return node.label;
  return `${node.typeLabel} ${node.label}, ${open ? 'expanded, press to collapse' : 'press to expand'}`;
}

// The visible part of an edge: from the rim of one circle to just short of the
// other, so the arrowhead is not hidden under the target node; the label sits
// at the middle.
export function edgeGeometry(a, b, ra, rb) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: a.x + ux * ra,
    y1: a.y + uy * ra,
    x2: b.x - ux * (rb + 4),
    y2: b.y - uy * (rb + 4),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}

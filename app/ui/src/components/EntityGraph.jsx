import { useMemo } from 'react';

// ─── EntityGraph ──────────────────────────────────────────────────────
// Radial graph: the current entity sits in the middle, relationship nodes
// orbit around it. Clicking a node can "fan out" children — those render
// as a sub-ring arcing outward from the clicked node. The caller drives
// expansion by populating `children` on any node; the component itself
// only handles layout + rendering.
//
// props:
//   centerLabel   — short label for the center node ("User", "Resource", …)
//   centerSubLabel— optional second line under the label (entity name)
//   nodes         — root-ring [{ key, label, count, children? }]
//                   Any node may recursively carry `children: [...]`.
//   activeKey     — key of the currently selected leaf (optional)
//   onNodeClick   — (nodePathOrNode) => void   caller decides click semantics

const LIME          = '#65a30d';
const GREEN_DARK    = '#365314';
const GREEN_MID     = '#a3e635';
const GREEN_LABEL   = '#4d7c0f';
const GRAY_DIM      = '#d1d5db';
const GRAY_DIM_TEXT = '#9ca3af';

const LIME_ACCENT = { fill: 'url(#eg-grad-lime)', stroke: '#4d7c0f', text: '#1a2e05', label: '#365314' };

// Layout tuning — tweaked to keep 3 expansion levels readable.
const ROOT_RADIUS_MIN  = 80;
const ROOT_RADIUS_STEP = 8;
const ROOT_RADIUS_MAX  = 160;
const BRANCH_DISTANCE  = 100;     // px from parent to child fanout
const BRANCH_ARC_DEG   = 120;     // total arc fanned children occupy (capped)
const BRANCH_ARC_PER_CHILD_DEG = 24;

function formatCount(n) {
  if (n == null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Base node radius shrinks one step per nesting level so the layout
// doesn't run off the viewbox when the user drills deep.
function radiusFor(count, depth) {
  const base = !count ? 18 : Math.min(32, 20 + Math.log10(count + 1) * 4);
  return Math.max(9, base - depth * 5);
}

// Walk the node tree, attaching {x, y, angle, depth} to each node so the
// render pass can stay dumb. Root ring sits evenly around the center; each
// expansion places its children on an arc extending outward from the parent.
function layoutTree(rootNodes, cx, cy) {
  const n = rootNodes.length;
  if (n === 0) return [];
  const rootR = Math.min(ROOT_RADIUS_MAX, ROOT_RADIUS_MIN + n * ROOT_RADIUS_STEP);

  const positioned = rootNodes.map((node, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    return layNode(node, cx + rootR * Math.cos(angle), cy + rootR * Math.sin(angle), angle, 0);
  });

  function layNode(node, x, y, outwardAngle, depth) {
    const laidChildren = [];
    if (node.children && node.children.length > 0) {
      const kids = node.children;
      const count = kids.length;
      const arcDeg = Math.min(BRANCH_ARC_DEG, Math.max(BRANCH_ARC_PER_CHILD_DEG * count, 30));
      const arcRad = (arcDeg * Math.PI) / 180;
      const step = count > 1 ? arcRad / (count - 1) : 0;
      const start = outwardAngle - arcRad / 2;
      const distance = Math.max(60, BRANCH_DISTANCE - depth * 10);
      for (let i = 0; i < count; i++) {
        const a = count === 1 ? outwardAngle : start + i * step;
        const cxx = x + distance * Math.cos(a);
        const cyy = y + distance * Math.sin(a);
        laidChildren.push(layNode(kids[i], cxx, cyy, a, depth + 1));
      }
    }
    return { ...node, x, y, depth, children: laidChildren };
  }

  return positioned;
}

// Flatten the tree into lists we can render in z-order: edges first,
// satellites second. Each entry carries its parent position for edge
// drawing.
function flatten(tree, parent) {
  const edges = [];
  const nodes = [];
  for (const node of tree) {
    nodes.push({ ...node, parentX: parent.x, parentY: parent.y, parentDepth: parent.depth ?? -1 });
    edges.push({ from: parent, to: node, depth: node.depth });
    if (node.children && node.children.length > 0) {
      const sub = flatten(node.children, node);
      edges.push(...sub.edges);
      nodes.push(...sub.nodes);
    }
  }
  return { edges, nodes };
}

export default function EntityGraph({
  centerLabel,
  centerSubLabel,
  nodes = [],
  activeKey,
  onNodeClick,
  // Path of expanded keys from root down, used to style the expansion chain
  // differently from the dormant branches. Caller tracks this state.
  expandedPath = [],
}) {
  const baseWidth  = 520;
  const baseHeight = 420;
  // Tree expansions can push children well past the viewbox — scale up the
  // viewBox instead of clipping so deep drill-ins stay readable.
  const depth = expandedPath.length;
  const width  = baseWidth  + (depth >= 2 ? 220 : depth === 1 ? 120 : 0);
  const height = baseHeight + (depth >= 2 ? 200 : depth === 1 ? 100 : 0);
  const cx = width / 2;
  const cy = height / 2;
  const centerR = 40;

  const layout = useMemo(() => {
    const tree = layoutTree(nodes, cx, cy);
    return { tree, ...flatten(tree, { x: cx, y: cy, depth: -1 }) };
  }, [nodes, cx, cy]);

  const expandedSet = useMemo(() => new Set(expandedPath), [expandedPath]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" style={{ maxHeight: '560px' }}>
      <defs>
        <radialGradient id="eg-grad-lime" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#d9f99d" />
          <stop offset="40%" stopColor="#a3e635" />
          <stop offset="100%" stopColor="#65a30d" />
        </radialGradient>
        <radialGradient id="eg-grad-dim" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#f7fee7" />
          <stop offset="100%" stopColor="#ecfccb" />
        </radialGradient>
        <radialGradient id="eg-grad-center" cx="30%" cy="30%">
          <stop offset="0%" stopColor="#f0fdf4" />
          <stop offset="100%" stopColor="#dcfce7" />
        </radialGradient>
        <filter id="eg-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feColorMatrix in="blur" type="matrix"
            values="0 0 0 0 0.64  0 0 0 0 0.90  0 0 0 0 0.21  0 0 0 0.55 0" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Edges — parent to each child, drawn behind the nodes */}
      <g>
        {layout.edges.map((e, i) => {
          const active = (e.to.count || 0) > 0 || e.to.kind === 'item';
          const isOnPath = expandedSet.has(e.to.key);
          const selected = activeKey === e.to.key;
          const opacity = selected ? 0.95 : isOnPath ? 0.8 : active ? 0.65 : 0.4;
          return (
            <line
              key={`edge-${i}-${e.to.key}`}
              x1={e.from.x}
              y1={e.from.y}
              x2={e.to.x}
              y2={e.to.y}
              stroke={selected || isOnPath ? LIME : active ? '#a3e635' : '#e5e7eb'}
              strokeWidth={selected ? 2.5 : isOnPath ? 1.8 : active ? 1.4 : 1}
              strokeDasharray={active ? '' : '3,3'}
              opacity={opacity}
            >
              {active && !selected && !isOnPath && (
                <animate attributeName="stroke-opacity" values="0.45;0.8;0.45"
                  dur={`${4 + (i % 3)}s`} repeatCount="indefinite"
                  begin={`${(i * 0.29) % 3}s`} />
              )}
            </line>
          );
        })}
      </g>

      {/* Nodes */}
      <g>
        {layout.nodes.map((n, i) => {
          const isItem = n.kind === 'item';
          const active = isItem ? true : (n.count || 0) > 0;
          const selected = activeKey === n.key;
          const onPath = expandedSet.has(n.key);
          const accent = LIME_ACCENT;
          const r = radiusFor(isItem ? 1 : n.count, n.depth);
          const clickable = (active || isItem) && onNodeClick;
          return (
            <g
              key={`node-${n.key}`}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onClick={() => clickable && onNodeClick(n)}
            >
              {selected && (
                <circle cx={n.x} cy={n.y} r={r + 6} fill="none" stroke={accent.stroke} strokeWidth={2} opacity={0.7} />
              )}
              {(active && !selected) && (
                <circle cx={n.x} cy={n.y} r={r + 4} fill="none" stroke={GREEN_MID} strokeWidth={1.1} opacity={onPath ? 0.6 : 0.35}>
                  <animate attributeName="r" values={`${r + 4};${r + 8};${r + 4}`} dur={`${3.5 + i * 0.25}s`} repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.4;0.05;0.4" dur={`${3.5 + i * 0.25}s`} repeatCount="indefinite" />
                </circle>
              )}
              <circle
                cx={n.x}
                cy={n.y}
                r={r}
                fill={active ? accent.fill : 'url(#eg-grad-dim)'}
                stroke={active ? accent.stroke : GRAY_DIM}
                strokeWidth={active ? 1.75 : 1.25}
                filter={active ? 'url(#eg-glow)' : undefined}
              />
              {isItem ? (
                // Item nodes show an initial letter; the label underneath
                // carries the full name so the circle stays uncluttered.
                <text x={n.x} y={n.y + 4} textAnchor="middle" style={{ fontSize: '12px', fontWeight: 700, pointerEvents: 'none', fill: accent.text }}>
                  {(n.label || '?')[0]}
                </text>
              ) : (
                <text x={n.x} y={n.y + 4} textAnchor="middle" style={{ fontSize: Math.max(10, 13 - n.depth) + 'px', fontWeight: 800, pointerEvents: 'none', fill: active ? accent.text : GRAY_DIM_TEXT }}>
                  {formatCount(n.count)}
                </text>
              )}
              <text
                x={n.x}
                y={n.y + r + 13}
                textAnchor="middle"
                style={{
                  fontSize: (10 - Math.min(2, n.depth)) + 'px',
                  fontWeight: 600,
                  fill: active ? accent.label : GRAY_DIM_TEXT,
                  letterSpacing: '0.02em',
                  pointerEvents: 'none',
                }}
              >
                {truncate(n.label, 22)}
              </text>
            </g>
          );
        })}
      </g>

      {/* Center node — drawn on top so edges terminate inside it visually */}
      <g>
        <circle cx={cx} cy={cy} r={centerR + 3} fill="none" stroke={LIME} strokeWidth={1.25} opacity={0.5} />
        <circle cx={cx} cy={cy} r={centerR} fill="url(#eg-grad-center)" stroke={LIME} strokeWidth={1.75} />
        <text x={cx} y={cy - 2} textAnchor="middle" style={{ fontSize: '11px', fontWeight: 700, fill: GREEN_LABEL, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {centerLabel}
        </text>
        {centerSubLabel && (
          <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: '11px', fontWeight: 600, fill: GREEN_DARK }}>
            {truncate(centerSubLabel, 18)}
          </text>
        )}
      </g>
    </svg>
  );
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

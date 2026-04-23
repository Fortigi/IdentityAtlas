import { useMemo, useState, useRef } from 'react';

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

const LIME_ACCENT     = { fill: 'url(#eg-grad-lime)',    stroke: '#4d7c0f', text: '#1a2e05', label: '#365314' };
// Yellow-amber "fresh" tint for nodes that represent a relationship
// added inside the recent-changes window. Reads clearly against the
// green palette without screaming for attention.
const ADDED_ACCENT    = { fill: 'url(#eg-grad-added)',   stroke: '#a16207', text: '#422006', label: '#854d0e' };
// Muted rose for removed relationships — still legible but clearly
// different from any "healthy" node.
const REMOVED_ACCENT  = { fill: 'url(#eg-grad-removed)', stroke: '#9f1239', text: '#4c0519', label: '#881337' };

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

  // ─── Pan + zoom on the workspace ─────────────────────────────────────
  // Deep expansions can run past the viewBox edges. Wrap the contents in
  // a translatable/scalable group; allow pointer drag for pan, wheel for
  // zoom. A Reset button restores 1× / centered.
  const [pan, setPan]     = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const svgRef = useRef(null);
  const dragRef = useRef(null);     // { startX, startY, panX, panY, moved }

  // Convert a pixel delta on the rendered SVG to a viewBox-coordinate
  // delta. The SVG scales `width`/`height` to its rendered box, so one
  // CSS pixel == (width / boundingClientRect.width) viewBox units.
  function toViewBoxScale() {
    const svg = svgRef.current;
    if (!svg) return 1;
    const rect = svg.getBoundingClientRect();
    return rect.width > 0 ? width / rect.width : 1;
  }

  // Plain functions — React Compiler memoizes them automatically. Manual
  // useCallback() wrappers here were confusing the compiler (one of the
  // handlers closes over `toViewBoxScale`, a helper redefined on every
  // render, which made "existing memoization could not be preserved").
  function onPointerDown(e) {
    // Only the primary button initiates a pan; right-click and middle
    // pass through.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      panX: pan.x, panY: pan.y,
      moved: false,
    };
  }

  function onPointerMove(e) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    // Tiny twitches between mousedown and mouseup shouldn't be treated
    // as drags — they'd swallow legitimate node clicks. Only commit a
    // pan once the pointer has actually travelled.
    if (!dragRef.current.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    dragRef.current.moved = true;
    const k = toViewBoxScale();
    setPan({
      x: dragRef.current.panX + dx * k,
      y: dragRef.current.panY + dy * k,
    });
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  // Suppress the click that immediately follows a drag. Otherwise a long
  // drag that ends over a node would pop the node detail.
  function onClickCapture(e) {
    if (dragRef.current?.moved) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function onWheel(e) {
    if (!svgRef.current) return;
    e.preventDefault();
    setScale(prev => {
      const next = Math.max(0.4, Math.min(3, prev * (e.deltaY > 0 ? 0.9 : 1.1)));
      return Number(next.toFixed(2));
    });
  }

  function resetView() {
    setPan({ x: 0, y: 0 });
    setScale(1);
  }

  const isDirty = pan.x !== 0 || pan.y !== 0 || scale !== 1;

  return (
    <div className="relative">
      {isDirty && (
        <button
          onClick={resetView}
          className="absolute top-2 right-2 z-10 px-2 py-0.5 text-[11px] rounded border border-gray-200 dark:border-gray-700 bg-white/90 dark:bg-gray-800/90 text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 backdrop-blur-sm shadow-sm"
          title="Reset graph view to default position and zoom"
        >Reset view</button>
      )}
      <span className="absolute bottom-2 left-2 z-10 text-[10px] text-gray-400 dark:text-gray-500 select-none pointer-events-none">
        drag to pan · wheel to zoom{scale !== 1 ? ` · ${Math.round(scale * 100)}%` : ''}
      </span>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto cursor-grab active:cursor-grabbing"
        style={{ maxHeight: '560px', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
        onClickCapture={onClickCapture}
        onWheel={onWheel}
      >
      <defs>
        <radialGradient id="eg-grad-lime" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#d9f99d" />
          <stop offset="40%" stopColor="#a3e635" />
          <stop offset="100%" stopColor="#65a30d" />
        </radialGradient>
        {/* Recent-added — pale yellow fading into amber. Light enough
            that it doesn't shout, distinct enough to pop against green. */}
        <radialGradient id="eg-grad-added" cx="35%" cy="30%">
          <stop offset="0%"  stopColor="#fef9c3" />
          <stop offset="40%" stopColor="#fde047" />
          <stop offset="100%" stopColor="#ca8a04" />
        </radialGradient>
        {/* Recent-removed — rose-pink so strikethrough/gone reads
            instantly without any danger-red alarm. */}
        <radialGradient id="eg-grad-removed" cx="35%" cy="30%">
          <stop offset="0%"  stopColor="#ffe4e6" />
          <stop offset="40%" stopColor="#fb7185" />
          <stop offset="100%" stopColor="#e11d48" />
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

      {/* Pan + zoom transform wraps every visual layer so they move
          together. Origin of scale is the centre of the viewBox so a
          symmetric zoom doesn't drag content off to one corner. */}
      <g transform={`translate(${pan.x} ${pan.y}) translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`}>

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
          // Recent-change nodes (categories with recent: 'added'/'removed'
          // or items tagged the same way when they're inside a normal
          // fanout) pick a different accent so the eye finds them fast.
          const accent = n.recent === 'added' ? ADDED_ACCENT
                       : n.recent === 'removed' ? REMOVED_ACCENT
                       : LIME_ACCENT;
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
                <circle cx={n.x} cy={n.y} r={r + 4} fill="none"
                  stroke={n.recent === 'added' ? '#fde047' : n.recent === 'removed' ? '#fb7185' : GREEN_MID}
                  strokeWidth={1.1} opacity={onPath ? 0.6 : 0.35}>
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
                /* Green glow only suits the green palette — skip it for
                   amber/rose recent nodes so the colour stays clean. */
                filter={active && !n.recent ? 'url(#eg-glow)' : undefined}
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
      </g>{/* end pan/zoom wrapper */}
    </svg>
    </div>
  );
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

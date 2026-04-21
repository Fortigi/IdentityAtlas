import { useMemo } from 'react';

// ─── EntityGraph ──────────────────────────────────────────────────────
// Radial graph: the current entity sits in the middle, relationship nodes
// orbit around it. Visual language matches the dashboard BrainGraph (green
// lime palette, animated halos on active nodes). Nodes are clickable —
// parent passes `activeKey` to highlight the selected relationship and
// receives node-click events via `onNodeClick`.
//
// props:
//   centerLabel   — short label for the center node ("User", "Resource", …)
//   centerSubLabel— optional second line under the label (entity name)
//   nodes         — [{ key, label, count, accent? }]  accent: 'blue'|'purple'|'amber'|'red'|'emerald'
//   activeKey     — key of the currently selected node (optional)
//   onNodeClick   — (nodeKey) => void

const LIME_BRIGHT    = '#84cc16';
const LIME           = '#65a30d';
const GREEN_DARK     = '#365314';
const GREEN_MID      = '#a3e635';
const GREEN_LABEL    = '#4d7c0f';
const GRAY_DIM       = '#d1d5db';
const GRAY_DIM_TEXT  = '#9ca3af';

// Accent colors for active relationship nodes — pick one to hint at category
// (e.g. blue for memberships, amber for ownership, red for risk-heavy).
const ACCENTS = {
  lime:    { fill: 'url(#eg-grad-lime)',    stroke: '#4d7c0f', text: '#1a2e05', label: '#365314' },
  blue:    { fill: 'url(#eg-grad-blue)',    stroke: '#1d4ed8', text: '#0c1950', label: '#1e3a8a' },
  purple:  { fill: 'url(#eg-grad-purple)',  stroke: '#6d28d9', text: '#2e0a5a', label: '#5b21b6' },
  amber:   { fill: 'url(#eg-grad-amber)',   stroke: '#b45309', text: '#451a03', label: '#92400e' },
  red:     { fill: 'url(#eg-grad-red)',     stroke: '#b91c1c', text: '#450a0a', label: '#991b1b' },
  emerald: { fill: 'url(#eg-grad-emerald)', stroke: '#047857', text: '#022c1c', label: '#065f46' },
};

function formatCount(n) {
  if (n == null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function EntityGraph({ centerLabel, centerSubLabel, nodes = [], activeKey, onNodeClick }) {
  const width = 520;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;
  const centerR = 40;

  // Positions: evenly spread around a circle, starting at the top. Two radii
  // if there are many nodes — inner ring for the first 8, outer for overflow.
  const positioned = useMemo(() => {
    const n = nodes.length;
    if (n === 0) return [];
    const r = Math.min(160, 80 + n * 8);
    return nodes.map((node, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start at top
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      return { ...node, x, y };
    });
  }, [nodes, cx, cy]);

  const radiusFor = (count) => {
    if (!count) return 18;
    const base = 20 + Math.log10(count + 1) * 4;
    return Math.min(32, base);
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" style={{ maxHeight: '420px' }}>
      <defs>
        <radialGradient id="eg-grad-lime" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#d9f99d" />
          <stop offset="55%" stopColor="#a3e635" />
          <stop offset="100%" stopColor="#65a30d" />
        </radialGradient>
        <radialGradient id="eg-grad-blue" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#dbeafe" />
          <stop offset="55%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#2563eb" />
        </radialGradient>
        <radialGradient id="eg-grad-purple" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#ede9fe" />
          <stop offset="55%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#7c3aed" />
        </radialGradient>
        <radialGradient id="eg-grad-amber" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#fef3c7" />
          <stop offset="55%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#d97706" />
        </radialGradient>
        <radialGradient id="eg-grad-red" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#fee2e2" />
          <stop offset="55%" stopColor="#f87171" />
          <stop offset="100%" stopColor="#dc2626" />
        </radialGradient>
        <radialGradient id="eg-grad-emerald" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#d1fae5" />
          <stop offset="55%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#059669" />
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

      {/* Edges — center to each satellite node */}
      <g>
        {positioned.map((n, i) => {
          const active = (n.count || 0) > 0;
          const selected = activeKey === n.key;
          return (
            <line
              key={`edge-${n.key}`}
              x1={cx}
              y1={cy}
              x2={n.x}
              y2={n.y}
              stroke={selected ? LIME : (active ? '#a3e635' : '#e5e7eb')}
              strokeWidth={selected ? 2.5 : (active ? 1.4 : 1)}
              strokeDasharray={active ? '' : '3,3'}
              opacity={selected ? 0.9 : (active ? 0.7 : 0.55)}
            >
              {active && !selected && (
                <animate
                  attributeName="stroke-opacity"
                  values="0.55;0.9;0.55"
                  dur={`${4 + (i % 3)}s`}
                  repeatCount="indefinite"
                  begin={`${(i * 0.29) % 3}s`}
                />
              )}
            </line>
          );
        })}
      </g>

      {/* Satellite nodes */}
      <g>
        {positioned.map((n, i) => {
          const active = (n.count || 0) > 0;
          const selected = activeKey === n.key;
          const accent = ACCENTS[n.accent] || ACCENTS.lime;
          const r = radiusFor(n.count);
          const clickable = active && onNodeClick;
          return (
            <g
              key={n.key}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onClick={() => clickable && onNodeClick(n.key)}
            >
              {selected && (
                <circle cx={n.x} cy={n.y} r={r + 6} fill="none" stroke={accent.stroke} strokeWidth={2} opacity={0.7} />
              )}
              {active && !selected && (
                <circle cx={n.x} cy={n.y} r={r + 4} fill="none" stroke={GREEN_MID} strokeWidth={1.1} opacity={0.4}>
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
              <text
                x={n.x}
                y={n.y + 4}
                textAnchor="middle"
                style={{
                  fontSize: '13px',
                  fontWeight: 800,
                  pointerEvents: 'none',
                  fill: active ? accent.text : GRAY_DIM_TEXT,
                }}
              >
                {formatCount(n.count)}
              </text>
              <text
                x={n.x}
                y={n.y + r + 14}
                textAnchor="middle"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  fill: active ? accent.label : GRAY_DIM_TEXT,
                  letterSpacing: '0.02em',
                  pointerEvents: 'none',
                }}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </g>

      {/* Center node — always drawn last so it sits on top of the edges */}
      <g>
        <circle cx={cx} cy={cy} r={centerR + 3} fill="none" stroke={LIME} strokeWidth={1.25} opacity={0.5} />
        <circle cx={cx} cy={cy} r={centerR} fill="url(#eg-grad-center)" stroke={LIME} strokeWidth={1.75} />
        <text x={cx} y={cy - 2} textAnchor="middle" style={{ fontSize: '11px', fontWeight: 700, fill: GREEN_LABEL, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {centerLabel}
        </text>
        {centerSubLabel && (
          <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: '11px', fontWeight: 600, fill: GREEN_DARK }}>
            {centerSubLabel.length > 18 ? centerSubLabel.slice(0, 17) + '…' : centerSubLabel}
          </text>
        )}
      </g>
    </svg>
  );
}

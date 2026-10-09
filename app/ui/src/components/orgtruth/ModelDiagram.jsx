// The Model tab's diagram: draws the layout from modelGraph.js as inline SVG.
// No graph library — the meta-model is dozens of nodes at most, and the layout
// is a pure, tested function. Colours are hex (SVG attributes), picked per theme
// with useIsDark(); fills are the soft 200–300 tier.
//
// Edges: predicates (solid arcs), links between two lists (dashed arcs) and
// links to the system truth (dashed lines, one per attribute).
//
// Hover or focus a node: its <title> lists the attribute keys and the number of
// sources (entity types) or the size of the system table (system types).
import { useMemo } from 'react';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { layoutModel } from './modelGraph';

const LIGHT = {
  entityFill: '#c7d2fe', entityStroke: '#4338ca', systemFill: '#bae6fd', systemStroke: '#0369a1',
  text: '#111827', badge: '#374151', edge: '#6b7280', link: '#0369a1', label: '#374151', labelBg: '#ffffff',
};
const DARK = {
  entityFill: '#3730a3', entityStroke: '#a5b4fc', systemFill: '#075985', systemStroke: '#7dd3fc',
  text: '#f9fafb', badge: '#e5e7eb', edge: '#9ca3af', link: '#7dd3fc', label: '#e5e7eb', labelBg: '#1f2937',
};

function nodeTitle(n) {
  if (n.kind === 'system') {
    return n.systemCount != null ? `${n.label}: ${n.systemCount} in the system truth` : n.label;
  }
  const keys = n.attributeKeys.length > 0 ? n.attributeKeys.join(', ') : 'none';
  const sources = n.sources != null ? `\nSources: ${n.sources}` : '';
  return `${n.label}: ${n.count} entities (${n.proposed} proposed)\nAttributes: ${keys}${sources}`;
}

// Predicates and links between two lists have a direction; a link to the
// system truth is always downwards and needs no arrow.
const MARKERS = { predicate: 'url(#ot-arrow)', entityLink: 'url(#ot-arrow-link)' };
const markerOf = (e) => MARKERS[e.kind];

function EdgeLabel({ edge, c }) {
  const w = edge.labelW;
  return (
    <g>
      <rect x={edge.labelX - w / 2} y={edge.labelY - 9} width={w} height={16} rx={3} fill={c.labelBg} opacity={0.9} />
      <text x={edge.labelX} y={edge.labelY + 3} textAnchor="middle" fontSize={11} fill={c.label}>{edge.label}</text>
    </g>
  );
}

export default function ModelDiagram({ model }) {
  const c = useIsDark() ? DARK : LIGHT;
  const layout = useMemo(() => layoutModel(model), [model]);
  if (layout.nodes.length === 0) return null;

  return (
    <svg
      role="img"
      aria-label="Organisation model diagram"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="w-full h-auto"
      style={{ maxHeight: 560 }}
    >
      <defs>
        <marker id="ot-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={c.edge} />
        </marker>
        <marker id="ot-arrow-link" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={c.link} />
        </marker>
      </defs>
      {layout.edges.map(e => (
        <path
          key={e.id}
          data-edge={e.id}
          d={e.path}
          fill="none"
          stroke={e.dashed ? c.link : c.edge}
          strokeWidth={1.5}
          strokeDasharray={e.dashed ? '5 4' : undefined}
          markerEnd={markerOf(e)}
        />
      ))}
      {layout.nodes.map(n => (
        <g key={n.id} data-node={n.id} tabIndex={0} aria-label={`${n.label} ${n.count}`}>
          <title>{nodeTitle(n)}</title>
          <rect
            x={n.x} y={n.y} width={n.w} height={n.h} rx={n.kind === 'system' ? 4 : 10}
            fill={n.kind === 'system' ? c.systemFill : c.entityFill}
            stroke={n.kind === 'system' ? c.systemStroke : c.entityStroke}
            strokeWidth={1.2}
          />
          <text x={n.x + 12} y={n.y + n.h / 2 + 4} fontSize={13} fontWeight={600} fill={c.text}>{n.label}</text>
          <text x={n.x + n.w - 10} y={n.y + n.h / 2 + 4} fontSize={11} textAnchor="end" fill={c.badge}>
            {n.kind === 'system' ? (n.systemCount ?? '') : n.count}
          </text>
        </g>
      ))}
      {layout.edges.map(e => <EdgeLabel key={`${e.id}:label`} edge={e} c={c} />)}
    </svg>
  );
}

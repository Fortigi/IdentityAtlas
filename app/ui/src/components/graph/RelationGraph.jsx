// ─── RelationGraph ───────────────────────────────────────────────────
// Draws the relationship graph that useRelationGraph keeps: one node per
// object (type inside the circle, name under it), one labelled, directed edge
// per relation, cluster nodes for big relation sets. Positions come from the
// force layout (graphLayout.js); the drawing decisions live in graphDraw.js.
//
//   click / Enter on a node     expand it, or collapse it when expanded
//   click / Enter on a name     open that object's detail page (also: double click)
//   drag a node                 move it and pin it there
//   drag the canvas / wheel     pan / zoom
import { edgeLabel } from './graphModel';
import { radiusOf, viewBoxOf } from './graphLayout';
import { DASHED, nodeClass, truncate, canOpen, nodeAriaLabel, edgeGeometry } from './graphDraw';
import useGraphPointer from './useGraphPointer';

const TEXT = 'fill-gray-800 dark:fill-gray-100';
const HALO = 'stroke-white dark:stroke-gray-800';

function onKey(handler) {
  return (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    handler();
  };
}

function GraphEdge({ edge, from, to, positions }) {
  const g = edgeGeometry(positions[from.key], positions[to.key], radiusOf(from), radiusOf(to));
  return (
    <g data-edge={`${from.key}->${to.key}`}>
      <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} strokeWidth={1.4}
        className="stroke-gray-500 dark:stroke-gray-400" markerEnd="url(#rg-arrow)" />
      <text x={g.mx} y={g.my - 3} textAnchor="middle" strokeWidth={3} paintOrder="stroke"
        className={`fill-gray-700 dark:fill-gray-300 ${HALO}`} style={{ fontSize: '10px', pointerEvents: 'none' }}>
        {truncate(edgeLabel(edge), 34)}
      </text>
    </g>
  );
}

function NodeName({ node, r, openable, onOpen }) {
  const link = openable
    ? {
      role: 'link',
      tabIndex: 0,
      'aria-label': `Open ${node.label}`,
      onClick: (e) => { e.stopPropagation(); onOpen(node); },
      onKeyDown: onKey(() => onOpen(node)),
      className: `${TEXT} ${HALO} cursor-pointer hover:underline`,
    }
    : { className: `${TEXT} ${HALO}` };
  return (
    <text y={r + 14} textAnchor="middle" strokeWidth={3} paintOrder="stroke"
      style={{ fontSize: '11px', fontWeight: node.root ? 700 : 600 }} {...link}>
      {truncate(node.label, 26)}
    </text>
  );
}

function GraphNode({ node, pos, open, openable, dragging, onNodePointerDown, onActivate, onOpen }) {
  const r = radiusOf(node);
  const glyph = node.kind === 'cluster' ? String(node.count) : node.typeLabel;
  return (
    <g style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }} data-node={node.key}
      className={dragging ? undefined : 'transition-transform duration-300 ease-out'}>
      <g role="button" tabIndex={node.kind === 'more' ? -1 : 0} aria-label={nodeAriaLabel(node, open)}
        aria-expanded={node.kind === 'entity' ? open : undefined}
        className="cursor-pointer"
        onPointerDown={(e) => onNodePointerDown(e, node.key, pos)}
        onClick={() => onActivate(node)}
        onDoubleClick={() => openable && onOpen(node)}
        onKeyDown={onKey(() => onActivate(node))}>
        <title>{`${node.typeLabel} · ${node.label}`}</title>
        {node.root && <circle r={r + 5} fill="none" strokeWidth={1.5} className="stroke-lime-600 dark:stroke-lime-400" />}
        <circle r={r} strokeWidth={node.root ? 2.2 : 1.6} strokeDasharray={DASHED[node.kind]} className={nodeClass(node, open)} />
        <text y={4} textAnchor="middle" className={TEXT}
          style={{ fontSize: node.kind === 'cluster' ? '12px' : '9px', fontWeight: 700, pointerEvents: 'none' }}>
          {truncate(glyph, node.root ? 11 : 8)}
        </text>
      </g>
      <NodeName node={node} r={r} openable={openable} onOpen={onOpen} />
    </g>
  );
}

export default function RelationGraph({ graph, onOpenDetail }) {
  const { nodes, edges, positions, rootKey } = graph;
  const box = viewBoxOf(positions);
  const { svgRef, pan, scale, dragging, dirty, resetView, onNodePointerDown, canvasHandlers } =
    useGraphPointer({ viewBox: box, onMove: graph.move, onPin: graph.pin });
  const byKey = Object.fromEntries(nodes.map(n => [n.key, n]));
  const expanded = new Set(graph.expanded);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const open = (node) => onOpenDetail?.(node.entityKind, node.entityId, node.label);
  const drawnEdges = edges.filter(e => byKey[e.from] && byKey[e.to] && positions[e.from] && positions[e.to]);
  const drawnNodes = nodes.filter(n => positions[n.key]);

  return (
    <div className="relative">
      {dirty && (
        <button type="button" onClick={resetView}
          className="absolute top-2 right-2 z-10 px-2 py-0.5 text-[11px] rounded border border-gray-200 dark:border-gray-700 bg-white/90 dark:bg-gray-800/90 text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 shadow-sm">
          Reset view
        </button>
      )}
      <svg ref={svgRef} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        role="group" aria-label="Relationship graph"
        className="w-full h-auto cursor-grab active:cursor-grabbing select-none"
        style={{ maxHeight: '600px', touchAction: 'none' }} {...canvasHandlers}>
        <defs>
          <marker id="rg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fill-gray-500 dark:fill-gray-400" />
          </marker>
        </defs>
        <g transform={`translate(${pan.x} ${pan.y}) translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`}>
          {drawnEdges.map(e => (
            <GraphEdge key={e.key} edge={e} from={byKey[e.from]} to={byKey[e.to]} positions={positions} />
          ))}
          {drawnNodes.map(n => (
            <GraphNode key={n.key} node={n} pos={positions[n.key]} open={expanded.has(n.key)}
              openable={canOpen(n, rootKey)} dragging={dragging === n.key} onNodePointerDown={onNodePointerDown}
              onActivate={graph.activate} onOpen={open} />
          ))}
        </g>
      </svg>
      <p className="absolute bottom-1 left-2 text-[10px] text-gray-600 dark:text-gray-400 select-none pointer-events-none">
        click a node to expand or collapse · click a name to open · drag to move{scale !== 1 ? ` · ${Math.round(scale * 100)}%` : ''}
      </p>
    </div>
  );
}

// Organisation → Model → the model canvas: draws the cards, rows, rule lines
// and relation lines that modelCanvas.js computes, inside a pan/zoom group
// (useCanvasGestures). A card header is its drag handle (and, focused, moves
// with the arrow keys); every row and every rule label is a focusable button
// (Enter/Space activate it) whose accessible name says what it does
// (linkRulesDraft.rowName). A reader gets the same drawing without the rule
// buttons. With a highlighted list, the other lists' cards and lines fade.
//
// Enrichment blocks sit at the foot of their system card; activity and
// relation pairs (templateCanvas.js) are dashed edges like the predicates.
//
// Props: { placed, lines, predicates, edges, ghost, view, svgRef, handlers,
//          selection, canEdit, highlight, onRow(row), onLine(line),
//          onNudge(boxId, dx, dy), rename: { type, value } | null,
//          onRenameStart(type), onRenameChange(value), onRenameSave(), onRenameCancel() }
import { useIsDark } from '@ui/contexts/ThemeContext';
import { rowName } from './linkRulesDraft';
import { HEADER_H, ROW_H, BLOCK_H } from './modelCanvas';
import { LABEL_H } from './modelGraph';

const LIGHT = {
  entityHead: '#c7d2fe', systemHead: '#bae6fd', body: '#ffffff', stroke: '#6b7280', text: '#111827',
  sub: '#374151', chip: '#eef2ff', selected: '#fde68a', target: '#e0f2fe', line: '#0369a1',
  relation: '#4b5563', labelBg: '#ffffff', label: '#1f2937', canvas: '#f9fafb', block: '#f0fdf4', activity: '#15803d',
};
const DARK = {
  entityHead: '#3730a3', systemHead: '#075985', body: '#1f2937', stroke: '#9ca3af', text: '#f9fafb',
  sub: '#e5e7eb', chip: '#312e81', selected: '#92400e', target: '#0c4a6e', line: '#7dd3fc',
  relation: '#d1d5db', labelBg: '#111827', label: '#e5e7eb', canvas: '#111827', block: '#052e16', activity: '#86efac',
};
const FADED = 0.3;
const NUDGE = 20;
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

// Button semantics for an SVG group.
function buttonProps(enabled, onActivate, name) {
  if (!enabled) return { 'aria-label': name };
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': name,
    style: { cursor: 'pointer' },
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
    },
  };
}

function rowFill(row, selection, c) {
  if (selection && row.source && selection.entityType === row.entityType && selection.attribute === row.attribute) return c.selected;
  if (selection && row.target) return c.target;
  return 'transparent';
}

function Row({ row, selection, canEdit, onRow, c }) {
  const name = rowName(selection, row, row.boxTitle);
  const active = canEdit && (row.source || (selection && row.target));
  const pressed = selection?.entityType === row.entityType && selection?.attribute === row.attribute;
  return (
    <g data-row={row.id} {...(canEdit && row.source ? { 'data-drag': 'row' } : {})}
      {...buttonProps(Boolean(active), () => onRow(row), name)} {...(active && row.source ? { 'aria-pressed': pressed } : {})}>
      <rect x={row.x + 1} y={row.y} width={198} height={ROW_H} fill={rowFill(row, selection, c)} />
      <text x={row.x + 12} y={row.cy + 4} fontSize={12} fill={c.text}>{row.label}</text>
    </g>
  );
}

// An enrichment: the attributes another list adds to these objects, with
// that list's name in brackets.
function Block({ block, highlight, c }) {
  const faded = highlight && block.owner !== highlight;
  return (
    <g data-block={block.id} opacity={faded ? FADED : 1} pointerEvents="none">
      <title>{block.label} ({block.source})</title>
      <rect x={block.x + 1} y={block.y} width={198} height={BLOCK_H} fill={c.block} />
      <text x={block.x + 12} y={block.y + 15} fontSize={11} fill={c.text}>
        {clip(block.label, 24)} <tspan fill={c.sub}>({block.source})</tspan>
      </text>
    </g>
  );
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function RenameField({ box, rename, onRenameChange, onRenameSave, onRenameCancel }) {
  return (
    <foreignObject x={box.x + 4} y={box.y + 3} width={box.w - 8} height={24} data-nodrag="">
      <input
        aria-label={`New name for ${box.title}`}
        value={rename.value}
        autoFocus
        onChange={e => onRenameChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); onRenameSave(); }
          if (e.key === 'Escape') { e.preventDefault(); onRenameCancel(); }
        }}
        className="w-full h-full rounded border border-gray-300 bg-white px-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
      />
    </foreignObject>
  );
}

function PencilButton({ box, onRenameStart, c }) {
  const x = box.x + box.w - 26;
  const y = box.y + 5;
  return (
    <g data-nodrag="" {...buttonProps(true, () => onRenameStart(box.entityType), `Rename ${box.entityType}`)}>
      <title>Rename {box.entityType}</title>
      <rect x={x - 2} y={y - 2} width={22} height={22} rx={4} fill="transparent" />
      <path
        d={`M ${x + 3} ${y + 15} L ${x + 4} ${y + 11} L ${x + 13} ${y + 2} L ${x + 16} ${y + 5} L ${x + 7} ${y + 14} Z`}
        fill="none" stroke={c.sub} strokeWidth={1.4} strokeLinejoin="round"
      />
    </g>
  );
}

// The header: the drag handle; focused, the arrow keys move the card.
function Header({ box, c, onNudge }) {
  const onKeyDown = (e) => {
    const step = ARROWS[e.key];
    if (!step) return;
    e.preventDefault();
    onNudge(box.id, step[0] * NUDGE, step[1] * NUDGE);
  };
  return (
    <g data-drag="box" tabIndex={0} aria-label={`Move ${box.title}`} aria-roledescription="draggable card"
      onKeyDown={onKeyDown} style={{ cursor: 'move' }}>
      <rect x={box.x} y={box.y} width={box.w} height={HEADER_H} rx={6} fill={box.kind === 'system' ? c.systemHead : c.entityHead} />
    </g>
  );
}

function Title({ box, c }) {
  const chip = box.kind === 'system' ? 'System' : box.owner ?? 'No list';
  return (
    <g pointerEvents="none">
      <text x={box.x + 10} y={box.y + 18} fontSize={13} fontWeight={600} fill={c.text}>
        {box.title}{box.count != null ? ` (${box.count})` : ''}
      </text>
      <text x={box.x + 10} y={box.y + 35} fontSize={10} fill={c.sub} data-chip="">{chip}</text>
    </g>
  );
}

function Box({ box, c, props }) {
  const { selection, canEdit, onRow, rename, highlight, onNudge } = props;
  const renaming = rename?.type === box.entityType && box.own;
  const faded = highlight && box.kind === 'entity' && box.owner !== highlight;
  return (
    <g data-box={box.id} opacity={faded ? FADED : 1}>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} fill={c.body} stroke={c.stroke} strokeWidth={1} />
      <Header box={box} c={c} onNudge={onNudge} />
      {renaming ? <RenameField box={box} rename={rename} {...props} /> : <Title box={box} c={c} />}
      {canEdit && box.own && !renaming && <PencilButton box={box} onRenameStart={props.onRenameStart} c={c} />}
      {box.rows.map(r => <Row key={r.id} row={r} selection={selection} canEdit={canEdit} onRow={onRow} c={c} />)}
      {(box.blocks ?? []).map(k => <Block key={k.id} block={k} highlight={highlight} c={c} />)}
    </g>
  );
}

function LineLabel({ line, c, stroke }) {
  return (
    <>
      <rect x={line.labelX - line.labelW / 2} y={line.labelY - LABEL_H / 2 - 1} width={line.labelW} height={LABEL_H}
        rx={3} fill={c.labelBg} stroke={stroke} strokeWidth={0.6} />
      <text x={line.labelX} y={line.labelY + 3} textAnchor="middle" fontSize={11} fill={c.label}>{line.label}</text>
    </>
  );
}

function Line({ line, canEdit, onLine, highlight, c }) {
  const open = () => onLine(line);
  return (
    <g data-line={line.key} opacity={highlight && line.profile !== highlight ? FADED : 1}>
      <path d={line.path} fill="none" stroke={c.line} strokeWidth={1.6} markerEnd="url(#ot-canvas-arrow)"
        aria-hidden="true" onClick={canEdit ? open : undefined} style={canEdit ? { cursor: 'pointer' } : undefined} />
      <g {...buttonProps(canEdit, open, line.name)}><LineLabel line={line} c={c} stroke={c.line} /></g>
    </g>
  );
}

const EDGE_TITLE = { activity: 'Activity', relation: 'Pairs' };

function Relation({ line, highlight, c }) {
  const faded = highlight && !line.owners.includes(highlight);
  const stroke = line.kind === 'activity' ? c.activity : c.relation;
  return (
    <g {...(line.kind ? { 'data-edge': line.key } : { 'data-predicate': line.key })} opacity={faded ? FADED : 1} pointerEvents="none">
      <title>{EDGE_TITLE[line.kind] ?? 'Relation'} {line.label}</title>
      <path d={line.path} fill="none" stroke={stroke} strokeWidth={1.2} strokeDasharray="5 4" />
      <LineLabel line={line} c={c} stroke={stroke} />
    </g>
  );
}

export default function RuleCanvas(props) {
  const { placed, lines, predicates, edges = [], ghost, view, svgRef, handlers, canEdit, onLine, highlight } = props;
  const c = useIsDark() ? DARK : LIGHT;
  return (
    <svg ref={svgRef} role="group" aria-label="Model canvas" className="block w-full rounded border border-gray-200 dark:border-gray-700"
      style={{ height: 600, touchAction: 'none', background: c.canvas }} {...handlers}>
      <defs>
        <marker id="ot-canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={c.line} />
        </marker>
      </defs>
      <g data-view={`${view.x},${view.y},${view.k}`} transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {predicates.map(l => <Relation key={l.key} line={l} highlight={highlight} c={c} />)}
        {edges.map(l => <Relation key={l.key} line={l} highlight={highlight} c={c} />)}
        {placed.map(b => <Box key={b.id} box={b} c={c} props={props} />)}
        {lines.map(l => <Line key={l.key} line={l} canEdit={canEdit} onLine={onLine} highlight={highlight} c={c} />)}
        {ghost && (
          <line data-ghost="" x1={ghost.from.x} y1={ghost.from.y} x2={ghost.to.x} y2={ghost.to.y}
            stroke={c.line} strokeWidth={1.6} strokeDasharray="4 3" pointerEvents="none" />
        )}
      </g>
    </svg>
  );
}

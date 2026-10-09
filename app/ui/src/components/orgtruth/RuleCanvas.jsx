// Organisation → Model → Link rules: the canvas of one profile. Draws the
// boxes, rows and rule lines that modelCanvas.js computes; every row and every
// line label is a focusable button (Enter/Space activate it) whose accessible
// name says what it does (linkRulesDraft.rowName). A reader gets the same
// drawing without buttons.
//
// Props: { layout, lines, selection, canEdit, onRow(row), onLine(index),
//          rename: { type, value } | null, onRenameStart(type),
//          onRenameChange(value), onRenameSave(), onRenameCancel() }
import { useIsDark } from '@ui/contexts/ThemeContext';
import { rowName } from './linkRulesDraft';
import { HEADER_H, ROW_H } from './modelCanvas';
import { LABEL_H } from './modelGraph';

const LIGHT = {
  entityHead: '#c7d2fe', systemHead: '#bae6fd', body: '#ffffff', stroke: '#6b7280', text: '#111827',
  sub: '#374151', selected: '#fde68a', target: '#e0f2fe', line: '#0369a1', labelBg: '#ffffff', label: '#1f2937',
};
const DARK = {
  entityHead: '#3730a3', systemHead: '#075985', body: '#1f2937', stroke: '#9ca3af', text: '#f9fafb',
  sub: '#e5e7eb', selected: '#92400e', target: '#0c4a6e', line: '#7dd3fc', labelBg: '#111827', label: '#e5e7eb',
};

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
    <g data-row={row.id} {...buttonProps(Boolean(active), () => onRow(row), name)} {...(active && row.source ? { 'aria-pressed': pressed } : {})}>
      <rect x={row.x + 1} y={row.y} width={198} height={ROW_H} fill={rowFill(row, selection, c)} />
      <text x={row.x + 12} y={row.cy + 4} fontSize={12} fill={c.text}>{row.label}</text>
    </g>
  );
}

function RenameField({ box, rename, onRenameChange, onRenameSave, onRenameCancel }) {
  return (
    <foreignObject x={box.x + 4} y={box.y + 3} width={box.w - 8} height={HEADER_H - 6}>
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
  const y = box.y + 7;
  return (
    <g {...buttonProps(true, () => onRenameStart(box.entityType), `Rename ${box.entityType}`)}>
      <title>Rename {box.entityType}</title>
      <rect x={x - 2} y={y - 2} width={22} height={22} rx={4} fill="transparent" />
      <path
        d={`M ${x + 3} ${y + 15} L ${x + 4} ${y + 11} L ${x + 13} ${y + 2} L ${x + 16} ${y + 5} L ${x + 7} ${y + 14} Z`}
        fill="none" stroke={c.sub} strokeWidth={1.4} strokeLinejoin="round"
      />
    </g>
  );
}

function Box({ box, c, props }) {
  const { selection, canEdit, onRow, rename } = props;
  const renaming = rename?.type === box.entityType && box.own;
  return (
    <g data-box={box.id}>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} fill={c.body} stroke={c.stroke} strokeWidth={1} />
      <rect x={box.x} y={box.y} width={box.w} height={HEADER_H} rx={6} fill={box.kind === 'system' ? c.systemHead : c.entityHead} />
      {renaming
        ? <RenameField box={box} rename={rename} {...props} />
        : (
          <text x={box.x + 10} y={box.y + 20} fontSize={13} fontWeight={600} fill={c.text}>
            {box.title}{box.count != null ? ` (${box.count})` : ''}
          </text>
        )}
      {canEdit && box.own && !renaming && <PencilButton box={box} onRenameStart={props.onRenameStart} c={c} />}
      {box.rows.map(r => <Row key={r.id} row={r} selection={selection} canEdit={canEdit} onRow={onRow} c={c} />)}
    </g>
  );
}

function Line({ line, canEdit, onLine, c }) {
  const open = () => onLine(line.index);
  return (
    <g data-line={line.index}>
      <path d={line.path} fill="none" stroke={c.line} strokeWidth={1.6} markerEnd="url(#ot-canvas-arrow)"
        aria-hidden="true" onClick={canEdit ? open : undefined} style={canEdit ? { cursor: 'pointer' } : undefined} />
      <g {...buttonProps(canEdit, open, line.name)}>
        <rect x={line.labelX - line.labelW / 2} y={line.labelY - LABEL_H / 2 - 1} width={line.labelW} height={LABEL_H}
          rx={3} fill={c.labelBg} stroke={c.line} strokeWidth={0.6} />
        <text x={line.labelX} y={line.labelY + 3} textAnchor="middle" fontSize={11} fill={c.label}>{line.label}</text>
      </g>
    </g>
  );
}

export default function RuleCanvas(props) {
  const { layout, lines, canEdit, onLine } = props;
  const c = useIsDark() ? DARK : LIGHT;
  return (
    <svg
      role="group"
      aria-label="Link rules canvas"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="w-full h-auto"
      style={{ maxHeight: 640 }}
    >
      <defs>
        <marker id="ot-canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={c.line} />
        </marker>
      </defs>
      {layout.boxes.map(b => <Box key={b.id} box={b} c={c} props={props} />)}
      {lines.map(l => <Line key={l.index} line={l} canEdit={canEdit} onLine={onLine} c={c} />)}
    </svg>
  );
}

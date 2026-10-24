import { useDraggable, useDroppable } from '@dnd-kit/core';
import { countText, memberWord, unitMarks } from './adjustTree.helpers';
import AdjustTreeMembers from './AdjustTreeMembers';

// One unit of the Adjust tree, then (when open) its members and its sub-units.
// In an editable tree the row is both a drag handle (drop it onto another unit
// to move it there) and a drop target; a checkbox picks it for "Group into new
// unit…". Blue marks only what can be acted on: the selection and a drop target.

const INDENT_PX = 18;

const MARK_CLASS = {
  neutral: 'border border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-700/50 dark:text-gray-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
};

export function Mark({ label, tone }) {
  return <span className={`shrink-0 rounded-full px-1.5 text-[11px] leading-[18px] ${MARK_CLASS[tone] || MARK_CLASS.neutral}`}>{label}</span>;
}

function rowClass({ selected, isOver, forbidden }) {
  if (forbidden) return 'opacity-50';
  if (isOver) return 'bg-blue-50 ring-2 ring-blue-500 dark:bg-blue-900/30 dark:ring-blue-400';
  if (selected) return 'bg-blue-50 dark:bg-blue-900/30';
  return 'hover:bg-gray-50 dark:hover:bg-gray-700/40';
}

// The drag + drop wiring of one row, as flat values. Not placed is a drop
// target (for people) but never dragged itself.
function useRowDnd(unit, editable) {
  const movable = editable && !unit.notPlaced;
  const { setNodeRef: dragRef, listeners, isDragging } = useDraggable({
    id: `u:${unit.id}`, data: { type: 'unit', unitId: unit.id, name: unit.name }, disabled: !movable,
  });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: unit.id, disabled: !editable });
  return { movable, dragRef, listeners: movable ? listeners : {}, isDragging, dropRef, isOver };
}

function nameClass(unit, movable) {
  const tone = unit.notPlaced ? 'italic text-gray-600 dark:text-gray-400' : 'text-gray-900 dark:text-white';
  return `min-w-0 truncate text-left text-sm font-medium ${tone} ${movable ? 'cursor-grab active:cursor-grabbing' : ''}`;
}

export default function AdjustTreeRow({ unit, depth, view }) {
  const { isOpen, visible, showMembers } = view;
  const kids = visible ? unit.children.filter(c => visible.has(c.id)) : unit.children;
  const open = isOpen(unit.id);
  const membersShown = open && showMembers && (unit.memberCount ?? 0) > 0;
  return (
    <li>
      <UnitLine unit={unit} depth={depth} open={open} view={view} />
      {membersShown && (
        <AdjustTreeMembers key={`${unit.id}:${view.version}`} unitId={unit.id} targetType={view.targetType} editable={view.editable} indent={30 + depth * INDENT_PX} />
      )}
      {open && kids.length > 0 && (
        <ul>
          {kids.map(c => <AdjustTreeRow key={c.id} unit={c} depth={depth + 1} view={view} />)}
        </ul>
      )}
    </li>
  );
}

function UnitLine({ unit, depth, open, view }) {
  const { editable, selectedId, onSelect, toggle, matches, checked, onCheck, forbiddenIds, dragging } = view;
  const { movable, dragRef, listeners, isDragging, dropRef, isOver } = useRowDnd(unit, editable);
  const selected = selectedId === unit.id;
  const forbidden = dragging && forbiddenIds.has(unit.id);
  return (
    <div
      ref={dropRef}
      className={`flex items-center gap-1.5 rounded-md py-1 pr-2 ${rowClass({ selected, isOver, forbidden })}`}
      style={{ paddingLeft: `${4 + depth * INDENT_PX}px`, opacity: isDragging ? 0.4 : undefined }}
    >
      <ExpandButton unit={unit} open={open} onToggle={() => toggle(unit.id)} />
      {movable && (
        <input type="checkbox" checked={checked.has(unit.id)} onChange={() => onCheck(unit.id)} aria-label={`Pick ${unit.name}`} className="h-3.5 w-3.5 shrink-0" />
      )}
      <button
        type="button" ref={dragRef} {...listeners} onClick={() => onSelect(unit.id)}
        aria-current={selected ? 'true' : undefined}
        title={movable ? 'Drag onto another unit to move it there' : undefined}
        className={nameClass(unit, movable)}
      >
        {unit.name}
        {unit.accountable?.name && <>{' '}<span className="font-normal text-gray-600 dark:text-gray-400">({unit.accountable.name})</span></>}
      </button>
      {unitMarks(unit).map(m => <Mark key={m.key} label={m.label} tone={m.tone} />)}
      {matches.has(unit.id) && <Mark label="match" tone="warn" />}
      <RowCount unit={unit} targetType={view.targetType} />
    </div>
  );
}

function ExpandButton({ unit, open, onToggle }) {
  if (unit.children.length === 0) return <span className="h-5 w-5 shrink-0" />;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${unit.name}`}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700">
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
  );
}

function RowCount({ unit, targetType }) {
  const direct = unit.memberCount ?? 0;
  const total = unit.totalMemberCount ?? direct;
  const title = `${direct} ${memberWord(targetType, direct)} directly in this unit, ${total} including its sub-units`;
  return (
    <span className="ml-auto shrink-0 pl-3 text-xs tabular-nums text-gray-600 dark:text-gray-400" title={title}>
      <span className="sr-only">{title}</span>
      <span aria-hidden="true">{countText(unit)}</span>
    </span>
  );
}

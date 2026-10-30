import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { rowCount, editedTitle } from './treePanel.helpers';

// The small presentational pieces of ContextTreeView: member ovals, the pills
// shown under the cursor while dragging, the row's one count, the row's chip
// and the inline rename field. Kept apart so the tree file holds only the tree
// logic. No colour per classification: blue is the selection (and a drop
// target while dragging), everything else is neutral.

const OVAL_CLASS = 'flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs text-left max-w-[220px] hover:border-slate-400 dark:hover:border-gray-400 hover:shadow-sm';
const OVAL_DOT = <span className="w-2 h-2 rounded-full bg-slate-400 dark:bg-gray-500 shrink-0" aria-hidden="true" />;

// A member shown as a small oval nested inside its unit. Click opens it.
export function MemberOval({ member, onOpen }) {
  return (
    <button onClick={onOpen} title={member.displayName} className={OVAL_CLASS}>
      {OVAL_DOT}
      <span className="text-gray-800 dark:text-gray-200 truncate">{member.displayName}</span>
    </button>
  );
}

// In an editable Manager-Hierarchy tree the member ovals are draggable: drop one
// onto another team to change who this person reports to (a 6px activation
// distance keeps a plain click opening the detail). The drag carries the member
// + its current unit so the drop handler can move it. Only the pointer drags
// (there is no keyboard sensor), so the drag's ARIA attributes are not spread:
// they would announce a keyboard drag that does not exist, and mark the button
// aria-disabled when dragging is off.
export function DraggableMemberOval({ member, fromContextId, onOpen }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `m:${fromContextId}:${member.id}`,
    data: { type: 'member', memberId: member.id, fromContextId, displayName: member.displayName },
  });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      onClick={onOpen}
      title={`${member.displayName} — drag onto another team to move`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className={`${OVAL_CLASS} cursor-grab active:cursor-grabbing`}
    >
      {OVAL_DOT}
      <span className="text-gray-800 dark:text-gray-200 truncate">{member.displayName}</span>
    </button>
  );
}

// The member oval rendered under the cursor while dragging it to a new team.
export function MemberDragPill({ displayName }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-blue-500 bg-white dark:bg-gray-800 text-xs shadow-lg cursor-grabbing">
      {OVAL_DOT}
      <span className="text-gray-800 dark:text-gray-200 truncate max-w-[200px]">{displayName}</span>
    </div>
  );
}

// Inline text editor reused for rename and add-child. Commits on Enter / blur,
// cancels on Escape.
export function RenameInput({ initial, placeholder, onCommit, onCancel }) {
  const [value, setValue] = useState(initial || '');
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={placeholder || 'Unit name'}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value.trim());
        else if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => onCommit(value.trim())}
      className="w-full min-w-[200px] max-w-[480px] px-2 py-1 text-sm border border-blue-400 dark:border-blue-500 rounded bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-400"
    />
  );
}

// The pill rendered under the cursor while dragging a unit.
export function DragPill({ node }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-blue-500 bg-white dark:bg-gray-800 shadow-lg cursor-grabbing">
      <span className="font-medium text-gray-900 dark:text-white truncate max-w-[220px]">{node.displayName}</span>
    </div>
  );
}

// The row's one count — everyone in the unit including its sub-units — with a
// title that splits it ("37 accounts (12 directly in this unit)").
export function MemberCount({ node }) {
  const count = rowCount(node);
  if (!count) return null;
  return (
    <span className="text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap shrink-0" title={count.title}>
      <span className="sr-only">, {count.title}</span>
      <span aria-hidden="true">{count.value}</span>
    </span>
  );
}

function chipClass({ canDrag, isValidDropTarget, isForbiddenTarget, selected }) {
  let state = 'border-slate-200 dark:border-gray-600';
  if (isValidDropTarget) state = 'border-blue-500 ring-2 ring-blue-400 dark:ring-blue-500 bg-blue-50 dark:bg-blue-900/30';
  else if (selected) state = 'border-blue-500 dark:border-blue-400 ring-1 ring-blue-400 dark:ring-blue-500';
  return [
    'flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border text-left shrink max-w-full transition-shadow',
    selected ? 'bg-blue-50 dark:bg-blue-900/30' : 'bg-white dark:bg-gray-800 hover:bg-slate-50 dark:hover:bg-gray-700/50',
    'hover:border-slate-300 dark:hover:border-gray-500 hover:shadow-sm',
    canDrag ? 'cursor-grab active:cursor-grabbing' : '',
    state,
    isForbiddenTarget ? 'opacity-50' : '',
  ].join(' ');
}

function chipTitle(editable, canDrag) {
  if (!editable) return undefined;
  return canDrag
    ? 'Double-click to rename · drag onto another unit to move it there'
    : 'Double-click to rename';
}

// The unit's own pill: an inline rename field while renaming, else the label
// button with its name (plus the kind as a word where the tab mixes kinds),
// an "edited" word on a derived unit changed here, and the one count. The
// drag listeners (pointer only) sit on it in an editable tree; the drag's ARIA
// attributes do not (see DraggableMemberOval).
export function NodeChip({ node, nodeLabel, suffix, renaming, setRenaming, onRename, dragRef, listeners, handleClick, handleDoubleClick, editable, canDrag, isValidDropTarget, isForbiddenTarget, selected }) {
  const edited = editedTitle(node);
  if (renaming) {
    return (
      <RenameInput
        initial={node.displayName}
        onCommit={(name) => { setRenaming(false); if (name && name !== node.displayName) onRename?.(node.id, name); }}
        onCancel={() => setRenaming(false)}
      />
    );
  }
  return (
    <button
      ref={dragRef}
      {...(canDrag ? listeners : {})}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      aria-current={selected ? 'true' : undefined}
      title={chipTitle(editable, canDrag)}
      className={chipClass({ canDrag, isValidDropTarget, isForbiddenTarget, selected })}
    >
      <span className="font-medium text-gray-900 dark:text-white truncate" title={nodeLabel !== node.displayName ? node.displayName : undefined}>
        {nodeLabel}{suffix && <>{' '}<span className="font-normal text-gray-600 dark:text-gray-400">· {suffix}</span></>}
      </span>
      {edited && <span className="text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap shrink-0" title={edited}>edited</span>}
      <MemberCount node={node} />
    </button>
  );
}

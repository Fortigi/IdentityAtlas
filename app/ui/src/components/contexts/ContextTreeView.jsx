import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, closestCenter,
} from '@dnd-kit/core';
import { variantMeta, targetTypeMeta, editedMeta } from '@ui/utils/contextStyles';
import { parseOrg, computeChildLabels, stripSiblingPrefix } from './ContextTreeView.helpers.js';

// Recursive tree renderer. Each node is a rounded pill with a variant-colored
// bubble; connector lines between parent and child make the hierarchy
// obvious at a glance. Every pill is a button so keyboard navigation still
// works — aria-expanded stays on the expander toggle.
//
// The tree is also editable in place:
//   • drag a node onto another node to re-parent it (drop = "become a child of")
//   • double-click a node's name to rename it
//   • use the "+" affordance to add a manual child context
// All three call back into ContextsPage, which PATCHes/POSTs and refetches so
// member counts (direct + total) stay correct after every structural change.

const INDENT_PX = 22;  // horizontal offset per depth level
const CONNECTOR = 'rgb(203 213 225)'; // slate-300 — matches the bubble ring
const MEMBER_KIND = { Identity: 'identity', Resource: 'group', System: 'system' };

// Lazy-load a node's members when its member panel is first opened; drop the
// cache when the direct count changes. members is value-set everywhere so a
// reducer dispatch stands in for setState, keeping the invalidate effect clear
// of react-hooks/set-state-in-effect.
function useNodeMembers(nodeId, directMemberCount, showMembers, onLoadMembers) {
  const [members, setMembers] = useReducer((_, v) => v, null); // null = not loaded
  const [memberTotal, setMemberTotal] = useState(0);
  useEffect(() => {
    if (!showMembers || members !== null || !onLoadMembers) return;
    let cancelled = false;
    onLoadMembers(nodeId)
      .then(({ rows, total }) => { if (!cancelled) { setMembers(rows); setMemberTotal(total); } })
      .catch(() => { if (!cancelled) { setMembers([]); setMemberTotal(0); } });
    return () => { cancelled = true; };
  }, [showMembers, members, onLoadMembers, nodeId]);
  useEffect(() => { setMembers(null); }, [directMemberCount]);
  return { members, memberTotal };
}

// Collect a node's id plus every descendant id — the set of drop targets that
// would create a cycle for that node (you can't drop a node onto itself or
// anything beneath it).
function collectSubtreeIds(node, out = new Set()) {
  out.add(node.id);
  for (const c of node.children || []) collectSubtreeIds(c, out);
  return out;
}

function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

// Label-computation helpers (dedupeSegments / parseOrg / computeChildLabels /
// stripSiblingPrefix) live in ContextTreeView.helpers.js so this file only
// exports its component.

export default function ContextTreeView({ nodes, onOpenDetail, onReparent, onRename, onAddChild, onLoadMembers, onOpenMember, onMoveMember }) {
  const sensors = useSensors(
    // 6px activation distance — a plain click still opens the detail; only a
    // deliberate drag starts a re-parent.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const [activeId, setActiveId] = useState(null);
  const activeNode = useMemo(() => (activeId ? findNode(nodes, activeId) : null), [activeId, nodes]);
  // Ids that the active node may NOT be dropped onto (itself + its descendants).
  const forbidden = useMemo(
    () => (activeNode ? collectSubtreeIds(activeNode) : new Set()),
    [activeNode]
  );

  const editable = typeof onReparent === 'function';
  const memberMoveEnabled = typeof onMoveMember === 'function';
  const dndEnabled = editable || memberMoveEnabled;
  // The member chip being dragged (vs a context node). { memberId, fromContextId, displayName }
  const [activeMember, setActiveMember] = useState(null);

  // Expand/collapse state lives here (keyed by node id) instead of in each
  // TreeNode's local state, so it SURVIVES a refetch — e.g. after a drag-drop
  // re-parent the tree reloads, but every node you'd expanded stays expanded.
  // New nodes default to expanded when shallow (depth < 2); we remember which
  // ids we've already defaulted so a node you deliberately collapsed doesn't
  // spring back open on the next reload.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const seededRef = useRef(new Set());
  useEffect(() => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      const walk = (list, depth) => {
        for (const n of list) {
          if (!seededRef.current.has(n.id)) {
            seededRef.current.add(n.id);
            if (depth < 2) next.add(n.id);
          }
          if (n.children?.length) walk(n.children, depth + 1);
        }
      };
      walk(nodes, 0);
      return next;
    });
  }, [nodes]);

  const isExpanded = (id) => expandedIds.has(id);
  const toggleExpanded = (id) => setExpandedIds(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const setExpanded = (id, v) => setExpandedIds(prev => {
    const n = new Set(prev);
    if (v) n.add(id); else n.delete(id);
    return n;
  });

  function handleDragStart(e) {
    const d = e.active.data?.current;
    if (d?.type === 'member') { setActiveMember(d); setActiveId(null); }
    else { setActiveId(e.active.id); setActiveMember(null); }
  }

  function handleDragEnd(evt) {
    const { active, over } = evt;
    const d = active.data?.current;
    setActiveId(null);
    setActiveMember(null);
    if (!over) return;
    // Member chip dropped onto a team → move the person there.
    if (d?.type === 'member') {
      if (onMoveMember && over.id !== d.fromContextId) onMoveMember(d.memberId, d.fromContextId, over.id);
      return;
    }
    // Context node dropped onto another → re-parent.
    if (!onReparent) return;
    const childId = active.id;
    const newParentId = over.id;
    if (childId === newParentId || forbidden.has(newParentId)) return; // cycle / no-op
    onReparent(childId, newParentId);
  }

  const rootLabels = useMemo(() => stripSiblingPrefix(nodes), [nodes]);

  const treeBody = (
    <div className="p-4">
      <ul className="text-sm space-y-1">
        {nodes.map(n => (
          <TreeNode
            key={n.id}
            node={n}
            displayLabel={rootLabels.get(n.id)}
            depth={0}
            isLast={true}
            onOpenDetail={onOpenDetail}
            onRename={onRename}
            onAddChild={onAddChild}
            onLoadMembers={onLoadMembers}
            onOpenMember={onOpenMember}
            editable={editable}
            memberDraggable={memberMoveEnabled}
            forbidden={forbidden}
            dragging={!!activeId || !!activeMember}
            isExpanded={isExpanded}
            toggleExpanded={toggleExpanded}
            setExpanded={setExpanded}
          />
        ))}
      </ul>
    </div>
  );

  if (!dndEnabled) return treeBody;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => { setActiveId(null); setActiveMember(null); }}
    >
      {treeBody}
      <DragOverlay dropAnimation={null}>
        {activeNode ? <DragPill node={activeNode} />
          : activeMember ? <MemberDragPill displayName={activeMember.displayName} />
          : null}
      </DragOverlay>
    </DndContext>
  );
}

function TreeNode({ node, displayLabel, depth, isLast, onOpenDetail, onRename, onAddChild, onLoadMembers, onOpenMember, editable, memberDraggable, forbidden, dragging, isExpanded, toggleExpanded, setExpanded }) {
  const expanded = isExpanded(node.id);
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const nodeLabel = displayLabel || node.displayName;

  // Opt-in: members (the actual users) are hidden until the analyst clicks the
  // member toggle, then shown nested inside the node. Lazy-loaded on first open.
  const [showMembers, setShowMembers] = useState(false);
  const { members, memberTotal } = useNodeMembers(node.id, node.directMemberCount, showMembers, onLoadMembers);
  const canShowMembers = typeof onLoadMembers === 'function' && node.directMemberCount > 0;
  const memberKind = MEMBER_KIND[node.targetType] || 'user';
  // Single click opens the detail; double click renames. We delay the open so a
  // double-click can cancel it — otherwise the first click navigates away before
  // the rename can fire.
  const clickTimerRef = useRef(null);
  const openDetail = () => onOpenDetail(node.id, node.displayName);
  const handleClick = () => {
    if (!editable) { openDetail(); return; }
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => { clickTimerRef.current = null; openDetail(); }, 220);
  };
  const handleDoubleClick = (e) => {
    if (!editable) return;
    e.preventDefault();
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
    setRenaming(true);
  };
  const hasChildren = node.children && node.children.length > 0;
  const v = variantMeta(node.variant);
  const t = targetTypeMeta(node.targetType);
  const edited = editedMeta(node);

  // Root of the displayed subtree can't be dragged (it has no parent to change
  // within this view); everything below it can.
  const canDrag = editable && depth > 0 && !renaming;

  const { setNodeRef: dragRef, listeners, attributes, isDragging } = useDraggable({
    id: node.id, disabled: !canDrag,
  });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: node.id, disabled: !editable });

  const isForbiddenTarget = dragging && forbidden.has(node.id);
  const isValidDropTarget = isOver && dragging && !isForbiddenTarget;

  // Pass-through props the recursive child nodes inherit unchanged.
  const shared = {
    onOpenDetail, onRename, onAddChild, onLoadMembers, onOpenMember,
    isExpanded, toggleExpanded, setExpanded, editable, memberDraggable, forbidden, dragging,
  };

  return (
    <li className="relative">
      {depth > 0 && (
        <span
          aria-hidden="true"
          className="absolute"
          style={{
            left: `${(depth - 1) * INDENT_PX + 10}px`,
            top: 0,
            bottom: isLast ? '50%' : 0,
            width: `${INDENT_PX - 2}px`,
            borderLeft: `1px solid ${CONNECTOR}`,
            borderBottom: `1px solid ${CONNECTOR}`,
            borderBottomLeftRadius: '6px',
          }}
        />
      )}

      <div
        ref={dropRef}
        className="group flex items-center gap-2 rounded-full"
        style={{ paddingLeft: `${depth * INDENT_PX}px`, opacity: isDragging ? 0.4 : 1 }}
      >
        <ExpandToggle hasChildren={hasChildren} expanded={expanded} onToggle={() => toggleExpanded(node.id)} />

        <NodeChip
          node={node} nodeLabel={nodeLabel} renaming={renaming} setRenaming={setRenaming} onRename={onRename}
          dragRef={dragRef} listeners={listeners} attributes={attributes}
          handleClick={handleClick} handleDoubleClick={handleDoubleClick}
          canDrag={canDrag} isValidDropTarget={isValidDropTarget} isForbiddenTarget={isForbiddenTarget}
          edited={edited} v={v} t={t}
        />

        {/* Member toggle — show/hide the actual users nested inside this node. */}
        <MemberToggle canShow={canShowMembers} dragging={dragging} show={showMembers} count={node.directMemberCount} onToggle={() => setShowMembers(s => !s)} />

        {/* Add-child affordance — appears on hover, hidden while dragging. */}
        <AddChildButton editable={editable} renaming={renaming} dragging={dragging} onClick={() => { setAddingChild(true); setExpanded(node.id, true); }} />
      </div>

      {/* Members nested inside this context — the direct-report users as ovals. */}
      {showMembers && (
        <NodeMembersPanel
          members={members} memberTotal={memberTotal} depth={depth}
          memberDraggable={memberDraggable} nodeId={node.id} memberKind={memberKind}
          onOpenMember={onOpenMember}
        />
      )}

      {addingChild && (
        <div className="mt-1" style={{ paddingLeft: `${(depth + 1) * INDENT_PX + 28}px` }}>
          <RenameInput
            initial=""
            placeholder="New child name…"
            onCommit={(name) => { setAddingChild(false); if (name) onAddChild?.(node.id, name); }}
            onCancel={() => setAddingChild(false)}
          />
        </div>
      )}

      {hasChildren && expanded && <NodeChildren node={node} depth={depth} shared={shared} />}
    </li>
  );
}

function ExpandToggle({ hasChildren, expanded, onToggle }) {
  if (!hasChildren) return <span className="w-5 h-5 inline-block shrink-0" />;
  return (
    <button
      aria-expanded={expanded}
      onClick={onToggle}
      className="w-5 h-5 flex items-center justify-center text-gray-600 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded shrink-0"
      title={expanded ? 'Collapse' : 'Expand'}
    >
      {expanded ? '▾' : '▸'}
    </button>
  );
}

function MemberToggle({ canShow, dragging, show, count, onToggle }) {
  if (!canShow || dragging) return null;
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-1 h-6 px-1.5 rounded-full border text-[11px] shrink-0 ${
        show
          ? 'border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300'
          : 'border-slate-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-slate-300 dark:hover:border-gray-500'
      }`}
      title={show ? 'Hide the users in this context' : 'Show the users directly in this context'}
    >
      <span aria-hidden="true">{show ? '▾' : '▸'}</span>
      <span aria-hidden="true">👤</span>
      <span>{count}</span>
    </button>
  );
}

function AddChildButton({ editable, renaming, dragging, onClick }) {
  if (!editable || renaming || dragging) return null;
  return (
    <button
      onClick={onClick}
      className="w-5 h-5 flex items-center justify-center text-gray-600 dark:text-gray-400 opacity-0 group-hover:opacity-100 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded shrink-0"
      title="Add a child context"
    >
      +
    </button>
  );
}

function chipClass({ canDrag, isValidDropTarget, edited, isForbiddenTarget }) {
  const dropState = isValidDropTarget
    ? 'border-blue-500 ring-2 ring-blue-400 dark:ring-blue-500 bg-blue-50 dark:bg-blue-900/30'
    : edited
      ? `border-amber-300 dark:border-amber-700 ${edited.ringClass}`
      : 'border-slate-200 dark:border-gray-600';
  return [
    'flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border bg-white dark:bg-gray-800 text-left shrink max-w-full transition-shadow',
    'hover:bg-slate-50 dark:bg-gray-700/50 hover:border-slate-300 dark:border-gray-500 hover:shadow-sm',
    canDrag ? 'cursor-grab active:cursor-grabbing' : '',
    dropState,
    isForbiddenTarget ? 'opacity-50' : '',
  ].join(' ');
}

// The node's own pill: an inline rename field while renaming, else the draggable
// label button with variant dot, type badge, edited badge and member count.
function NodeChip({ node, nodeLabel, renaming, setRenaming, onRename, dragRef, listeners, attributes, handleClick, handleDoubleClick, canDrag, isValidDropTarget, isForbiddenTarget, edited, v, t }) {
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
      {...listeners}
      {...attributes}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title={canDrag ? 'Click to open · double-click to rename · drag onto another node to re-parent' : undefined}
      className={chipClass({ canDrag, isValidDropTarget, edited, isForbiddenTarget })}
    >
      <span
        className={`w-2.5 h-2.5 rounded-full ${v.dotClass} ring-2 ring-white outline outline-1 outline-slate-200 shrink-0`}
        aria-hidden="true"
      />
      <span className="font-medium text-gray-900 dark:text-white truncate" title={nodeLabel !== node.displayName ? node.displayName : undefined}>{nodeLabel}</span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass} whitespace-nowrap shrink-0`}>
        {t.label}
      </span>
      {edited && (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${edited.badgeClass} whitespace-nowrap shrink-0`}
          title={edited.title}
        >
          ✎ {edited.label}
        </span>
      )}
      <MemberCount direct={node.directMemberCount} total={node.totalMemberCount} />
    </button>
  );
}

// The direct-report users of a node, shown as ovals once its member panel opens.
function NodeMembersPanel({ members, memberTotal, depth, memberDraggable, nodeId, memberKind, onOpenMember }) {
  const openMember = (m) => onOpenMember?.(m.id, m.displayName, memberKind);
  return (
    <div
      className="mt-1 rounded-xl border border-sky-200 dark:border-sky-800/60 bg-sky-50/50 dark:bg-sky-900/10 px-2 py-1.5"
      style={{ marginLeft: `${depth * INDENT_PX + 28}px` }}
    >
      {members === null ? (
        <span className="text-[11px] text-gray-500 dark:text-gray-400">Loading users…</span>
      ) : members.length === 0 ? (
        <span className="text-[11px] text-gray-500 dark:text-gray-400">No directly-assigned users.</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {members.map(m => (
            memberDraggable
              ? <DraggableMemberOval key={m.id} member={m} fromContextId={nodeId} onOpen={() => openMember(m)} />
              : <MemberOval key={m.id} member={m} onOpen={() => openMember(m)} />
          ))}
          {memberTotal > members.length && (
            <span className="self-center text-[11px] text-gray-500 dark:text-gray-400">
              +{memberTotal - members.length} more — open this context to see all
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// The expanded children of a node — strips the node's own org path from each
// child label so the org name isn't repeated at every level going down.
function NodeChildren({ node, depth, shared }) {
  const childLabels = computeChildLabels(node.children, parseOrg(node.displayName).org);
  return (
    <ul className="space-y-1 mt-1">
      {node.children.map((c, i) => (
        <TreeNode
          key={c.id}
          node={c}
          displayLabel={childLabels.get(c.id)}
          depth={depth + 1}
          isLast={i === node.children.length - 1}
          {...shared}
        />
      ))}
    </ul>
  );
}

// A user (member) shown as a small oval nested inside its context. Click opens
// the user's detail.
function MemberOval({ member, onOpen }) {
  return (
    <button
      onClick={onOpen}
      title={member.displayName}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-[11px] text-left max-w-[220px] hover:border-sky-300 dark:hover:border-sky-700 hover:shadow-sm"
    >
      <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" aria-hidden="true" />
      <span className="text-gray-800 dark:text-gray-200 truncate">{member.displayName}</span>
    </button>
  );
}

// In an editable Manager-Hierarchy tree the member ovals are draggable: drop one
// onto another team to change who this person reports to (a 6px activation
// distance keeps a plain click opening the detail). The drag carries the member
// + its current context so the drop handler can move it.
function DraggableMemberOval({ member, fromContextId, onOpen }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `m:${fromContextId}:${member.id}`,
    data: { type: 'member', memberId: member.id, fromContextId, displayName: member.displayName },
  });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onOpen}
      title={`${member.displayName} — drag onto another team to move`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-[11px] text-left max-w-[220px] cursor-grab active:cursor-grabbing hover:border-sky-300 dark:hover:border-sky-700 hover:shadow-sm"
    >
      <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" aria-hidden="true" />
      <span className="text-gray-800 dark:text-gray-200 truncate">{member.displayName}</span>
    </button>
  );
}

// The member oval rendered under the cursor while dragging it to a new team.
function MemberDragPill({ displayName }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-sky-400 bg-white dark:bg-gray-800 text-[11px] shadow-lg cursor-grabbing">
      <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" aria-hidden="true" />
      <span className="text-gray-800 dark:text-gray-200 truncate max-w-[200px]">{displayName}</span>
    </div>
  );
}

// Inline text editor reused for rename and add-child. Commits on Enter / blur,
// cancels on Escape.
function RenameInput({ initial, placeholder, onCommit, onCancel }) {
  const [value, setValue] = useState(initial || '');
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value.trim());
        else if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => onCommit(value.trim())}
      className="w-full min-w-[260px] max-w-[480px] px-2 py-1 text-sm border border-blue-400 dark:border-blue-500 rounded bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-400"
    />
  );
}

// The pill rendered under the cursor while dragging.
function DragPill({ node }) {
  const v = variantMeta(node.variant);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-blue-400 bg-white dark:bg-gray-800 shadow-lg cursor-grabbing">
      <span className={`w-2.5 h-2.5 rounded-full ${v.dotClass} ring-2 ring-white outline outline-1 outline-slate-200`} aria-hidden="true" />
      <span className="font-medium text-gray-900 dark:text-white truncate max-w-[220px]">{node.displayName}</span>
    </div>
  );
}

// Shows "<direct> direct" for leaves and "<direct> · <total>" for subtree
// nodes so the weight carried under an expanded node is obvious at a glance.
function MemberCount({ direct, total }) {
  if (typeof direct !== 'number' && typeof total !== 'number') return null;
  const d = direct || 0;
  const t = total  || 0;
  if (t > d) {
    return (
      <span className="text-[11px] text-gray-600 dark:text-gray-500 whitespace-nowrap shrink-0">
        {d} · <span className="text-gray-600 dark:text-gray-400">{t}</span>
      </span>
    );
  }
  return <span className="text-[11px] text-gray-600 dark:text-gray-500 whitespace-nowrap shrink-0">{d}</span>;
}

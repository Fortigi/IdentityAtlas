import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, closestCenter,
} from '@dnd-kit/core';
import { memberKindLabel } from '@ui/utils/contextStyles';
import { parseOrg, computeChildLabels, stripSiblingPrefix } from './ContextTreeView.helpers.js';
import { MemberOval, DraggableMemberOval, MemberDragPill, RenameInput, DragPill, NodeChip } from './ContextTreeParts';

// Recursive tree renderer. Each node is a rounded pill with its name and one
// count; connector lines between parent and child make the hierarchy obvious
// at a glance. Every pill is a button so keyboard navigation still works —
// aria-expanded stays on the expander toggle.
//
// The tree is editable in place only when the page passes the edit callbacks
// (a tree whose edits persist, and a user who may write):
//   • drag a node onto another node to re-parent it (drop = "become a child of")
//   • double-click a node's name to rename it
//   • use the "+" affordance to add a manual child context
// All three call back into ContextsPage, which PATCHes/POSTs and refetches so
// member counts (direct + total) stay correct after every structural change.
//
// Selection mode (the Contexts page's left pane): with `onSelect`, a click
// selects the node (highlighted while its id is `selectedId`) instead of
// opening it. A node flagged `childrenPending` has children not read yet: it
// shows an expander, starts collapsed, and calls `onExpandNode(id)` when
// opened. `memberMovable(root)` limits the member drag to some top-level trees.
// `renderRootActions(root)` draws a root row's own actions (the ⋯ menu), and
// `rootSuffix(root)` a word after a root's name (its kind, on mixed tabs).

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

export default function ContextTreeView({ nodes, onOpenDetail, onReparent, onRename, onAddChild, onLoadMembers, onOpenMember, onMoveMember, selectedId, onSelect, onExpandNode, memberMovable, renderRootActions, rootSuffix }) {
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
          // A node whose children are not read yet stays collapsed; it is
          // seeded once they arrive.
          if (!n.childrenPending && !seededRef.current.has(n.id)) {
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

  // Pass-through props every node (and, recursively, its children) inherits.
  const shared = {
    onOpenDetail, onRename, onAddChild, onLoadMembers, onOpenMember, onSelect, onExpandNode, selectedId,
    editable, forbidden, dragging: !!activeId || !!activeMember, isExpanded, toggleExpanded, setExpanded,
  };
  const treeBody = (
    <div className={onSelect ? 'p-2' : 'p-4'}>
      <ul className="text-sm space-y-1">
        {nodes.map(n => (
          <TreeNode
            key={n.id}
            node={n}
            displayLabel={rootLabels.get(n.id)}
            depth={0}
            isLast={true}
            {...shared}
            rootActions={renderRootActions?.(n)}
            suffix={rootSuffix?.(n)}
            memberDraggable={memberMoveEnabled && (!memberMovable || memberMovable(n))}
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

// Single click activates (selects, or opens the detail); double click renames.
// In an editable tree the activation is delayed so a double-click can cancel
// it — otherwise the first click would act before the rename can fire.
function useNodeClick(node, { editable, onSelect, onOpenDetail, setRenaming }) {
  const clickTimerRef = useRef(null);
  const activate = () => (onSelect ? onSelect(node.id, node.displayName) : onOpenDetail?.(node.id, node.displayName));
  const handleClick = () => {
    if (!editable) { activate(); return; }
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => { clickTimerRef.current = null; activate(); }, 220);
  };
  const handleDoubleClick = (e) => {
    if (!editable) return;
    e.preventDefault();
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
    setRenaming(true);
  };
  return { handleClick, handleDoubleClick };
}

// The drag (re-parent) and drop (become-a-child-of) wiring of one node. The
// root of the displayed tree can't be dragged (it has no parent to change
// within this view); everything below it can.
function useNodeDnd(node, { editable, depth, renaming, dragging, forbidden }) {
  const canDrag = editable && depth > 0 && !renaming;
  const { setNodeRef: dragRef, listeners, attributes, isDragging } = useDraggable({ id: node.id, disabled: !canDrag });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: node.id, disabled: !editable });
  const isForbiddenTarget = dragging && forbidden.has(node.id);
  const isValidDropTarget = isOver && dragging && !isForbiddenTarget;
  return { canDrag, dragRef, listeners, attributes, isDragging, dropRef, isForbiddenTarget, isValidDropTarget };
}

// The connector line from a child up to its parent.
function NodeConnector({ depth, isLast }) {
  if (depth === 0) return null;
  return (
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
  );
}

// What sits below an expanded node: "Loading…" while its children are read,
// else the children themselves.
function NodeBelow({ node, depth, expanded, shared }) {
  if (!expanded) return null;
  if (node.childrenPending) {
    return (
      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400" style={{ paddingLeft: `${(depth + 1) * INDENT_PX + 28}px` }}>
        Loading…
      </div>
    );
  }
  return node.children?.length > 0 ? <NodeChildren node={node} depth={depth} shared={shared} /> : null;
}

function TreeNode({ node, displayLabel, depth, isLast, memberDraggable, rootActions, suffix, ...shared }) {
  const { onRename, onAddChild, onLoadMembers, onOpenMember, onExpandNode, onSelect, selectedId, editable, dragging, isExpanded, toggleExpanded, setExpanded } = shared;
  const expanded = isExpanded(node.id);
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);

  // Opt-in: members (the actual users) are hidden until the analyst clicks the
  // member toggle, then shown nested inside the node. Lazy-loaded on first open.
  const [showMembers, setShowMembers] = useState(false);
  const { members, memberTotal } = useNodeMembers(node.id, node.directMemberCount, showMembers, onLoadMembers);
  const canShowMembers = typeof onLoadMembers === 'function' && node.directMemberCount > 0;
  const { handleClick, handleDoubleClick } = useNodeClick(node, { ...shared, setRenaming });
  const hasChildren = !!node.childrenPending || node.children?.length > 0;
  const { canDrag, dragRef, listeners, isDragging, dropRef, isForbiddenTarget, isValidDropTarget } = useNodeDnd(node, { ...shared, depth, renaming });
  const toggle = () => {
    if (!expanded && node.childrenPending) onExpandNode?.(node.id);
    toggleExpanded(node.id);
  };

  return (
    <li className="relative">
      <NodeConnector depth={depth} isLast={isLast} />

      <div
        ref={dropRef}
        className="group flex items-center gap-2 rounded-full"
        style={{ paddingLeft: `${depth * INDENT_PX}px`, opacity: isDragging ? 0.4 : 1 }}
      >
        <ExpandToggle hasChildren={hasChildren} expanded={expanded} onToggle={toggle} label={node.displayName} />

        <NodeChip
          node={node} nodeLabel={displayLabel || node.displayName} suffix={suffix} renaming={renaming} setRenaming={setRenaming} onRename={onRename}
          dragRef={dragRef} listeners={listeners}
          handleClick={handleClick} handleDoubleClick={handleDoubleClick}
          editable={editable} canDrag={canDrag} isValidDropTarget={isValidDropTarget} isForbiddenTarget={isForbiddenTarget}
          selected={!!onSelect && selectedId === node.id}
        />

        {/* Member toggle — show/hide the members directly in this unit, nested under it. */}
        <MemberToggle canShow={canShowMembers} dragging={dragging} show={showMembers} node={node} onToggle={() => setShowMembers(s => !s)} />

        {/* Add-sub-unit affordance — appears on hover, hidden while dragging. */}
        <AddChildButton editable={editable} renaming={renaming} dragging={dragging} onClick={() => { setAddingChild(true); setExpanded(node.id, true); }} />

        {rootActions}
      </div>

      {/* Members nested inside this context — the direct-report users as ovals. */}
      {showMembers && (
        <NodeMembersPanel
          members={members} memberTotal={memberTotal} depth={depth}
          memberDraggable={memberDraggable} nodeId={node.id} memberKind={MEMBER_KIND[node.targetType] || 'user'}
          kindWord={memberKindLabel(node.targetType).toLowerCase()}
          onOpenMember={onOpenMember}
        />
      )}

      {addingChild && (
        <div className="mt-1" style={{ paddingLeft: `${(depth + 1) * INDENT_PX + 28}px` }}>
          <RenameInput
            initial=""
            placeholder="New sub-unit name…"
            onCommit={(name) => { setAddingChild(false); if (name) onAddChild?.(node.id, name); }}
            onCancel={() => setAddingChild(false)}
          />
        </div>
      )}

      <NodeBelow node={node} depth={depth} expanded={expanded} shared={{ ...shared, memberDraggable }} />
    </li>
  );
}

function ExpandToggle({ hasChildren, expanded, onToggle, label }) {
  if (!hasChildren) return <span className="w-5 h-5 inline-block shrink-0" />;
  return (
    <button
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
      onClick={onToggle}
      className="w-5 h-5 flex items-center justify-center text-gray-600 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded shrink-0"
      title={expanded ? 'Collapse' : 'Expand'}
    >
      {expanded ? '▾' : '▸'}
    </button>
  );
}

// "Show members" — the expander for the members directly in this unit, nested
// under the row. It does not repeat the count; the row's count says how many.
function MemberToggle({ canShow, dragging, show, node, onToggle }) {
  if (!canShow || dragging) return null;
  const kind = memberKindLabel(node.targetType).toLowerCase();
  const label = `${show ? 'Hide' : 'Show'} the ${kind} directly in ${node.displayName}`;
  return (
    <button
      onClick={onToggle}
      aria-expanded={show}
      aria-label={label}
      title={label}
      className={`flex items-center gap-0.5 h-6 px-1.5 rounded-full border text-xs shrink-0 text-gray-600 dark:text-gray-400 ${
        show
          ? 'border-slate-400 dark:border-gray-400 bg-slate-100 dark:bg-gray-700'
          : 'border-slate-200 dark:border-gray-600 hover:border-slate-300 dark:hover:border-gray-500'
      }`}
    >
      <span aria-hidden="true">{show ? '▾' : '▸'}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.1a7.5 7.5 0 0 1 15 0" />
      </svg>
    </button>
  );
}

function AddChildButton({ editable, renaming, dragging, onClick }) {
  if (!editable || renaming || dragging) return null;
  return (
    <button
      onClick={onClick}
      aria-label="Add a sub-unit"
      className="w-5 h-5 flex items-center justify-center text-gray-600 dark:text-gray-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded shrink-0"
      title="Add a sub-unit"
    >
      +
    </button>
  );
}

// The members directly in a unit, shown as ovals once its member panel opens.
function NodeMembersPanel({ members, memberTotal, depth, memberDraggable, nodeId, memberKind, kindWord, onOpenMember }) {
  const openMember = (m) => onOpenMember?.(m.id, m.displayName, memberKind);
  return (
    <div
      className="mt-1 rounded-xl border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-900/30 px-2 py-1.5"
      style={{ marginLeft: `${depth * INDENT_PX + 28}px` }}
    >
      {members === null ? (
        <span className="text-xs text-gray-600 dark:text-gray-400">Loading {kindWord}…</span>
      ) : members.length === 0 ? (
        <span className="text-xs text-gray-600 dark:text-gray-400">No {kindWord} directly in this unit.</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {members.map(m => (
            memberDraggable
              ? <DraggableMemberOval key={m.id} member={m} fromContextId={nodeId} onOpen={() => openMember(m)} />
              : <MemberOval key={m.id} member={m} onOpen={() => openMember(m)} />
          ))}
          {memberTotal > members.length && (
            <span className="self-center text-xs text-gray-600 dark:text-gray-400">
              +{memberTotal - members.length} more — select the unit to see all
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

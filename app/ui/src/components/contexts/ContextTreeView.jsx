import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, closestCenter,
} from '@dnd-kit/core';
import { variantMeta, targetTypeMeta, editedMeta } from '../../utils/contextStyles';

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

// Sibling nodes built by the manager-hierarchy plugin share a long path prefix
// ("CEO · ADIR · ADIR (…)" / "CEO · ADIR · COO (…)"). Strip the common leading
// "·"-segments so each pill shows only its distinctive tail. Always keep at
// least the last segment. Returns id → short label.
const PATH_SEP = ' · ';
export function stripSiblingPrefix(siblings) {
  const map = new Map();
  const list = siblings || [];
  for (const s of list) map.set(s.id, s.displayName);
  if (list.length < 2) return map;
  const segLists = list.map(s => String(s.displayName || '').split(PATH_SEP));
  const minLen = Math.min(...segLists.map(l => l.length));
  let common = 0;
  while (common < minLen - 1) {
    const seg = segLists[0][common];
    if (seg && segLists.every(l => l[common] === seg)) common++; else break;
  }
  if (common === 0) return map;
  for (const s of list) {
    const segs = String(s.displayName || '').split(PATH_SEP);
    map.set(s.id, segs.slice(common).join(PATH_SEP) || s.displayName);
  }
  return map;
}

export default function ContextTreeView({ nodes, onOpenDetail, onReparent, onRename, onAddChild, onMoveMember, onLoadMembers, onOpenMember }) {
  const sensors = useSensors(
    // 6px activation distance — a plain click still opens the detail; only a
    // deliberate drag starts a re-parent.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  // active = { id, data } where data.type is 'member' for a member-reference
  // drag, or undefined for a context-node drag.
  const [active, setActive] = useState(null);
  const activeMember = active?.data?.type === 'member' ? active.data : null;
  const activeNode = useMemo(
    () => (active && !activeMember ? findNode(nodes, active.id) : null),
    [active, activeMember, nodes]
  );
  // Ids the active CONTEXT node may NOT be dropped onto (itself + descendants).
  // A member can be dropped on any context, so it has no forbidden set.
  const forbidden = useMemo(
    () => (activeNode ? collectSubtreeIds(activeNode) : new Set()),
    [activeNode]
  );

  const editable = typeof onReparent === 'function';

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

  function handleDragEnd(evt) {
    const { active: a, over } = evt;
    setActive(null);
    if (!over) return;
    const data = a.data?.current;
    // Member reference dropped onto a context → move the member.
    if (data?.type === 'member') {
      const toId = String(over.id);
      if (toId.startsWith('m:')) return;            // dropped on another member — ignore
      if (toId === data.fromContextId) return;      // same context — no-op
      onMoveMember?.(data.memberId, data.fromContextId, toId);
      return;
    }
    // Context node dropped onto another → re-parent.
    if (!onReparent) return;
    const childId = a.id;
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
            forbidden={forbidden}
            dragging={!!active}
            isExpanded={isExpanded}
            toggleExpanded={toggleExpanded}
            setExpanded={setExpanded}
          />
        ))}
      </ul>
    </div>
  );

  if (!editable) return treeBody;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActive({ id: e.active.id, data: e.active.data?.current })}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActive(null)}
    >
      {treeBody}
      <DragOverlay dropAnimation={null}>
        {activeMember ? <MemberDragPill name={activeMember.name} /> : activeNode ? <DragPill node={activeNode} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function TreeNode({ node, displayLabel, depth, isLast, onOpenDetail, onRename, onAddChild, onLoadMembers, onOpenMember, editable, forbidden, dragging, isExpanded, toggleExpanded, setExpanded }) {
  const expanded = isExpanded(node.id);
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  // Lazy-loaded direct members (user references) — fetched the first time the
  // node is expanded. null = not loaded yet.
  const [members, setMembers] = useState(null);
  const [memberTotal, setMemberTotal] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const memberLabel = displayLabel || node.displayName;
  // Which detail tab a member opens, from the context's target type.
  const memberKind = node.targetType === 'Identity' ? 'identity'
    : node.targetType === 'Resource' ? 'group'
    : node.targetType === 'System' ? 'system' : 'user';

  // Re-fetch members when this node's direct count changes (e.g. after a move
  // adds/removes a member here) — the cached list would otherwise go stale.
  useEffect(() => { setMembers(null); }, [node.directMemberCount]);

  // Fetch direct members the first time this node is expanded (and it has any).
  useEffect(() => {
    if (!expanded || members !== null || !onLoadMembers) return;
    if (!(node.directMemberCount > 0)) { setMembers([]); return; }
    let cancelled = false;
    setMembersLoading(true);
    onLoadMembers(node.id)
      .then(({ rows, total }) => { if (!cancelled) { setMembers(rows); setMemberTotal(total); } })
      .catch(() => { if (!cancelled) setMembers([]); })
      .finally(() => { if (!cancelled) setMembersLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, members, onLoadMembers, node.id, node.directMemberCount]);
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
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            onClick={() => toggleExpanded(node.id)}
            className="w-5 h-5 flex items-center justify-center text-gray-600 dark:text-gray-500 hover:text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 dark:bg-gray-700 rounded shrink-0"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-5 h-5 inline-block shrink-0" />
        )}

        {renaming ? (
          <RenameInput
            initial={node.displayName}
            onCommit={(name) => { setRenaming(false); if (name && name !== node.displayName) onRename?.(node.id, name); }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button
            ref={dragRef}
            {...listeners}
            {...attributes}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            title={canDrag ? 'Click to open · double-click to rename · drag onto another node to re-parent' : undefined}
            className={[
              'flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border bg-white dark:bg-gray-800 text-left shrink max-w-full transition-shadow',
              'hover:bg-slate-50 dark:bg-gray-700/50 hover:border-slate-300 dark:border-gray-500 hover:shadow-sm',
              canDrag ? 'cursor-grab active:cursor-grabbing' : '',
              isValidDropTarget
                ? 'border-blue-500 ring-2 ring-blue-400 dark:ring-blue-500 bg-blue-50 dark:bg-blue-900/30'
                : edited
                  ? `border-amber-300 dark:border-amber-700 ${edited.ringClass}`
                  : 'border-slate-200 dark:border-gray-600',
              isForbiddenTarget ? 'opacity-50' : '',
            ].join(' ')}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full ${v.dotClass} ring-2 ring-white outline outline-1 outline-slate-200 shrink-0`}
              aria-hidden="true"
            />
            <span className="font-medium text-gray-900 dark:text-white truncate" title={memberLabel !== node.displayName ? node.displayName : undefined}>{memberLabel}</span>
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
        )}

        {/* Add-child affordance — appears on hover, hidden while dragging. */}
        {editable && !renaming && !dragging && (
          <button
            onClick={() => { setAddingChild(true); setExpanded(node.id, true); }}
            className="w-5 h-5 flex items-center justify-center text-gray-600 dark:text-gray-400 opacity-0 group-hover:opacity-100 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded shrink-0"
            title="Add a child context"
          >
            +
          </button>
        )}
      </div>

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

      {hasChildren && expanded && (
        <ul className="space-y-1 mt-1">
          {(() => {
            const childLabels = stripSiblingPrefix(node.children);
            return node.children.map((c, i) => (
              <TreeNode
                key={c.id}
                node={c}
                displayLabel={childLabels.get(c.id)}
                depth={depth + 1}
                isLast={i === node.children.length - 1}
                onOpenDetail={onOpenDetail}
                onRename={onRename}
                onAddChild={onAddChild}
                onLoadMembers={onLoadMembers}
                onOpenMember={onOpenMember}
                isExpanded={isExpanded}
                toggleExpanded={toggleExpanded}
                setExpanded={setExpanded}
                editable={editable}
                forbidden={forbidden}
                dragging={dragging}
              />
            ));
          })()}
        </ul>
      )}

      {/* Member references — the actual users in this context, draggable so they
          can be moved to another context. Lazy-loaded on first expand. */}
      {expanded && onLoadMembers && (node.directMemberCount > 0 || membersLoading) && (
        <ul className="mt-1 flex flex-wrap gap-1" style={{ paddingLeft: `${(depth + 1) * INDENT_PX + 28}px` }}>
          {membersLoading && members === null ? (
            <li className="text-[11px] text-gray-500 dark:text-gray-400 py-0.5">Loading members…</li>
          ) : (
            <>
              {(members || []).map(m => (
                <MemberRef key={m.id} member={m} contextId={node.id} editable={editable} onOpenMember={onOpenMember} memberKind={memberKind} />
              ))}
              {memberTotal > (members?.length || 0) && (
                <li className="text-[11px] text-gray-500 dark:text-gray-400 py-0.5 self-center">
                  +{memberTotal - (members?.length || 0)} more — open this context to see all
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </li>
  );
}

// A user (member) shown under its context as a draggable reference chip. Drag it
// onto another context node to move it there.
function MemberRef({ member, contextId, editable, onOpenMember, memberKind }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `m:${contextId}:${member.id}`,
    disabled: !editable,
    data: { type: 'member', memberId: member.id, fromContextId: contextId, name: member.displayName },
  });
  const analyst = member.addedBy === 'analyst';
  return (
    <li>
      <button
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        onClick={() => onOpenMember?.(member.id, member.displayName, memberKind)}
        title={`${member.displayName}${analyst ? ' · manually placed' : ''}${editable ? ' · drag onto a context to move' : ''}`}
        className={[
          'flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] bg-white dark:bg-gray-800 text-left max-w-[200px]',
          analyst ? 'border-amber-300 dark:border-amber-700' : 'border-slate-200 dark:border-gray-600',
          editable ? 'cursor-grab active:cursor-grabbing' : '',
          isDragging ? 'opacity-40' : 'hover:border-slate-300 dark:hover:border-gray-500 hover:shadow-sm',
        ].join(' ')}
      >
        <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" aria-hidden="true" />
        <span className="text-gray-800 dark:text-gray-200 truncate">{member.displayName}</span>
        {analyst && <span className="text-amber-600 dark:text-amber-400 shrink-0" title="Manually placed — kept on re-run">✎</span>}
      </button>
    </li>
  );
}

// The chip rendered under the cursor while dragging a member.
function MemberDragPill({ name }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-sky-400 bg-white dark:bg-gray-800 shadow-lg cursor-grabbing text-[11px]">
      <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" aria-hidden="true" />
      <span className="text-gray-800 dark:text-gray-200 truncate max-w-[200px]">{name}</span>
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
      className="px-2 py-1 text-sm border border-blue-400 dark:border-blue-500 rounded bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-400"
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
        {d} · <span className="text-gray-600 dark:text-gray-400 dark:text-gray-500">{t}</span>
      </span>
    );
  }
  return <span className="text-[11px] text-gray-600 dark:text-gray-500 whitespace-nowrap shrink-0">{d}</span>;
}

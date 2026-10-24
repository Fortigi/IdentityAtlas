import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { DragPill, MemberDragPill } from '@ui/components/contexts/ContextTreeParts';
import { TOP_LEVEL_DROP_ID, buildTree, initialOpen, resolveDrop, searchUnits, showMembersLabel, subtreeIds, memberWord } from './adjustTree.helpers';
import AdjustTreeRow, { Mark } from './AdjustTreeRow';

// The tree pane of the Adjust tree screen: a search over unit names, the
// "Show people" toggle, and the whole tree inside ONE DndContext — so a unit or
// a member can be dropped anywhere in the tree, not only beside its siblings.
// Dropping is turned into an adjustment by resolveDrop(); the page posts it.

// Which units are open: opened by hand, or opened by the search (the units
// above a match). A unit closed by hand stays closed for the search it was
// closed under; a new search opens the way to its matches again.
function useOpenUnits(roots, searchOpen, query) {
  const [state, setState] = useState(() => ({ open: initialOpen(roots), closed: new Set(), closedQuery: query }));
  const closedNow = (id) => state.closedQuery === query && state.closed.has(id);
  const isOpen = (id) => !closedNow(id) && (state.open.has(id) || searchOpen.has(id));
  const toggle = (id) => {
    const wasOpen = isOpen(id);
    setState(prev => {
      const open = new Set(prev.open);
      const closed = new Set(prev.closedQuery === query ? prev.closed : []);
      if (wasOpen) { open.delete(id); closed.add(id); } else { open.add(id); closed.delete(id); }
      return { open, closed, closedQuery: query };
    });
  };
  const openUnit = (id) => setState(prev => {
    const closed = new Set(prev.closed);
    closed.delete(id);
    return { ...prev, open: new Set(prev.open).add(id), closed };
  });
  return { isOpen, toggle, openUnit };
}

// What is being dragged, and the units it may not be dropped on.
function useDragState(units) {
  const [drag, setDrag] = useState(null);
  const forbiddenIds = useMemo(
    () => (drag?.type === 'unit' ? subtreeIds(units, drag.unitId) : new Set()),
    [drag, units],
  );
  return { drag, setDrag, forbiddenIds };
}

export default function AdjustTreeView({ units, targetType, editable, selectedId, onSelect, onDrop, checked, onCheck, version }) {
  const [query, setQuery] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const roots = useMemo(() => buildTree(units), [units]);
  const search = useMemo(() => searchUnits(units, query), [units, query]);
  const { isOpen, toggle, openUnit } = useOpenUnits(roots, search.open, query.trim());
  const { drag, setDrag, forbiddenIds } = useDragState(units);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function handleDragEnd({ active, over }) {
    const data = active.data?.current;
    setDrag(null);
    if (!over) return;
    const result = resolveDrop(data, over.id, units);
    if (!result) return;
    if (!result.error && over.id !== TOP_LEVEL_DROP_ID) openUnit(over.id);
    onDrop(result, data);
  }

  const shownRoots = search.visible ? roots.filter(r => search.visible.has(r.id)) : roots;
  const view = {
    editable, selectedId, onSelect, isOpen, toggle, visible: search.visible, matches: search.matches,
    checked, onCheck, showMembers, targetType, version, forbiddenIds, dragging: !!drag,
  };
  const body = (
    <>
      {drag?.type === 'unit' && <TopLevelDropZone />}
      {shownRoots.length === 0
        ? <p className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">{query ? `Nothing matches "${query}".` : 'This tree has no units.'}</p>
        : <ul aria-label="Units">{shownRoots.map(r => <AdjustTreeRow key={r.id} unit={r} depth={0} view={view} />)}</ul>}
    </>
  );

  return (
    <section aria-label="Tree" className="min-w-0 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <input
          type="search" value={query} onChange={e => setQuery(e.target.value)}
          aria-label="Find a unit" placeholder="Find a unit"
          className="min-w-[180px] flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
        />
        <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={showMembers} onChange={e => setShowMembers(e.target.checked)} />
          {showMembersLabel(targetType)}
        </label>
      </div>
      <div className="overflow-x-auto px-1 py-2">
        {editable
          ? (
            <DndContext sensors={sensors} collisionDetection={pointerWithin}
              onDragStart={e => setDrag(e.active.data?.current || null)} onDragEnd={handleDragEnd} onDragCancel={() => setDrag(null)}>
              {body}
              <DragOverlay dropAnimation={null}>{dragPreview(drag)}</DragOverlay>
            </DndContext>
          )
          : body}
      </div>
      <TreeLegend targetType={targetType} editable={editable} />
    </section>
  );
}

function dragPreview(drag) {
  if (!drag) return null;
  return drag.type === 'member' ? <MemberDragPill displayName={drag.name} /> : <DragPill node={{ displayName: drag.name }} />;
}

// Drop a unit here to move it to the top level of the tree.
function TopLevelDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: TOP_LEVEL_DROP_ID });
  return (
    <div ref={setNodeRef}
      className={`mx-1 mb-2 rounded-md border border-dashed px-3 py-2 text-center text-xs ${isOver
        ? 'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-200'
        : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400'}`}>
      Top level — drop here to move the unit to the top of the tree
    </div>
  );
}

function TreeLegend({ targetType, editable }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400">
      <span className="flex items-center gap-1"><Mark label="adjusted" tone="neutral" /> changed by hand</span>
      <span className="flex items-center gap-1"><Mark label="interim" tone="warn" /> temporary manager</span>
      <span>numbers = {memberWord(targetType)} in the unit / including sub-units</span>
      {editable && <span>Drag a unit onto another unit to move it.</span>}
    </div>
  );
}

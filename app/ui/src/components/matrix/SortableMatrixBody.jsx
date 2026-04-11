import { useState, useCallback } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { useVirtualizer } from '@tanstack/react-virtual';
import MatrixGroupRow from './MatrixGroupRow';

// Row height in px — must match the actual rendered row height (24px cells + borders)
const ROW_HEIGHT = 25;

// Wrapper that provides sortable DnD props to a MatrixGroupRow
function SortableRow(props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.group.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <MatrixGroupRow
      {...props}
      sortableRef={setNodeRef}
      sortableStyle={style}
      sortableAttributes={attributes}
      sortableListeners={listeners}
    />
  );
}

export default function SortableMatrixBody({
  scrollRef,
  orderedGroups,
  groupIds,
  onDragEnd,
  columnHeaders,
  // Row props passed through to MatrixGroupRow
  users,
  memberships,
  managedMap,
  managedApMap,
  apIdToIndex,
  accessPackages,
  apGroupMap,
  managedFilter,
  onOpenDetail,
  // Nested group expansion props
  groupsWithNested,
  expandedGroups,
  onToggleExpand,
  loadingNested,
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Disable virtualization during drag so all rows are in the DOM for accurate
  // drop target detection. The brief mount of all rows on drag start is acceptable.
  const [dragging, setDragging] = useState(false);

  const handleDragStart = useCallback(() => setDragging(true), []);
  const handleDragEnd = useCallback((event) => {
    setDragging(false);
    onDragEnd(event);
  }, [onDragEnd]);
  const handleDragCancel = useCallback(() => setDragging(false), []);

  const virtualizer = useVirtualizer({
    count: orderedGroups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
    enabled: !dragging,
  });

  const virtualRows = virtualizer.getVirtualItems();

  // Row props shared by all rows
  const rowProps = {
    users,
    totalUsers: users.length,
    memberships,
    managedMap,
    managedApMap,
    apIdToIndex,
    accessPackages,
    apGroupMap,
    managedFilter,
    onOpenDetail,
    groupsWithNested,
    expandedGroups,
    onToggleExpand,
    loadingNested,
  };

  // Render a single row — nested rows are plain (not sortable), others are sortable
  const renderRow = (group) => {
    if (group.isNestedRow) {
      return <MatrixGroupRow key={group.id} group={group} {...rowProps} />;
    }
    return <SortableRow key={group.id} group={group} {...rowProps} />;
  };

  // When dragging: render all rows (DnD needs full DOM for accurate positioning).
  // When not dragging: render only visible rows + overscan for performance.
  const renderRows = () => {
    if (dragging) {
      return orderedGroups.map(renderRow);
    }

    const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
    const paddingBottom = virtualRows.length > 0
      ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;

    return (
      <>
        {paddingTop > 0 && (
          <tr aria-hidden="true"><td style={{ height: paddingTop, padding: 0, border: 'none' }} /></tr>
        )}
        {virtualRows.map(vRow => {
          const group = orderedGroups[vRow.index];
          return renderRow(group);
        })}
        {paddingBottom > 0 && (
          <tr aria-hidden="true"><td style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>
        )}
      </>
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      modifiers={[restrictToVerticalAxis]}
    >
      <table className="border-collapse" style={{ tableLayout: 'fixed' }}>
        {columnHeaders}
        <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
          <tbody>
            {renderRows()}
          </tbody>
        </SortableContext>
      </table>
    </DndContext>
  );
}

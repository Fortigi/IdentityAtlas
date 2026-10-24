import { useDraggable } from '@dnd-kit/core';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { memberDetail, memberWord } from './adjustTree.helpers';

// The members directly in one expanded unit, listed under its row when "Show
// people" is on. Read when the list first shows (the page remounts it after a
// change, so it reads again). In an editable tree each member can be dragged
// onto another unit; the drop is handled by the tree's one DndContext.

const MEMBER_LIMIT = 200;
const ROW_CLASS = 'flex items-center gap-2 rounded px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap';

export default function AdjustTreeMembers({ unitId, targetType, indent, editable }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(
    `/api/contexts/${encodeURIComponent(unitId)}/members?limit=${MEMBER_LIMIT}`,
    { authFetch, initialData: { data: [], total: 0 } },
  );
  const word = memberWord(targetType);
  const style = { paddingLeft: `${indent}px` };
  if (loading) return <div style={style} className="py-0.5 text-xs text-gray-600 dark:text-gray-400">Loading {word}…</div>;
  if (error) return <div style={style} className="py-0.5 text-xs text-red-700 dark:text-red-400">Could not load the {word}: {error.message}</div>;
  const rows = data?.data || [];
  if (rows.length === 0) return <div style={style} className="py-0.5 text-xs text-gray-600 dark:text-gray-400">No {word} directly in this unit.</div>;
  const more = (data.total || 0) - rows.length;
  return (
    <ul style={style} aria-label={`${word} in this unit`}>
      {rows.map(m => (
        <li key={m.id}>
          {editable ? <DraggableMember member={m} unitId={unitId} /> : <MemberLine member={m} />}
        </li>
      ))}
      {more > 0 && <li className="px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400">+{more} more — select the unit to see all</li>}
    </ul>
  );
}

function MemberLine({ member }) {
  return (
    <div className={ROW_CLASS}>
      <span className="text-gray-900 dark:text-gray-100">{member.displayName}</span>
      <span className="text-gray-600 dark:text-gray-400">{memberDetail(member)}</span>
    </div>
  );
}

// Pointer drag only (no keyboard sensor), so the drag's ARIA attributes are not
// spread — the panel's "Move under…" is the keyboard way to move a unit.
function DraggableMember({ member, unitId }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `m:${unitId}:${member.id}`,
    data: { type: 'member', memberId: member.id, fromUnitId: unitId, name: member.displayName },
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      title={`${member.displayName} — drag onto another unit to move`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className={`${ROW_CLASS} cursor-grab active:cursor-grabbing hover:bg-gray-100 dark:hover:bg-gray-700/50`}
    >
      <span className="text-gray-900 dark:text-gray-100">{member.displayName}</span>
      <span className="text-gray-600 dark:text-gray-400">{memberDetail(member)}</span>
    </div>
  );
}

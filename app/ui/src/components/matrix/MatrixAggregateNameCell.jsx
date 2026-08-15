// Names-row cell for a collapsed aggregate column: shows the user COUNT plus two
// explode controls — ▾ = all members (direct + indirect), ↳ = direct only.
export default function MatrixAggregateNameCell({ user, onToggleMembers }) {
  return (
    <th
      className="sticky top-0 z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center bg-indigo-50 dark:bg-indigo-900/20"
      style={{ height: '100px', width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
      title={`${user.userCount} ${user.userCount === 1 ? 'user' : 'users'} in ${user.value || '(none)'}`}
    >
      <div className="flex flex-col items-center justify-end h-full pb-1 gap-0.5">
        <span className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">{user.userCount}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleMembers?.(user.sortKeys, user.level, 'all'); }}
          className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
          title="Show all members here (direct + indirect)"
        >▾</button>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleMembers?.(user.sortKeys, user.level, 'direct'); }}
          className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
          title="Show direct members at this level only"
        >↳</button>
      </div>
    </th>
  );
}

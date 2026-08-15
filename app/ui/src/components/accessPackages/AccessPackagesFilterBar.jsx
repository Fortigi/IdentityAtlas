const ASSIGNMENT_TYPES = ['Auto-assigned', 'Request-based', 'Request-based with auto-removal', 'Both'];

// Search box + assignment-type filter + "Clear all" (shown only when filtering).
export default function AccessPackagesFilterBar({ search, setSearch, typeFilter, setTypeFilter, hasAnyFilter, onClearAll }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        aria-label="Search business roles by name or catalog"
        placeholder="Search by name or catalog..."
        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-xs w-56 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
      />
      <select
        aria-label="Filter by assignment type"
        value={typeFilter || ''}
        onChange={e => setTypeFilter(e.target.value || null)}
        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-xs dark:bg-gray-700 dark:text-gray-200"
      >
        <option value="">All types</option>
        {ASSIGNMENT_TYPES.map(t => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      {hasAnyFilter && (
        <>
          <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />
          <button
            onClick={onClearAll}
            className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700"
          >
            Clear all
          </button>
        </>
      )}
    </div>
  );
}

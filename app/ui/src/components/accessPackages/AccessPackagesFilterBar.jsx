import IncludeDeletedToggle from '@ui/components/IncludeDeletedToggle';
import { ACCESS_FILTERS, WAYS } from '@ui/components/businessRoles/accessModel';


// Search box + how-gained-or-lost filter + "Include deleted" + "Clear all" (shown only when filtering).
export default function AccessPackagesFilterBar({
  search, setSearch, typeFilter, setTypeFilter, includeDeleted, setIncludeDeleted, hasAnyFilter, onClearAll, onImportOwners,
}) {
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
        aria-label="Filter by how the role is gained or lost"
        value={typeFilter || ''}
        onChange={e => setTypeFilter(e.target.value || null)}
        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-xs dark:bg-gray-700 dark:text-gray-200"
      >
        <option value="">All types</option>
        {ACCESS_FILTERS.map(({ label, direction, ways }) => (
          <optgroup key={direction} label={label}>
            {ways.map(way => <option key={way} value={`${direction}:${way}`}>{WAYS[direction][way].label}</option>)}
          </optgroup>
        ))}
      </select>
      <IncludeDeletedToggle checked={includeDeleted} onChange={setIncludeDeleted} noun="business roles" />
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
      {onImportOwners && (
        <button type="button" onClick={onImportOwners}
          className="ml-auto px-2 py-1 rounded text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600">
          Import owners
        </button>
      )}
    </div>
  );
}

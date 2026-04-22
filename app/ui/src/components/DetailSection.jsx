export function Section({ title, count, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
        {title}
        {count != null && <span className="text-xs font-normal text-gray-400 dark:text-gray-500">({count})</span>}
      </h3>
      {children}
    </div>
  );
}

export function CollapsibleSection({ title, count, countLabel, open, onToggle, loading, children }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 hover:text-gray-900 dark:hover:text-white"
      >
        <span className="text-xs">{open ? '\u25BC' : '\u25B6'}</span>
        {title}
        {count != null && (
          <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
            ({count}{countLabel ? ` ${countLabel}` : ''})
          </span>
        )}
        {loading && <span className="text-xs text-gray-400 dark:text-gray-500 animate-pulse">Loading...</span>}
      </button>
      {open && !loading && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          {children}
        </div>
      )}
    </div>
  );
}

// Bulk-action bar shown when one or more business roles are selected: assign or
// remove a category, or clear the selection.
export default function SelectionActionBar({
  selectedCount, categories, actionCategory, setActionCategory, onAssign, onRemove, onClear, busy,
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="flex items-center gap-3 mb-3 p-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg text-sm">
      <span className="font-medium text-blue-700 dark:text-blue-300">{selectedCount} selected</span>
      <div className="border-l border-blue-200 dark:border-blue-700 h-5" />
      <select
        aria-label="Assign category to selected"
        value={actionCategory}
        onChange={e => setActionCategory(e.target.value)}
        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200"
      >
        <option value="">Select category...</option>
        {categories.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <button
        onClick={onAssign}
        disabled={!actionCategory || busy}
        className="px-3 py-1 rounded text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
      >
        Set Category
      </button>
      <button
        onClick={onRemove}
        disabled={busy}
        className="px-3 py-1 rounded text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 border border-red-200 dark:border-red-700 disabled:opacity-50"
      >
        Remove Category
      </button>
      <button
        onClick={onClear}
        className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 ml-auto"
      >
        Clear selection
      </button>
    </div>
  );
}

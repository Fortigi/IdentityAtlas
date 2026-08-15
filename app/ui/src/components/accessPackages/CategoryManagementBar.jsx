import { tagPillStyle } from '@ui/utils/colors';

// A single category filter chip with its own delete button.
function CategoryChip({ category, active, isDark, onToggle, onDelete }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer border ${
        active ? 'ring-2 ring-offset-1 ring-blue-400' : 'hover:opacity-80'
      }`}
      style={tagPillStyle(category.color, isDark)}
      onClick={onToggle}
      title={`${category.assignmentCount} business roles — click to filter`}
    >
      {category.name}
      <span className="text-[10px]">({category.assignmentCount})</span>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="ml-0.5 hover:opacity-100 opacity-50"
        title="Delete category"
      >
        &times;
      </button>
    </span>
  );
}

// Category filter/management bar: one chip per category, the Uncategorized
// pseudo-filter, and the "+ New Category" toggle.
export default function CategoryManagementBar({
  categories, categoryFilter, setCategoryFilter, isDark, onDelete, onToggleCreate,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
      <span className="font-medium text-gray-600 dark:text-gray-400">Categories:</span>
      {categories.map(c => (
        <CategoryChip
          key={c.id}
          category={c}
          active={categoryFilter === c.id}
          isDark={isDark}
          onToggle={() => setCategoryFilter(categoryFilter === c.id ? null : c.id)}
          onDelete={() => onDelete(c.id)}
        />
      ))}
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer border ${
          categoryFilter === 'uncategorized'
            ? 'ring-2 ring-offset-1 ring-blue-400 bg-gray-100 dark:bg-gray-700 border-gray-400 dark:border-gray-500 text-gray-600 dark:text-gray-400'
            : 'hover:opacity-80 bg-gray-50 dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400'
        }`}
        onClick={() => setCategoryFilter(categoryFilter === 'uncategorized' ? null : 'uncategorized')}
        title="Show business roles without a category"
      >
        Uncategorized
      </span>
      <button
        onClick={onToggleCreate}
        className="px-2 py-0.5 rounded text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-700 border-dashed"
      >
        + New Category
      </button>
    </div>
  );
}

import { tagPillStyle } from '@ui/utils/colors';
import FilterPill from '@ui/components/FilterPill';

// Category filter/management bar: one chip per category, the Uncategorized
// pseudo-filter, and the "+ New Category" toggle.
export default function CategoryManagementBar({
  categories, categoryFilter, setCategoryFilter, isDark, onDelete, onToggleCreate,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
      <span className="font-medium text-gray-600 dark:text-gray-400">Categories:</span>
      {categories.map(c => (
        <FilterPill
          key={c.id}
          active={categoryFilter === c.id}
          style={tagPillStyle(c.color, isDark)}
          onToggle={() => setCategoryFilter(categoryFilter === c.id ? null : c.id)}
          title={`${c.assignmentCount} business roles — click to filter`}
          onDelete={() => onDelete(c.id)}
          deleteLabel={`Delete category ${c.name}`}
        >
          {c.name}
          <span className="text-[10px]">({c.assignmentCount})</span>
        </FilterPill>
      ))}
      <FilterPill
        active={categoryFilter === 'uncategorized'}
        onToggle={() => setCategoryFilter(categoryFilter === 'uncategorized' ? null : 'uncategorized')}
        title="Show business roles without a category"
        className={
          categoryFilter === 'uncategorized'
            ? 'bg-gray-100 dark:bg-gray-700 border-gray-400 dark:border-gray-500 text-gray-600 dark:text-gray-400'
            : 'bg-gray-50 dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400'
        }
      >
        Uncategorized
      </FilterPill>
      <button
        onClick={onToggleCreate}
        className="px-2 py-0.5 rounded text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-700 border-dashed"
      >
        + New Category
      </button>
    </div>
  );
}

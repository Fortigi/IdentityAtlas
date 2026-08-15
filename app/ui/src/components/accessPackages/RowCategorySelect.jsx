import { tagPillStyle } from '@ui/utils/colors';

// Per-row category dropdown — quick-assign or clear a business role's category.
export default function RowCategorySelect({ ap, categories, busy, isDark, onAssignCategoryToOne }) {
  return (
    <select
      aria-label={`Category for ${ap.displayName || ap.name || ap.id}`}
      value={ap.category?.id || ''}
      onChange={e => onAssignCategoryToOne(ap.id, e.target.value ? parseInt(e.target.value) : null)}
      disabled={busy}
      className="px-1.5 py-0.5 border border-gray-200 dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 dark:text-gray-200"
      style={ap.category ? tagPillStyle(ap.category.color, isDark) : {}}
    >
      <option value="">None</option>
      {categories.map(c => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}

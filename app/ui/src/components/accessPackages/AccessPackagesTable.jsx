import AccessPackageRow from './AccessPackageRow';
import SortableTh from '@ui/components/SortableTh';

const SORT_COLUMNS = [
  { key: 'displayName',      label: 'Name' },
  { key: 'assignmentType',   label: 'Type' },
  { key: 'complianceStatus', label: 'Review Status' },
  { key: 'lastReviewDate',   label: 'Review Date' },
  { key: 'lastReviewedBy',   label: 'Reviewed By' },
  { key: 'category',         label: 'Category' },
];

// The Business Roles table (header + rows), wrapped in a horizontal scroller.
export default function AccessPackagesTable({
  packages, categories, selected, allOnPageSelected, sortCol, sortDir, busy, isDark,
  onToggleSelectAll, onToggleSort, onToggleSelect, onOpenDetail, onAssignCategoryToOne,
}) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
            <th className="w-10 px-3 py-2">
              <input
                type="checkbox"
                aria-label="Select all business roles on this page"
                checked={allOnPageSelected}
                onChange={onToggleSelectAll}
                className="rounded"
              />
            </th>
            {SORT_COLUMNS.map(col => (
              <SortableTh
                key={col.key}
                label={col.label}
                active={sortCol === col.key}
                dir={sortDir}
                onSort={() => onToggleSort(col.key)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {packages.map(ap => (
            <AccessPackageRow
              key={ap.id}
              ap={ap}
              selected={selected.has(ap.id)}
              categories={categories}
              busy={busy}
              isDark={isDark}
              onToggleSelect={onToggleSelect}
              onOpenDetail={onOpenDetail}
              onAssignCategoryToOne={onAssignCategoryToOne}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

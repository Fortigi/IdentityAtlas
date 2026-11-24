import AccessPackageRow from './AccessPackageRow';

const SORT_COLUMNS = [
  { key: 'displayName',      label: 'Name' },
  { key: 'assignmentType',   label: 'Type' },
  { key: 'complianceStatus', label: 'Review Status' },
  { key: 'lastReviewDate',   label: 'Review Date' },
  { key: 'lastReviewedBy',   label: 'Reviewed By' },
];

// A clickable, sort-indicating column header.
function SortableHeader({ label, colKey, sortCol, sortDir, onToggleSort }) {
  const active = sortCol === colKey;
  return (
    <th
      onClick={() => onToggleSort(colKey)}
      className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          <span className="text-blue-600 text-[10px]">{sortDir === 'asc' ? '▲' : '▼'}</span>
        ) : (
          <span className="text-gray-500 dark:text-gray-500 text-[10px]">{'▴'}</span>
        )}
      </span>
    </th>
  );
}

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
              <SortableHeader
                key={col.key}
                label={col.label}
                colKey={col.key}
                sortCol={sortCol}
                sortDir={sortDir}
                onToggleSort={onToggleSort}
              />
            ))}
            <SortableHeader
              label="Category"
              colKey="category"
              sortCol={sortCol}
              sortDir={sortDir}
              onToggleSort={onToggleSort}
            />
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

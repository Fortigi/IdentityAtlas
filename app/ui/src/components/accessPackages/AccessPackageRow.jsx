import { formatDateOnly as formatDate } from '@ui/utils/formatters';
import { ASSIGNMENT_TYPE_STYLES } from '@ui/utils/accessPackageStyles';
import ComplianceStatusCell from './ComplianceStatusCell';
import ReviewedByCell from './ReviewedByCell';
import RowCategorySelect from './RowCategorySelect';

// One business role row in the Business Roles table. Row click toggles the
// checkbox; cells that carry their own controls stop propagation.
export default function AccessPackageRow({
  ap, selected, categories, busy, isDark, onToggleSelect, onOpenDetail, onAssignCategoryToOne,
}) {
  return (
    <tr
      className={`border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer ${
        selected ? 'bg-blue-50 dark:bg-blue-900/30' : ''
      }`}
      onClick={() => onToggleSelect(ap.id)}
    >
      <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${ap.displayName || ap.name || ap.id}`}
          checked={selected}
          onChange={() => onToggleSelect(ap.id)}
          className="rounded"
        />
      </td>
      <td className="px-3 py-2 font-medium" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => onOpenDetail?.('access-package', ap.id, ap.displayName)}
          className="text-blue-600 hover:text-blue-800 hover:underline text-left"
        >
          {ap.displayName}
        </button>
      </td>
      <td className="px-3 py-2">
        {ap.assignmentType && (
          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${ASSIGNMENT_TYPE_STYLES[ap.assignmentType] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
            {ap.assignmentType}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        <ComplianceStatusCell ap={ap} />
      </td>
      <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs whitespace-nowrap">
        {ap.lastReviewDate ? formatDate(ap.lastReviewDate) : <span className="text-gray-500 dark:text-gray-500">-</span>}
      </td>
      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">
        <ReviewedByCell value={ap.lastReviewedBy} />
      </td>
      <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
        <RowCategorySelect
          ap={ap}
          categories={categories}
          busy={busy}
          isDark={isDark}
          onAssignCategoryToOne={onAssignCategoryToOne}
        />
      </td>
    </tr>
  );
}

import ComplianceStatusCell from './ComplianceStatusCell';
import RowCategorySelect from './RowCategorySelect';
import DeletedBadge from '@ui/components/DeletedBadge';
import RoleTypeCell from '@ui/components/businessRoles/RoleTypeCell';

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
        {ap.deletedAt && <DeletedBadge at={ap.deletedAt} label="Deleted in source" className="ml-2" />}
      </td>
      <td className="px-3 py-2">
        <RoleTypeCell accessModel={ap.accessModel} />
      </td>
      <td className="px-3 py-2 text-xs">
        <ComplianceStatusCell ap={ap} />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300" data-testid="role-users">{ap.userCount ?? 0}</td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300" data-testid="role-resources">{ap.resourceCount ?? 0}</td>
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

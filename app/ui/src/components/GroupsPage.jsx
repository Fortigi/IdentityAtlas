import EntityListPage from './EntityListPage';
import DeletedBadge from './DeletedBadge';

const FIELD_LABELS = {
  displayName: 'Name',
  resourceType: 'Resource Type',
  groupTypeCalculated: 'Group Type',
  description: 'Description',
  mailEnabled: 'Mail Enabled',
  securityEnabled: 'Security Enabled',
  visibility: 'Visibility',
  membershipRule: 'Membership Rule',
  isAssignableToRole: 'Role Assignable',
  onPremisesSyncEnabled: 'On-Prem Sync',
  mail: 'Mail',
  resourceProvisioningOptions: 'Provisioning',
  __resourceTag: 'Resource Tag',
  __groupTag: 'Group Tag',
};

const TABLE_COLUMNS = [
  { key: 'displayName',  label: 'Display Name' },
  { key: 'resourceType', label: 'Type' },
  { key: 'description',  label: 'Description' },
];

// Exported as both ResourcesPage (new) and GroupsPage (backward compat)
export default function ResourcesPage({ onOpenDetail }) {
  return (
    <EntityListPage
      title="Resources"
      entityType="resource"
      listEndpoint="/api/resources"
      columnsEndpoint="/api/resource-columns"
      tagFilterKey="__resourceTag"
      tableColumns={TABLE_COLUMNS}
      fieldLabels={FIELD_LABELS}
      renderEntityCell={(g, openDetail) => (
        <td className="px-3 py-2 font-medium text-blue-600 hover:text-blue-800 cursor-pointer"
          onClick={() => openDetail?.('resource', g.id, g.displayName)}>
          {g.displayName}{g.deletedAt && <> <DeletedBadge at={g.deletedAt} /></>}
        </td>
      )}
      renderDataCells={(g) => (
        <>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{g.resourceType || g.groupTypeCalculated || ''}</td>
          <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs max-w-xs truncate" title={g.description || ''}>{g.description || ''}</td>
        </>
      )}
      searchPlaceholder="Search by resource name or description..."
      showIncludeDeleted
      onOpenDetail={onOpenDetail}
    />
  );
}

// Backward compat alias
export { ResourcesPage as GroupsPage };

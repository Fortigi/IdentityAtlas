import EntityListPage from './EntityListPage';

// Identities list — intentionally a stripped-down Resources-style table.
// Account-correlation controls (verify / confirm / reject, correlation
// signals, confidence bars, HR anchor badges, orphan status) will get
// their own dedicated UI later; this page is just "flat list + tags".

const FIELD_LABELS = {
  displayName:   'Name',
  email:         'Email',
  department:    'Department',
  jobTitle:      'Job Title',
  companyName:   'Company',
  city:          'City',
  country:       'Country',
  employeeId:    'Employee ID',
  accountCount:  'Accounts',
  __identityTag: 'Identity Tag',
};

const TABLE_COLUMNS = [
  { key: 'displayName',       label: 'Name' },
  { key: 'primaryAccountUpn', label: 'Email' },
  { key: 'accountCount',      label: 'Accounts' },
  { key: 'department',        label: 'Department' },
  { key: 'jobTitle',          label: 'Job Title' },
];

export default function IdentitiesPage({ onOpenDetail }) {
  return (
    <EntityListPage
      title="Identities"
      entityType="identity"
      listEndpoint="/api/identities"
      columnsEndpoint="/api/identity-columns"
      tagFilterKey="__identityTag"
      tableColumns={TABLE_COLUMNS}
      fieldLabels={FIELD_LABELS}
      renderEntityCell={(i, openDetail) => (
        <td className="px-3 py-2 font-medium text-blue-600 hover:text-blue-800 cursor-pointer"
          onClick={() => openDetail?.('identity', i.id, i.displayName)}>
          {i.displayName}
        </td>
      )}
      renderDataCells={(i) => (
        <>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs font-mono">{i.primaryAccountUpn || ''}</td>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{i.accountCount ?? ''}</td>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{i.department || ''}</td>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{i.jobTitle || ''}</td>
        </>
      )}
      searchPlaceholder="Search by name, email, job title, employee ID..."
      onOpenDetail={onOpenDetail}
    />
  );
}

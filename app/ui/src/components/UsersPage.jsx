import { useMemo, useState, useEffect } from 'react';
import EntityListPage from './EntityListPage';
import DeletedBadge from './DeletedBadge';

const FIELD_LABELS = {
  department: 'Department',
  jobTitle: 'Job Title',
  companyName: 'Company',
  accountEnabled: 'Enabled',
  officeLocation: 'Office',
  city: 'City',
  state: 'State',
  country: 'Country',
  usageLocation: 'Usage Location',
  employeeType: 'Employee Type',
  userType: 'User Type',
  onPremisesSyncEnabled: 'On-Prem Sync',
  mail: 'Mail',
  __userTag: 'User Tag',
};

const TABLE_COLUMNS = [
  { key: 'displayName',       label: 'Display Name' },
  { key: 'userPrincipalName', label: 'UPN' },
  { key: 'department',        label: 'Department' },
  { key: 'jobTitle',          label: 'Job Title' },
];

// Sub-tabs for principalType. The Principals table is a universal identity
// store, so the "Users" page now lists more than just humans — splitting it
// by type keeps each view manageable when SP/MI/AIAgent sync is enabled.
const PRINCIPAL_TYPE_TABS = [
  { key: 'all',              label: 'All' },
  { key: 'User',             label: 'Users' },
  { key: 'ServicePrincipal', label: 'Service Principals' },
  { key: 'ManagedIdentity',  label: 'Managed Identities' },
  { key: 'AIAgent',          label: 'AI Agents' },
];

// Read/write the active sub-tab from the URL hash (?type=User on the users
// route). This keeps deep links working across reload, matching the pattern
// the Admin page uses for its own sub-tabs.
function readTypeFromHash() {
  const hash = window.location.hash.replace('#', '');
  const q = hash.indexOf('?');
  const params = new URLSearchParams(q >= 0 ? hash.substring(q + 1) : '');
  const t = params.get('type');
  return t && PRINCIPAL_TYPE_TABS.some(tab => tab.key === t) ? t : 'all';
}

function writeTypeToHash(tab) {
  const hash = window.location.hash.replace('#', '');
  const q = hash.indexOf('?');
  const page = q >= 0 ? hash.substring(0, q) : hash;
  const params = new URLSearchParams(q >= 0 ? hash.substring(q + 1) : '');
  if (tab === 'all') params.delete('type'); else params.set('type', tab);
  const qs = params.toString();
  window.history.replaceState(null, '', `#${page}${qs ? '?' + qs : ''}`);
}

export default function UsersPage({ onOpenDetail }) {
  const [activeTypeTab, setActiveTypeTab] = useState(readTypeFromHash);
  useEffect(() => { writeTypeToHash(activeTypeTab); }, [activeTypeTab]);

  // Memoised so useEntityPage's filtersObj memo isn't busted every render.
  const baseFilters = useMemo(
    () => (activeTypeTab === 'all' ? null : { principalType: activeTypeTab }),
    [activeTypeTab],
  );

  // Hide `principalType` from Filters when a specific sub-tab is active —
  // the tab is the authoritative selector, so two controls for the same value
  // would be confusing.
  const customizeFilterFields = useMemo(
    () => activeTypeTab === 'all'
      ? null
      : (fields) => fields.filter(f => f.key !== 'principalType'),
    [activeTypeTab],
  );

  const subTabBar = (
    <div className="border-b border-gray-200 dark:border-gray-700 mb-4">
      <nav className="flex gap-1 -mb-px">
        {PRINCIPAL_TYPE_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTypeTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTypeTab === tab.key
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );

  return (
    <EntityListPage
      title="Principals (Users)"
      entityType="user"
      listEndpoint="/api/users"
      columnsEndpoint="/api/user-columns-page"
      tagFilterKey="__userTag"
      tableColumns={TABLE_COLUMNS}
      fieldLabels={FIELD_LABELS}
      renderEntityCell={(u, openDetail) => (
        <td className="px-3 py-2 font-medium text-blue-600 hover:text-blue-800 cursor-pointer"
          onClick={() => openDetail?.('user', u.id, u.displayName)}>
          {u.displayName}{u.deletedAt && <> <DeletedBadge at={u.deletedAt} /></>}
        </td>
      )}
      renderDataCells={(u) => (
        <>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{u.userPrincipalName}</td>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{u.department || ''}</td>
          <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{u.jobTitle || ''}</td>
        </>
      )}
      searchPlaceholder="Search by name or UPN..."
      showIncludeDeleted
      subTabBar={subTabBar}
      baseFilters={baseFilters}
      customizeFilterFields={customizeFilterFields}
      onOpenDetail={onOpenDetail}
    />
  );
}

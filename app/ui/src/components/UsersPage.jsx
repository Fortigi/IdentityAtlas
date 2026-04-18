import { useMemo, useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthGate';
import useEntityPage from '../hooks/useEntityPage';
import FilterBar from './FilterBar';
import { TAG_COLORS } from '../utils/colors';

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
// The tab label is what's shown; the value is matched against the column.
// 'all' is a sentinel for "no filter".
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
  const { authFetch } = useAuth();
  const [activeTypeTab, setActiveTypeTab] = useState(readTypeFromHash);

  useEffect(() => { writeTypeToHash(activeTypeTab); }, [activeTypeTab]);

  // Memoise so useEntityPage's filtersObj memo isn't busted every render.
  const baseFilters = useMemo(
    () => (activeTypeTab === 'all' ? null : { principalType: activeTypeTab }),
    [activeTypeTab],
  );

  const ep = useEntityPage({
    authFetch,
    entityType: 'user',
    listEndpoint: '/api/users',
    columnsEndpoint: '/api/user-columns-page',
    tagFilterKey: '__userTag',
    baseFilters,
  });

  // Hide `principalType` from the Filters dropdown only when a specific
  // sub-tab is active — the tab is the authoritative selector there, and
  // having both would create two ways to set the same value. On the "All"
  // tab no type is pinned, so leave `principalType` available as a regular
  // filter option.
  const filterFields = useMemo(
    () => ep.getFilterFields(FIELD_LABELS).filter(f =>
      !(activeTypeTab !== 'all' && f.key === 'principalType')
    ),
    [ep, activeTypeTab],
  );

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Users</h2>
        <span className="text-sm text-gray-500">{ep.total.toLocaleString()} total</span>
      </div>

      {/* Principal-type sub-tabs. Matches the underlined-pills style used by
          the Admin page's own sub-tab bar so the UX is consistent. */}
      <div className="border-b border-gray-200 mb-4">
        <nav className="flex gap-1 -mb-px">
          {PRINCIPAL_TYPE_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTypeTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTypeTab === tab.key
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tag management bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span className="font-medium text-gray-600">Tags:</span>
        {ep.tags.map(t => (
          <span
            key={t.id}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer border ${
              ep.activeTagFilter === t.name
                ? 'ring-2 ring-offset-1 ring-blue-400'
                : 'hover:opacity-80'
            }`}
            style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}
            onClick={() => {
              if (ep.activeTagFilter === t.name) {
                ep.removeFilter('__userTag');
              } else {
                ep.addFilter('__userTag', t.name);
              }
            }}
            title={`${t.assignmentCount} users tagged — click to filter`}
          >
            {t.name}
            <span className="text-[10px] opacity-70">({t.assignmentCount})</span>
            <button
              onClick={(e) => { e.stopPropagation(); ep.deleteTag(t.id); }}
              className="ml-0.5 hover:opacity-100 opacity-50"
              title="Delete tag"
            >
              &times;
            </button>
          </span>
        ))}
        <button
          onClick={() => ep.setShowCreateTag(!ep.showCreateTag)}
          className="px-2 py-0.5 rounded text-xs text-blue-600 hover:bg-blue-50 border border-blue-200 border-dashed"
        >
          + New Tag
        </button>
      </div>

      {/* Create tag form */}
      {ep.showCreateTag && (
        <div className="flex items-center gap-2 mb-3 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm">
          <input
            type="text"
            value={ep.newTagName}
            onChange={e => ep.setNewTagName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ep.createTag()}
            placeholder="Tag name..."
            className="px-2 py-1 border border-gray-300 rounded text-sm w-48"
            autoFocus
          />
          <div className="flex items-center gap-1">
            {TAG_COLORS.map(c => (
              <button
                key={c}
                onClick={() => ep.setNewTagColor(c)}
                className={`w-5 h-5 rounded-full border-2 ${ep.newTagColor === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <button
            onClick={ep.createTag}
            disabled={!ep.newTagName.trim() || ep.busy}
            className="px-3 py-1 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            Create
          </button>
          <button
            onClick={() => ep.setShowCreateTag(false)}
            className="px-2 py-1 rounded text-sm text-gray-500 hover:bg-gray-200"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Filter bar + search */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <FilterBar
          label="Filters:"
          filterFields={filterFields}
          activeFilters={ep.activeFilters}
          getOptionsForField={ep.getOptionsForField}
          onAddFilter={ep.addFilter}
          onRemoveFilter={ep.removeFilter}
          loading={ep.columnsLoading}
        />

        <div className="border-l border-gray-300 h-5 mx-1" />

        <input
          type="text"
          value={ep.search}
          onChange={e => ep.setSearch(e.target.value)}
          placeholder="Search by name or UPN..."
          className="px-2 py-1 border border-gray-300 rounded text-xs w-56"
        />

        {ep.hasAnyFilter && (
          <>
            <div className="border-l border-gray-300 h-5 mx-1" />
            <button
              onClick={ep.clearAllFilters}
              className="px-2 py-1 rounded text-xs text-gray-500 hover:bg-gray-100 border border-gray-200"
            >
              Clear all
            </button>
          </>
        )}
      </div>

      {/* Action bar (visible when items selected) */}
      {ep.selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 p-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <span className="font-medium text-blue-700">{ep.selected.size} selected</span>
          <div className="border-l border-blue-200 h-5" />
          <select
            value={ep.actionTag}
            onChange={e => ep.setActionTag(e.target.value)}
            className="px-2 py-1 border border-gray-300 rounded text-sm"
          >
            <option value="">Select tag...</option>
            {ep.tags.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={ep.assignTag}
            disabled={!ep.actionTag || ep.busy}
            className="px-3 py-1 rounded text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
          >
            Assign Tag
          </button>
          <button
            onClick={ep.removeTagFromSelected}
            disabled={!ep.actionTag || ep.busy}
            className="px-3 py-1 rounded text-sm font-medium text-red-600 hover:bg-red-50 border border-red-200 disabled:opacity-50"
          >
            Remove Tag
          </button>
          {ep.hasAnyFilter && ep.total > ep.selected.size && (
            <>
              <div className="border-l border-blue-200 h-5" />
              <button
                onClick={ep.assignTagToAll}
                disabled={!ep.actionTag || ep.busy}
                className="px-3 py-1 rounded text-sm font-medium text-blue-700 hover:bg-blue-100 border border-blue-300 disabled:opacity-50"
                title={`Tag all ${ep.total} users matching current filters`}
              >
                Tag all {ep.total} matching
              </button>
            </>
          )}
          <button
            onClick={() => ep.setSelected(new Set())}
            className="px-2 py-1 rounded text-xs text-gray-500 hover:bg-gray-100 ml-auto"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      {ep.loading ? (
        <div className="text-center text-gray-500 py-12">Loading users...</div>
      ) : ep.items.length === 0 ? (
        <div className="text-center text-gray-500 py-12">
          {ep.hasAnyFilter ? 'No users match the current filters.' : 'No users found.'}
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={ep.allOnPageSelected}
                    onChange={ep.toggleSelectAll}
                    className="rounded"
                  />
                </th>
                {TABLE_COLUMNS.map(col => (
                  <th
                    key={col.key}
                    onClick={() => ep.toggleSort(col.key)}
                    className="text-left px-3 py-2 font-medium text-gray-700 cursor-pointer select-none hover:bg-gray-100"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {ep.sortCol === col.key ? (
                        <span className="text-blue-600 text-[10px]">{ep.sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
                      ) : (
                        <span className="text-gray-300 text-[10px]">{'\u25B4'}</span>
                      )}
                    </span>
                  </th>
                ))}
                <th className="text-left px-3 py-2 font-medium text-gray-700">Tags</th>
              </tr>
            </thead>
            <tbody>
              {ep.sortedItems.map(u => (
                <tr
                  key={u.id}
                  className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${
                    ep.selected.has(u.id) ? 'bg-blue-50' : ''
                  }`}
                  onClick={() => ep.toggleSelect(u.id)}
                >
                  <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={ep.selected.has(u.id)}
                      onChange={() => ep.toggleSelect(u.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-3 py-2 font-medium text-blue-600 hover:text-blue-800 cursor-pointer"
                    onClick={() => onOpenDetail?.('user', u.id, u.displayName)}>{u.displayName}</td>
                  <td className="px-3 py-2 text-gray-600 text-xs">{u.userPrincipalName}</td>
                  <td className="px-3 py-2 text-gray-600">{u.department || ''}</td>
                  <td className="px-3 py-2 text-gray-600">{u.jobTitle || ''}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {u.tags.map(t => (
                        <span
                          key={t.id}
                          className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium border"
                          style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {ep.totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm text-gray-600">
          <span>
            Showing {ep.page * ep.PAGE_SIZE + 1}&ndash;{Math.min((ep.page + 1) * ep.PAGE_SIZE, ep.total)} of {ep.total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => ep.setPage(p => Math.max(0, p - 1))}
              disabled={ep.page === 0}
              className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
            >
              Prev
            </button>
            <span>Page {ep.page + 1} of {ep.totalPages}</span>
            <button
              onClick={() => ep.setPage(p => Math.min(ep.totalPages - 1, p + 1))}
              disabled={ep.page >= ep.totalPages - 1}
              className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';
import useEntityPage from '../hooks/useEntityPage';
import FilterBar from './FilterBar';
import { TAG_COLORS } from '../utils/colors';

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
  const { authFetch } = useAuth();

  const ep = useEntityPage({
    authFetch,
    entityType: 'resource',
    listEndpoint: '/api/resources',
    columnsEndpoint: '/api/resource-columns',
    tagFilterKey: '__resourceTag',
  });

  const filterFields = useMemo(() => ep.getFilterFields(FIELD_LABELS), [ep]);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Resources</h2>
        <span className="text-sm text-gray-500 dark:text-gray-400">{ep.total.toLocaleString()} total</span>
      </div>

      {/* Tag management bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span className="font-medium text-gray-600 dark:text-gray-400">Tags:</span>
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
                ep.removeFilter('__resourceTag');
              } else {
                ep.addFilter('__resourceTag', t.name);
              }
            }}
            title={`${t.assignmentCount} resources tagged -- click to filter`}
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
          className="px-2 py-0.5 rounded text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-700 border-dashed"
        >
          + New Tag
        </button>
      </div>

      {/* Create tag form */}
      {ep.showCreateTag && (
        <div className="flex items-center gap-2 mb-3 p-3 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
          <input
            type="text"
            value={ep.newTagName}
            onChange={e => ep.setNewTagName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ep.createTag()}
            placeholder="Tag name..."
            className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm w-48 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
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
            className="px-2 py-1 rounded text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
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

        <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />

        <input
          type="text"
          value={ep.search}
          onChange={e => ep.setSearch(e.target.value)}
          placeholder="Search by resource name or description..."
          className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-xs w-64 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
        />

        {ep.hasAnyFilter && (
          <>
            <div className="border-l border-gray-300 dark:border-gray-600 h-5 mx-1" />
            <button
              onClick={ep.clearAllFilters}
              className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700"
            >
              Clear all
            </button>
          </>
        )}
      </div>

      {/* Action bar */}
      {ep.selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 p-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg text-sm">
          <span className="font-medium text-blue-700 dark:text-blue-300">{ep.selected.size} selected</span>
          <div className="border-l border-blue-200 dark:border-blue-700 h-5" />
          <select
            value={ep.actionTag}
            onChange={e => ep.setActionTag(e.target.value)}
            className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200"
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
            className="px-3 py-1 rounded text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 border border-red-200 dark:border-red-700 disabled:opacity-50"
          >
            Remove Tag
          </button>
          {ep.hasAnyFilter && ep.total > ep.selected.size && (
            <>
              <div className="border-l border-blue-200 dark:border-blue-700 h-5" />
              <button
                onClick={ep.assignTagToAll}
                disabled={!ep.actionTag || ep.busy}
                className="px-3 py-1 rounded text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 border border-blue-300 dark:border-blue-700 disabled:opacity-50"
                title={`Tag all ${ep.total} resources matching current filters`}
              >
                Tag all {ep.total} matching
              </button>
            </>
          )}
          <button
            onClick={() => ep.setSelected(new Set())}
            className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 ml-auto"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      {ep.loading ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">Loading resources...</div>
      ) : ep.items.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          {ep.hasAnyFilter ? 'No resources match the current filters.' : 'No resources found.'}
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
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
                    className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {ep.sortCol === col.key ? (
                        <span className="text-blue-600 text-[10px]">{ep.sortDir === 'asc' ? '▲' : '▼'}</span>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-500 text-[10px]">{'▴'}</span>
                      )}
                    </span>
                  </th>
                ))}
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Tags</th>
              </tr>
            </thead>
            <tbody>
              {ep.sortedItems.map(g => (
                <tr
                  key={g.id}
                  className={`border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer ${
                    ep.selected.has(g.id) ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                  }`}
                  onClick={() => ep.toggleSelect(g.id)}
                >
                  <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={ep.selected.has(g.id)}
                      onChange={() => ep.toggleSelect(g.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-3 py-2 font-medium text-blue-600 hover:text-blue-800 cursor-pointer"
                    onClick={() => onOpenDetail?.('resource', g.id, g.displayName)}>{g.displayName}</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{g.resourceType || g.groupTypeCalculated || ''}</td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs max-w-xs truncate" title={g.description || ''}>
                    {g.description || ''}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {g.tags.map(t => (
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
        <div className="flex items-center justify-between mt-3 text-sm text-gray-600 dark:text-gray-400">
          <span>
            Showing {ep.page * ep.PAGE_SIZE + 1}&ndash;{Math.min((ep.page + 1) * ep.PAGE_SIZE, ep.total)} of {ep.total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => ep.setPage(p => Math.max(0, p - 1))}
              disabled={ep.page === 0}
              className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
            >
              Prev
            </button>
            <span>Page {ep.page + 1} of {ep.totalPages}</span>
            <button
              onClick={() => ep.setPage(p => Math.min(ep.totalPages - 1, p + 1))}
              disabled={ep.page >= ep.totalPages - 1}
              className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Backward compat alias
export { ResourcesPage as GroupsPage };

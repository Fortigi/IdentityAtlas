import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection, { RISK_FIELDS } from './RiskScoreSection';
import { formatDate, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';
import { CollapsibleSection } from './DetailSection';
import EntityGraph from './EntityGraph';
import EntityDetailLayout, { AttributesTable, buildAttributeEntries } from './EntityDetailLayout';
import ExpandedItemsList from './ExpandedItemsList';
import RecentChangesSection from './RecentChangesSection';
import useExpandableGraph from '../hooks/useExpandableGraph';
import useRecentChanges from '../hooks/useRecentChanges';
import { getRootNodes } from './entityGraphShape';

const RESOURCE_TYPE_COLORS = {
  EntraGroup: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  EntraAppRole: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  EntraDirectoryRole: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
  EntraAdminUnit: 'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300',
};

const HEADER_FIELDS = ['description', 'resourceType', 'groupTypeCalculated'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, ...RISK_FIELDS,
  'ValidFrom', 'ValidTo', 'extendedAttributes', 'systemId',
  'contextId',
]);

function parseExtendedAttributes(val) {
  if (!val) return null;
  if (typeof val === 'object' && !Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return null; }
}

export default function ResourceDetailPage({ resourceId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();

  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(cachedData?.history || null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/resources/${encodeURIComponent(resourceId)}`)
      .then(r => {
        if (!r.ok) return authFetch(`/api/group/${encodeURIComponent(resourceId)}`).then(r2 => {
          if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
          return r2.json();
        });
        return r.json();
      })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(resourceId, 'resource', { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resourceId, authFetch, cachedData?.core, onCacheData]);

  const loadHistory = useCallback(() => {
    if (history) return;
    setHistoryLoading(true);
    authFetch(`/api/resources/${encodeURIComponent(resourceId)}/history`)
      .then(r => {
        if (!r.ok) return authFetch(`/api/group/${encodeURIComponent(resourceId)}/history`).then(r2 => {
          if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
          return r2.json();
        });
        return r.json();
      })
      .then(d => {
        setHistory(d);
        onCacheData?.(resourceId, 'resource', { history: d });
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [resourceId, authFetch, history, onCacheData]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen(prev => {
      if (!prev) loadHistory();
      return !prev;
    });
  }, [loadHistory]);

  const recent = useRecentChanges('resource', resourceId, authFetch);

  const rootExtras = useMemo(() => ({
    contextId: data?.attributes?.contextId,
    recent,
  }), [data, recent]);

  const rootNodes = useMemo(() => (
    data ? getRootNodes('resource', data, rootExtras) : []
  ), [data, rootExtras]);

  const graph = useExpandableGraph({
    rootEntityKind: 'resource',
    rootEntityId: resourceId,
    rootExtras,
    rootNodes,
    authFetch,
  });

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">Loading resource details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6">
        <h2 className="text-red-800 dark:text-red-300 font-semibold">Error loading resource</h2>
        <p className="text-red-600 dark:text-red-400 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, tags, historyCount } = data;
  const resourceType = attributes.resourceType || attributes.groupTypeCalculated || '';
  const typeBadgeClass = RESOURCE_TYPE_COLORS[resourceType] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300';
  const extAttrs = parseExtendedAttributes(attributes.extendedAttributes);
  const resolvedHistoryCount = history ? history.length : historyCount;
  const attributeEntries = buildAttributeEntries(attributes, extAttrs, HIDDEN_FIELDS);
  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 flex items-center justify-center text-lg font-bold">R</div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                {resourceType && (
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${typeBadgeClass}`}>
                    {resourceType}
                  </span>
                )}
                {attributes.systemId && (
                  <span className="text-xs text-gray-400 dark:text-gray-500">System: {attributes.systemId}</span>
                )}
              </div>
            </div>
          </div>
          {attributes.description && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-2xl">{attributes.description}</p>
          )}
          {tags && tags.length > 0 && (
            <div className="flex gap-1.5 mt-2">
              {tags.map(t => (
                <span key={t.id} className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                  style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <button onClick={onClose}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Close tab">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <EntityDetailLayout
        left={<AttributesTable entries={attributeEntries} />}
        right={
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <EntityGraph
                centerLabel="Resource"
                centerSubLabel={attributes.displayName}
                nodes={graph.nodesWithExpansion}
                expandedPath={graph.expandedPath}
                onNodeClick={graph.handleNodeClick}
              />
              {graph.pathDepth > 0 && (
                <div className="text-xs text-gray-400 dark:text-gray-500 text-center pb-2">
                  <span className="font-medium text-gray-600 dark:text-gray-300">{graph.activeListLabel}</span>
                  {' — '}
                  <button onClick={graph.reset} className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline">collapse</button>
                </div>
              )}
            </div>

            {graph.pathDepth > 0 ? (
              <ExpandedItemsList
                label={graph.activeListLabel}
                items={graph.activeListItems}
                loading={graph.loading}
                onOpenDetail={onOpenDetail}
              />
            ) : (
              <div className="bg-white dark:bg-gray-800 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center">
                <p className="text-sm text-gray-400 dark:text-gray-500">Click a node in the graph to fan it out; click again to collapse.</p>
              </div>
            )}
          </div>
        }
      >
        <RiskScoreSection attributes={attributes} entityType="group" entityId={resourceId} authFetch={authFetch} />

        <RecentChangesSection
          events={recent.events}
          addedCount={recent.addedCount}
          removedCount={recent.removedCount}
          sinceDays={recent.sinceDays}
          loading={recent.loading}
          onOpenDetail={onOpenDetail}
        />

      {/* Assigned Users */}
      <div className="mt-6">
        <CollapsibleSection
          title="Assigned Users"
          count={assignments ? assignments.length : memberCount}
          open={assignmentsOpen}
          onToggle={() => { if (!assignmentsOpen) loadAssignments(); setAssignmentsOpen(p => !p); }}
          loading={assignmentsLoading}
        >
          {assignments && assignments.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic p-4">No assignments</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600">
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Assignment</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(assignments || []).map((a, i) => (
                  <tr key={i} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => onOpenDetail?.('user', a.principalId, a.principalDisplayName)}
                        className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline font-medium"
                      >{a.principalDisplayName || a.principalId}</button>
                    </td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400 text-xs">{a.principalType}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${ASSIGNMENT_TYPE_COLORS[a.assignmentType] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>
                        {a.assignmentType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400 text-xs">{a.assignmentStatus || a.state || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Business Roles containing this resource */}
      <div className="mt-6">
        <CollapsibleSection
          title="Business Roles"
          count={businessRoles ? businessRoles.length : accessPackageCount}
          open={businessRolesOpen}
          onToggle={() => { if (!businessRolesOpen) loadBusinessRoles(); setBusinessRolesOpen(p => !p); }}
          loading={businessRolesLoading}
        >
          {businessRoles && businessRoles.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic p-4">Not part of any business role</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600">
                  <th className="px-4 py-2 font-medium">Business Role</th>
                  <th className="px-4 py-2 font-medium">Role Name</th>
                </tr>
              </thead>
              <tbody>
                {(businessRoles || []).map((br, i) => (
                  <tr key={i} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className="px-4 py-2">
                      {br.businessRoleId ? (
                        <button
                          onClick={() => onOpenDetail?.('resource', br.businessRoleId, br.businessRoleName || 'Unnamed')}
                          className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline font-medium"
                        >{br.businessRoleName || <span className="text-gray-400 dark:text-gray-500 italic">Unnamed</span>}</button>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-500 italic">{br.businessRoleName || 'Unnamed'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{(br.roleName && br.roleName !== '-') ? br.roleName : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Parent Resources — hierarchical parent-child relationships */}
      <div className="mt-6">
        <CollapsibleSection
          title="Parent Resources"
          count={parentResources ? parentResources.length : parentResourceCount}
          open={parentResourcesOpen}
          onToggle={() => { if (!parentResourcesOpen) loadParentResources(); setParentResourcesOpen(p => !p); }}
          loading={parentResourcesLoading}
        >
          {parentResources && parentResources.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic p-4">No parent resources</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600">
                  <th className="px-4 py-2 font-medium">Parent Resource</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Relationship</th>
                </tr>
              </thead>
              <tbody>
                {(parentResources || []).map((pr, i) => (
                  <tr key={i} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className="px-4 py-2">
                      {(() => {
                        const name = pr.parentDisplayName || pr.parentResourceId;
                        const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
                        return isGuid ? (
                          <span
                            className="italic text-gray-400 dark:text-gray-500 cursor-help border-b border-dotted border-gray-300 dark:border-gray-600"
                            title={`A parent relationship exists but the parent resource could not be retrieved — the credentials used by the${attributes.systemName ? ` "${attributes.systemName}"` : ''} crawler may not have sufficient permissions to access it.`}
                          >{name}</span>
                        ) : (
                          <button
                            onClick={() => onOpenDetail?.('resource', pr.parentResourceId, pr.parentDisplayName)}
                            className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline font-medium"
                          >{name}</button>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${RESOURCE_TYPE_COLORS[pr.parentResourceType] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>
                        {pr.parentResourceType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400 text-xs">
                      {pr.roleName || (pr.relationshipType === 'Contains' ? 'Contained in' : pr.relationshipType)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Version History */}
      <div className="mt-6">
        <CollapsibleSection
          title="Version History"
          count={resolvedHistoryCount}
          countLabel={resolvedHistoryCount === 1 ? 'version' : 'versions'}
          open={historyOpen}
          onToggle={toggleHistory}
          loading={historyLoading}
        >
          {historyDiffs.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic p-4">No changes recorded</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
                  <th className="px-4 py-2 font-medium w-44">Date</th>
                  <th className="px-4 py-2 font-medium">Changes</th>
                </tr>
              </thead>
              <tbody>
                {historyDiffs.map((diff, i) => (
                  <tr key={i} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-400 text-xs align-top whitespace-nowrap">{formatDate(diff.date)}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-col gap-1">
                        {diff.changes.map((c, j) => (
                          <div key={j} className="text-xs">
                            <span className="font-medium text-gray-700 dark:text-gray-300">{friendlyLabel(c.field)}</span>
                            <span className="text-gray-400 dark:text-gray-500 mx-1">:</span>
                            <span className="text-red-500 dark:text-red-400 line-through mr-1">{c.from}</span>
                            <span className="text-gray-400 dark:text-gray-500 mr-1">&rarr;</span>
                            <span className="text-green-600 dark:text-green-400">{c.to}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </EntityDetailLayout>
    </div>
  );
}

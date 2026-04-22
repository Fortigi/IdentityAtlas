import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection, { RISK_FIELDS } from './RiskScoreSection';
import { formatDate, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';
import { CollapsibleSection } from './DetailSection';
import EntityGraph from './EntityGraph';
import EntityDetailLayout, { AttributesTable, buildAttributeEntries } from './EntityDetailLayout';

const RESOURCE_TYPE_COLORS = {
  EntraGroup: 'bg-blue-100 text-blue-700',
  EntraAppRole: 'bg-purple-100 text-purple-700',
  EntraDirectoryRole: 'bg-orange-100 text-orange-700',
  EntraAdminUnit: 'bg-teal-100 text-teal-700',
};

const HEADER_FIELDS = ['description', 'resourceType', 'groupTypeCalculated'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, ...RISK_FIELDS,
  'ValidFrom', 'ValidTo', 'extendedAttributes', 'systemId',
  'contextId',
]);

const ASSIGNMENT_TYPE_COLORS = {
  Direct: 'bg-green-100 text-green-700',
  Governed: 'bg-blue-100 text-blue-700',
  Owner: 'bg-amber-100 text-amber-700',
  Eligible: 'bg-purple-100 text-purple-700',
};

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

  // Graph interaction state
  const [activeKey, setActiveKey] = useState(null);
  const [listCache, setListCache] = useState({});
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    if (cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Try new endpoint first, fall back to legacy group endpoint
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

  // ─── Relationship node click → fetch list ───────────────────────────
  const fetchList = useCallback(async (key) => {
    if (listCache[key]) return;
    setListLoading(true);
    try {
      let items = [];
      if (key?.startsWith('members-')) {
        const r = await authFetch(`/api/resources/${encodeURIComponent(resourceId)}/assignments`);
        const all = r.ok ? await r.json() : [];
        const want = { 'members-direct': 'Direct', 'members-governed': 'Governed', 'members-owner': 'Owner', 'members-eligible': 'Eligible' }[key];
        items = all.filter(a => a.assignmentType === want);
      } else if (key === 'business-roles') {
        const r = await authFetch(`/api/resources/${encodeURIComponent(resourceId)}/business-roles`);
        items = r.ok ? await r.json() : [];
      } else if (key === 'parents') {
        const r = await authFetch(`/api/resources/${encodeURIComponent(resourceId)}/parent-resources`);
        items = r.ok ? await r.json() : [];
      } else if (key === 'context') {
        const ctxId = data?.attributes?.contextId;
        if (ctxId) {
          const r = await authFetch(`/api/contexts/${encodeURIComponent(ctxId)}`);
          const d = r.ok ? await r.json() : null;
          items = d?.context ? [d.context] : (d ? [d] : []);
        }
      }
      setListCache(prev => ({ ...prev, [key]: items }));
    } finally {
      setListLoading(false);
    }
  }, [resourceId, authFetch, listCache, data]);

  const handleNodeClick = useCallback((key) => {
    setActiveKey(key);
    fetchList(key);
  }, [fetchList]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading resource details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="text-red-800 font-semibold">Error loading resource</h2>
        <p className="text-red-600 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, tags, historyCount,
          assignmentByType = {}, accessPackageCount = 0, parentResourceCount = 0 } = data;
  const resourceType = attributes.resourceType || attributes.groupTypeCalculated || '';
  const typeBadgeClass = RESOURCE_TYPE_COLORS[resourceType] || 'bg-gray-100 text-gray-700';
  const extAttrs = parseExtendedAttributes(attributes.extendedAttributes);
  const resolvedHistoryCount = history ? history.length : historyCount;
  const attributeEntries = buildAttributeEntries(attributes, extAttrs, HIDDEN_FIELDS);
  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  const nodes = [
    { key: 'members-direct', label: 'Direct Members', count: assignmentByType.Direct || 0, accent: 'lime' },
    { key: 'members-governed', label: 'Governed', count: assignmentByType.Governed || 0, accent: 'blue' },
    { key: 'members-owner', label: 'Owners', count: assignmentByType.Owner || 0, accent: 'amber' },
    { key: 'members-eligible', label: 'Eligible', count: assignmentByType.Eligible || 0, accent: 'purple' },
    { key: 'business-roles', label: 'Business Roles', count: accessPackageCount, accent: 'purple' },
    { key: 'parents', label: 'Member Of', count: parentResourceCount, accent: 'emerald' },
    { key: 'context', label: 'Context', count: attributes.contextId ? 1 : 0, accent: 'purple' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-lg font-bold">R</div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{attributes.displayName}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                {resourceType && (
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${typeBadgeClass}`}>
                    {resourceType}
                  </span>
                )}
                {attributes.systemId && (
                  <span className="text-xs text-gray-400">System: {attributes.systemId}</span>
                )}
              </div>
            </div>
          </div>
          {attributes.description && (
            <p className="text-sm text-gray-600 mt-2 max-w-2xl">{attributes.description}</p>
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
          className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
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
                nodes={nodes}
                activeKey={activeKey}
                onNodeClick={handleNodeClick}
              />
              {activeKey && (
                <div className="text-xs text-gray-400 dark:text-gray-500 text-center pb-2">
                  Showing <span className="font-medium text-gray-600">{nodes.find(n => n.key === activeKey)?.label}</span>
                  {' — '}
                  <button onClick={() => setActiveKey(null)} className="text-gray-500 hover:text-gray-700 underline">clear</button>
                </div>
              )}
            </div>

            {activeKey && (
              <ResourceRelationshipList
                nodeKey={activeKey}
                items={listCache[activeKey]}
                loading={listLoading}
                onOpenDetail={onOpenDetail}
              />
            )}
            {!activeKey && (
              <div className="bg-white dark:bg-gray-800 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center">
                <p className="text-sm text-gray-400">Click a node in the graph to see its details.</p>
              </div>
            )}
          </div>
        }
      >
        <RiskScoreSection attributes={attributes} entityType="group" entityId={resourceId} authFetch={authFetch} />

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
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium w-44">Date</th>
                  <th className="px-4 py-2 font-medium">Changes</th>
                </tr>
              </thead>
              <tbody>
                {historyDiffs.map((diff, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="px-4 py-2 text-gray-600 text-xs align-top whitespace-nowrap">{formatDate(diff.date)}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-col gap-1">
                        {diff.changes.map((c, j) => (
                          <div key={j} className="text-xs">
                            <span className="font-medium text-gray-700">{friendlyLabel(c.field)}</span>
                            <span className="text-gray-400 mx-1">:</span>
                            <span className="text-red-500 line-through mr-1">{c.from}</span>
                            <span className="text-gray-400 mr-1">&rarr;</span>
                            <span className="text-green-600">{c.to}</span>
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

function ResourceRelationshipList({ nodeKey, items, loading, onOpenDetail }) {
  if (loading && !items) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500">Loading…</div>;
  }
  if (!items || items.length === 0) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-400 italic">Nothing to show for this relationship.</div>;
  }
  if (nodeKey?.startsWith('members-')) return <AssignmentRows items={items} onOpenDetail={onOpenDetail} />;
  if (nodeKey === 'business-roles') return <BusinessRoleRows items={items} onOpenDetail={onOpenDetail} />;
  if (nodeKey === 'parents') return <ParentRows items={items} onOpenDetail={onOpenDetail} />;
  if (nodeKey === 'context') return <ContextRows items={items} onOpenDetail={onOpenDetail} />;
  return null;
}

function ListShell({ count, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Selected</h3>
        <span className="text-xs text-gray-500">{count}</span>
      </div>
      <div className="max-h-[460px] overflow-y-auto">{children}</div>
    </div>
  );
}

function AssignmentRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <th className="px-4 py-2 font-medium">User</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={a.principalId + ':' + i} className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <td className="px-4 py-2">
                <button onClick={() => onOpenDetail?.('user', a.principalId, a.principalDisplayName)}
                        className="text-blue-700 hover:text-blue-900 hover:underline font-medium">
                  {a.principalDisplayName || a.principalId}
                </button>
                <div className="text-xs text-gray-400">{a.principalType}</div>
              </td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${ASSIGNMENT_TYPE_COLORS[a.assignmentType] || 'bg-gray-100 text-gray-700'}`}>
                  {a.assignmentType}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-500 text-xs">{a.assignmentStatus || a.state || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function BusinessRoleRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <th className="px-4 py-2 font-medium">Business Role</th>
            <th className="px-4 py-2 font-medium">Role Name</th>
          </tr>
        </thead>
        <tbody>
          {items.map((br, i) => (
            <tr key={(br.businessRoleId || '') + ':' + i} className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <td className="px-4 py-2">
                {br.businessRoleId ? (
                  <button onClick={() => onOpenDetail?.('access-package', br.businessRoleId, br.businessRoleName || 'Unnamed')}
                          className="text-blue-700 hover:text-blue-900 hover:underline font-medium">
                    {br.businessRoleName || <span className="text-gray-400 italic">Unnamed</span>}
                  </button>
                ) : <span className="text-gray-400 italic">{br.businessRoleName || 'Unnamed'}</span>}
              </td>
              <td className="px-4 py-2 text-gray-500">{(br.roleName && br.roleName !== '-') ? br.roleName : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function ParentRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <th className="px-4 py-2 font-medium">Parent Resource</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Relationship</th>
          </tr>
        </thead>
        <tbody>
          {items.map((pr, i) => (
            <tr key={pr.parentResourceId + ':' + i} className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <td className="px-4 py-2">
                <button onClick={() => onOpenDetail?.('resource', pr.parentResourceId, pr.parentDisplayName)}
                        className="text-blue-700 hover:text-blue-900 hover:underline font-medium">
                  {pr.parentDisplayName || pr.parentResourceId}
                </button>
              </td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${RESOURCE_TYPE_COLORS[pr.parentResourceType] || 'bg-gray-100 text-gray-700'}`}>
                  {pr.parentResourceType}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-500 text-xs">{pr.relationshipType}{pr.roleName ? ` (${pr.roleName})` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function ContextRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <div className="divide-y divide-gray-50">
        {items.map(c => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/40">
            <div className="min-w-0 flex-1">
              <button onClick={() => onOpenDetail?.('context', c.id, c.displayName)}
                      className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline text-left">
                {c.displayName || c.id}
              </button>
              <div className="text-xs text-gray-400">
                {[c.contextType, c.parentContextDisplayName].filter(Boolean).join(' • ') || '—'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ListShell>
  );
}

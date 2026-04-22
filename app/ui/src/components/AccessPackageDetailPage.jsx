import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import { formatDate, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';
import { CollapsibleSection } from './DetailSection';
import EntityGraph from './EntityGraph';
import EntityDetailLayout, { AttributesTable, buildAttributeEntries } from './EntityDetailLayout';

const HEADER_FIELDS = ['catalogName', 'catalogId', 'description'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, 'ValidFrom', 'ValidTo', 'extendedAttributes',
]);

const SCOPE_LABELS = {
  allMemberUsers:                          'All member users',
  allDirectoryUsers:                       'All directory users',
  specificDirectoryUsers:                  'Specific directory users',
  allDirectoryServicePrincipals:           'All service principals',
  specificDirectoryServicePrincipals:      'Specific service principals',
  specificConnectedOrganizationUsers:      'Specific connected org users',
  allConfiguredConnectedOrganizationUsers: 'All configured connected org users',
  allExternalUsers:                        'All external users',
  notSpecified:                            'Not specified',
};
function formatScope(val) { if (!val) return '\u2014'; return SCOPE_LABELS[val] || val; }

const DECISION_STYLES = {
  Approve:     'bg-green-100 text-green-800',
  Deny:        'bg-red-100 text-red-800',
  DontKnow:    'bg-yellow-100 text-yellow-800',
  NotReviewed: 'bg-gray-100 text-gray-600',
};
const DECISION_LABELS = {
  Approve:     'Approved',
  Deny:        'Denied',
  DontKnow:    'Don\u2019t Know',
  NotReviewed: 'Not Reviewed',
};
const REQUEST_STATE_STYLES = {
  PendingApproval: 'bg-yellow-100 text-yellow-800',
  Delivering:      'bg-blue-100 text-blue-800',
  Accepted:        'bg-green-100 text-green-800',
};
const ASSIGNMENT_TYPE_STYLES = {
  'Auto-assigned':                   'bg-green-100 text-green-800 border-green-200',
  'Request-based':                   'bg-blue-100 text-blue-800 border-blue-200',
  'Request-based with auto-removal': 'bg-orange-100 text-orange-800 border-orange-200',
  'Both':                            'bg-purple-100 text-purple-800 border-purple-200',
};

export default function AccessPackageDetailPage({ accessPackageId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();

  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(cachedData?.history || null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [riskData, setRiskData] = useState(null);

  // Graph state — node-click fetches + caches the matching list.
  const [activeKey, setActiveKey] = useState(null);
  const [listCache, setListCache] = useState({});
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/business-roles/${accessPackageId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, accessPackageId]);

  useEffect(() => {
    if (cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(accessPackageId, 'access-package', { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accessPackageId, authFetch, cachedData?.core, onCacheData]);

  const loadHistory = useCallback(() => {
    if (history) return;
    setHistoryLoading(true);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/history`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setHistory(d);
        onCacheData?.(accessPackageId, 'access-package', { history: d });
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [accessPackageId, authFetch, history, onCacheData]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen(prev => { if (!prev) loadHistory(); return !prev; });
  }, [loadHistory]);

  // Map graph-node key → list endpoint. Each endpoint is cached per node.
  const fetchList = useCallback(async (key) => {
    if (listCache[key]) return;
    setListLoading(true);
    const urls = {
      assignments:    `/api/access-package/${encodeURIComponent(accessPackageId)}/assignments`,
      resources:      `/api/access-package/${encodeURIComponent(accessPackageId)}/resource-roles`,
      policies:       `/api/access-package/${encodeURIComponent(accessPackageId)}/policies`,
      reviews:        `/api/access-package/${encodeURIComponent(accessPackageId)}/reviews`,
      requests:       `/api/access-package/${encodeURIComponent(accessPackageId)}/requests`,
    };
    try {
      let items = [];
      if (key === 'catalog') {
        const catId = data?.attributes?.catalogId;
        if (catId) {
          const r = await authFetch(`/api/governance/catalogs/${encodeURIComponent(catId)}`);
          items = r.ok ? [await r.json()] : [{ id: catId, displayName: data.attributes.catalogName }];
        }
      } else if (urls[key]) {
        const r = await authFetch(urls[key]);
        items = r.ok ? await r.json() : [];
      }
      setListCache(prev => ({ ...prev, [key]: items }));
    } finally {
      setListLoading(false);
    }
  }, [accessPackageId, authFetch, listCache, data]);

  const handleNodeClick = useCallback((key) => {
    setActiveKey(key);
    fetchList(key);
  }, [fetchList]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading business role details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="text-red-800 font-semibold">Error loading business role</h2>
        <p className="text-red-600 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const {
    attributes,
    assignmentCount = 0,
    groupCount = 0,
    reviewCount = 0,
    pendingRequestCount = 0,
    policyCount = 0,
    historyCount,
    lastReviewDate, lastReviewedBy, assignmentType, category,
  } = data;

  const resolvedHistoryCount = history ? history.length : historyCount;
  const attributeEntries = buildAttributeEntries(
    attributes,
    attributes.extendedAttributesParsed || (typeof attributes.extendedAttributes === 'object' ? attributes.extendedAttributes : null),
    HIDDEN_FIELDS,
  );
  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  const nodes = [
    { key: 'assignments', label: 'Assignments',      count: assignmentCount,     accent: 'blue' },
    { key: 'resources',   label: 'Resources',        count: groupCount,          accent: 'lime' },
    { key: 'policies',    label: 'Policies',         count: policyCount,         accent: 'purple' },
    { key: 'reviews',     label: 'Reviews',          count: reviewCount,         accent: 'emerald' },
    { key: 'requests',    label: 'Pending Requests', count: pendingRequestCount, accent: 'amber' },
    { key: 'catalog',     label: 'Catalog',          count: attributes.catalogId ? 1 : 0, accent: 'purple' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-lg font-bold">
              AP
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-gray-900">{attributes.displayName}</h2>
                {assignmentType && (
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${ASSIGNMENT_TYPE_STYLES[assignmentType] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                    {assignmentType}
                  </span>
                )}
                {category && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                    style={{ backgroundColor: category.color + '20', borderColor: category.color, color: category.color }}>
                    {category.name}
                  </span>
                )}
              </div>
              {attributes.catalogName && (
                <p className="text-sm text-gray-500">Catalog: {attributes.catalogName}</p>
              )}
            </div>
          </div>
          {attributes.description && (
            <p className="text-sm text-gray-600 mt-2 max-w-2xl">{attributes.description}</p>
          )}
          {lastReviewDate && (
            <div className="mt-2 text-sm text-gray-600">
              <span className="text-gray-500">Last Certification:</span>{' '}
              <span className="font-medium">{formatDate(lastReviewDate)}</span>
              {lastReviewedBy && <span className="text-gray-500"> by {lastReviewedBy}</span>}
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
            <div className="bg-white border border-gray-200 rounded-lg p-3">
              <EntityGraph
                centerLabel="Business Role"
                centerSubLabel={attributes.displayName}
                nodes={nodes}
                activeKey={activeKey}
                onNodeClick={handleNodeClick}
              />
              {activeKey && (
                <div className="text-xs text-gray-400 text-center pb-2">
                  Showing <span className="font-medium text-gray-600">{nodes.find(n => n.key === activeKey)?.label}</span>
                  {' — '}
                  <button onClick={() => setActiveKey(null)} className="text-gray-500 hover:text-gray-700 underline">clear</button>
                </div>
              )}
            </div>

            {activeKey ? (
              <APRelationshipList nodeKey={activeKey} items={listCache[activeKey]} loading={listLoading} onOpenDetail={onOpenDetail} />
            ) : (
              <div className="bg-white border border-dashed border-gray-200 rounded-lg p-6 text-center">
                <p className="text-sm text-gray-400">Click a node in the graph to see its details.</p>
              </div>
            )}
          </div>
        }
      >
        {riskData && <RiskScoreSection attributes={riskData} entityType="business-roles" entityId={accessPackageId} authFetch={authFetch} />}

        <CollapsibleSection
          title="Version History"
          count={resolvedHistoryCount}
          countLabel={resolvedHistoryCount === 1 ? 'version' : 'versions'}
          open={historyOpen}
          onToggle={toggleHistory}
          loading={historyLoading}
        >
          {historyDiffs.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">No changes recorded</p>
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

// ─── Relationship list dispatcher for the AP graph ─────────────────────

function APRelationshipList({ nodeKey, items, loading, onOpenDetail }) {
  if (loading && !items) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500">Loading…</div>;
  }
  if (!items || items.length === 0) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-400 italic">Nothing to show for this relationship.</div>;
  }
  if (nodeKey === 'assignments') return <AssignmentsRows items={items} onOpenDetail={onOpenDetail} />;
  if (nodeKey === 'resources')   return <ResourceRoleRows items={items} onOpenDetail={onOpenDetail} />;
  if (nodeKey === 'policies')    return <PoliciesRows items={items} />;
  if (nodeKey === 'reviews')     return <ReviewsRows items={items} onOpenDetail={onOpenDetail} />;
  if (nodeKey === 'requests')    return <RequestsRows items={items} onOpenDetail={onOpenDetail} />;
  if (nodeKey === 'catalog')     return <CatalogRows items={items} />;
  return null;
}

function ListShell({ count, children }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-700">Selected</h3>
        <span className="text-xs text-gray-500">{count}</span>
      </div>
      <div className="max-h-[460px] overflow-y-auto">{children}</div>
    </div>
  );
}

function AssignmentsRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200 sticky top-0">
            <th className="px-4 py-2 font-medium">User</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Assigned</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={(a.principalId || '') + ':' + i} className="border-b border-gray-50 hover:bg-gray-50">
              <td className="px-4 py-2">
                {a.principalId ? (
                  <button onClick={() => onOpenDetail?.('user', a.principalId, a.targetDisplayName)}
                          className="text-blue-700 hover:text-blue-900 hover:underline font-medium">
                    {a.targetDisplayName || a.principalId}
                  </button>
                ) : <span className="text-gray-900 font-medium">{a.targetDisplayName || '—'}</span>}
                {a.targetUPN && <div className="text-xs text-gray-400">{a.targetUPN}</div>}
              </td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  a.assignmentState === 'Delivered' ? 'bg-green-100 text-green-800'
                  : a.assignmentState === 'Delivering' ? 'bg-blue-100 text-blue-800'
                  : a.assignmentState === 'Expired' ? 'bg-gray-100 text-gray-600'
                  : 'bg-yellow-100 text-yellow-800'
                }`}>
                  {a.assignmentState || '—'}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-500 text-xs">{a.assignmentStatus || '—'}</td>
              <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{a.assignedDate ? formatDate(a.assignedDate) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function ResourceRoleRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200 sticky top-0">
            <th className="px-4 py-2 font-medium">Resource</th>
            <th className="px-4 py-2 font-medium">Role</th>
            <th className="px-4 py-2 font-medium">Type</th>
          </tr>
        </thead>
        <tbody>
          {items.map((rr, i) => {
            const name = rr.resourceDisplayName || rr.scopeDisplayName || rr.groupDisplayName;
            return (
              <tr key={(rr.childResourceId || '') + ':' + i} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-4 py-2">
                  {rr.childResourceId ? (
                    <button onClick={() => onOpenDetail?.('resource', rr.childResourceId, name)}
                            className="text-blue-700 hover:text-blue-900 hover:underline font-medium">
                      {name || rr.childResourceId}
                    </button>
                  ) : <span className="text-gray-900 font-medium">{name || '—'}</span>}
                  {rr.scopeOriginSystem && <div className="text-xs text-gray-400">{rr.scopeOriginSystem}</div>}
                </td>
                <td className="px-4 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    rr.roleName === 'Owner' ? 'bg-purple-100 text-purple-800'
                    : rr.roleName === 'Member' ? 'bg-blue-100 text-blue-800'
                    : 'bg-gray-100 text-gray-600'
                  }`}>
                    {rr.roleName || '—'}
                  </span>
                </td>
                <td className="px-4 py-2 text-gray-500 text-xs">{rr.resourceType || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ListShell>
  );
}

function PoliciesRows({ items }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200 sticky top-0">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Scope</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p, i) => (
            <tr key={(p.id || '') + ':' + i} className="border-b border-gray-50 hover:bg-gray-50">
              <td className="px-4 py-2">
                <div className="text-gray-900 font-medium">{p.displayName || '—'}</div>
                {p.description && <div className="text-xs text-gray-400 mt-0.5 truncate max-w-xs" title={p.description}>{p.description}</div>}
              </td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  p.hasAutoAddRule ? 'bg-green-100 text-green-800'
                  : p.hasAutoRemoveRule ? 'bg-orange-100 text-orange-800'
                  : 'bg-blue-100 text-blue-800'
                }`}>
                  {p.hasAutoAddRule ? 'Auto-assigned' : p.hasAutoRemoveRule ? 'Request-based w/ auto-removal' : 'Request-based'}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-600 text-xs">
                <div>{formatScope(p.allowedTargetScope)}</div>
                {p.autoAssignmentFilter && (
                  <div className="mt-0.5 text-gray-400 font-mono text-[11px] leading-snug break-all" title="Auto-assignment filter rule">
                    {p.autoAssignmentFilter}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function ReviewsRows({ items }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200 sticky top-0">
            <th className="px-4 py-2 font-medium">User</th>
            <th className="px-4 py-2 font-medium">Reviewer</th>
            <th className="px-4 py-2 font-medium">Decision</th>
            <th className="px-4 py-2 font-medium">Date</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={(r.id || '') + ':' + i} className="border-b border-gray-50 hover:bg-gray-50">
              <td className="px-4 py-2 text-gray-900">{r.principalDisplayName || '—'}</td>
              <td className="px-4 py-2 text-gray-600">{r.reviewedByDisplayName || '—'}</td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${DECISION_STYLES[r.decision] || 'bg-gray-100 text-gray-600'}`}>
                  {DECISION_LABELS[r.decision] || r.decision || '—'}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{r.reviewedDateTime ? formatDate(r.reviewedDateTime) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function RequestsRows({ items }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200 sticky top-0">
            <th className="px-4 py-2 font-medium">Requestor</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={(r.id || '') + ':' + i} className="border-b border-gray-50 hover:bg-gray-50">
              <td className="px-4 py-2">
                <div className="text-gray-900">{r.requestorDisplayName || '—'}</div>
                {r.requestorUPN && <div className="text-xs text-gray-400">{r.requestorUPN}</div>}
              </td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${REQUEST_STATE_STYLES[r.requestState] || 'bg-gray-100 text-gray-600'}`}>
                  {r.requestState || '—'}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{r.createdDateTime ? formatDate(r.createdDateTime) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function CatalogRows({ items }) {
  return (
    <ListShell count={items.length}>
      <div className="divide-y divide-gray-50">
        {items.map(c => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50">
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-gray-900">{c.displayName || c.id}</span>
              {c.description && <div className="text-xs text-gray-400">{c.description}</div>}
            </div>
          </div>
        ))}
      </div>
    </ListShell>
  );
}

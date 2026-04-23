import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection, { RISK_FIELDS } from './RiskScoreSection';
import { formatDate, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';
import { tierClass } from '../utils/tierStyles';
import { CollapsibleSection } from './DetailSection';
import EntityGraph from './EntityGraph';
import EntityDetailLayout, { AttributesTable, buildAttributeEntries } from './EntityDetailLayout';

const HEADER_FIELDS = ['userPrincipalName', 'email', 'department', 'jobTitle', 'companyName'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, ...RISK_FIELDS,
  'ValidFrom', 'ValidTo', 'extendedAttributes', 'extendedAttributesParsed',
  // These columns show up as graph nodes instead of attribute rows so the
  // visualization doesn't feel duplicated by the table.
  'managerId', 'contextId',
]);

function safeParse(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { return JSON.parse(val) || {}; } catch { return {}; }
}

export default function UserDetailPage({ userId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();

  // Core data (attributes, tags, all counts incl. membership breakdown)
  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  // Lazy-loaded history
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(cachedData?.history || null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Identity membership banner
  const [identityInfo, setIdentityInfo] = useState(undefined);

  // Manager (one record) — fetched eagerly because the header uses it and
  // the graph shows the manager node.
  const [manager, setManager] = useState(null);
  const [managerLoaded, setManagerLoaded] = useState(false);

  // Graph selection + cache of relationship lists keyed by node key. Cache
  // keeps us from re-fetching when the user toggles between nodes.
  const [activeKey, setActiveKey] = useState(null);
  const [listCache, setListCache] = useState({});
  const [listLoading, setListLoading] = useState(false);

  // Core fetch
  useEffect(() => {
    if (cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/user/${encodeURIComponent(userId)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(userId, 'user', { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, authFetch, cachedData?.core, onCacheData]);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/identities/by-user/${encodeURIComponent(userId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setIdentityInfo(d?.identity ? d : null); })
      .catch(() => { if (!cancelled) setIdentityInfo(null); });
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/org-chart/user/${encodeURIComponent(userId)}/manager`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.manager) setManager(d.manager); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setManagerLoaded(true); });
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  const loadHistory = useCallback(() => {
    if (history) return;
    setHistoryLoading(true);
    authFetch(`/api/user/${encodeURIComponent(userId)}/history`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setHistory(d);
        onCacheData?.(userId, 'user', { history: d });
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [userId, authFetch, history, onCacheData]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen(prev => {
      if (!prev) loadHistory();
      return !prev;
    });
  }, [loadHistory]);

  // ─── Relationship node click → fetch list if not cached ────────────
  const fetchList = useCallback(async (key) => {
    if (listCache[key]) return;
    setListLoading(true);
    try {
      let items = [];
      if (key === 'manager') {
        items = manager ? [manager] : [];
      } else if (key === 'reports') {
        const r = await authFetch(`/api/org-chart/user/${encodeURIComponent(userId)}/reports`);
        const d = r.ok ? await r.json() : {};
        items = d.reports || [];
      } else if (key === 'context') {
        const ctxId = data?.attributes?.contextId;
        if (ctxId) {
          const r = await authFetch(`/api/contexts/${encodeURIComponent(ctxId)}`);
          const d = r.ok ? await r.json() : null;
          // /api/contexts/:id returns { attributes, members, subContexts }
          if (d?.attributes) items = [d.attributes];
        }
      } else if (key?.startsWith('groups-')) {
        const r = await authFetch(`/api/user/${encodeURIComponent(userId)}/memberships`);
        const d = r.ok ? await r.json() : [];
        const want = { 'groups-direct': 'Direct', 'groups-indirect': 'Indirect', 'groups-owner': 'Owner', 'groups-eligible': 'Eligible' }[key];
        items = d.filter(m => m.membershipType === want);
      } else if (key === 'access-packages') {
        const r = await authFetch(`/api/user/${encodeURIComponent(userId)}/access-packages`);
        items = r.ok ? await r.json() : [];
      } else if (key === 'oauth2-grants') {
        const r = await authFetch(`/api/user/${encodeURIComponent(userId)}/oauth2-grants`);
        items = r.ok ? await r.json() : [];
      } else if (key === 'identity') {
        items = identityInfo?.identity ? [identityInfo.identity] : [];
      }
      setListCache(prev => ({ ...prev, [key]: items }));
    } finally {
      setListLoading(false);
    }
  }, [userId, authFetch, listCache, manager, data, identityInfo]);

  const handleNodeClick = useCallback((key) => {
    setActiveKey(key);
    fetchList(key);
  }, [fetchList]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading user details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="text-red-800 font-semibold">Error loading user</h2>
        <p className="text-red-600 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, tags, historyCount, lastActivity,
          membershipByType = {}, accessPackageCount = 0,
          oauth2GrantCount = 0, directReportCount = 0 } = data;

  const resolvedHistoryCount = history ? history.length : historyCount;
  const attributeEntries = buildAttributeEntries(attributes, attributes.extendedAttributesParsed, HIDDEN_FIELDS);
  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  // ─── Graph nodes ──────────────────────────────────────────────────
  const nodes = [
    { key: 'manager', label: 'Manager', count: manager ? 1 : 0, accent: 'emerald' },
    { key: 'reports', label: 'Direct Reports', count: directReportCount, accent: 'blue' },
    { key: 'context', label: 'Context', count: attributes.contextId ? 1 : 0, accent: 'purple' },
    { key: 'groups-direct', label: 'Groups (Direct)', count: membershipByType.Direct || 0, accent: 'lime' },
    { key: 'groups-indirect', label: 'Groups (Indirect)', count: membershipByType.Indirect || 0, accent: 'lime' },
    { key: 'groups-owner', label: 'Groups Owned', count: membershipByType.Owner || 0, accent: 'amber' },
    { key: 'groups-eligible', label: 'Eligible', count: membershipByType.Eligible || 0, accent: 'purple' },
    { key: 'access-packages', label: 'Access Packages', count: accessPackageCount, accent: 'purple' },
    { key: 'oauth2-grants', label: 'OAuth2 Grants', count: oauth2GrantCount, accent: 'red' },
    { key: 'identity', label: 'Identity', count: identityInfo?.identity ? 1 : 0, accent: 'emerald' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-lg font-bold">
              {(attributes.displayName || '?')[0]}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-gray-900">{attributes.displayName}</h2>
                {attributes.principalType && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 border border-indigo-200">
                    {attributes.principalType}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500">{attributes.userPrincipalName || attributes.email}</p>
              {(attributes.systemDisplayName || attributes.systemId) && (
                <p className="text-xs text-gray-400">System: {attributes.systemDisplayName || attributes.systemId}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
            {attributes.jobTitle && <span>{attributes.jobTitle}</span>}
            {attributes.department && <span className="text-gray-400">|</span>}
            {attributes.department && <span>{attributes.department}</span>}
            {attributes.companyName && <span className="text-gray-400">|</span>}
            {attributes.companyName && <span>{attributes.companyName}</span>}
          </div>
          {lastActivity?.lastActivityDateTime && (
            <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-400">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Last sign-in: {formatDate(lastActivity.lastActivityDateTime)}</span>
            </div>
          )}
          {tags.length > 0 && (
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
                centerLabel="User"
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
              <UserRelationshipList
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
        <RiskScoreSection attributes={attributes} entityType="user" entityId={userId} authFetch={authFetch} />

        {identityInfo && (
          <IdentityMembershipSection
            identityInfo={identityInfo}
            onNavigateToIdentities={() => { window.location.hash = 'identities'; }}
          />
        )}

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
                    <td className="px-4 py-2 text-gray-600 text-xs align-top whitespace-nowrap">
                      {formatDate(diff.date)}
                    </td>
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

// ─── UserRelationshipList ──────────────────────────────────────────────
// Renders the list of relationship objects below the graph. Row shape
// varies by relationship type; a small switch keeps the markup readable.

function UserRelationshipList({ nodeKey, items, loading, onOpenDetail }) {
  if (loading && !items) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500">Loading…</div>;
  }
  if (!items || items.length === 0) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-400 italic">Nothing to show for this relationship.</div>;
  }

  if (nodeKey === 'manager' || nodeKey === 'reports') {
    return <PrincipalRows items={items} onOpenDetail={onOpenDetail} />;
  }
  if (nodeKey === 'context') {
    return <ContextRows items={items} onOpenDetail={onOpenDetail} />;
  }
  if (nodeKey?.startsWith('groups-')) {
    return <MembershipRows items={items} onOpenDetail={onOpenDetail} />;
  }
  if (nodeKey === 'access-packages') {
    return <AccessPackageRows items={items} onOpenDetail={onOpenDetail} />;
  }
  if (nodeKey === 'oauth2-grants') {
    return <OAuth2GrantRows items={items} onOpenDetail={onOpenDetail} />;
  }
  if (nodeKey === 'identity') {
    return <IdentityRows items={items} onOpenDetail={onOpenDetail} />;
  }
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

function PrincipalRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <div className="divide-y divide-gray-50">
        {items.map(r => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/40">
            <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">
              {(r.displayName || '?')[0]}
            </div>
            <div className="min-w-0 flex-1">
              <button
                onClick={() => onOpenDetail?.('user', r.id, r.displayName)}
                className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline text-left"
              >
                {r.displayName}
              </button>
              <div className="text-xs text-gray-400">
                {[r.jobTitle, r.department].filter(Boolean).join(' \u2022 ') || '\u2014'}
              </div>
            </div>
            {r.riskTier && r.riskTier !== 'None' && r.riskTier !== 'Minimal' && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tierClass(r.riskTier)}`}>
                {r.riskTier}
              </span>
            )}
          </div>
        ))}
      </div>
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
              <button
                onClick={() => onOpenDetail?.('context', c.id, c.displayName)}
                className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline text-left"
              >
                {c.displayName || c.id}
              </button>
              <div className="text-xs text-gray-400">
                {[c.contextType, c.parentContextDisplayName].filter(Boolean).join(' \u2022 ') || '\u2014'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ListShell>
  );
}

function MembershipRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <th className="px-4 py-2 font-medium">Group / Resource</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Managed</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m, i) => (
            <tr key={m.resourceId + ':' + i} className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <td className="px-4 py-2">
                <button
                  onClick={() => onOpenDetail?.('resource', m.resourceId, m.resourceDisplayName || m.groupDisplayName)}
                  className="text-blue-700 hover:text-blue-900 hover:underline text-left font-medium"
                >
                  {m.resourceDisplayName || m.groupDisplayName || m.resourceId}
                </button>
              </td>
              <td className="px-4 py-2 text-gray-500 text-xs">{m.resourceType || m.groupTypeCalculated || '—'}</td>
              <td className="px-4 py-2 text-xs">
                {m.managedByAccessPackage
                  ? <span className="inline-block px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">Governed</span>
                  : <span className="text-gray-400">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function AccessPackageRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <th className="px-4 py-2 font-medium">Access Package</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Expires</th>
          </tr>
        </thead>
        <tbody>
          {items.map((ap, i) => (
            <tr key={ap.resourceId + ':' + i} className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <td className="px-4 py-2">
                <button
                  onClick={() => onOpenDetail?.('access-package', ap.resourceId, ap.accessPackageName)}
                  className="text-blue-700 hover:text-blue-900 hover:underline text-left font-medium"
                >
                  {ap.accessPackageName || ap.resourceId}
                </button>
              </td>
              <td className="px-4 py-2 text-xs text-gray-500">{ap.state || '—'}</td>
              <td className="px-4 py-2 text-xs text-gray-500">{ap.expirationDateTime ? formatDate(ap.expirationDateTime) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function OAuth2GrantRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <th className="px-4 py-2 font-medium">Client application</th>
            <th className="px-4 py-2 font-medium">Scope</th>
          </tr>
        </thead>
        <tbody>
          {items.map((g, i) => {
            const grantExt = safeParse(g.grantExtendedAttributes);
            const scopeExt = safeParse(g.scopeExtendedAttributes);
            const clientName = g.clientDisplayName || grantExt.clientDisplayName || grantExt.clientSpId || '—';
            const scopeValue = grantExt.scope || scopeExt.scope || g.scopeDisplayName || '—';
            return (
              <tr key={g.scopeResourceId + ':' + i} className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                <td className="px-4 py-2">
                  {g.clientSpId ? (
                    <button onClick={() => onOpenDetail?.('resource', g.clientSpId, clientName)}
                            className="text-blue-700 hover:text-blue-900 hover:underline text-left font-medium">
                      {clientName}
                    </button>
                  ) : <span className="text-gray-900">{clientName}</span>}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-gray-600">{scopeValue}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ListShell>
  );
}

function IdentityRows({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <div className="divide-y divide-gray-50">
        {items.map(id => (
          <div key={id.id} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/40">
            <div className="min-w-0 flex-1">
              <button
                onClick={() => onOpenDetail?.('identity', id.id, id.displayName)}
                className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline text-left"
              >
                {id.displayName || id.id}
              </button>
              <div className="text-xs text-gray-400">
                {id.accountCount ? `${id.accountCount} accounts` : ''}
                {id.primaryAccountUpn ? ` \u2022 primary: ${id.primaryAccountUpn}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ListShell>
  );
}

// ─── Identity Membership banner — unchanged from v1 ────────────────────

const ACCOUNT_TYPE_COLORS = {
  Regular:  'bg-blue-100 text-blue-800 border-blue-200',
  Admin:    'bg-red-100 text-red-800 border-red-200',
  Test:     'bg-amber-100 text-amber-800 border-amber-200',
  Service:  'bg-purple-100 text-purple-800 border-purple-200',
  Shared:   'bg-teal-100 text-teal-800 border-teal-200',
  External: 'bg-gray-100 text-gray-600 border-gray-200',
};

function IdentityMembershipSection({ identityInfo, onNavigateToIdentities }) {
  const [expanded, setExpanded] = useState(false);
  const { identity, memberInfo, otherMembers = [] } = identityInfo;
  const typeColor = ACCOUNT_TYPE_COLORS[memberInfo.accountType] || ACCOUNT_TYPE_COLORS.Regular;

  return (
    <div className="bg-white border border-emerald-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
          </svg>
          Identity Membership
        </h3>
        <button onClick={onNavigateToIdentities} className="text-xs text-emerald-700 hover:text-emerald-900 hover:underline">
          View all identities →
        </button>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 text-sm">{identity.displayName}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${typeColor}`}>
              {memberInfo.accountType}
            </span>
            {memberInfo.isPrimary && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">Primary</span>
            )}
            {memberInfo.isHrAuthoritative && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200" title={`HR Score: ${memberInfo.hrScore}`}>HR Source</span>
            )}
            {memberInfo.analystOverride && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${
                memberInfo.analystOverride === 'confirmed' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}>{memberInfo.analystOverride}</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''} · primary: {identity.primaryAccountUpn}
            {identity.correlationConfidence != null && ` · ${identity.correlationConfidence}% confidence`}
          </div>
          {memberInfo.correlationSignals && (
            <div className="text-xs text-gray-400 mt-0.5">
              Signals: {memberInfo.correlationSignals}
            </div>
          )}
        </div>
      </div>

      {otherMembers.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setExpanded(v => !v)} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1">
            <span>{expanded ? '▼' : '▶'}</span>
            {expanded ? 'Hide' : 'Show'} other accounts ({otherMembers.length})
          </button>
          {expanded && (
            <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
              {otherMembers.map(m => {
                const tc = ACCOUNT_TYPE_COLORS[m.accountType] || ACCOUNT_TYPE_COLORS.Regular;
                return (
                  <div key={m.userId} className="flex items-center gap-2 text-xs">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full font-medium border ${tc}`}>{m.accountType}</span>
                    {m.isPrimary && <span className="text-blue-600 font-medium">Primary</span>}
                    {m.isHrAuthoritative && <span className="text-emerald-700 font-medium">HR</span>}
                    <span className="text-gray-700 font-medium truncate max-w-48">{m.displayName}</span>
                    <span className="text-gray-400 truncate max-w-64">{m.userPrincipalName}</span>
                    <span className={`ml-auto ${m.accountEnabled === 'True' || m.accountEnabled === true ? 'text-green-500' : 'text-gray-300'}`}>
                      {m.accountEnabled === 'True' || m.accountEnabled === true ? '●' : '○'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

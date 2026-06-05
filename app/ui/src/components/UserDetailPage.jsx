import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection, { RISK_FIELDS } from './RiskScoreSection';
import { formatDate } from '../utils/formatters';
import EntityGraph from './EntityGraph';
import { AttributesTable } from './EntityDetailLayout';
import { buildAttributeEntries } from '../utils/attributeEntries';
import ExpandedItemsList from './ExpandedItemsList';
import TabBar from './TabBar';
import UserTimeline from './UserTimeline';
import ConfidenceBar from './ConfidenceBar';
import useExpandableGraph from '../hooks/useExpandableGraph';
import useTimeline from '../hooks/useTimeline';
import useFeatures from '../hooks/useFeatures';
import { getRootNodes } from './entityGraphShape';

const HEADER_FIELDS = ['userPrincipalName', 'email', 'department', 'jobTitle', 'companyName'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, ...RISK_FIELDS,
  'ValidFrom', 'ValidTo', 'extendedAttributes', 'extendedAttributesParsed',
  // These columns show up as graph nodes instead of attribute rows so the
  // visualization doesn't feel duplicated by the table.
  'managerId', 'contextId',
]);

export default function UserDetailPage({ userId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();

  // Core data (attributes, tags, all counts incl. membership breakdown)
  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  // Sub-tab + timeline range
  const [activeTab, setActiveTab] = useState('attributes');
  const [timelineDays, setTimelineDays] = useState(90);

  // Identity membership banner (a relationship — lives on the Relationships tab)
  const [identityInfo, setIdentityInfo] = useState(undefined);

  // Manager (one record) — fetched eagerly because the header uses it and
  // the graph shows the manager node.
  const [manager, setManager] = useState(null);

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
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  // Timeline — lazy: only fetched once the Timeline tab is opened.
  const timeline = useTimeline(userId, authFetch, {
    sinceDays: timelineDays,
    enabled: activeTab === 'timeline',
  });

  // Root-ring nodes for the relationship graph. recent: null → the graph drops
  // the "Recently Added/Removed" pseudo-nodes (those changes live on the
  // Timeline tab now).
  const rootExtras = useMemo(() => ({
    manager,
    identityInfo,
    contextId: data?.attributes?.contextId,
    recent: null,
  }), [manager, identityInfo, data]);

  const rootNodes = useMemo(() => (
    data ? getRootNodes('user', data, rootExtras) : []
  ), [data, rootExtras]);

  const graph = useExpandableGraph({
    rootEntityKind: 'user',
    rootEntityId: userId,
    rootExtras,
    rootNodes,
    authFetch,
  });

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">Loading user details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6">
        <h2 className="text-red-800 dark:text-red-300 font-semibold">Error loading user</h2>
        <p className="text-red-600 dark:text-red-400 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, tags, lastActivity } = data;
  const attributeEntries = buildAttributeEntries(attributes, attributes.extendedAttributesParsed, HIDDEN_FIELDS);

  const tabs = [
    { key: 'attributes', label: 'Attributes', count: attributeEntries.length },
    { key: 'relationships', label: 'Relationships' },
    { key: 'timeline', label: 'Timeline' },
    features.riskScoring && { key: 'risk', label: 'Risk' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-lg font-bold">
              {(attributes.displayName || '?')[0]}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
                {attributes.principalType && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-700">
                    {attributes.principalType}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{attributes.userPrincipalName || attributes.email}</p>
              {(attributes.systemDisplayName || attributes.systemId) && (
                <p className="text-xs text-gray-600 dark:text-gray-500">System: {attributes.systemDisplayName || attributes.systemId}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
            {attributes.jobTitle && <span>{attributes.jobTitle}</span>}
            {attributes.department && <span className="text-gray-600 dark:text-gray-500">|</span>}
            {attributes.department && <span>{attributes.department}</span>}
            {attributes.companyName && <span className="text-gray-600 dark:text-gray-500">|</span>}
            {attributes.companyName && <span>{attributes.companyName}</span>}
          </div>
          {lastActivity?.lastActivityDateTime && (
            <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-600 dark:text-gray-500">
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
          className="text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Close tab">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="mt-4">
        {activeTab === 'attributes' && (
          <AttributesTable entries={attributeEntries} />
        )}

        {activeTab === 'relationships' && (
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <EntityGraph
                centerLabel="User"
                centerSubLabel={attributes.displayName}
                nodes={graph.nodesWithExpansion}
                expandedPath={graph.expandedPath}
                onNodeClick={graph.handleNodeClick}
              />
              {graph.pathDepth > 0 && (
                <div className="text-xs text-gray-600 dark:text-gray-500 text-center pb-2">
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
                <p className="text-sm text-gray-600 dark:text-gray-500">Click a node in the graph to fan it out; click again to collapse.</p>
              </div>
            )}

            {identityInfo && (
              <IdentityMembershipSection
                identityInfo={identityInfo}
                onNavigateToIdentities={() => { window.location.hash = 'identities'; }}
              />
            )}
          </div>
        )}

        {activeTab === 'timeline' && (
          <UserTimeline
            events={timeline.events}
            loading={timeline.loading}
            sinceDays={timelineDays}
            onSinceDaysChange={setTimelineDays}
            onOpenDetail={onOpenDetail}
          />
        )}

        {activeTab === 'risk' && (
          <RiskScoreSection attributes={attributes} entityType="user" entityId={userId} authFetch={authFetch} />
        )}
      </div>
    </div>
  );
}

// ─── Identity Membership banner ───────────────────────────────────────

const ACCOUNT_TYPE_COLORS = {
  Regular:  'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  Admin:    'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
  Test:     'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  Service:  'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700',
  Shared:   'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-700',
  External: 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600',
};

function IdentityMembershipSection({ identityInfo, onNavigateToIdentities }) {
  const [expanded, setExpanded] = useState(false);
  const { identity, memberInfo, otherMembers = [] } = identityInfo;
  const typeColor = ACCOUNT_TYPE_COLORS[memberInfo.accountType] || ACCOUNT_TYPE_COLORS.Regular;

  return (
    <div className="bg-white dark:bg-gray-800 border border-emerald-200 dark:border-emerald-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
          </svg>
          Identity Membership
        </h3>
        <button onClick={onNavigateToIdentities} className="text-xs text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-200 hover:underline">
          View all identities →
        </button>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">{identity.displayName}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${typeColor}`}>
              {memberInfo.accountType}
            </span>
            {memberInfo.isPrimary && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700">Primary</span>
            )}
            {memberInfo.isHrAuthoritative && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700" title={`HR Score: ${memberInfo.hrScore}`}>HR Source</span>
            )}
            {memberInfo.analystOverride && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${
                memberInfo.analystOverride === 'confirmed' ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
              }`}>{memberInfo.analystOverride}</span>
            )}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''} · primary: {identity.primaryAccountUpn}
          </div>
          {/* Correlation confidence — the correlation result IS this identity
              relationship, so its confidence belongs right here. */}
          {identity.correlationConfidence != null && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Correlation confidence</div>
              <ConfidenceBar confidence={identity.correlationConfidence} />
            </div>
          )}
          {memberInfo.correlationSignals && (
            <div className="text-xs text-gray-600 dark:text-gray-500 mt-1">
              Signals: {memberInfo.correlationSignals}
            </div>
          )}
        </div>
      </div>

      {otherMembers.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setExpanded(v => !v)} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1">
            <span>{expanded ? '▼' : '▶'}</span>
            {expanded ? 'Hide' : 'Show'} other accounts ({otherMembers.length})
          </button>
          {expanded && (
            <div className="mt-2 space-y-1 border-t border-gray-100 dark:border-gray-700 pt-2">
              {otherMembers.map(m => {
                const tc = ACCOUNT_TYPE_COLORS[m.accountType] || ACCOUNT_TYPE_COLORS.Regular;
                return (
                  <div key={m.userId} className="flex items-center gap-2 text-xs">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full font-medium border ${tc}`}>{m.accountType}</span>
                    {m.isPrimary && <span className="text-blue-600 dark:text-blue-400 font-medium">Primary</span>}
                    {m.isHrAuthoritative && <span className="text-emerald-700 dark:text-emerald-300 font-medium">HR</span>}
                    <span className="text-gray-700 dark:text-gray-300 font-medium truncate max-w-48">{m.displayName}</span>
                    <span className="text-gray-600 dark:text-gray-500 truncate max-w-64">{m.userPrincipalName}</span>
                    <span className={`ml-auto ${m.accountEnabled === 'True' || m.accountEnabled === true ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
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

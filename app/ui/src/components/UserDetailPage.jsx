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
    // Only show Risk when scoring is enabled AND this user actually has a
    // score — otherwise the tab would open onto an empty panel.
    (features.riskScoring && attributes.riskScore != null) && { key: 'risk', label: 'Risk' },
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
                <p className="text-sm text-gray-600 dark:text-gray-500">Click a node in the graph to fan it out; click again to collapse. The user's identity, manager, groups and access packages are all here — click through to drill in.</p>
              </div>
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

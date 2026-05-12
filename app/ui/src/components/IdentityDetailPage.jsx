import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import ConfidenceBar from './ConfidenceBar';
import EntityGraph from './EntityGraph';
import EntityDetailLayout, { AttributesTable, buildAttributeEntries } from './EntityDetailLayout';
import ExpandedItemsList from './ExpandedItemsList';
import RecentChangesSection from './RecentChangesSection';
import useExpandableGraph from '../hooks/useExpandableGraph';
import useRecentChanges from '../hooks/useRecentChanges';
import { getRootNodes } from './entityGraphShape';

const SYSTEM_COLS = new Set([
  'SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo',
  // Identity header already shows these; no point repeating in the table.
  'displayName', 'contextId', 'contextDisplayName',
]);

export default function IdentityDetailPage({ identityId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [members, setMembers] = useState([]);
  const [aggregate, setAggregate] = useState({});
  const [riskData, setRiskData] = useState(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/identities/${identityId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, identityId]);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/identities/${identityId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setIdentity(data.identity);
      setMembers(data.members || []);
      setAggregate(data.aggregateAssignments || {});
      if (onCacheData) onCacheData(identityId, 'identity', data);
    } catch (err) {
      console.error('Failed to load identity detail:', err);
      setError(err.message || 'Failed to load identity details');
    } finally {
      setLoading(false);
    }
  }, [authFetch, identityId, onCacheData]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // Verify/remove-verification is the only action kept on this page —
  // per-member override lives in the dedicated correlation UI now.
  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await authFetch(`/api/identities/${identityId}/verify`, {
        method: identity.analystVerified ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: '' }),
      });
      if (res.ok) await fetchDetail();
    } catch (err) { console.error('Failed to update verification:', err); }
    finally { setVerifying(false); }
  };

  const recent = useRecentChanges('identity', identityId, authFetch);

  const rootExtras = useMemo(() => ({
    members,
    contextId: identity?.contextId,
    recent,
  }), [members, identity, recent]);

  // Pack the identity core payload into the shape getRootNodes expects.
  const core = useMemo(() => (
    identity ? { identity, members, aggregateAssignments: aggregate } : null
  ), [identity, members, aggregate]);

  const rootNodes = useMemo(() => (
    core ? getRootNodes('identity', core, rootExtras) : []
  ), [core, rootExtras]);

  const graph = useExpandableGraph({
    rootEntityKind: 'identity',
    rootEntityId: identityId,
    rootExtras,
    rootNodes,
    authFetch,
  });

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500 dark:text-gray-400">Loading identity details...</div></div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Failed to load identity</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <div className="flex gap-3 mt-3">
          <button onClick={fetchDetail} className="text-sm text-red-700 dark:text-red-400 underline hover:text-red-900 dark:hover:text-red-200">Retry</button>
          <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-200">Close</button>
        </div>
      </div>
    );
  }
  if (!identity) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center text-gray-500 dark:text-gray-400 text-sm">
        Identity not found.
        <button onClick={onClose} className="ml-2 text-blue-700 underline hover:text-blue-900">Close</button>
      </div>
    );
  }

  const cleaned = {};
  for (const [k, v] of Object.entries(identity)) {
    if (!SYSTEM_COLS.has(k) && v != null && v !== '') cleaned[k] = v;
  }
  const attributeEntries = buildAttributeEntries(cleaned, null, new Set());
  const hrAccount = members.find(m => m.isHrAuthoritative);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-sm font-bold">ID</div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{identity.displayName || identityId}</h2>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-sm text-gray-500 dark:text-gray-400">{identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''}</span>
                  {identity.contextDisplayName && (
                    <button onClick={() => onOpenDetail?.('context', identity.contextId, identity.contextDisplayName)}
                            className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 hover:underline">
                      {identity.contextDisplayName}
                    </button>
                  )}
                  {hrAccount?.jobTitle && <span className="text-sm text-gray-500 dark:text-gray-400">{hrAccount.jobTitle}</span>}
                  {identity.correlationConfidence != null && <ConfidenceBar confidence={identity.correlationConfidence} />}
                  {identity.analystVerified && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-700">
                      Verified
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleVerify} disabled={verifying}
              className={`text-xs px-3 py-1.5 rounded border ${
                identity.analystVerified
                  ? 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
                  : 'bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50'
              }`}>
              {identity.analystVerified ? 'Remove Verification' : 'Verify Identity'}
            </button>
            <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1" title="Close">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <EntityDetailLayout
        left={<AttributesTable entries={attributeEntries} />}
        right={
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <EntityGraph
                centerLabel="Identity"
                centerSubLabel={identity.displayName}
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
        {riskData && <RiskScoreSection attributes={riskData} entityType="identities" entityId={identityId} authFetch={authFetch} />}

        <RecentChangesSection
          events={recent.events}
          addedCount={recent.addedCount}
          removedCount={recent.removedCount}
          sinceDays={recent.sinceDays}
          loading={recent.loading}
          onOpenDetail={onOpenDetail}
        />

        {identity.correlationSignals && (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Correlation Signals</h3>
            <div className="flex flex-wrap gap-1.5">
              {identity.correlationSignals.split(',').map(s => (
                <span key={s} className="inline-block bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-2 py-1 rounded text-xs">{s.trim()}</span>
              ))}
            </div>
          </div>
        )}
      </EntityDetailLayout>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import useFeatures from '@ui/hooks/useFeatures';
import EntityDetailPage from './EntityDetailPage';
import RiskScoreSection from './RiskScoreSection';
import LinkedAccountsPanel from './LinkedAccountsPanel';
import { buildAttributeEntries } from '@ui/utils/attributeEntries';

const SYSTEM_COLS = new Set([
  'SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo',
  'displayName', 'contextId', 'contextDisplayName',
]);

async function fetchIdentityData({ entityId, authFetch }) {
  const res = await authFetch(`/api/identities/${entityId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.identity) throw new Error('Identity not found');
  return data;
}

function getIdentityAttributeEntries(data) {
  const cleaned = {};
  for (const [k, v] of Object.entries(data.identity)) {
    if (k === 'extendedAttributes') continue;
    if (!SYSTEM_COLS.has(k) && v != null && v !== '') cleaned[k] = v;
  }
  return buildAttributeEntries(cleaned, data.identity.extendedAttributes, new Set());
}

function getIdentityRootExtras(data) {
  return {
    members: data.members || [],
    aggregateAssignments: data.aggregateAssignments || {},
    contextCount: data.contextCount || 0,
    contextId: data.identity?.contextId,
    recent: null,
  };
}

function IdentityHeader({ data, onOpenDetail }) {
  const { identity, members } = data;
  const hrAccount = members?.find(m => m.isHrAuthoritative);
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-sm font-bold">ID</div>
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{identity.displayName}</h2>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''}
          </span>
          {identity.contextDisplayName && (
            <button
              onClick={() => onOpenDetail?.('context', identity.contextId, identity.contextDisplayName)}
              className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 hover:underline">
              {identity.contextDisplayName}
            </button>
          )}
          {hrAccount?.jobTitle && (
            <span className="text-sm text-gray-500 dark:text-gray-400">{hrAccount.jobTitle}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function IdentityDetailPage({ identityId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();
  const [riskData, setRiskData] = useState(null);
  const [busyMember, setBusyMember] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/identities/${identityId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, identityId]);

  const overrideMember = useCallback(async (principalId, action) => {
    setBusyMember(principalId);
    try {
      const url = `/api/identities/${identityId}/members/${principalId}/override`;
      const res = action === 'clear'
        ? await authFetch(url, { method: 'DELETE' })
        : await authFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          });
      if (res.ok) setRefreshKey(k => k + 1);
    } catch (err) { console.error('Failed to update linked account:', err); }
    finally { setBusyMember(null); }
  }, [authFetch, identityId]);

  const getTabs = useCallback((data, entries) => {
    const hasRisk = features.riskScoring && riskData && riskData.riskScore != null;
    return [
      { key: 'attributes', label: 'Attributes', count: entries.length },
      { key: 'relationships', label: 'Relationships' },
      { key: 'timeline', label: 'Timeline' },
      hasRisk && { key: 'risk', label: 'Risk' },
    ];
  }, [features, riskData]);

  return (
    <EntityDetailPage
      entityKind="identity"
      entityId={identityId}
      authFetch={authFetch}
      fetchData={fetchIdentityData}
      cachedData={cachedData}
      onCacheData={onCacheData}
      refreshKey={refreshKey}
      getGraphRootExtras={getIdentityRootExtras}
      graphCenterLabel="Identity"
      getDisplayName={(data) => data.identity?.displayName}
      getTabs={getTabs}
      getAttributeEntries={getIdentityAttributeEntries}
      renderHeader={(data) => <IdentityHeader data={data} onOpenDetail={onOpenDetail} />}
      headerCard
      renderRelationshipsExtra={(data) => (
        <LinkedAccountsPanel
          members={data.members || []}
          busyMember={busyMember}
          onOverride={overrideMember}
          onOpenDetail={onOpenDetail}
        />
      )}
      renderRisk={riskData ? () => (
        <RiskScoreSection attributes={riskData} entityType="identities" entityId={identityId} authFetch={authFetch} />
      ) : undefined}
      onRetry={() => setRefreshKey(k => k + 1)}
      entityLabel="identity"
      onClose={onClose}
      onOpenDetail={onOpenDetail}
    />
  );
}

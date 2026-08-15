import { useState, useEffect, useReducer, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import ContextDetailHeader from './ContextDetailHeader';
import ContextAttributesTab from './ContextAttributesTab';
import ContextRelationshipsTab from './ContextRelationshipsTab';
import TabBar from './TabBar';
import EntityTimeline from './EntityTimeline';
import useTimeline from '@ui/hooks/useTimeline';
import useFeatures from '@ui/hooks/useFeatures';

// ─── Context Detail Page ──────────────────────────────────────────────────────
// Shows details for a single Context (v6 shape): header with variant /
// target / scope-system / owner, paginated members, sub-contexts.
// Loaded via /api/contexts/:id.

export default function ContextDetailPage({ contextId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();
  // loading/error are flipped synchronously inside the fetch effects; reducer
  // dispatches keep that clear of set-state-in-effect.
  const [loading, setLoading] = useReducer((_, v) => v, true);
  const [error, setError] = useReducer((_, v) => v, null);
  const [detail, setDetail] = useState(null);
  const [activeTab, setActiveTab] = useState('relationships');
  const [timelineDays, setTimelineDays] = useState(90);

  // Paginated members
  const [memberPage, setMemberPage] = useState(0);
  const [memberSearch, setMemberSearch] = useState('');
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [members, setMembers] = useState([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [membersLoading, setMembersLoading] = useReducer((_, v) => v, false);
  const [riskData, setRiskData] = useState(null);
  const PAGE_SIZE = 50;

  // ─── Fetch risk score data ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/contexts/${contextId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, contextId]);

  // ─── Fetch Context detail ──────────────────────────────────────────
  const fetchDetail = useCallback(() => {
    setLoading(true);
    setError(null);
    return authFetch(`/api/contexts/${contextId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setDetail(data);
        if (onCacheData) onCacheData(contextId, 'context', data);
      })
      .catch((err) => {
        console.error('Failed to load context detail:', err);
        setError(err.message || 'Failed to load context details');
      })
      .finally(() => setLoading(false));
  }, [authFetch, contextId, onCacheData]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // ─── Fetch paginated members ──────────────────────────────────────
  const fetchMembers = useCallback(() => {
    setMembersLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(memberPage * PAGE_SIZE),
    });
    if (memberSearch) params.set('search', memberSearch);
    if (includeDescendants) params.set('include', 'descendants');
    return authFetch(`/api/contexts/${contextId}/members?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setMembers(data.data || []);
        setMemberTotal(data.total || 0);
      })
      .catch((err) => console.error('Failed to load context members:', err))
      .finally(() => setMembersLoading(false));
  }, [authFetch, contextId, memberPage, memberSearch, includeDescendants]);

  useEffect(() => { fetchMembers(); }, [fetchMembers]);

  // Reset page when search / scope changes — during render via a composite
  // compare, so no synchronous setState lives in an effect.
  const memberFilterSig = `${memberSearch}|${includeDescendants}`;
  const [seenMemberFilterSig, setSeenMemberFilterSig] = useState(memberFilterSig);
  if (memberFilterSig !== seenMemberFilterSig) {
    setSeenMemberFilterSig(memberFilterSig);
    setMemberPage(0);
  }

  const timeline = useTimeline('context', contextId, authFetch, {
    sinceDays: timelineDays,
    enabled: activeTab === 'timeline',
  });

  // ─── Render ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500 dark:text-gray-400">Loading context details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Failed to load context</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <div className="flex gap-3 mt-3">
          <button onClick={fetchDetail} className="text-sm text-red-700 dark:text-red-400 underline hover:text-red-900">Retry</button>
          <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-300">Close</button>
        </div>
      </div>
    );
  }

  if (!detail || !detail.attributes) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center text-gray-600 dark:text-gray-500 text-sm">
        Context not found.
        <button onClick={onClose} className="ml-2 text-blue-500 dark:text-blue-400 underline hover:text-blue-700 dark:hover:text-blue-300">Close</button>
      </div>
    );
  }

  const subContexts = detail.subContexts || [];
  const isManual = detail.attributes.variant === 'manual';
  const isGenerated = detail.attributes.variant === 'generated';
  // Analyst-owned membership writes work for both manual + generated
  // contexts. Synced is the only variant we refuse — the source system
  // would overwrite the analyst edit on the next crawl.
  const canEditMembers = isManual || isGenerated;

  const hasRisk = features.riskScoring && riskData && riskData.riskScore != null;
  const tabs = [
    { key: 'attributes', label: 'Attributes' },
    { key: 'relationships', label: 'Relationships', count: memberTotal },
    { key: 'timeline', label: 'Timeline' },
    hasRisk && { key: 'risk', label: 'Risk' },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <ContextDetailHeader attrs={detail.attributes} onClose={onClose} />
      {detail.attributes.description && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-6 py-3 text-sm text-gray-700 dark:text-gray-300">{detail.attributes.description}</div>
      )}

      <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="mt-4 space-y-4">
        {activeTab === 'attributes' && (
          <ContextAttributesTab
            contextId={contextId}
            attrs={detail.attributes}
            isManual={isManual}
            isGenerated={isGenerated}
            authFetch={authFetch}
            onUpdated={() => fetchDetail()}
            onDeleted={() => onClose?.()}
          />
        )}

        {activeTab === 'relationships' && (
          <ContextRelationshipsTab
            subContexts={subContexts}
            contextId={contextId}
            attrs={detail.attributes}
            canEditMembers={canEditMembers}
            isGenerated={isGenerated}
            includeDescendants={includeDescendants}
            onIncludeDescendantsChange={setIncludeDescendants}
            memberSearch={memberSearch}
            onMemberSearchChange={setMemberSearch}
            members={members}
            memberTotal={memberTotal}
            membersLoading={membersLoading}
            memberPage={memberPage}
            onMemberPageChange={setMemberPage}
            pageSize={PAGE_SIZE}
            authFetch={authFetch}
            onMembersChanged={() => { fetchMembers(); fetchDetail(); }}
            onOpenDetail={onOpenDetail}
          />
        )}

        {activeTab === 'timeline' && (
          <EntityTimeline
            events={timeline.events}
            loading={timeline.loading}
            sinceDays={timelineDays}
            onSinceDaysChange={setTimelineDays}
            onOpenDetail={onOpenDetail}
          />
        )}

        {activeTab === 'risk' && riskData && (
          <RiskScoreSection attributes={riskData} entityType="contexts" entityId={contextId} authFetch={authFetch} />
        )}
      </div>
    </div>
  );
}

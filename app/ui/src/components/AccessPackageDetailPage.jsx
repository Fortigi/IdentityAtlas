import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import { formatDate } from '../utils/formatters';
import EntityGraph from './EntityGraph';
import { AttributesTable } from './EntityDetailLayout';
import { buildAttributeEntries } from '../utils/attributeEntries';
import ExpandedItemsList from './ExpandedItemsList';
import TabBar from './TabBar';
import EntityTimeline from './EntityTimeline';
import AccessPackageGovernance from './AccessPackageGovernance';
import useExpandableGraph from '../hooks/useExpandableGraph';
import useTimeline from '../hooks/useTimeline';
import useFeatures from '../hooks/useFeatures';
import { getRootNodes } from './entityGraphShape';
import { ASSIGNMENT_TYPE_STYLES, COMPLIANCE_STYLES } from '../utils/accessPackageStyles';

const HEADER_FIELDS = ['catalogName', 'catalogId', 'description'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, 'ValidFrom', 'ValidTo', 'extendedAttributes',
]);

export default function AccessPackageDetailPage({ accessPackageId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();

  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);
  const [riskData, setRiskData] = useState(null);

  const [activeTab, setActiveTab] = useState('attributes');
  const [timelineDays, setTimelineDays] = useState(90);

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

  const timeline = useTimeline('access-package', accessPackageId, authFetch, {
    sinceDays: timelineDays,
    enabled: activeTab === 'timeline',
  });

  const rootExtras = useMemo(() => ({
    catalogId: data?.attributes?.catalogId,
    catalogName: data?.attributes?.catalogName,
    recent: null,
  }), [data]);

  const rootNodes = useMemo(() => (
    data ? getRootNodes('access-package', data, rootExtras) : []
  ), [data, rootExtras]);

  const graph = useExpandableGraph({
    rootEntityKind: 'access-package',
    rootEntityId: accessPackageId,
    rootExtras,
    rootNodes,
    authFetch,
  });

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">Loading business role details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6">
        <h2 className="text-red-800 dark:text-red-300 font-semibold">Error loading business role</h2>
        <p className="text-red-600 dark:text-red-400 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, lastReviewDate, lastReviewedBy, complianceStatus, daysOverdue, assignmentType, category } = data;
  const attributeEntries = buildAttributeEntries(
    attributes,
    attributes.extendedAttributesParsed || (typeof attributes.extendedAttributes === 'object' ? attributes.extendedAttributes : null),
    HIDDEN_FIELDS,
  );

  const hasRisk = features.riskScoring && riskData && riskData.riskScore != null;
  const tabs = [
    { key: 'attributes', label: 'Attributes', count: attributeEntries.length },
    { key: 'relationships', label: 'Relationships' },
    { key: 'timeline', label: 'Timeline' },
    hasRisk && { key: 'risk', label: 'Risk' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-lg font-bold">BR</div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
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
                <p className="text-sm text-gray-500 dark:text-gray-400">Catalog: {attributes.catalogName}</p>
              )}
            </div>
          </div>
          {attributes.description && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-2xl">{attributes.description}</p>
          )}
          {lastReviewDate && (
            <div className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              <span className="text-gray-500 dark:text-gray-400">Last Certification:</span>{' '}
              <span className="font-medium">{formatDate(lastReviewDate)}</span>
              {lastReviewedBy && <span className="text-gray-500 dark:text-gray-400"> by {lastReviewedBy}</span>}
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
          <div className="space-y-4">
            <OverviewPanel
              assignmentType={assignmentType}
              complianceStatus={complianceStatus}
              daysOverdue={daysOverdue}
              lastReviewDate={lastReviewDate}
              lastReviewedBy={lastReviewedBy}
              category={category}
            />
            <AttributesTable entries={attributeEntries} />
            {/* Governance records (policies, access reviews, requests) live at
                the bottom of Attributes — they describe this role, not a graph
                relationship. */}
            <AccessPackageGovernance accessPackageId={accessPackageId} authFetch={authFetch} />
          </div>
        )}

        {activeTab === 'relationships' && (
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <EntityGraph
                centerLabel="Business Role"
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
          </div>
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
          <RiskScoreSection attributes={riskData} entityType="business-roles" entityId={accessPackageId} authFetch={authFetch} />
        )}
      </div>
    </div>
  );
}

// ─── Overview — the list's calculated fields, with the same badges/colours ──
function OverviewRow({ label, children }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-gray-50 dark:border-gray-700/50 last:border-b-0">
      <span className="text-xs text-gray-500 dark:text-gray-400 w-32 shrink-0">{label}</span>
      <span className="text-sm text-gray-900 dark:text-gray-100">{children}</span>
    </div>
  );
}

const BADGE = 'inline-block px-2 py-0.5 rounded-full text-xs font-medium border';
const NEUTRAL = 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600';

function OverviewPanel({ assignmentType, complianceStatus, daysOverdue, lastReviewDate, lastReviewedBy, category }) {
  if (!(assignmentType || complianceStatus || lastReviewDate || lastReviewedBy || category)) return null;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Overview</h3>
      </div>
      <div className="px-4 py-2">
        {assignmentType && (
          <OverviewRow label="Type">
            <span className={`${BADGE} ${ASSIGNMENT_TYPE_STYLES[assignmentType] || NEUTRAL}`}>{assignmentType}</span>
          </OverviewRow>
        )}
        {complianceStatus && (
          <OverviewRow label="Review status">
            <span className={`${BADGE} ${COMPLIANCE_STYLES[complianceStatus] || NEUTRAL}`}>
              {complianceStatus}{daysOverdue ? ` (${daysOverdue}d ago)` : ''}
            </span>
          </OverviewRow>
        )}
        {lastReviewDate && <OverviewRow label="Review date">{formatDate(lastReviewDate)}</OverviewRow>}
        {lastReviewedBy && <OverviewRow label="Reviewed by">{lastReviewedBy}</OverviewRow>}
        {category && (
          <OverviewRow label="Category">
            <span className={BADGE} style={{ backgroundColor: category.color + '20', borderColor: category.color, color: category.color }}>{category.name}</span>
          </OverviewRow>
        )}
      </div>
    </div>
  );
}

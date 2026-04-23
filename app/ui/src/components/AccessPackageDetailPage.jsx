import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import { formatDate, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';
import { CollapsibleSection } from './DetailSection';
import EntityGraph from './EntityGraph';
import EntityDetailLayout, { AttributesTable, buildAttributeEntries } from './EntityDetailLayout';
import ExpandedItemsList from './ExpandedItemsList';
import RecentChangesSection from './RecentChangesSection';
import useExpandableGraph from '../hooks/useExpandableGraph';
import useRecentChanges from '../hooks/useRecentChanges';
import { getRootNodes } from './entityGraphShape';

const HEADER_FIELDS = ['catalogName', 'catalogId', 'description'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, 'ValidFrom', 'ValidTo', 'extendedAttributes',
]);

const ASSIGNMENT_TYPE_STYLES = {
  'Auto-assigned': 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border-green-200 dark:border-green-700',
  'Request-based': 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-700',
  'Request-based with auto-removal': 'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300 border-orange-200 dark:border-orange-700',
  'Both': 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-700',
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

  const recent = useRecentChanges('access-package', accessPackageId, authFetch);

  const rootExtras = useMemo(() => ({
    catalogId: data?.attributes?.catalogId,
    catalogName: data?.attributes?.catalogName,
    recent,
  }), [data, recent]);

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

  const { attributes, historyCount, lastReviewDate, lastReviewedBy, assignmentType, category } = data;

  const resolvedHistoryCount = history ? history.length : historyCount;
  const attributeEntries = buildAttributeEntries(
    attributes,
    attributes.extendedAttributesParsed || (typeof attributes.extendedAttributes === 'object' ? attributes.extendedAttributes : null),
    HIDDEN_FIELDS,
  );
  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-lg font-bold">AP</div>
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
                centerLabel="Business Role"
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
        {riskData && <RiskScoreSection attributes={riskData} entityType="business-roles" entityId={accessPackageId} authFetch={authFetch} />}

        <RecentChangesSection
          events={recent.events}
          addedCount={recent.addedCount}
          removedCount={recent.removedCount}
          sinceDays={recent.sinceDays}
          loading={recent.loading}
          onOpenDetail={onOpenDetail}
        />

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

import { useState, useEffect, useReducer, useMemo } from 'react';
import EntityGraph from './EntityGraph';
import { AttributesTable } from './EntityDetailLayout';
import ExpandedItemsList from './ExpandedItemsList';
import TabBar from './TabBar';
import EntityTimeline from './EntityTimeline';
import useExpandableGraph from '@ui/hooks/useExpandableGraph';
import useTimeline from '@ui/hooks/useTimeline';
import { getRootNodes } from './entityGraphShape';

// Error guard — shown when the detail fetch rejects. Retry/Close only when onRetry.
function DetailErrorState({ entityLabel, error, onRetry, onClose }) {
  return (
    <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6">
      <h2 className="text-red-800 dark:text-red-300 font-semibold">Error loading {entityLabel}</h2>
      <p className="text-red-600 dark:text-red-400 mt-1 text-sm">{error}</p>
      {onRetry && (
        <div className="flex gap-3 mt-3">
          <button onClick={onRetry} className="text-sm text-red-700 dark:text-red-400 underline hover:text-red-900 dark:hover:text-red-200">Retry</button>
          <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-200">Close</button>
        </div>
      )}
    </div>
  );
}

// Left-side header content + close button, optionally wrapped in a card.
function DetailHeader({ headerCard, renderHeader, data, onClose }) {
  const headerInner = (
    <>
      <div>{renderHeader(data)}</div>
      <button onClick={onClose}
        className="text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        title="Close tab">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </>
  );

  return headerCard ? (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-4">
      <div className="flex items-start justify-between">{headerInner}</div>
    </div>
  ) : (
    <div className="flex items-start justify-between mb-4">{headerInner}</div>
  );
}

// Attributes tab body — wraps the table with optional before/extra render slots.
function AttributesTab({ data, attributeEntries, renderAttributesBefore, renderAttributesExtra }) {
  if (renderAttributesBefore || renderAttributesExtra) {
    return (
      <div className="space-y-4">
        {renderAttributesBefore?.(data)}
        <AttributesTable entries={attributeEntries} />
        {renderAttributesExtra?.(data)}
      </div>
    );
  }
  return <AttributesTable entries={attributeEntries} />;
}

// Relationships tab body — radial graph plus the expanded-items list / empty state.
function RelationshipsTab({ data, graph, graphCenterLabel, getDisplayName, renderRelationshipsExtra, onOpenDetail }) {
  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
        <EntityGraph
          centerLabel={graphCenterLabel}
          centerSubLabel={getDisplayName(data)}
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
      {renderRelationshipsExtra?.(data, graph)}
    </div>
  );
}

/**
 * Shared scaffold for entity detail pages (Resource, User, AccessPackage, Identity).
 *
 * Owns: data fetch, loading/error states, TabBar, all 4 tab panels.
 *
 * Props:
 *   entityKind            'resource' | 'user' | 'access-package' | 'identity'
 *   entityId              ID string used for fetching and hooks
 *   authFetch             from caller's useAuth()
 *   fetchData             async ({ entityId, authFetch }) => rawData
 *   cachedData            { core: rawData } — skip fetch when present (ignored when refreshKey > 0)
 *   onCacheData           optional: (id, kind, { core }) => void
 *   refreshKey            optional number; increment to force re-fetch ignoring cache
 *   getGraphRootExtras    (data) => extras object passed to getRootNodes + useExpandableGraph
 *   graphCenterLabel      string for EntityGraph center node label
 *   getDisplayName        optional: (data) => string for graph center sub-label
 *   getTabs               (data, attributeEntries) => [{key, label, count?}, ...]
 *   getAttributeEntries   (data) => [{key, label, value}, ...] — attribute table rows
 *   renderHeader          (data) => JSX — left-side header content only
 *   headerCard            optional bool — wraps header in a card (used by IdentityDetailPage)
 *   renderAttributesBefore optional: (data) => JSX — rendered above AttributesTable
 *   renderAttributesExtra optional: (data) => JSX — rendered below AttributesTable
 *   renderRelationshipsExtra optional: (data, graph) => JSX — rendered below ExpandedItemsList
 *   renderRisk            optional: (data) => JSX — risk tab content
 *   onRetry               optional: () => void — shows Retry button in error state
 *   entityLabel           lowercase string for loading/error text
 *   onClose               () => void
 *   onOpenDetail          (kind, id, name) => void
 */
export default function EntityDetailPage({
  entityKind,
  entityId,
  authFetch,
  fetchData,
  cachedData,
  onCacheData,
  refreshKey = 0,
  getGraphRootExtras,
  graphCenterLabel,
  getDisplayName = (d) => d.attributes?.displayName,
  getTabs,
  getAttributeEntries,
  renderHeader,
  headerCard = false,
  renderAttributesBefore,
  renderAttributesExtra,
  renderRelationshipsExtra,
  renderRisk,
  onRetry,
  entityLabel,
  onClose,
  onOpenDetail,
}) {
  const [data, setData] = useState(cachedData?.core || null);
  // loading/error are flipped synchronously inside the fetch effect; reducer
  // dispatches (not useState setters) keep that clear of set-state-in-effect.
  const [loading, setLoading] = useReducer((_, v) => v, !cachedData?.core);
  const [error, setError] = useReducer((_, v) => v, null);
  const [activeTab, setActiveTab] = useState('attributes');
  const [timelineDays, setTimelineDays] = useState(90);

  useEffect(() => {
    if (!refreshKey && cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchData({ entityId, authFetch })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(entityId, entityKind, { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityId, authFetch, cachedData?.core, fetchData, onCacheData, entityKind, refreshKey]);

  const rootExtras = useMemo(
    () => (data ? getGraphRootExtras(data) : {}),
    [data, getGraphRootExtras],
  );

  const rootNodes = useMemo(
    () => (data ? getRootNodes(entityKind, data, rootExtras) : []),
    [data, entityKind, rootExtras],
  );

  const timeline = useTimeline(entityKind, entityId, authFetch, {
    sinceDays: timelineDays,
    enabled: activeTab === 'timeline',
  });

  const graph = useExpandableGraph({
    rootEntityKind: entityKind,
    rootEntityId: entityId,
    rootExtras,
    rootNodes,
    authFetch,
  });

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">Loading {entityLabel} details...</div>;
  }
  if (error) {
    return <DetailErrorState entityLabel={entityLabel} error={error} onRetry={onRetry} onClose={onClose} />;
  }
  if (!data) return null;

  const attributeEntries = getAttributeEntries(data);
  const tabs = getTabs(data, attributeEntries);

  return (
    <div className="max-w-7xl mx-auto">
      <DetailHeader headerCard={headerCard} renderHeader={renderHeader} data={data} onClose={onClose} />

      <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="mt-4">
        {activeTab === 'attributes' && (
          <AttributesTab
            data={data}
            attributeEntries={attributeEntries}
            renderAttributesBefore={renderAttributesBefore}
            renderAttributesExtra={renderAttributesExtra}
          />
        )}

        {activeTab === 'relationships' && (
          <RelationshipsTab
            data={data}
            graph={graph}
            graphCenterLabel={graphCenterLabel}
            getDisplayName={getDisplayName}
            renderRelationshipsExtra={renderRelationshipsExtra}
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

        {activeTab === 'risk' && renderRisk?.(data)}
      </div>
    </div>
  );
}

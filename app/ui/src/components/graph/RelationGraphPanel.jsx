// The relationship graph card plus the list under it, as every entity detail
// page shows it (EntityDetailPage, OrgEntityDetailPage). `graph` is what
// useRelationGraph returns. Opening a cluster fills the list with all of that
// relation's objects (the graph shows at most CLUSTER_ITEM_CAP of them).
import RelationGraph from './RelationGraph';
import ExpandedItemsList from '@ui/components/ExpandedItemsList';

export default function RelationGraphPanel({ graph, onOpenDetail, missing = false }) {
  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
        {missing ? (
          <p className="p-6 text-center text-sm text-gray-600 dark:text-gray-400">The relationship graph is not available yet.</p>
        ) : (
          <RelationGraph graph={graph} onOpenDetail={onOpenDetail} />
        )}
        {graph.expanded.length > 1 && (
          <p className="text-xs text-center text-gray-600 dark:text-gray-400 pb-1">
            <button type="button" onClick={graph.reset} className="underline hover:text-gray-800 dark:hover:text-gray-200">
              Collapse all
            </button>
          </p>
        )}
      </div>
      {graph.list ? (
        <ExpandedItemsList label={graph.list.label} items={graph.list.items} note={graph.list.note}
          loading={graph.loading} onOpenDetail={onOpenDetail} />
      ) : (
        <div className="bg-white dark:bg-gray-800 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Click a node to show its relations; click a numbered cluster to list all of its objects here.
          </p>
        </div>
      )}
    </div>
  );
}

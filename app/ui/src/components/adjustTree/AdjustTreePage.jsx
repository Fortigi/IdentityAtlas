import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useContextTreeEdits } from '@ui/components/contexts/useContextTreeEdits';
import { buildTree, indexUnits, liveAdjustments } from './adjustTree.helpers';
import { useAdjustTree } from './useAdjustTree';
import { useAdjustTreeActions } from './useAdjustTreeActions';
import AdjustTreeHeader from './AdjustTreeHeader';
import AdjustTreeView from './AdjustTreeView';
import AdjustTreeSidePanel from './AdjustTreeSidePanel';
import GroupBar from './GroupBar';

// ─── Adjust tree ────────────────────────────────────────────────────────
// A full-width screen to correct one tree (docs/architecture/adjust-tree.md
// §5): the tree on the left (~60 %), and on the right the selected unit, what
// needs attention and the log of adjustments. Every change is an adjustment
// the API records and applies at once; the screen then reads the tree again.
// Opens as the detail tab #adjust-tree:<treeKey>, and inside a finished run
// tab (`embedded`: no header Close, no tab relabel). Only a user holding
// data.write.contexts gets the editing; anyone else sees the tree read-only.

function useSelection(units) {
  const [chosen, setChosen] = useState(null);
  const byId = indexUnits(units);
  // A unit that went away (undone, merged) falls back to the first top unit.
  const selectedId = chosen && byId.has(chosen) ? chosen : buildTree(units)[0]?.id ?? null;
  return { selectedId, unit: selectedId ? byId.get(selectedId) : null, select: setChosen };
}

function useChecked() {
  const [checked, setChecked] = useState(() => new Set());
  const toggle = (id) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return { checked, toggle, clear: () => setChecked(new Set()) };
}

export default function AdjustTreePage({ treeKey, onClose, onCacheData, embedded = false }) {
  const { authFetch } = useAuth();
  const canWrite = useHasPermission('data.write.contexts');
  const data = useAdjustTree(treeKey);
  const units = data.tree?.units || [];
  const selection = useSelection(units);
  const picks = useChecked();
  const [tab, setTab] = useState('unit');
  const select = (id) => { selection.select(id); setTab('unit'); };
  const actions = useAdjustTreeActions(data, { select });
  const sync = useContextTreeEdits({ authFetch, nodes: [], refresh: data.reload, onTreeDeleted: () => {} });
  const editable = canWrite && data.tree?.canAdjust !== false;
  const treeName = data.tree?.name;

  // A tab opened from a URL carries the key until the tree's name is known.
  useEffect(() => {
    if (!embedded && treeName) onCacheData?.(treeKey, 'adjust-tree', { displayName: `Adjust: ${treeName}` });
  }, [embedded, treeName, treeKey, onCacheData]);

  if (data.loading && !data.tree) return <p className="p-8 text-sm text-gray-600 dark:text-gray-400">Loading the tree…</p>;
  if (!data.tree) {
    return (
      <div role="alert" className="mx-auto mt-12 max-w-md rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-700 dark:bg-red-900/30">
        <h2 className="text-lg font-semibold text-red-800 dark:text-red-300">Could not load the tree</h2>
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">{data.error}</p>
        <button type="button" onClick={data.reload} className="mt-3 text-sm text-blue-700 underline dark:text-blue-300">Try again</button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AdjustTreeHeader
        tree={data.tree} adjustmentCount={liveAdjustments(data.adjustments).length} editable={editable}
        onRefresh={units[0] ? () => sync.syncTree(units[0].id) : undefined} refreshing={sync.syncing}
        onClose={embedded ? undefined : onClose}
      />
      {(data.error || sync.editError) && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
          {sync.editError || data.error}
        </p>
      )}
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-2">
          {editable && <GroupBar checked={picks.checked} units={units} onGroup={actions.group} onClear={picks.clear} />}
          <AdjustTreeView
            units={units} targetType={data.tree.targetType} editable={editable}
            selectedId={selection.selectedId} onSelect={select} onDrop={actions.drop}
            checked={picks.checked} onCheck={picks.toggle} version={data.version}
          />
        </div>
        <AdjustTreeSidePanel tab={tab} onTab={setTab} unit={selection.unit} data={data} treeKey={treeKey} editable={editable} actions={actions} />
      </div>
    </div>
  );
}

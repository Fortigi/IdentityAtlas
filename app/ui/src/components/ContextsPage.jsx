// Contexts tab — two-pane layout: left selector + right tree/list view.
// See docs/architecture/context-redesign-ui.md for the design.

import { useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useContextRoots, useContextSubtree } from '../hooks/useContextTrees';
import ContextTreeSelector from './contexts/ContextTreeSelector';
import ContextTreeView from './contexts/ContextTreeView';
import ContextListView from './contexts/ContextListView';
import NewContextModal from './contexts/NewContextModal';
import { variantMeta, targetTypeMeta } from '../utils/contextStyles';

export default function ContextsPage({ onOpenDetail, onNavigate }) {
  const { authFetch } = useAuth();
  const { roots, loading: rootsLoading, error: rootsError, reload: reloadRoots } = useContextRoots();
  const [selectedRootId, setSelectedRootId] = useState(null);
  const [viewMode, setViewMode] = useState('tree');
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Auto-select the first root when roots load.
  const effectiveRootId = useMemo(() => {
    if (selectedRootId && roots.find(r => r.id === selectedRootId)) return selectedRootId;
    return roots[0]?.id || null;
  }, [roots, selectedRootId]);

  const { nodes, loading: subtreeLoading } = useContextSubtree(effectiveRootId);
  const selectedRoot = roots.find(r => r.id === effectiveRootId);

  function open(id, name) {
    onOpenDetail?.('context', id, name);
  }

  // Delete an entire tree (root + all descendants via ON DELETE CASCADE).
  // Manual + generated allowed; synced is rejected by the API. After delete,
  // we reload the roots list and clear the selection so the right pane
  // gracefully falls back to the next available tree.
  async function deleteTree(rootId) {
    setDeleteError(null);
    try {
      const r = await authFetch(`/api/contexts/${rootId}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      setSelectedRootId(null);
      reloadRoots();
    } catch (err) {
      setDeleteError(err.message || 'Delete failed');
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-180px)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex flex-1 min-h-0">
        <div className="w-80 flex-shrink-0">
          <ContextTreeSelector
            roots={roots}
            selectedRootId={effectiveRootId}
            onSelectRoot={setSelectedRootId}
            onNewTree={() => setNewModalOpen(true)}
            loading={rootsLoading}
          />
        </div>

        <div className="flex-1 min-w-0 overflow-auto flex flex-col">
          {rootsError && (
            <div className="p-4 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border-b border-red-100">
              {rootsError}
            </div>
          )}

          {!selectedRoot && !rootsLoading && (
            <div className="flex-1 flex items-center justify-center p-8 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">
              Select a tree on the left, or click <span className="font-semibold">+ New</span> to create one.
            </div>
          )}

          {selectedRoot && (
            <>
              <SelectedRootHeader
                root={selectedRoot}
                viewMode={viewMode}
                onChangeViewMode={setViewMode}
                onDeleteTree={deleteTree}
                deleteError={deleteError}
              />
              {subtreeLoading ? (
                <div className="p-4 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">Loading subtree…</div>
              ) : viewMode === 'tree' ? (
                <ContextTreeView nodes={nodes} onOpenDetail={open} />
              ) : (
                <ContextListView nodes={nodes} onOpenDetail={open} />
              )}
            </>
          )}
        </div>
      </div>

      <NewContextModal
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        onCreated={(created) => {
          reloadRoots();
          if (created?.id) onOpenDetail?.('context', created.id, created.displayName);
        }}
        onRunStarted={(runId) => {
          if (runId) onOpenDetail?.('run', runId, 'Plugin run');
        }}
        onOpenCrawlers={() => onNavigate?.('admin')}
      />
    </div>
  );
}

function SelectedRootHeader({ root, viewMode, onChangeViewMode, onDeleteTree, deleteError }) {
  const v = variantMeta(root.variant);
  const t = targetTypeMeta(root.targetType);
  const [confirming, setConfirming] = useState(false);
  // Synced trees come from a crawler — deleting them via the API would
  // let them re-appear on the next sync, so the API blocks it.
  const canDelete = root.variant !== 'synced';
  return (
    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`w-1.5 h-6 ${v.dotClass} rounded`} aria-hidden="true" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate">{root.displayName}</h2>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] ${v.textClass}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${v.dotClass}`} />{v.label}
            </span>
            {root.scopeSystemName && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-gray-700 text-slate-600 dark:text-gray-400 border border-slate-200 dark:border-gray-600">
                {root.scopeSystemName}
              </span>
            )}
            {root.ownerUserId && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-700" title="Owner">
                Owner: {root.ownerUserId}
              </span>
            )}
          </div>
          {root.description && <p className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-1 truncate">{root.description}</p>}
        </div>

        <div className="flex items-center gap-3">
          {canDelete && !confirming && (
            <button
              onClick={() => setConfirming(true)}
              className="text-[11px] text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
              title="Delete this entire tree (root + descendants + members)"
            >Delete tree…</button>
          )}
          {canDelete && confirming && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-red-700 dark:text-red-400">
                Delete the entire "{root.displayName}" tree ({root.totalMemberCount ?? 0} members)?
              </span>
              <button
                onClick={() => { setConfirming(false); onDeleteTree(root.id); }}
                className="px-2 py-0.5 text-[11px] rounded bg-red-600 dark:bg-red-700 text-white hover:bg-red-700 dark:hover:bg-red-600"
              >Yes, delete</button>
              <button
                onClick={() => setConfirming(false)}
                className="px-2 py-0.5 text-[11px] rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300"
              >Cancel</button>
            </div>
          )}

          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded p-0.5">
            <button
              onClick={() => onChangeViewMode('tree')}
              className={`px-2.5 py-1 text-xs rounded ${viewMode === 'tree' ? 'bg-white dark:bg-gray-800 shadow-sm text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
            >Tree</button>
            <button
              onClick={() => onChangeViewMode('list')}
              className={`px-2.5 py-1 text-xs rounded ${viewMode === 'list' ? 'bg-white dark:bg-gray-800 shadow-sm text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
            >List</button>
          </div>
        </div>
      </div>

      {deleteError && (
        <div className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">
          {deleteError}
        </div>
      )}
    </div>
  );
}

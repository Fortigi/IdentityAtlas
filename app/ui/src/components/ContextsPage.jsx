// Contexts tab — two-pane layout: left selector + right tree/list view.
// See docs/architecture/context-redesign-ui.md for the design.

import { useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useContextRoots, useContextSubtree } from '../hooks/useContextTrees';
import ContextTreeSelector from './contexts/ContextTreeSelector';
import ContextTreeView from './contexts/ContextTreeView';
import ContextListView from './contexts/ContextListView';
import NewContextWizard from './contexts/NewContextWizard';
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

  const { nodes, loading: subtreeLoading, reload: reloadSubtree } = useContextSubtree(effectiveRootId);
  const selectedRoot = roots.find(r => r.id === effectiveRootId);
  const [editError, setEditError] = useState(null);

  function open(id, name) {
    onOpenDetail?.('context', id, name);
  }

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  // Refresh both the subtree (structure + recomputed member counts) and the
  // roots list (root-level totals shown in the left selector) after any edit.
  async function refreshAfterEdit() {
    await reloadSubtree();
    reloadRoots();
  }

  // Sync = re-run the generating plugin onto this tree so out-of-date
  // references update (e.g. a user who changed manager moves to the new node),
  // keeping all analyst edits. We poll the queued run, then refresh the view.
  async function syncTree(rootId) {
    setSyncing(true); setSyncMsg(null); setEditError(null);
    try {
      const r = await authFetch(`/api/contexts/${rootId}/sync`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      const runId = body.runId;
      const deadline = Date.now() + 120000;
      let status = 'queued';
      while (runId && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 2000));
        const pr = await authFetch(`/api/context-plugins/runs/${runId}`);
        if (pr.ok) { status = (await pr.json()).status; if (status === 'succeeded' || status === 'failed') break; }
      }
      if (status === 'failed') throw new Error('Sync run failed — see the run log.');
      await refreshAfterEdit();
      setSyncMsg('Synced');
      setTimeout(() => setSyncMsg(null), 2500);
    } catch (e) {
      setEditError(e.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  // Drag-drop re-parent: make `childId` a child of `newParentId`. The API
  // validates targetType + cycles and recomputes counts on both branches.
  async function reparent(childId, newParentId) {
    setEditError(null);
    try {
      const r = await authFetch(`/api/contexts/${childId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentContextId: newParentId }),
      });
      if (!r.ok) { const p = await r.json().catch(() => ({})); throw new Error(p.error || `HTTP ${r.status}`); }
      await refreshAfterEdit();
    } catch (e) { setEditError(e.message || 'Move failed'); }
  }

  // Inline rename from the tree.
  async function rename(id, displayName) {
    setEditError(null);
    try {
      const r = await authFetch(`/api/contexts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (!r.ok) { const p = await r.json().catch(() => ({})); throw new Error(p.error || `HTTP ${r.status}`); }
      await refreshAfterEdit();
    } catch (e) { setEditError(e.message || 'Rename failed'); }
  }

  // Create a new manual child under `parentId`, inheriting the parent's
  // targetType (required to sit in the same tree) and contextType.
  async function addChild(parentId, displayName) {
    setEditError(null);
    const parent = findNodeById(nodes, parentId) || selectedRoot;
    try {
      const r = await authFetch('/api/contexts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          targetType: parent?.targetType || selectedRoot?.targetType,
          contextType: parent?.contextType || selectedRoot?.contextType || 'Manual',
          parentContextId: parentId,
        }),
      });
      if (!r.ok) { const p = await r.json().catch(() => ({})); throw new Error(p.error || `HTTP ${r.status}`); }
      await refreshAfterEdit();
    } catch (e) { setEditError(e.message || 'Add child failed'); }
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
                onSyncTree={syncTree}
                syncing={syncing}
                syncMsg={syncMsg}
              />
              {editError && (
                <div className="mx-4 mt-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">
                  {editError}
                </div>
              )}
              {/* Only show the loading placeholder on the FIRST load (no nodes
                  yet). On a refetch after an edit we keep the tree mounted so it
                  doesn't unmount-and-remount — that would reset every node's
                  expand/collapse state and collapse the tree on each drag-drop. */}
              {subtreeLoading && nodes.length === 0 ? (
                <div className="p-4 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">Loading subtree…</div>
              ) : viewMode === 'tree' ? (
                <ContextTreeView
                  nodes={nodes}
                  onOpenDetail={open}
                  onReparent={reparent}
                  onRename={rename}
                  onAddChild={addChild}
                />
              ) : (
                <ContextListView nodes={nodes} onOpenDetail={open} />
              )}
            </>
          )}
        </div>
      </div>

      <NewContextWizard
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

// Find a node by id in the nested subtree (used to inherit targetType /
// contextType when adding a child to a deep node).
function findNodeById(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNodeById(n.children, id);
    if (hit) return hit;
  }
  return null;
}

function SelectedRootHeader({ root, viewMode, onChangeViewMode, onDeleteTree, deleteError, onSyncTree, syncing, syncMsg }) {
  const v = variantMeta(root.variant);
  const t = targetTypeMeta(root.targetType);
  const [confirming, setConfirming] = useState(false);
  // Synced trees come from a crawler — deleting them via the API would
  // let them re-appear on the next sync, so the API blocks it.
  const canDelete = root.variant !== 'synced';
  // Sync re-runs the generating plugin onto this tree, so only generated trees.
  const canSync = root.variant === 'generated';
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
          {canSync && (
            <button
              onClick={() => onSyncTree?.(root.id)}
              disabled={syncing}
              className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 disabled:opacity-50"
              title="Re-run the plugin to update memberships (e.g. manager changes) — your renames, moves and manual additions are kept"
            >
              <span className={syncing ? 'inline-block animate-spin' : ''} aria-hidden="true">↻</span>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          )}
          {syncMsg && <span className="text-[11px] text-green-700 dark:text-green-400">{syncMsg}</span>}
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

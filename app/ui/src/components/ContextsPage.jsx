// Contexts tab — two-pane layout: left selector + right tree/list view.
// See docs/architecture/context-redesign-ui.md for the design.

import { useMemo, useState } from 'react';
import { useContextRoots, useContextSubtree } from '../hooks/useContextTrees';
import ContextTreeSelector from './contexts/ContextTreeSelector';
import ContextTreeView from './contexts/ContextTreeView';
import ContextListView from './contexts/ContextListView';
import { variantMeta, targetTypeMeta } from '../utils/contextStyles';

export default function ContextsPage({ onOpenDetail }) {
  const { roots, loading: rootsLoading, error: rootsError, reload: reloadRoots } = useContextRoots();
  const [selectedRootId, setSelectedRootId] = useState(null);
  const [viewMode, setViewMode] = useState('tree');

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

  return (
    <div className="flex flex-col h-[calc(100vh-180px)] bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex flex-1 min-h-0">
        <div className="w-80 flex-shrink-0">
          <ContextTreeSelector
            roots={roots}
            selectedRootId={effectiveRootId}
            onSelectRoot={setSelectedRootId}
            loading={rootsLoading}
          />
        </div>

        <div className="flex-1 min-w-0 overflow-auto flex flex-col">
          {rootsError && (
            <div className="p-4 text-sm text-red-700 bg-red-50 border-b border-red-100">
              {rootsError}
            </div>
          )}

          {!selectedRoot && !rootsLoading && (
            <div className="flex-1 flex items-center justify-center p-8 text-sm text-gray-500">
              Select a tree on the left to view its contents.
            </div>
          )}

          {selectedRoot && (
            <>
              <SelectedRootHeader root={selectedRoot} viewMode={viewMode} onChangeViewMode={setViewMode} />
              {subtreeLoading ? (
                <div className="p-4 text-sm text-gray-500">Loading subtree…</div>
              ) : viewMode === 'tree' ? (
                <ContextTreeView nodes={nodes} onOpenDetail={open} />
              ) : (
                <ContextListView nodes={nodes} onOpenDetail={open} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SelectedRootHeader({ root, viewMode, onChangeViewMode }) {
  const v = variantMeta(root.variant);
  const t = targetTypeMeta(root.targetType);
  return (
    <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`w-1.5 h-6 ${v.dotClass} rounded`} aria-hidden="true" />
          <h2 className="text-base font-semibold text-gray-900 truncate">{root.displayName}</h2>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
          <span className={`inline-flex items-center gap-1 text-[10px] ${v.textClass}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${v.dotClass}`} />{v.label}
          </span>
          {root.scopeSystemName && (
            <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
              {root.scopeSystemName}
            </span>
          )}
          {root.ownerUserId && (
            <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200" title="Owner">
              Owner: {root.ownerUserId}
            </span>
          )}
        </div>
        {root.description && <p className="text-xs text-gray-500 mt-1 truncate">{root.description}</p>}
      </div>

      <div className="flex items-center gap-1 bg-gray-100 rounded p-0.5">
        <button
          onClick={() => onChangeViewMode('tree')}
          className={`px-2.5 py-1 text-xs rounded ${viewMode === 'tree' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-600'}`}
        >Tree</button>
        <button
          onClick={() => onChangeViewMode('list')}
          className={`px-2.5 py-1 text-xs rounded ${viewMode === 'list' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-600'}`}
        >List</button>
      </div>
    </div>
  );
}

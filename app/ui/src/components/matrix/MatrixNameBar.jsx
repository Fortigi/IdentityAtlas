// The document half of the strip above the matrix (#768 → #1202): which matrix
// this is, whether it has unsaved changes, and who it is shared with.
//
// "A matrix is a document": there is always a name on screen — the saved matrix
// on screen, or "Unsaved matrix". The name is also the menu that opens another
// one, starts a new one, or renames / duplicates / deletes this one. Saving and
// creating a share are not here any more: they happen in the wizard's last step,
// where the matrix is given its name. So the strip only STATES things, and each
// statement is the door to what it describes:
//
//   * "Unsaved changes" — only for a matrix loaded from a saved one that has
//     since been adjusted; it opens the wizard on its last (save/share) step. A
//     matrix that was never saved has no chip: its name already says so.
//   * "Shared with N ▾" — only for a shared saved matrix, and only for somebody
//     who may share; it opens the recipients panel.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanShareMatrix } from '@ui/hooks/useCanShareMatrix';
import { useDialog } from '@ui/components/dialogContext';
import SavedMatrixMenu from './SavedMatrixMenu';
import SaveMatrixDialog from './SaveMatrixDialog';
import MatrixHistoryDialog from './MatrixHistoryDialog';
import { useSavedMatrixNaming, namingCopy } from './useSavedMatrixNaming';
import { currentSavedMatrix, savedMatrixLoadArgs, sharedWithLabel } from './shareState';

// The last wizard step, where a matrix is saved and shared. The wizard slice
// renames the key; this is the one place the strip spells it.
export const SAVE_STEP = 'share';

// "Loading…" while the list is on its way, so a saved matrix doesn't flash up
// as "Unsaved matrix" first. (No chip needs the same guard: a matrix can only
// read as diverged from a saved matrix that is already in the list.)
function triggerLabelFor(loading, current) {
  if (loading) return 'Loading matrix…';
  return current?.name || 'Unsaved matrix';
}

function NamingDialog({ naming }) {
  const { state } = naming;
  const copy = namingCopy(state.mode, state.row);
  return (
    <SaveMatrixDialog
      title={copy.title}
      saveLabel={copy.saveLabel}
      notice={copy.notice}
      name={state.name}
      onNameChange={naming.setName}
      onSave={naming.submit}
      onClose={naming.close}
      saving={state.saving}
      error={state.error}
    />
  );
}

export default function MatrixNameBar({ filter, onLoad, onAdjust, onShare }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const canShare = useCanShareMatrix();

  const { data: savedFilters, loading, reload } = useFetch('/api/matrix/saved-filters', {
    authFetch,
    initialData: [],
    transform: rows => (Array.isArray(rows) ? rows : []),
  });

  // Re-fetched whenever a matrix is applied — that is when a save or share from
  // the wizard, or a load, may just have happened. Keyed on the filter OBJECT,
  // not its content: sharing an unchanged saved matrix applies an identical
  // filter, and the strip must still learn that it is now shared. Every apply
  // hands over a new object; re-renders keep the same one. Guarded so mounting
  // doesn't fetch the list twice.
  const lastFilter = useRef(filter);
  useEffect(() => {
    if (lastFilter.current === filter) return;
    lastFilter.current = filter;
    reload();
  }, [filter, reload]);

  // Always an array: `initialData` and `transform` see to it, and a failed read
  // keeps the last list.
  const rows = savedFilters;
  // Only the FIRST load holds the name back; a re-read keeps the list it had.
  const firstLoad = loading && rows.length === 0;
  const { current, diverged } = currentSavedMatrix(rows, filter);
  const naming = useSavedMatrixNaming({ authFetch, dialog, onDone: reload });
  // Which saved matrix's trail is open, if any — 'who changed this, and when'.
  const [historyOf, setHistoryOf] = useState(null);

  const load = useCallback((id) => {
    const row = rows.find(f => f.id === id);
    if (row && onLoad) onLoad(...savedMatrixLoadArgs(row));
  }, [onLoad, rows]);

  const remove = useCallback(async (id) => {
    await authFetch(`/api/matrix/saved-filters/${id}`, { method: 'DELETE' }).catch(() => {});
    reload();
  }, [authFetch, reload]);

  return (
    <>
      <SavedMatrixMenu
        savedFilters={rows}
        triggerLabel={triggerLabelFor(firstLoad, current)}
        currentId={current?.id ?? null}
        onLoad={load}
        onDelete={remove}
        onNew={() => onAdjust?.({ fresh: true })}
        onRename={naming.openRename}
        onDuplicate={naming.openDuplicate}
        onHistory={setHistoryOf}
      />

      {diverged && (
        <button
          type="button"
          onClick={() => onAdjust?.({ step: SAVE_STEP })}
          className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/50"
          title="This matrix differs from the saved one — open it to save the changes"
        >
          Unsaved changes
        </button>
      )}

      {/* Self-gating on the flag + `data.share`: no permission, no share
          affordance. An unshared matrix gets none here either — creating a share
          is the wizard's last step. */}
      {canShare && onShare && current?.shared && (
        <button
          type="button"
          onClick={() => onShare({ savedFilterId: current.id, savedName: current.name })}
          className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/40"
          title="See and change who this matrix is shared with"
        >
          {sharedWithLabel(current.recipientCount)} <span aria-hidden="true">▾</span>
        </button>
      )}

      {naming.state && <NamingDialog naming={naming} />}

      {historyOf && (
        <MatrixHistoryDialog
          savedFilterId={historyOf.id}
          savedName={historyOf.name}
          onClose={() => setHistoryOf(null)}
        />
      )}
    </>
  );
}

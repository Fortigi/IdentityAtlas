// The matrix's Load / Save / Share bar (#768 + #1202).
//
// Three things used to be hidden or scolding: loading a saved matrix lived
// inside the wizard, saving lived behind a wizard footer button, and a matrix
// that matched nothing wore an amber "Not saved" warning triangle. They are one
// visible row now — which saved matrix this is, whether it has unsaved changes,
// and who it is shared with — so "is this saved?" and "is this shared?" are
// answered without opening anything.
//
// Apply and Save stay deliberately separate verbs: Apply (the wizard) changes
// what is on screen, Save stores it for the org. Nothing here applies anything
// except Load, which is labelled as such.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanShareMatrix } from '@ui/hooks/useCanShareMatrix';
import { useDialog } from '@ui/components/dialogContext';
import SavedMatrixMenu from './SavedMatrixMenu';
import SaveMatrixDialog from './SaveMatrixDialog';
import { matchSavedMatrix, sharedWithLabel } from './shareState';

// The neutral replacement for the amber "Not saved" badge: a statement of fact
// next to the action that fixes it, not a warning about something being wrong.
function StateChip({ saved }) {
  if (saved) {
    return (
      <span
        className="inline-flex max-w-[28ch] items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
        title={saved.description || 'Saved org-wide matrix'}
      >
        <span className="truncate">{saved.name}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700 dark:border-gray-600 dark:bg-gray-700/40 dark:text-gray-300">
      Unsaved changes
    </span>
  );
}

export default function MatrixSaveBar({ filter, managed, onLoad, onShare }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const canShare = useCanShareMatrix();

  const { data: savedFilters, loading, reload } = useFetch('/api/matrix/saved-filters', {
    authFetch,
    initialData: [],
    transform: rows => (Array.isArray(rows) ? rows : []),
  });

  // Re-fetched whenever the applied filter changes — that is when a
  // save-from-the-wizard, or a load, may just have happened. Guarded on the
  // previous key so mounting doesn't fetch the list twice.
  const filterKey = filter ? JSON.stringify(filter) : '';
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    reload();
  }, [filterKey, reload]);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const saved = matchSavedMatrix(savedFilters, filter);

  const save = useCallback(async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const res = await authFetch('/api/matrix/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The governed toggle is part of what was saved, so it rides in the
        // filter — the same shape the wizard and the share API write.
        body: JSON.stringify({ name: saveName.trim(), filter: { ...filter, managed } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not save this matrix (HTTP ${res.status})`);
      setSaveOpen(false);
      setSaveName('');
      dialog.toast('Matrix saved', { variant: 'success' });
      reload();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }, [authFetch, dialog, filter, managed, reload, saveName]);

  const load = useCallback((id) => {
    const row = (savedFilters || []).find(f => f.id === id);
    if (!row || !onLoad) return;
    const { managed: savedManaged, ...rest } = row.filter || {};
    onLoad(rest, ['all', 'managed', 'unmanaged', 'gaps'].includes(savedManaged) ? savedManaged : 'all');
  }, [onLoad, savedFilters]);

  const remove = useCallback(async (id) => {
    await authFetch(`/api/matrix/saved-filters/${id}`, { method: 'DELETE' }).catch(() => {});
    reload();
  }, [authFetch, reload]);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800">
      <SavedMatrixMenu savedFilters={savedFilters || []} onLoad={load} onDelete={remove} />

      {loading ? (
        <span className="text-gray-600 dark:text-gray-400">…</span>
      ) : (
        <>
          <StateChip saved={saved} />
          {!saved && (
            <button
              type="button"
              onClick={() => { setSaveName(''); setSaveError(null); setSaveOpen(true); }}
              className="rounded border border-blue-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/30"
            >
              Save matrix…
            </button>
          )}
        </>
      )}

      {/* Self-gating on the flag + `data.share`: no permission, no share
          affordances — while the bar itself stays unflagged, because it replaces
          surfaces (#768) that were never behind a flag. */}
      {canShare && onShare && (
        <button
          type="button"
          onClick={() => onShare({ savedFilterId: saved?.id || null, savedName: saved?.name || null })}
          className={`ml-auto rounded border px-2 py-1 text-xs font-medium ${
            saved?.shared
              ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/40'
              : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50'
          }`}
          title={saved?.shared ? 'See and change who this matrix is shared with' : 'Share this matrix with named colleagues'}
        >
          {saved?.shared ? `${sharedWithLabel(saved.recipientCount)} ▾` : 'Share…'}
        </button>
      )}

      {saveOpen && (
        <SaveMatrixDialog
          name={saveName}
          onNameChange={setSaveName}
          onSave={save}
          onClose={() => { setSaveOpen(false); setSaveError(null); }}
          saving={saving}
          error={saveError}
        />
      )}

    </div>
  );
}

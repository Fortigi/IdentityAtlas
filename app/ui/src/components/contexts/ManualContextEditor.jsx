import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthGate';
import ContextPicker from './ContextPicker';

// ─── Manual-context inline editor ─────────────────────────────────────────────
// Rename, edit description, set parent (picker restricted to same targetType),
// set owner (text input — v6 has no analyst-account directory yet), and delete
// (with confirm). Only rendered by ContextDetailPage when variant === 'manual'.
//
// All backend rules (variant check, targetType invariants, cycle prevention)
// live in PATCH /api/contexts/:id — the UI just posts whatever the analyst
// set and surfaces the error if rejected.

export default function ManualContextEditor({ contextId, attrs, onUpdated, onDeleted }) {
  const { authFetch } = useAuth();

  const [displayName, setDisplayName] = useState(attrs.displayName || '');
  const [description, setDescription] = useState(attrs.description || '');
  const [ownerUserId, setOwnerUserId] = useState(attrs.ownerUserId || '');
  const [parentId, setParentId] = useState(attrs.parentContextId || '');
  const [parentLabel, setParentLabel] = useState(attrs.parentDisplayName || '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [excludeIds, setExcludeIds] = useState(() => new Set([contextId]));

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Reset when a different context opens in this tab.
  useEffect(() => {
    setDisplayName(attrs.displayName || '');
    setDescription(attrs.description || '');
    setOwnerUserId(attrs.ownerUserId || '');
    setParentId(attrs.parentContextId || '');
    setParentLabel(attrs.parentDisplayName || '');
    setError(null); setSaved(false);
  }, [attrs.id, attrs.displayName, attrs.description, attrs.ownerUserId, attrs.parentContextId, attrs.parentDisplayName]);

  // Compute the set of context ids that can NOT be picked as a parent:
  // self + self's descendants (would create a cycle). The picker fetches
  // its own tree, so we just give it the id list to filter out.
  const refreshExcludes = useCallback(async () => {
    try {
      const r = await authFetch('/api/contexts/tree');
      if (!r.ok) return;
      const roots = await r.json();
      const ids = new Set([contextId]);
      (function walk(nodes, inSubtree) {
        for (const n of nodes) {
          const isSelf = n.id === contextId;
          const inSub = inSubtree || isSelf;
          if (inSub) ids.add(n.id);
          if (n.children?.length) walk(n.children, inSub);
        }
      })(roots, false);
      setExcludeIds(ids);
    } catch { /* non-critical — picker still works without */ }
  }, [authFetch, contextId]);

  useEffect(() => { refreshExcludes(); }, [refreshExcludes]);

  const dirty = (
    displayName !== (attrs.displayName || '') ||
    description !== (attrs.description || '') ||
    ownerUserId !== (attrs.ownerUserId || '') ||
    (parentId || null) !== (attrs.parentContextId || null)
  );

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const body = {
        displayName: displayName.trim(),
        description: description.trim() || null,
        ownerUserId: ownerUserId.trim() || null,
        parentContextId: parentId || null,
      };
      const r = await authFetch(`/api/contexts/${contextId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
      onUpdated?.(payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    setDeleting(true); setError(null);
    try {
      const r = await authFetch(`/api/contexts/${contextId}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        const payload = await r.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${r.status}`);
      }
      onDeleted?.();
    } catch (err) {
      setError(err.message || 'Delete failed');
      setDeleting(false);
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-700 rounded-lg p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Edit manual context</h3>
        <span className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded px-1.5 py-0.5">
          Manual — analyst-owned
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Display name">
          <input
            value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Owner (user id or email)">
          <input
            value={ownerUserId} onChange={e => setOwnerUserId(e.target.value)}
            placeholder="(none)"
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Description" full>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            rows={2}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </Field>
        <Field
          label="Parent"
          full
          help={`Any ${attrs.targetType}-targeted context (manual, synced, or generated).`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex-1 text-left px-2 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 truncate"
              title="Open picker"
            >
              {parentId
                ? <span className="text-gray-900 dark:text-white">{parentLabel || parentId.slice(0, 8)}</span>
                : <span className="text-gray-400 dark:text-gray-500">(no parent — root)</span>}
            </button>
            {parentId && (
              <button
                type="button"
                onClick={() => { setParentId(''); setParentLabel(''); }}
                className="text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                title="Clear — make this a root context"
              >clear</button>
            )}
          </div>
        </Field>
      </div>

      {error && <div className="mt-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">{error}</div>}

      <div className="mt-4 flex items-center justify-between gap-2">
        <div>
          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-red-700 dark:text-red-400">Delete this context and all its members?</span>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="px-3 py-1 text-xs rounded bg-red-600 dark:bg-red-700 text-white disabled:opacity-50 hover:bg-red-700 dark:hover:bg-red-600"
              >
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="px-3 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300"
              >Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="text-[11px] text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
            >Delete context…</button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-[11px] text-green-700">Saved</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-3 py-1 text-xs rounded bg-blue-600 dark:bg-blue-700 text-white disabled:opacity-50 hover:bg-blue-700 dark:hover:bg-blue-600"
          >{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>

      <ContextPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(node) => {
          setParentId(node.id);
          setParentLabel(node.displayName);
        }}
        value={parentId || null}
        targetType={attrs.targetType}
        excludeIds={excludeIds}
        title="Pick a parent context"
        subtitle="Self and descendants are hidden so you can't create a cycle."
      />
    </div>
  );
}


function Field({ label, help, full, children }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
      {help && <p className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-0.5">{help}</p>}
    </div>
  );
}

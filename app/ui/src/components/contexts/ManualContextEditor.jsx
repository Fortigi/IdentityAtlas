import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthGate';

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
  const [candidates, setCandidates] = useState([]);

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
    setError(null); setSaved(false);
  }, [attrs.id, attrs.displayName, attrs.description, attrs.ownerUserId, attrs.parentContextId]);

  // Load parent candidates: roots + sub-contexts of the same target type,
  // excluding self (backend rejects cycles but we hide the obviously-wrong
  // options so the user isn't tempted).
  const loadCandidates = useCallback(async () => {
    try {
      const r = await authFetch(`/api/contexts?targetType=${encodeURIComponent(attrs.targetType)}`);
      if (r.ok) {
        const body = await r.json();
        setCandidates((body.data || []).filter(c => c.id !== contextId));
      }
    } catch { /* non-critical */ }
  }, [authFetch, attrs.targetType, contextId]);

  useEffect(() => { loadCandidates(); }, [loadCandidates]);

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
    <div className="bg-white border border-amber-200 rounded-lg p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">Edit manual context</h3>
        <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
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
        <Field label="Parent" full help={`Picker is limited to ${attrs.targetType} trees.`}>
          <select
            value={parentId || ''}
            onChange={e => setParentId(e.target.value || '')}
            className="w-full border rounded px-2 py-1 text-sm"
          >
            <option value="">(no parent — root)</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>
                {c.displayName} <span>({c.contextType})</span>
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error && <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>}

      <div className="mt-4 flex items-center justify-between gap-2">
        <div>
          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-red-700">Delete this context and all its members?</span>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="px-3 py-1 text-xs rounded bg-red-600 text-white disabled:opacity-50 hover:bg-red-700"
              >
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="px-3 py-1 text-xs rounded border border-gray-200 bg-white hover:bg-gray-50 text-gray-700"
              >Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="text-[11px] text-red-600 hover:text-red-700"
            >Delete context…</button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-[11px] text-green-700">Saved</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-3 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-700"
          >{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, help, full, children }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <label className="block text-xs font-medium text-gray-700">{label}</label>
      {children}
      {help && <p className="text-[11px] text-gray-500 mt-0.5">{help}</p>}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { ruleSourcePhrase } from '@ui/utils/contextStyles';
import ContextPicker from './ContextPicker';
import ContextCategorySelect from './ContextCategorySelect';
import { isContextDirty, normalizeContextFields } from './ManualContextEditor.helpers';

// ─── The edit form of a context (the body of ContextEditModal) ────────────────
// Name, description, template and parent (picker restricted to the same kind
// of member), then one Delete in the footer whose confirm says what deleting
// does. A derived context says up front which edits survive its rule's next
// refresh. The legacy owner column is not edited here: who answers for a unit
// is its Accountable, set in the facts card — one word per role.
//
// All backend rules (variant check, targetType invariants, cycle prevention)
// live in PATCH /api/contexts/:id — the UI just posts whatever was set and
// surfaces the error if rejected.

export default function ManualContextEditor({ contextId, attrs, onUpdated, onDeleted }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();

  const seed = normalizeContextFields(attrs);
  const [displayName, setDisplayName] = useState(seed.displayName);
  const [description, setDescription] = useState(seed.description);
  const [contextCategory, setContextCategory] = useState(seed.contextCategory);
  const [parentId, setParentId] = useState(seed.parentId);
  const [parentLabel, setParentLabel] = useState(seed.parentLabel);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [excludeIds, setExcludeIds] = useState(() => new Set([contextId]));

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Reset when a different context opens in this tab.
  useEffect(() => {
    setDisplayName(attrs.displayName || '');
    setDescription(attrs.description || '');
    setContextCategory(attrs.contextCategory || '');
    setParentId(attrs.parentContextId || '');
    setParentLabel(attrs.parentDisplayName || '');
    setError(null); setSaved(false);
  }, [attrs.id, attrs.displayName, attrs.description, attrs.contextCategory, attrs.parentContextId, attrs.parentDisplayName]);

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

  // The owner is not edited here; it is sent back as loaded.
  const dirty = isContextDirty(attrs, { displayName, description, ownerUserId: seed.ownerUserId, contextCategory, parentId });

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const body = {
        displayName: displayName.trim(),
        description: description.trim() || null,
        ownerUserId: seed.ownerUserId || null,
        contextCategory: contextCategory || null,
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
    const ok = await dialog.confirm({
      title: `Delete ${attrs.displayName || 'this unit'}?`,
      message: deleteConsequence(attrs),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
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
    <div>
      {attrs.variant === 'generated' && (
        <p data-testid="edit-note" className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          This unit is derived from {ruleSourcePhrase(attrs)}. A new name or parent you set here is kept when it refreshes.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" id="ctx-display-name">
          <input id="ctx-display-name" value={displayName} onChange={e => setDisplayName(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Template" help="An organisation unit or an application can name who answers for it.">
          <ContextCategorySelect value={contextCategory} onChange={setContextCategory} allowNone className={INPUT} />
        </Field>
        <Field label="Description" id="ctx-description" full>
          <textarea id="ctx-description" value={description} onChange={e => setDescription(e.target.value)} rows={2} className={INPUT} />
        </Field>
        <Field label="Parent" full>
          <ParentField
            parentId={parentId}
            parentLabel={parentLabel}
            onOpen={() => setPickerOpen(true)}
            onClear={() => { setParentId(''); setParentLabel(''); }}
          />
        </Field>
      </div>

      {error && <div role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">{error}</div>}

      <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between gap-2">
        <button type="button" onClick={doDelete} disabled={deleting}
          className="text-sm text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50">
          {deleting ? 'Deleting…' : 'Delete…'}
        </button>
        <SaveControl saved={saved} dirty={dirty} saving={saving} onSave={save} />
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
        title="Pick a parent"
        subtitle="This unit and the units under it are left out."
      />
    </div>
  );
}

const INPUT = 'w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 dark:text-gray-200';

// What a delete does, said in the confirm (and nowhere before it).
function deleteConsequence(attrs) {
  const base = 'This removes the unit, its sub-units and their member lists. It cannot be undone.';
  if (attrs.variant !== 'generated') return base;
  return `${base} Because it is derived from ${ruleSourcePhrase(attrs)}, the next refresh creates it again unless that rule changes.`;
}

function Field({ label, help, full, id, children }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
      {help && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{help}</p>}
    </div>
  );
}

// Parent picker trigger + clear button. Shows the picked label (or a truncated
// id) when set, otherwise "None (top level)".
function ParentField({ parentId, parentLabel, onOpen, onClear }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 text-left px-2 py-1 text-sm border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 truncate"
        title="Choose a parent"
      >
        {parentId
          ? <span className="text-gray-900 dark:text-white">{parentLabel || parentId.slice(0, 8)}</span>
          : <span className="text-gray-600 dark:text-gray-400">None (top level)</span>}
      </button>
      {parentId && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          title="Make this a top-level unit"
        >clear</button>
      )}
    </div>
  );
}

// Save button plus the transient "Saved" confirmation.
function SaveControl({ saved, dirty, saving, onSave }) {
  return (
    <div className="flex items-center gap-2">
      {saved && <span className="text-xs text-green-700 dark:text-green-300">Saved</span>}
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || saving}
        className="px-3 py-1 text-sm rounded bg-blue-600 dark:bg-blue-700 text-white disabled:opacity-50 hover:bg-blue-700 dark:hover:bg-blue-600"
      >{saving ? 'Saving…' : 'Save changes'}</button>
    </div>
  );
}

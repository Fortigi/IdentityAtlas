import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthGate';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';
import ContextPicker from '../contexts/ContextPicker';

// ─── Matrix context-filter chip widget ────────────────────────────────────────
// Small chip bar that displays active context filters and lets the analyst add
// new ones via the shared ContextPicker modal. Each chip has a × to remove and
// a checkbox to toggle "include descendants".
//
// The state is owned by the caller (MatrixView); this component is a
// controlled view: value = [{ id, includeChildren }], onChange emits a new
// array.

export default function ContextFilterControl({ value = [], onChange }) {
  const { authFetch } = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [contextsById, setContextsById] = useState(new Map());

  // Resolve labels for any chips we don't yet have. ContextPicker fetches
  // its own data on open, but the chips need labels from the moment a
  // bookmarked URL hydrates them.
  useEffect(() => {
    const missing = value.filter(v => !contextsById.has(v.id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const resolved = await Promise.all(missing.map(async v => {
        try {
          const r = await authFetch(`/api/contexts/${v.id}`);
          if (!r.ok) return null;
          const body = await r.json();
          return body?.attributes || null;
        } catch { return null; }
      }));
      if (cancelled) return;
      setContextsById(prev => {
        const next = new Map(prev);
        for (const row of resolved) { if (row) next.set(row.id, row); }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [value, contextsById, authFetch]);

  const selectedIds = useMemo(() => new Set(value.map(v => v.id)), [value]);

  function add(node) {
    if (selectedIds.has(node.id)) return;
    onChange([...value, { id: node.id, includeChildren: true }]);
    // Cache the picked node's label so the chip renders immediately
    // without a round-trip.
    setContextsById(prev => new Map(prev).set(node.id, node));
  }
  function remove(id) { onChange(value.filter(v => v.id !== id)); }
  function toggleChildren(id) {
    onChange(value.map(v => v.id === id ? { ...v, includeChildren: !v.includeChildren } : v));
  }

  return (
    <div className="inline-flex items-center gap-1 flex-wrap">
      <span className="text-xs text-gray-600 dark:text-gray-400 mr-1">Context:</span>

      {value.map(v => {
        const row = contextsById.get(v.id);
        const variant = row ? variantMeta(row.variant) : null;
        const target = row ? targetTypeMeta(row.targetType) : null;
        return (
          <span
            key={v.id}
            className="inline-flex items-center gap-1 text-[11px] bg-slate-50 dark:bg-gray-700/50 border border-slate-200 dark:border-gray-600 rounded px-1.5 py-0.5"
            title={row ? `${row.contextType} · ${row.targetType}${row.scopeSystemName ? ' · ' + row.scopeSystemName : ''}` : v.id}
          >
            {variant && <span className={`w-1.5 h-1.5 rounded-full ${variant.dotClass}`} aria-hidden="true" />}
            <span className="max-w-[14rem] truncate">{row ? row.displayName : v.id.slice(0, 8)}</span>
            {target && <span className={`text-[9px] px-1 rounded border ${target.badgeClass}`}>{target.label}</span>}
            <label className="inline-flex items-center gap-0.5 text-slate-500 dark:text-gray-400 cursor-pointer" title="Include descendants">
              <input
                type="checkbox"
                checked={v.includeChildren}
                onChange={() => toggleChildren(v.id)}
                className="w-3 h-3"
              />
              <span>+sub</span>
            </label>
            <button
              onClick={() => remove(v.id)}
              className="text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-300 ml-0.5"
              aria-label="Remove context filter"
            >×</button>
          </span>
        );
      })}

      <button
        onClick={() => setPickerOpen(true)}
        className="px-2 py-0.5 text-[11px] rounded border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
      >+ context</button>

      <ContextPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={add}
        excludeIds={selectedIds}
        title="Add context filter"
        subtitle="Pick any tree or sub-tree to constrain the matrix. Already-selected contexts are hidden."
      />
    </div>
  );
}

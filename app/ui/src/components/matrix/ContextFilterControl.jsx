import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthGate';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';

// ─── Matrix context-filter chip widget ────────────────────────────────────────
// Small chip bar that displays active context filters and lets the analyst add
// new ones via a popover picker. Each chip has a × to remove and a checkbox
// to toggle "include descendants".
//
// The state is owned by the caller (MatrixView); this component is a
// controlled view: value = [{ id, includeChildren }], onChange emits a new
// array.

export default function ContextFilterControl({ value = [], onChange }) {
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const [contextsById, setContextsById] = useState(new Map());
  const [allRoots, setAllRoots] = useState([]);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef(null);

  // Load roots once (for the picker); also resolve labels for any chips that
  // aren't in the root list (sub-contexts get labels via the same endpoint
  // when expanded).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch('/api/contexts');
        if (r.ok) {
          const body = await r.json();
          if (cancelled) return;
          const rows = body.data || [];
          setAllRoots(rows);
          const map = new Map(rows.map(c => [c.id, c]));
          setContextsById(map);
        }
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [authFetch]);

  // If the user bookmarked a filter that references a sub-context, fetch it
  // so the chip has a label. Only fires for ids we don't yet know.
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

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const selectedIds = useMemo(() => new Set(value.map(v => v.id)), [value]);

  const filteredRoots = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRoots;
    return allRoots.filter(r =>
      (r.displayName || '').toLowerCase().includes(q) ||
      (r.contextType || '').toLowerCase().includes(q)
    );
  }, [allRoots, search]);

  function add(id) {
    if (selectedIds.has(id)) return;
    onChange([...value, { id, includeChildren: true }]);
    setOpen(false);
    setSearch('');
  }
  function remove(id) { onChange(value.filter(v => v.id !== id)); }
  function toggleChildren(id) {
    onChange(value.map(v => v.id === id ? { ...v, includeChildren: !v.includeChildren } : v));
  }

  return (
    <div ref={wrapperRef} className="relative inline-flex items-center gap-1 flex-wrap">
      <span className="text-xs text-gray-600 mr-1">Context:</span>

      {value.map(v => {
        const row = contextsById.get(v.id);
        const variant = row ? variantMeta(row.variant) : null;
        const target = row ? targetTypeMeta(row.targetType) : null;
        return (
          <span
            key={v.id}
            className="inline-flex items-center gap-1 text-[11px] bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5"
            title={row ? `${row.contextType} · ${row.targetType}${row.scopeSystemName ? ' · ' + row.scopeSystemName : ''}` : v.id}
          >
            {variant && <span className={`w-1.5 h-1.5 rounded-full ${variant.dotClass}`} aria-hidden="true" />}
            <span className="max-w-[14rem] truncate">{row ? row.displayName : v.id.slice(0, 8)}</span>
            {target && <span className={`text-[9px] px-1 rounded border ${target.badgeClass}`}>{target.label}</span>}
            <label className="inline-flex items-center gap-0.5 text-slate-500 cursor-pointer" title="Include descendants">
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
              className="text-slate-500 hover:text-slate-700 ml-0.5"
              aria-label="Remove context filter"
            >×</button>
          </span>
        );
      })}

      <button
        onClick={() => setOpen(o => !o)}
        className="px-2 py-0.5 text-[11px] rounded border border-dashed border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700"
      >+ context</button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded shadow-lg z-30 w-80 max-h-80 overflow-auto">
          <div className="p-2 border-b border-gray-100">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search trees…"
              className="w-full text-xs border border-gray-200 rounded px-2 py-1"
            />
          </div>
          {filteredRoots.length === 0 ? (
            <div className="p-3 text-xs text-gray-500">No trees. Create one on the Contexts tab.</div>
          ) : (
            <ul>
              {filteredRoots.map(r => {
                const t = targetTypeMeta(r.targetType);
                const alreadyIn = selectedIds.has(r.id);
                return (
                  <li key={r.id}>
                    <button
                      disabled={alreadyIn}
                      onClick={() => add(r.id)}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-gray-50 ${alreadyIn ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <span className="truncate">{r.displayName}</span>
                      <span className={`text-[10px] px-1 rounded border ${t.badgeClass} ml-2`}>{t.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

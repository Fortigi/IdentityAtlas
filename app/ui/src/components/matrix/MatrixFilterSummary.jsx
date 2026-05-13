// Compact display of the currently-applied Matrix filter, shown above the
// matrix. Each condition is rendered as a small chip; an "Adjust filter"
// button re-opens the wizard.
//
// This component is read-only — it never mutates the filter. The wizard owns
// editing.

import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthGate';

export default function MatrixFilterSummary({ filter, preview, onAdjust }) {
  const { authFetch } = useAuth();
  const [contextNames, setContextNames] = useState(new Map());

  // Resolve display names for any context conditions in the filter.
  useEffect(() => {
    const ids = collectContextIds(filter);
    const missing = ids.filter(id => !contextNames.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map(id =>
      authFetch(`/api/contexts/${id}`)
        .then(r => r.ok ? r.json() : null)
        .then(body => body?.attributes ? { id, name: body.attributes.displayName } : null)
        .catch(() => null)
    )).then(results => {
      if (cancelled) return;
      setContextNames(prev => {
        const next = new Map(prev);
        for (const r of results) { if (r) next.set(r.id, r.name); }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [filter, contextNames, authFetch]);

  if (!filter) return null;

  const rowTypeLabel = filter.rowType === 'identity' ? 'Identity' : 'User';
  const subjectChips = collectChips(filter.subject, contextNames);
  const resourceChips = collectChips(filter.resource, contextNames);

  return (
    <div className="bg-blue-50/30 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">Rows</span>
        <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium">{rowTypeLabel} × Resource</span>
      </span>

      <Section label="Subjects" chips={subjectChips} preview={preview ? `${preview.subjectCount.toLocaleString()}/${preview.subjectTotal.toLocaleString()}` : null} />
      <Section label="Resources" chips={resourceChips} preview={preview ? `${preview.resourceCount.toLocaleString()}/${preview.resourceTotal.toLocaleString()}` : null} />

      {preview && (
        <span className="inline-flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">Cells</span>
          <span className="font-medium text-gray-800 dark:text-gray-200">{preview.assignmentCount.toLocaleString()}</span>
        </span>
      )}

      <button
        onClick={onAdjust}
        className="ml-auto px-2 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
      >
        Adjust filter
      </button>
    </div>
  );
}

function Section({ label, chips, preview }) {
  if (chips.length === 0 && !preview) return null;
  return (
    <span className="inline-flex items-center gap-1 flex-wrap max-w-[40%]">
      <span className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">{label}</span>
      {chips.length === 0
        ? <span className="text-gray-400 dark:text-gray-500 italic">all</span>
        : chips.map((c, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] ${
                c.side === 'exclude'
                  ? 'border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300'
                  : 'border-slate-200 dark:border-gray-600 bg-slate-50 dark:bg-gray-700/40 text-gray-700 dark:text-gray-300'
              }`}
              title={c.title}
            >
              {c.side === 'exclude' && <span className="text-[9px] font-bold">NOT</span>}
              <span className="truncate max-w-[14ch]">{c.label}</span>
            </span>
          ))
      }
      {preview && <span className="text-gray-500 dark:text-gray-400">({preview})</span>}
    </span>
  );
}

function collectChips(block, contextNames) {
  if (!block) return [];
  const out = [];
  for (const side of ['include', 'exclude']) {
    for (const c of (block[side] || [])) {
      if (c?.kind === 'context') {
        const name = contextNames.get(c.contextId) || c.contextId.slice(0, 8);
        out.push({
          side,
          label: name + (c.includeChildren ? ' +sub' : ''),
          title: `${side === 'exclude' ? 'NOT in' : 'In'} context "${name}"${c.includeChildren ? ' (incl. descendants)' : ''}`,
        });
      } else if (c?.kind === 'attribute') {
        const vals = (c.values || []).join(', ');
        out.push({
          side,
          label: `${c.field}: ${vals}`,
          title: `${side === 'exclude' ? 'NOT ' : ''}${c.field} in ${vals}`,
        });
      }
    }
  }
  return out;
}

function collectContextIds(filter) {
  const ids = new Set();
  for (const block of [filter?.subject, filter?.resource]) {
    if (!block) continue;
    for (const side of [block.include, block.exclude]) {
      for (const c of (side || [])) {
        if (c?.kind === 'context' && typeof c.contextId === 'string') ids.add(c.contextId);
      }
    }
  }
  return [...ids];
}

// Compact display of the currently-applied Matrix filter, shown above the
// matrix. Each condition is rendered as a small chip; an "Adjust filter"
// button re-opens the wizard.
//
// This component is read-only — it never mutates the filter. The wizard owns
// editing.

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { matrixFilterFingerprint } from '@ui/utils/matrixFilter';
import { collectChips, collectContextIds } from './MatrixFilterSummary.helpers';

export default function MatrixFilterSummary({ filter, preview, onAdjust }) {
  const { authFetch } = useAuth();
  const [contextNames, setContextNames] = useState(new Map());
  const [savedFilters, setSavedFilters] = useState(null);  // null = still loading

  // Fetch saved filters so we can label the current filter with its saved
  // name (or "Not saved" if no match). Refetched whenever the filter is
  // re-applied — that's when a save-from-wizard might have just happened.
  const filterKey = filter ? JSON.stringify(filter) : '';
  useEffect(() => {
    let cancelled = false;
    authFetch('/api/matrix/saved-filters')
      .then(r => r.ok ? r.json() : [])
      .then(rows => { if (!cancelled) setSavedFilters(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setSavedFilters([]); });
    return () => { cancelled = true; };
  }, [authFetch, filterKey]);

  // Match the current filter against the saved ones. Compared by fingerprint,
  // not raw JSON, so a saved matrix keeps its badge after being adjusted (or
  // folded/drilled) without actually being changed — see utils/matrixFilter.js.
  const savedMatch = useMemo(() => {
    if (!savedFilters || !filter) return null;
    const fingerprint = matrixFilterFingerprint(filter);
    return savedFilters.find(s => matrixFilterFingerprint(s.filter) === fingerprint) || null;
  }, [savedFilters, filter]);

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
      <SavedBadge savedMatch={savedMatch} loading={savedFilters === null} />

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
        Adjust matrix
      </button>
    </div>
  );
}

function SavedBadge({ savedMatch, loading }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 text-gray-600 dark:text-gray-400 text-[11px]">
        …
      </span>
    );
  }
  if (savedMatch) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium"
        title={savedMatch.description || `Saved org-wide matrix`}
      >
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
        </svg>
        <span className="truncate max-w-[20ch]">{savedMatch.name}</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-[11px] font-medium"
      title="This matrix doesn't match any saved one. Use the wizard to save it."
    >
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
      </svg>
      Not saved
    </span>
  );
}

function Section({ label, chips, preview }) {
  if (chips.length === 0 && !preview) return null;
  return (
    <span className="inline-flex items-center gap-1 flex-wrap max-w-[40%]">
      <span className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">{label}</span>
      {chips.length === 0
        ? <span className="text-gray-600 dark:text-gray-400 italic">all</span>
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

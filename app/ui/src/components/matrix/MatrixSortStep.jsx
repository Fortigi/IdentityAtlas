// The Matrix wizard's "Sort" step — column order, plus the two options that
// decide how the matrix OPENS: folded into count columns, and whether the scope
// statistics (trends & breakdown) panel comes with it.
//
// Extracted from MatrixFilterWizard.jsx, which is over the file-size ceiling and
// may only shrink.

import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { attributeLabel } from '@ui/utils/formatters';
import { DEFAULT_SORT } from '@ui/utils/matrixFilter';
import { FOLD_AUTO_THRESHOLD } from './MatrixFilterWizard.helpers';

// Pull selectable attribute names out of a /matrix/columns response. Excludes
// the display-name column (every value is unique, useless to group/sort by).
function attributeOptions(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map(c => c.column)
    .filter(Boolean)
    .filter(name => name !== 'displayName');
}

export default function MatrixSortStep({
  sortAttributes, columns, disabled, onChange,
  foldOnLoad = 'auto', onFoldChange, assignmentCount = 0,
  sortHierarchy, onHierarchyChange,
  showTrends = false, onShowTrendsChange,
}) {
  const { authFetch } = useAuth();
  // Any attribute can be sorted on, including ext.* extended attributes — the
  // matrix payload now carries extendedAttributes for the column sort.
  const options = attributeOptions(columns);
  const rows = sortAttributes.length ? sortAttributes : DEFAULT_SORT;
  const autoFold = assignmentCount >= FOLD_AUTO_THRESHOLD;
  const foldChecked = foldOnLoad === 'auto' ? autoFold : !!foldOnLoad;
  const isHierarchy = !!sortHierarchy; // an object (even with empty contextId) = hierarchy mode

  // Manager-Hierarchy roots to sort by.
  const [ctxRoots, setCtxRoots] = useState(null);
  useEffect(() => {
    if (!isHierarchy || ctxRoots !== null) return;
    let cancelled = false;
    authFetch('/api/contexts?contextType=ManagerHierarchy')
      .then(r => r.ok ? r.json() : { data: [] })
      .then(body => { if (!cancelled) setCtxRoots(Array.isArray(body.data) ? body.data : []); })
      .catch(() => { if (!cancelled) setCtxRoots([]); });
    return () => { cancelled = true; };
  }, [isHierarchy, ctxRoots, authFetch]);

  // Default to the first hierarchy once the list loads.
  useEffect(() => {
    if (isHierarchy && !sortHierarchy.contextId && Array.isArray(ctxRoots) && ctxRoots.length) {
      onHierarchyChange?.({ contextId: ctxRoots[0].id });
    }
  }, [isHierarchy, sortHierarchy, ctxRoots, onHierarchyChange]);

  const update = (i, patch) => onChange(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => {
    const used = new Set(rows.map(r => r.attribute));
    const next = options.find(o => !used.has(o)) || options[0];
    if (next) onChange([...rows, { attribute: next, dir: 'asc' }]);
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Sort columns</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Order the columns by attributes, or by the Manager Hierarchy tree. The chosen levels appear as
          grouped header rows — click a header value to fold that group into a single count column.
        </p>
      </div>

      {/* Mode: attributes vs Manager Hierarchy */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onHierarchyChange?.(null)}
          className={`text-xs px-2 py-1 rounded border ${!isHierarchy ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}
        >By attributes</button>
        <button
          type="button"
          onClick={() => onHierarchyChange?.({ contextId: '' })}
          className={`text-xs px-2 py-1 rounded border ${isHierarchy ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}
        >By Manager Hierarchy</button>
      </div>

      {isHierarchy ? (
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Hierarchy</label>
          {ctxRoots === null ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">Loading hierarchies…</p>
          ) : ctxRoots.length === 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">No Manager Hierarchy context found — run the manager-hierarchy plugin first.</p>
          ) : (
            <select
              value={sortHierarchy.contextId || ''}
              onChange={e => onHierarchyChange?.({ contextId: e.target.value })}
              className="w-full max-w-md border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
            >
              <option value="">Select a hierarchy…</option>
              {ctxRoots.map(c => <option key={c.id} value={c.id}>{c.displayName} ({c.totalMemberCount})</option>)}
            </select>
          )}
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Columns are sorted by each subject's place in the org tree. Start folded at the top level, then
            unfold a group to reveal the next level — down to individual people.
          </p>
        </div>
      ) : disabled ? (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic">
          Sorting doesn’t apply in roll-up mode — columns are the roll-up groups, ordered alphabetically.
        </p>
      ) : (
        <>
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 dark:text-gray-400 w-12">{i === 0 ? 'Sort by' : 'then by'}</span>
              <select
                value={r.attribute}
                onChange={e => update(i, { attribute: e.target.value })}
                className="flex-1 max-w-xs border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
              >
                {/* Option TEXT is the display name; option VALUE stays the stored
                    key (`ext.extension_<appId>_sfTeamID`) so the sort still
                    addresses the real attribute — labels only, never keys (#872). */}
                {!options.includes(r.attribute) && <option value={r.attribute}>{attributeLabel(r.attribute) || r.attribute}</option>}
                {options.map(o => <option key={o} value={o}>{attributeLabel(o) || o}</option>)}
              </select>
              <button
                type="button"
                onClick={() => update(i, { dir: r.dir === 'asc' ? 'desc' : 'asc' })}
                className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                title="Toggle ascending / descending"
              >{r.dir === 'asc' ? 'A→Z' : 'Z→A'}</button>
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded shrink-0"
                  title="Remove"
                >×</button>
              )}
            </div>
          ))}
          {rows.length < 6 && options.length > rows.length && (
            <button type="button" onClick={add} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
              + Add attribute
            </button>
          )}
        </>
      )}

      {/* How the matrix opens. Both are properties of the matrix, so they are
          saved and shared with it. */}
      <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 space-y-2">
        {!disabled && !isHierarchy && (
          <OpenWithToggle checked={foldChecked} onChange={(v) => onFoldChange?.(v)}>
            Open with the first group folded into count columns
            {foldOnLoad === 'auto' && (
              <span className="text-gray-500 dark:text-gray-400"> — auto ({autoFold ? 'on' : 'off'}: {assignmentCount.toLocaleString()} assignments, folds at {FOLD_AUTO_THRESHOLD.toLocaleString()}+ to keep rendering fast)</span>
            )}
          </OpenWithToggle>
        )}

        {/* #1202: the scope-statistics panel used to sit above every matrix,
            pushing the grid down. It is reporting tooling — opt in per matrix. */}
        <OpenWithToggle checked={!!showTrends} onChange={(v) => onShowTrendsChange?.(v)}>
          Show trends &amp; breakdown above the matrix
          <span className="block text-gray-500 dark:text-gray-400">
            Adds the scope-statistics panel: subject / resource / assignment totals, the governed split,
            and — on expand — the history of each and a per-department breakdown. Off by default, so the
            matrix starts at the top of the page.
          </span>
        </OpenWithToggle>
      </div>
    </div>
  );
}

// One "how this matrix opens" checkbox: a real <label>, so the box is reachable
// by the text next to it.
function OpenWithToggle({ checked, onChange, children }) {
  return (
    <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

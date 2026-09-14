// The Matrix wizard's "Group & sort columns" section (Layout step, #1202) —
// column order, plus whether the matrix OPENS with its first group folded into
// count columns. The trends & breakdown toggle moved to the Layout step's
// "Open with" section.
//
// Extracted from MatrixFilterWizard.jsx, which is over the file-size ceiling and
// may only shrink.

import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { attributeLabel } from '@ui/utils/formatters';
import { FOLD_AUTO_THRESHOLD } from './MatrixFilterWizard.helpers';
import {
  attributeOptions, sortRows, autoFolds, foldOnLoadChecked,
  canAddSortRow, addSortRow, updateSortRow, removeSortRow, toggleDir,
} from './sortStepState';

export default function MatrixSortStep({
  sortAttributes, columns, onChange,
  foldOnLoad = 'auto', onFoldChange, assignmentCount = 0,
  sortHierarchy, onHierarchyChange,
}) {
  const { authFetch } = useAuth();
  // Any attribute can be sorted on, including ext.* extended attributes — the
  // matrix payload now carries extendedAttributes for the column sort.
  const options = attributeOptions(columns);
  const rows = sortRows(sortAttributes);
  const autoFold = autoFolds(assignmentCount);
  const foldChecked = foldOnLoadChecked(foldOnLoad, assignmentCount);
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

  const update = (i, patch) => onChange(updateSortRow(rows, i, patch));
  const remove = (i) => onChange(removeSortRow(rows, i));
  const add = () => onChange(addSortRow(rows, options));

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Group &amp; sort columns</h3>
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
                onClick={() => update(i, { dir: toggleDir(r.dir) })}
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
          {canAddSortRow(rows, options) && (
            <button type="button" onClick={add} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
              + Add attribute
            </button>
          )}
        </>
      )}

      {/* Whether the matrix opens folded is a property of the matrix, so it is
          saved and shared with it. A hierarchy sort opens at its top level instead. */}
      {!isHierarchy && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          <OpenWithToggle checked={foldChecked} onChange={(v) => onFoldChange?.(v)}>
            Open with the first group folded into count columns
            {foldOnLoad === 'auto' && (
              <span className="text-gray-500 dark:text-gray-400"> — auto ({autoFold ? 'on' : 'off'}: {assignmentCount.toLocaleString()} assignments, folds at {FOLD_AUTO_THRESHOLD.toLocaleString()}+ to keep rendering fast)</span>
            )}
          </OpenWithToggle>
        </div>
      )}
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

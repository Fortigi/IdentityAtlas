// "+ Attribute" dialog used by the matrix wizard's Subject and Resource steps:
// pick a field, then tick the values to filter on.
//
// The value list the API preloads with /matrix/columns is capped at one page
// per column (500 values by default, see MATRIX_VALUE_PAGE_SIZE) — a real
// tenant has far more distinct `description`s than that. The API serves the
// alphabetically first page and flags the column `truncated`; this dialog
// therefore always offers a search box, and for a truncated column it asks the
// server (/matrix/column-values) for matches beyond the preloaded page, so
// every stored value stays reachable (#928).

import { useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import { useFetch } from '@ui/hooks/useFetch';
import { attributeLabel } from '@ui/utils/formatters';

// Columns that are never useful as a filter field: opaque identifiers nobody
// filters by hand. `displayName` deliberately stays available — picking the
// specific subjects or resources you mean by name is a core role-mining ask
// (#927). It is excluded from the wizard's Sort / roll-up options instead (see
// attributeOptions() in MatrixFilterWizard), where a near-unique value has
// nothing to group by.
const HIDDEN_COLUMNS = ['id', 'principalId', 'resourceId', 'identityId'];

export default function AttributePicker({ entity, columns, onPick, onClose }) {
  const { authFetch } = useAuth();
  const [field, setField] = useState('');
  const [selectedValues, setSelectedValues] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  // Filter columns to ones with at least one distinct value AND a sensible
  // type (we hide UUID/ID-like columns since they're not useful filters).
  const filterable = useMemo(() => {
    if (!Array.isArray(columns)) return [];
    return columns
      .filter(c => !HIDDEN_COLUMNS.includes(c.column))
      .filter(c => Array.isArray(c.values));
  }, [columns]);

  const selectedColumn = filterable.find(c => c.column === field);
  const preloaded = useMemo(() => selectedColumn?.values || [], [selectedColumn]);
  const truncated = !!selectedColumn?.truncated;

  // Ask the server for values outside the preloaded page — only for a truncated
  // column, where the local list is provably incomplete.
  const searchUrl = field && truncated && debouncedSearch
    ? `/api/matrix/column-values?entity=${encodeURIComponent(entity)}`
      + `&column=${encodeURIComponent(field)}&q=${encodeURIComponent(debouncedSearch)}`
    : null;
  const { data: searchResult, loading: searching } = useFetch(searchUrl, { authFetch });
  // The response echoes the column it searched, so a result still in flight from
  // the previously selected field is never rendered against the new one.
  const remoteValues = useMemo(() => (
    searchUrl && searchResult?.column === field && Array.isArray(searchResult.values)
      ? searchResult.values
      : []
  ), [searchUrl, searchResult, field]);

  // What the list shows: the preloaded page narrowed by the search term, plus
  // any server-found matches, plus anything already ticked (so a selection made
  // before typing never silently disappears).
  const valueOptions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const local = needle
      ? preloaded.filter(v => String(v).toLowerCase().includes(needle))
      : preloaded;
    const merged = [...local];
    for (const v of remoteValues) if (!merged.includes(v)) merged.push(v);
    for (const v of selectedValues) if (!merged.includes(v)) merged.push(v);
    return merged.sort((a, b) => String(a).localeCompare(String(b)));
  }, [preloaded, remoteValues, selectedValues, search]);

  const toggleValue = (v) => {
    setSelectedValues(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  };

  const pickField = (name) => {
    setField(name);
    setSelectedValues([]);
    setSearch('');
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 dark:bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-4 w-[480px] max-w-full max-h-[80vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Add attribute filter</h3>

        <label htmlFor="attr-picker-field" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">Field</label>
        <select
          id="attr-picker-field"
          value={field}
          onChange={e => pickField(e.target.value)}
          className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 mb-3"
        >
          <option value="">— select a field —</option>
          {filterable.map(c => (
            <option key={c.column} value={c.column}>
              {/* Name shown, key sent: the option value stays the stored column so
                  the filter still addresses the real attribute (#872). */}
              {c.label || attributeLabel(c.column) || c.column} ({c.values.length}{c.truncated ? '+' : ''})
            </option>
          ))}
        </select>

        {field && (
          <>
            <label htmlFor="attr-picker-search" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">
              Search values
            </label>
            <input
              id="attr-picker-search"
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Type to narrow the list…"
              className="w-full px-2 py-1 mb-2 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 dark:placeholder-gray-500"
            />
            {truncated && (
              <p className="text-[10px] text-gray-600 dark:text-gray-400 mb-2">
                Showing the first {preloaded.length} values of more than can be listed — search to find any of the others.
              </p>
            )}

            <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">
              Values <span className="text-gray-600 dark:text-gray-500">(any of these match — OR)</span>
            </label>
            <div className="border border-gray-200 dark:border-gray-700 rounded max-h-48 overflow-y-auto">
              {valueOptions.length === 0 ? (
                <p className="text-[11px] text-gray-600 dark:text-gray-500 italic px-2 py-1">
                  {searching ? 'Searching…' : 'No values available'}
                </p>
              ) : (
                valueOptions.map(v => (
                  <label key={v} className="flex items-center gap-1.5 px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/30 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedValues.includes(v)}
                      onChange={() => toggleValue(v)}
                      className="w-3 h-3"
                    />
                    <span className="text-gray-800 dark:text-gray-200 truncate">{v}</span>
                  </label>
                ))
              )}
            </div>
            <p className="text-[10px] text-gray-600 dark:text-gray-500 mt-1">{selectedValues.length} selected</p>
          </>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton onClick={() => onPick(field, selectedValues)} disabled={!field || selectedValues.length === 0}>
            Add
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

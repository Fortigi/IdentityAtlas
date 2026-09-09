// Controlled multi-select for picking people out of the directory (#1166).
//
// Search + chips, the same shape as ContextFilterControl's context chips, but
// over `/api/users` instead of the context tree. Deliberately generic — it
// owns no submit and knows nothing about shares — so the next "pick some
// people" surface uses this rather than growing a third typeahead.
//
// A person is selectable only if they have a sign-in name (UPN / e-mail):
// that string is the key any downstream match is made on, and a row without
// one could never be matched to a signed-in user. Such rows are shown, and
// disabled with the reason, rather than silently filtered away — otherwise a
// search for a colleague you can see in the app returns "no matches" with no
// explanation.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';

const RESULT_LIMIT = 10;

// The picker's value shape, from a /api/users row. `userKey` is the sign-in
// name; `principalId` keeps the directory id so a later rename still resolves.
export function toPerson(row) {
  return {
    principalId: row.id || null,
    userKey: row.userPrincipalName || row.email || '',
    displayName: row.displayName || row.userPrincipalName || row.email || '',
  };
}

export default function PeoplePicker({ value = [], onChange, label = 'Search people', help, inputId = 'people-picker' }) {
  const { authFetch } = useAuth();
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);
  // Value-set only; a reducer dispatch keeps the search effect clear of
  // react-hooks/set-state-in-effect.
  const [results, setResults] = useReducer((_, v) => v, []);
  const [loading, setLoading] = useReducer((_, v) => v, false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const selectedKeys = useMemo(() => new Set(value.map(p => p.userKey)), [value]);

  useEffect(() => {
    if (!debounced.trim()) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/users?search=${encodeURIComponent(debounced.trim())}&limit=${RESULT_LIMIT}`)
      .then(r => (r.ok ? r.json() : { data: [] }))
      .then(body => { if (!cancelled) setResults(Array.isArray(body?.data) ? body.data : []); })
      .catch(() => { if (!cancelled) setResults([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authFetch, debounced]);

  // Clicking outside closes the result list without clearing the selection.
  useEffect(() => {
    const onClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function add(row) {
    const person = toPerson(row);
    if (!person.userKey || selectedKeys.has(person.userKey)) return;
    onChange([...value, person]);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  function remove(userKey) {
    onChange(value.filter(p => p.userKey !== userKey));
  }

  return (
    <div ref={boxRef} className="relative">
      <label htmlFor={inputId} className="block text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      <input
        id={inputId}
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search by name or e-mail…"
        className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
      />
      {help && <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{help}</p>}

      {open && (loading || results.length > 0 || debounced.trim()) && (
        <div
          role="group"
          aria-label="Search results"
          className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-auto rounded border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {loading && <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">Searching…</p>}
          {!loading && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">No people match “{debounced.trim()}”.</p>
          )}
          {!loading && results.map(row => {
            const person = toPerson(row);
            const already = selectedKeys.has(person.userKey);
            const unusable = !person.userKey;
            return (
              <button
                key={row.id}
                type="button"
                disabled={already || unusable}
                onClick={() => add(row)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:opacity-50 dark:hover:bg-gray-700/50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-gray-900 dark:text-gray-100">{row.displayName || person.userKey}</span>
                  <span className="block truncate text-[11px] text-gray-600 dark:text-gray-400">{person.userKey || 'no sign-in name'}</span>
                </span>
                <span className="shrink-0 text-[11px] text-gray-600 dark:text-gray-400">
                  {unusable ? 'cannot sign in' : already ? 'already added' : 'add'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {value.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Selected people">
          {value.map(p => (
            <li
              key={p.userKey}
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300"
            >
              <span className="max-w-[16rem] truncate" title={p.userKey}>{p.displayName || p.userKey}</span>
              <button
                type="button"
                onClick={() => remove(p.userKey)}
                aria-label={`Remove ${p.displayName || p.userKey}`}
                className="text-blue-700 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

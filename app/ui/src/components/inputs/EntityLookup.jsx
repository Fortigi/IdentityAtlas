// Type-ahead picker for a parameter that means AN ENTITY.
//
// Generic on both sides: the options come from a named lookup source
// (`/api/lookups/<source>`, see app/api/src/lookups/), already normalised to
// value / label / hint, so this control knows nothing about logical
// applications, systems or business roles. A second entity-shaped parameter is
// a source on the server and an `x-lookup` annotation on the schema — no change
// here.
//
// What it stores is the **id**, never the label. That is the whole point: a
// name can match several entities and a report parameterised by a typed name
// silently runs over all of them. Picking from the list pins one.
//
// It is NOT a merge of PeoplePicker. That one's value is a list of objects
// keyed on a person's sign-in name, because a share recipient is matched on
// that string rather than on a directory id — a genuinely different contract
// from "a list of entity ids", and folding them together would produce a
// component whose value is sometimes strings and sometimes objects.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';

const RESULT_LIMIT = 20;
const DEBOUNCE_MS = 250;

/** `{ value: label }` for everything the control has ever been told about. */
function rememberLabels(known, options) {
  const next = { ...known };
  for (const option of options) if (option?.value) next[option.value] = option.label || option.value;
  return next;
}

/**
 * Options whose labels collide inside ONE result list, with the head of their
 * id appended to the hint. A catalogue with three applications under one name
 * is exactly the case this control exists for, so it must not offer three rows
 * a person cannot tell apart.
 */
export function disambiguate(options) {
  const seen = new Map();
  for (const option of options) seen.set(option.label, (seen.get(option.label) || 0) + 1);
  return options.map(option => (seen.get(option.label) > 1
    ? { ...option, hint: [option.hint, `id ${String(option.value).slice(0, 8)}`].filter(Boolean).join(' · ') }
    : option));
}

// `label` is optional because a caller may already own it: SchemaConfigForm
// draws `<label htmlFor={id}>` from the schema, and a second one here would
// give the field two accessible names.
export default function EntityLookup({
  source, value = [], onChange, label, help, inputId = 'entity-lookup', placeholder = 'Start typing…',
}) {
  const { authFetch } = useAuth();
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, DEBOUNCE_MS);
  const term = debounced.trim();

  // Results carry the term they were fetched for. Without that, the render
  // between the debounce settling and the request starting has an empty list
  // and a false loading flag, and the dropdown says "nothing matches" about a
  // term it has not looked up yet.
  const [found, setFound] = useReducer((_, v) => v, { term: null, options: [] });
  const [labels, setLabels] = useReducer(rememberLabels, {});
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const settled = found.term === term;
  const selected = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/lookups/${encodeURIComponent(source)}?q=${encodeURIComponent(term)}&limit=${RESULT_LIMIT}`)
      .then(r => (r.ok ? r.json() : { q: term, data: [] }))
      .then(body => {
        // The server echoes the term it searched; a reply for an older term is
        // discarded rather than drawn over the current one.
        if (cancelled || body?.q !== term) return;
        const options = Array.isArray(body?.data) ? body.data : [];
        setFound({ term, options });
        setLabels(options);
      })
      .catch(() => { if (!cancelled) setFound({ term, options: [] }); });
    return () => { cancelled = true; };
  }, [authFetch, source, term]);

  // Ids that arrived without a label — a bookmarked report, or a link someone
  // was sent — are resolved so the chips read as names rather than uuids.
  const unresolved = value.filter(v => !labels[v]).join(',');
  useEffect(() => {
    if (!unresolved) return undefined;
    let cancelled = false;
    authFetch(`/api/lookups/${encodeURIComponent(source)}?ids=${encodeURIComponent(unresolved)}`)
      .then(r => (r.ok ? r.json() : { data: [] }))
      .then(body => { if (!cancelled) setLabels(Array.isArray(body?.data) ? body.data : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authFetch, source, unresolved]);

  useEffect(() => {
    const onClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function add(option) {
    if (selected.has(option.value)) return;
    setLabels([option]);
    onChange([...value, option.value]);
    setQuery('');
    setOpen(false);
  }

  const options = useMemo(() => disambiguate(found.options), [found.options]);

  return (
    <div ref={boxRef} className="relative">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      )}
      {help && <p className="text-[11px] text-gray-500 dark:text-gray-400">{help}</p>}
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${inputId}-results`}
        autoComplete="off"
        value={query}
        placeholder={placeholder}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
      />

      {open && (
        <div
          id={`${inputId}-results`}
          role="listbox"
          aria-label="Matching entries"
          className="absolute left-0 right-0 z-20 mt-1 max-h-60 overflow-auto rounded border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {!settled && <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">Searching…</p>}
          {settled && options.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              {term ? `Nothing matches “${term}”.` : 'Nothing to pick here yet.'}
            </p>
          )}
          {settled && options.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected.has(option.value)}
              disabled={selected.has(option.value)}
              onClick={() => add(option)}
              className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:opacity-50 dark:hover:bg-gray-700/50"
            >
              <span className="min-w-0">
                <span className="block truncate text-gray-900 dark:text-gray-100">{option.label}</span>
                {option.hint && (
                  <span className="block truncate text-[11px] text-gray-600 dark:text-gray-400">{option.hint}</span>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-gray-600 dark:text-gray-400">
                {selected.has(option.value) ? 'selected' : 'add'}
              </span>
            </button>
          ))}
        </div>
      )}

      {value.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Selected entries">
          {value.map(id => (
            <li
              key={id}
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300"
            >
              <span className="max-w-[18rem] truncate" title={id}>{labels[id] || id}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter(v => v !== id))}
                aria-label={`Remove ${labels[id] || id}`}
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

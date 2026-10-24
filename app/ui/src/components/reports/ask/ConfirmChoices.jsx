// PROTOTYPE — "did you mean …?" for a named object the lookup could not match exactly.
//
// Shown by the assistant and by the builder's preview. Picking a choice (or typing
// the exact name) is applied by POST /api/nl-reports/resolve — no model round-trip.

import { useState } from 'react';

const CHOICE = 'rounded border border-gray-300 bg-white px-3 py-1.5 text-left text-sm text-gray-800 hover:border-blue-400 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

function humanType(type) {
  return type ? type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : '';
}

/**
 * A name from the question the report does not use ("ACME"): which field it should
 * match, or leave it out. Nothing is typed here — the choices are the fields the
 * name was actually found in.
 * @param {object} props.confirm  { kind: 'term', name, message, drop, choices: [{ name, fields }] }
 */
function TermChoices({ confirm, onChoose, busy }) {
  const base = { kind: 'term', path: [], term: confirm.name, drop: confirm.drop };
  return (
    <div className="space-y-2">
      <p>{confirm.message}</p>
      <div className="flex flex-wrap items-center gap-2">
        {confirm.choices.map(c => (
          <button key={c.name} type="button" className={CHOICE} disabled={busy}
            onClick={() => onChoose({ ...base, name: c.name, fields: c.fields })}>
            <span className="font-medium">{c.name}</span>
          </button>
        ))}
        <button type="button" className="text-xs text-blue-700 hover:underline dark:text-blue-300" disabled={busy}
          onClick={() => onChoose({ ...base, name: `Leave “${confirm.name}” out`, skip: true })}>
          Leave “{confirm.name}” out
        </button>
      </div>
    </div>
  );
}

/**
 * @param {object}   props.confirm   { kind, path, name, message, choices: [{ id, name, type, score? }] }
 *                                   (kind 'person': the last choice is { name, keep: true })
 *                                   or a term confirmation (see TermChoices)
 * @param {Function} props.onChoose  ({ path, name, id?, keep? }) => void
 */
export default function ConfirmChoices({ confirm, onChoose, busy }) {
  if (confirm.kind === 'term') return <TermChoices confirm={confirm} onChoose={onChoose} busy={busy} />;
  return <NameChoices confirm={confirm} onChoose={onChoose} busy={busy} />;
}

function NameChoices({ confirm, onChoose, busy }) {
  const [typed, setTyped] = useState('');
  const choose = (patch) => onChoose({ path: confirm.path, ...patch });
  // A person picked for a "contains" is pinned by id, like a reference; a
  // "name is X" answer is the name itself. "Everyone with X in the name" is
  // offered as the keep-as-written link, not as one more person.
  const records = confirm.choices.filter(c => !c.keep);
  const everyone = confirm.choices.find(c => c.keep);
  const keepLabel = everyone ? everyone.name : `Keep “${confirm.name}” as written`;

  return (
    <div className="space-y-2">
      <p>{confirm.message}</p>
      {records.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {records.map(c => (
            <button key={c.id} type="button" className={CHOICE} disabled={busy}
              onClick={() => choose({ name: c.name, id: confirm.kind === 'value' ? undefined : c.id })}>
              <span className="font-medium">{c.name}</span>
              {c.type && <span className="ml-1.5 text-xs text-gray-600 dark:text-gray-400">{humanType(c.type)}</span>}
            </button>
          ))}
        </div>
      )}
      <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); if (typed.trim()) choose({ name: typed }); }}>
        <label htmlFor={`confirm-${confirm.path.join('-')}`} className="text-xs text-gray-700 dark:text-gray-300">
          {records.length ? 'None of these — exact name:' : 'Exact name:'}
        </label>
        <input id={`confirm-${confirm.path.join('-')}`} value={typed} onChange={e => setTyped(e.target.value)} disabled={busy}
          className="w-64 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
        <button type="submit" className={CHOICE} disabled={busy || !typed.trim()}>Use this name</button>
        {confirm.kind !== 'reference' && (
          <button type="button" className="text-xs text-blue-700 hover:underline dark:text-blue-300" disabled={busy}
            onClick={() => choose({ name: confirm.name, keep: true })}>
            {keepLabel}
          </button>
        )}
      </form>
    </div>
  );
}

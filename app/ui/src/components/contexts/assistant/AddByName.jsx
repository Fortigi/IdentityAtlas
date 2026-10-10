// Context builder — find something by name and put it in by hand: a resource the terms do
// not find, or (for a users recipe) one user. Both use the assistant's lookup; `kind`
// picks what it searches, and a resource lookup is sent without it, as it always was.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { MUTED, SECONDARY } from '@ui/components/reports/ask/AskAssistant.styles';
import { lookupUrl } from './recipeDraft';

/**
 * @param {object}   props
 * @param {string}   props.inputId
 * @param {string}   props.label        accessible name of the search box
 * @param {string}   props.placeholder
 * @param {string}   [props.kind]       lookup kind ('principal'); absent = resources
 * @param {Function} [props.accept]     (found) → offer it? Defaults to everything
 * @param {string[]} props.included     ids already put in by hand
 * @param {Function} props.onInclude    (id)
 */
export default function AddByName({ inputId, label, placeholder, kind, accept = () => true, included, onInclude }) {
  const { authFetch } = useAuth();
  const [text, setText] = useState('');
  const [found, setFound] = useState(null);

  const search = async (e) => {
    e.preventDefault();
    const res = await authFetch(lookupUrl(text, kind));
    const body = await res.json().catch(() => ({}));
    setFound(res.ok ? (body.data || []).filter(accept) : []);
  };

  return (
    <div className="space-y-1">
      <form onSubmit={search} className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">{label}</label>
        <input id={inputId} value={text} onChange={e => setText(e.target.value)} placeholder={placeholder}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
        <button type="submit" className={SECONDARY} disabled={text.trim().length < 2}>Find</button>
      </form>
      {found && found.length === 0 && <p className={MUTED}>Nothing found.</p>}
      {found?.map(f => (
        <div key={f.id} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <span>{f.name || f.displayName}</span><span className={MUTED}>{[f.type, f.upn].filter(Boolean).join(' · ')}</span>
          {included.includes(f.id)
            ? <span className={MUTED}>included</span>
            : <button type="button" className="text-xs font-medium text-blue-700 dark:text-blue-300" onClick={() => onInclude(f.id)}>Include</button>}
        </div>
      ))}
    </div>
  );
}

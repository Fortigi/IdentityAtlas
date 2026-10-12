// "Choose another…": search the objects a mention of this type could be
// (GET /knowledge/search?type=&q=, at least two characters) and pick one.
// Props: { type, label, onChoose(candidate), onCancel() }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { buildQuery, targetTypeLabel } from '@ui/components/orgtruth/orgFormat';
import { INPUT, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE } from './knowledgeFormat';

export default function ChooseObject({ type, label, onChoose, onCancel }) {
  const { authFetch } = useAuth();
  const [q, setQ] = useState(label ?? '');
  const term = useDebouncedValue(q.trim(), 300);
  const enabled = term.length >= 2;
  const state = useFetch(`${API}${KNOWLEDGE}/search${buildQuery({ type, q: term })}`, { authFetch, enabled });
  const found = enabled ? (state.data?.candidates ?? []) : [];

  return (
    <div className="mt-2 space-y-2 rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-center gap-2">
        <input className={INPUT} aria-label={`Search for another object for ${label}`} value={q} onChange={e => setQ(e.target.value)} />
        <button type="button" className={SMALL_BUTTON} onClick={onCancel}>Close</button>
      </div>
      {enabled && !state.loading && found.length === 0 && <p className="text-xs text-gray-600 dark:text-gray-400">Nothing found.</p>}
      {state.error && <p className="text-xs text-red-700 dark:text-red-300">Search failed: {state.error.message}</p>}
      <ul className="space-y-1">
        {found.map(c => (
          <li key={`${c.targetType}:${c.targetId}`} className="flex items-center justify-between gap-2 text-sm text-gray-700 dark:text-gray-300">
            <span>{c.label} <span className="text-xs text-gray-600 dark:text-gray-400">{targetTypeLabel(c.targetType)} · {c.confidence}%</span></span>
            <button type="button" className={SMALL_BUTTON} onClick={() => onChoose(c)}>Choose {c.label}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Context builder — the objects the terms find: exclude one, include one a term does not
// find, and see why each is there.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { MUTED, SECONDARY } from '@ui/components/reports/ask/AskAssistant.styles';
import { rowAction } from './recipeDraft';

const MAX_ROWS = 300;

const VIEWS = [
  { key: 'in', label: 'In the context', statuses: ['member', 'included'] },
  { key: 'excluded', label: 'Excluded', statuses: ['excluded'] },
  { key: 'candidate', label: 'Found only by dropped terms', statuses: ['candidate'] },
];

const STATUS_BADGE = {
  included: { text: 'added by hand', cls: 'bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  excluded: { text: 'excluded', cls: 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
};

function HitChips({ hits, fieldLabels }) {
  return hits.map(h => (
    <span key={h.term} title={`in ${h.fields.map(f => fieldLabels[f] || f).join(', ')}`}
      className={`mr-1 inline-block rounded px-1.5 py-0.5 text-[11px] ${h.accepted ? 'bg-sky-50 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}`}>
      {h.term}{h.fields.includes('displayName') ? '' : ` (${(fieldLabels[h.fields[0]] || h.fields[0]).toLowerCase()})`}
    </span>
  ));
}

function MatchRow({ m, fieldLabels, onChoose, onOpen }) {
  const action = rowAction(m.status);
  const badge = STATUS_BADGE[m.status];
  return (
    <tr className="align-top">
      <td className="px-3 py-1.5">
        <button type="button" className="text-left text-sm font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={() => onOpen(m)}>{m.displayName}</button>
        {badge && <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${badge.cls}`}>{badge.text}</span>}
        {m.description && <div className="max-w-xl truncate text-xs text-gray-500 dark:text-gray-400" title={m.description}>{m.description}</div>}
      </td>
      <td className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400">{m.resourceType}{m.systemName ? ` · ${m.systemName}` : ''}</td>
      <td className="px-3 py-1.5"><HitChips hits={m.hits} fieldLabels={fieldLabels} /></td>
      <td className="px-3 py-1.5 text-right">
        <button type="button" className="text-xs font-medium text-gray-700 hover:text-blue-700 dark:text-gray-300" onClick={() => onChoose(m.id, action.choice)}>{action.label}</button>
      </td>
    </tr>
  );
}

function AddByName({ include, resourceTypes, onChoose }) {
  const { authFetch } = useAuth();
  const [text, setText] = useState('');
  const [found, setFound] = useState(null);

  const search = async (e) => {
    e.preventDefault();
    const res = await authFetch(`/api/context-assistant/lookup?q=${encodeURIComponent(text.trim())}`);
    const body = await res.json().catch(() => ({}));
    // Only kinds of object the context searches: anything else would never show up in it.
    setFound(res.ok ? (body.data || []).filter(f => resourceTypes.includes(f.type)) : []);
  };

  return (
    <div className="space-y-1">
      <form onSubmit={search} className="flex flex-wrap items-center gap-2">
        <label htmlFor="ctx-add-object" className="sr-only">Find an object to include by hand</label>
        <input id="ctx-add-object" value={text} onChange={e => setText(e.target.value)} placeholder="Include by name…"
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
        <button type="submit" className={SECONDARY} disabled={text.trim().length < 2}>Find</button>
      </form>
      {found && found.length === 0 && <p className={MUTED}>Nothing found.</p>}
      {found?.map(f => (
        <div key={f.id} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <span>{f.name}</span><span className={MUTED}>{f.type}</span>
          {include.includes(f.id)
            ? <span className={MUTED}>included</span>
            : <button type="button" className="text-xs font-medium text-blue-700 dark:text-blue-300" onClick={() => onChoose(f.id, 'include')}>Include</button>}
        </div>
      ))}
    </div>
  );
}

/**
 * @param {object}   props
 * @param {object}   [props.evaluation]  the evaluate answer
 * @param {object}   props.recipe
 * @param {object}   props.fieldLabels
 * @param {Function} props.onChoose      (id, 'include'|'exclude'|'auto')
 * @param {Function} props.onOpenDetail
 */
export default function MatchesPanel({ evaluation, recipe, fieldLabels, onChoose, onOpenDetail }) {
  const [view, setView] = useState('in');
  const matches = evaluation?.matches || [];
  const counts = Object.fromEntries(VIEWS.map(v => [v.key, matches.filter(m => v.statuses.includes(m.status)).length]));
  const shown = matches.filter(m => VIEWS.find(v => v.key === view).statuses.includes(m.status));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist">
        {VIEWS.map(v => (
          <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${view === v.key ? 'bg-blue-600 text-white dark:bg-blue-700' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
            {v.label} ({counts[v.key]})
          </button>
        ))}
        {evaluation && <span className={MUTED}>of {evaluation.scopeTotal} {recipe.resourceTypes.join(' / ').toLowerCase()} objects in scope</span>}
      </div>
      {evaluation?.truncated && <p className="text-xs text-amber-700 dark:text-amber-300">More objects matched than can be shown; narrow the terms.</p>}
      {shown.length === 0 ? (
        <p className={MUTED}>Nothing here.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-100 text-sm dark:divide-gray-700">
            <thead className="bg-gray-50 text-left text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              <tr><th className="px-3 py-1.5">Name</th><th className="px-3 py-1.5">Type</th><th className="px-3 py-1.5">Found by</th><th className="px-3 py-1.5" /></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {shown.slice(0, MAX_ROWS).map(m => (
                <MatchRow key={m.id} m={m} fieldLabels={fieldLabels} onChoose={onChoose}
                  onOpen={row => onOpenDetail?.('resource', row.id, row.displayName)} />
              ))}
            </tbody>
          </table>
          {shown.length > MAX_ROWS && <p className={`px-3 py-2 ${MUTED}`}>Showing the first {MAX_ROWS} of {shown.length}.</p>}
        </div>
      )}
      <AddByName include={recipe.include} resourceTypes={recipe.resourceTypes} onChoose={onChoose} />
    </div>
  );
}

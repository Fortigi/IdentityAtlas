// Organisation → Signals: what imported activity (timesheets, logs) says about
// one collection type — four lists of findings (signals.js FINDING_KINDS),
// each row linking to the entity and, where one is named, the person — and the
// settings that decide them (SignalsSettings).
//
// GET /api/org-truth/model gives the collection types; GET /signals?type=
// the findings; a 404/501 renders "not available yet".
//
// Props: { onOpenDetail }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { Section } from '@ui/components/DetailSection';
import EmptyState from '@ui/components/EmptyState';
import { buildQuery, fetchBlocked } from './orgFormat';
import { SIGNALS_URL, FINDING_KINDS, collectionTypes, findingsOf, findingRows, asOfText } from './signals';
import SignalsSettings from './SignalsSettings';
import { FetchState, INPUT, LINK_BUTTON } from './orgUi';

function RefButton({ target, onOpenDetail }) {
  if (!target?.id || !target.kind) return <span>{target?.label}</span>;
  return (
    <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.(target.kind, target.id, target.label)}>
      {target.label}
    </button>
  );
}

function FindingList({ kind, rows, onOpenDetail }) {
  const items = findingRows(kind.key, rows);
  return (
    <section aria-label={kind.title}>
      <Section title={kind.title} count={items.length}>
        <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">{kind.hint}</p>
        {items.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">None.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
            {items.map(r => (
              <li key={r.key} className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-sm text-gray-700 dark:text-gray-300">
                <RefButton target={r.entity} onOpenDetail={onOpenDetail} />
                {r.person && <><span aria-hidden="true">·</span><RefButton target={r.person} onOpenDetail={onOpenDetail} /></>}
                <span className="text-xs text-gray-600 dark:text-gray-400">{r.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </section>
  );
}

function Findings({ type, onOpenDetail }) {
  const { authFetch } = useAuth();
  const state = useFetch(`${SIGNALS_URL}${buildQuery({ type })}`, { authFetch });
  if (fetchBlocked(state)) return <FetchState state={state} what="Signals" />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">{asOfText(state.data)}</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {FINDING_KINDS.map(k => <FindingList key={k.key} kind={k} rows={findingsOf(state.data, k.key)} onOpenDetail={onOpenDetail} />)}
      </div>
    </div>
  );
}

export default function SignalsTab({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const model = useFetch('/api/org-truth/model?withSystemCounts=0', { authFetch });
  const [picked, setPicked] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  if (fetchBlocked(model)) return <FetchState state={model} what="Signals" />;
  const types = collectionTypes(model.data);
  if (types.length === 0) {
    return <EmptyState title="No collections yet" hint="Signals compare a collection (customers, projects) with the activity imported against it. Import both to see them." />;
  }
  const type = types.includes(picked) ? picked : types[0];

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        Collection type
        <select className={INPUT} value={type} onChange={e => setPicked(e.target.value)}>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <SignalsSettings key={type} type={type} model={model.data} onSaved={() => setReloadKey(k => k + 1)} />
      <Findings key={`${type}-${reloadKey}`} type={type} onOpenDetail={onOpenDetail} />
    </div>
  );
}

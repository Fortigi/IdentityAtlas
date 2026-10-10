// "+ Organisation" dialog of the matrix wizard's Subjects and Resources steps
// (T8): filter the matrix on organisation entities directly, without a Context
// in between. Pick a kind of entity, then narrow it by an attribute value
// and/or by hand-picked entities, and choose which links count.
//
// Reads GET /api/org-truth/model (the kinds), GET /api/org-truth/filter-options
// (attributes, values and link names of one kind) and GET /api/org-truth/entities
// (the search for hand-picking). Every decision about the condition it builds is
// buildOrgCondition() in ./orgCondition.js.

import { useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import { useFetch } from '@ui/hooks/useFetch';
import { buildQuery, rowsOf } from './orgFormat';
import { buildOrgCondition, selectsEveryEntity, viasForSide } from './orgCondition';

const LABEL = 'block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1';
const INPUT = 'w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 dark:placeholder-gray-500';
const LIST = 'border border-gray-200 dark:border-gray-700 rounded max-h-40 overflow-y-auto';
const ROW = 'flex items-center gap-1.5 px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/30 text-xs cursor-pointer';
const HINT = 'text-[10px] text-gray-600 dark:text-gray-400';
const SEARCH_PAGE = 20;

function toggle(list, item) {
  return list.includes(item) ? list.filter(x => x !== item) : [...list, item];
}

function CheckRow({ checked, onChange, children }) {
  return (
    <label className={ROW}>
      <input type="checkbox" checked={checked} onChange={onChange} className="w-3 h-3" />
      <span className="text-gray-800 dark:text-gray-200 truncate">{children}</span>
    </label>
  );
}

// A value typed by hand, for an attribute whose values are too many to list.
function FreeValueInput({ attrKey, onAdd }) {
  const [text, setText] = useState('');
  const add = () => { if (text.trim()) onAdd(text.trim()); setText(''); };
  return (
    <div className="flex gap-1">
      <input
        type="text" value={text} aria-label={`Value of ${attrKey}`}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        placeholder="Type a value and press Enter" className={INPUT}
      />
      <SecondaryButton onClick={add} disabled={!text.trim()}>Add value</SecondaryButton>
    </div>
  );
}

function AttributeSection({ attributes, attrKey, values, onKey, onValues }) {
  const meta = attributes.find(a => a.key === attrKey);
  const listed = (meta?.values || []).map(v => v.value);
  const extra = values.filter(v => !listed.includes(v));
  return (
    <div>
      <label htmlFor="org-cond-attr" className={LABEL}>Attribute <span className="font-normal">(optional)</span></label>
      <select id="org-cond-attr" value={attrKey} onChange={e => onKey(e.target.value)} className={INPUT}>
        <option value="">— any —</option>
        {attributes.map(a => <option key={a.key} value={a.key}>{a.key}</option>)}
      </select>
      {meta && (
        <div className="mt-2 space-y-1">
          <p className={HINT}>Values (any of these match — OR)</p>
          {meta.free && <FreeValueInput attrKey={meta.key} onAdd={v => onValues(values.includes(v) ? values : [...values, v])} />}
          {(listed.length > 0 || extra.length > 0) && (
            <div className={LIST}>
              {(meta.values || []).map(v => (
                <CheckRow key={v.value} checked={values.includes(v.value)} onChange={() => onValues(toggle(values, v.value))}>
                  {v.value} <span className="text-gray-600 dark:text-gray-400">({v.count})</span>
                </CheckRow>
              ))}
              {extra.map(v => (
                <CheckRow key={v} checked onChange={() => onValues(toggle(values, v))}>{v}</CheckRow>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PickSection({ entityType, picked, onPicked }) {
  const { authFetch } = useAuth();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const url = q ? `/api/org-truth/entities${buildQuery({ type: entityType, q, pageSize: SEARCH_PAGE })}` : null;
  const { data, loading } = useFetch(url, { authFetch });
  const results = url ? rowsOf(data) : [];
  const pickedIds = picked.map(p => p.id);
  const flip = (e) => onPicked(pickedIds.includes(e.id)
    ? picked.filter(p => p.id !== e.id)
    : [...picked, { id: e.id, label: e.displayName || e.id }]);
  return (
    <div>
      <label htmlFor="org-cond-search" className={LABEL}>Pick entities <span className="font-normal">(optional)</span></label>
      <input id="org-cond-search" type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder={`Search ${entityType}…`} className={INPUT} />
      {url && (
        <div className={`${LIST} mt-1`}>
          {results.length === 0
            ? <p className={`${HINT} italic px-2 py-1`}>{loading ? 'Searching…' : 'No match'}</p>
            : results.map(e => (
              <CheckRow key={e.id} checked={pickedIds.includes(e.id)} onChange={() => flip(e)}>{e.displayName || e.id}</CheckRow>
            ))}
        </div>
      )}
      {picked.length > 0 && (
        <ul aria-label="Picked entities" className="flex flex-wrap gap-1 mt-1">
          {picked.map(p => (
            <li key={p.id} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
              {p.label}
              <button type="button" aria-label={`Remove ${p.label}`} onClick={() => flip(p)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ViaSection({ vias, unchecked, onUnchecked }) {
  if (vias.length === 0) return null;
  return (
    <fieldset>
      <legend className={LABEL}>Linked through</legend>
      <div className={LIST}>
        {vias.map(v => (
          <CheckRow key={v.name} checked={!unchecked.includes(v.name)} onChange={() => onUnchecked(toggle(unchecked, v.name))}>
            {v.name} <span className="text-gray-600 dark:text-gray-400">({v.kind === 'through' ? 'through rows' : 'direct'}, {v.links} links)</span>
          </CheckRow>
        ))}
      </div>
    </fieldset>
  );
}

function OrgTypeBody({ entityType, options, vias, draft, setDraft }) {
  const attributes = options.data?.attributes || [];
  const patch = (p) => setDraft(d => ({ ...d, ...p }));
  if (options.error) return <p role="alert" className="text-xs text-red-700 dark:text-red-300">Could not load the options of {entityType}: {options.error.message}</p>;
  if (options.loading && !options.data) return <p className={HINT}>Loading…</p>;
  return (
    <>
      <AttributeSection attributes={attributes} attrKey={draft.attributeKey} values={draft.attributeValues}
        onKey={k => patch({ attributeKey: k, attributeValues: [] })} onValues={v => patch({ attributeValues: v })} />
      <PickSection entityType={entityType} picked={draft.picked} onPicked={p => patch({ picked: p })} />
      <ViaSection vias={vias} unchecked={draft.uncheckedVias} onUnchecked={u => patch({ uncheckedVias: u })} />
    </>
  );
}

const EMPTY_DRAFT = { entityType: '', attributeKey: '', attributeValues: [], picked: [], uncheckedVias: [] };

export default function OrgConditionPicker({ entity, onPick, onClose }) {
  const { authFetch } = useAuth();
  const model = useFetch('/api/org-truth/model?withSystemCounts=0', { authFetch });
  const types = (model.data?.entityTypes || []).map(t => t.type).filter(Boolean);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const options = useFetch(draft.entityType ? `/api/org-truth/filter-options${buildQuery({ type: draft.entityType })}` : null, { authFetch });
  const vias = useMemo(() => viasForSide(options.data?.vias, entity), [options.data, entity]);
  const { condition, problem } = buildOrgCondition(draft, vias);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 dark:bg-black/70" onClick={onClose}>
      <div
        role="dialog" aria-label="Add organisation filter"
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-4 w-[480px] max-w-full max-h-[80vh] overflow-auto space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Add organisation filter</h3>
        <div>
          <label htmlFor="org-cond-type" className={LABEL}>Kind of entity</label>
          <select id="org-cond-type" value={draft.entityType}
            onChange={e => setDraft({ ...EMPTY_DRAFT, entityType: e.target.value })} className={INPUT}>
            <option value="">— select —</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {draft.entityType && <OrgTypeBody entityType={draft.entityType} options={options} vias={vias} draft={draft} setDraft={setDraft} />}
        {condition && selectsEveryEntity(condition) && (
          <p className={HINT}>No attribute or entity picked: every {condition.entityType} counts.</p>
        )}
        {problem && draft.entityType && <p className={HINT}>{problem}</p>}
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton onClick={() => onPick(condition)} disabled={!condition}>Add</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

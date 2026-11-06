import { useState } from 'react';
import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { ROLE_KINDS, JOINER_POLICIES, LEAVER_POLICIES, ruleSentence, usesOrgKnowledge } from './workbench.rule';

// ─── How a proposed role is assigned ─────────────────────────────────────
// Every new role first asks its kind (two cards): rule-based — assigned
// automatically, members follow the assignment rule, with what happens to joiners
// and leavers — or requestable — people request it and an approver decides, with
// an optional rule for who may request it. The rule is the workbench's own filters
// ("Use the current filters"), shown as one sentence. A rule on activity, expertise
// or duty rests on knowledge the IGA system does not hold: noted, not blocked.

const FIELD = 'rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';
const LINK = 'text-xs text-blue-700 hover:underline dark:text-blue-300';
const BTN = 'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700';

export function KindPicker({ onPick, suggested }) {
  return (
    <div role="group" aria-label="How is this role assigned?" className="space-y-2">
      <p className="text-xs font-semibold text-gray-800 dark:text-gray-100">How is this role assigned?</p>
      {ROLE_KINDS.map(k => (
        <button key={k.key} type="button" onClick={() => onPick(k.key)}
          className="block w-full rounded-lg border border-gray-300 p-2 text-left hover:border-blue-500 hover:bg-blue-50 dark:border-gray-600 dark:hover:border-blue-400 dark:hover:bg-blue-900/30">
          <span className="block text-sm font-semibold text-gray-900 dark:text-white">{k.title}{suggested === k.key ? ' · as the source does today' : ''}</span>
          <span className="block text-xs text-gray-700 dark:text-gray-300">{k.help}</span>
        </button>
      ))}
    </div>
  );
}

function Radios({ legend, name, options, value, onChange }) {
  return (
    <fieldset className="text-xs">
      <legend className="font-medium text-gray-800 dark:text-gray-200">{legend}</legend>
      <div className="mt-0.5 flex flex-wrap gap-x-3">
        {options.map(o => (
          <label key={o.key} className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
            <input type="radio" name={name} checked={value === o.key} onChange={() => onChange(o.key)} className="h-3 w-3" />{o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Approver({ approver, accountable, onChange }) {
  const [searching, setSearching] = useState(false);
  const value = approver?.kind ?? '';
  const choose = (kind) => { if (kind === 'person') setSearching(true); else onChange(kind ? { kind } : null); };
  return (
    <div className="text-xs">
      <label className="flex flex-wrap items-center gap-1 font-medium text-gray-800 dark:text-gray-200">
        Approved by
        <select value={value} onChange={e => choose(e.target.value)} aria-label="Approved by" className={FIELD}>
          <option value="">— choose —</option>
          <option value="accountable">The unit&apos;s Accountable{accountable ? ` (${accountable})` : ''}</option>
          <option value="owner">The role&apos;s owner</option>
          <option value="person">{approver?.kind === 'person' ? approver.name : 'A named person…'}</option>
        </select>
      </label>
      {searching && (
        <div className="mt-1">
          <PersonSearch inputId="workbench-approver" label="Find the approver" onPick={(p) => { onChange({ kind: 'person', principalId: p.id, name: p.displayName }); setSearching(false); }} />
        </div>
      )}
    </div>
  );
}

function RuleControls({ candidate, dispatch, onUseAsRule, requestable }) {
  const rule = candidate.rule;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={rule.includeChildren} onChange={e => dispatch({ type: 'setRule', rule: { ...rule, includeChildren: e.target.checked } })} className="h-3 w-3" />
        Include sub-units
      </label>
      <button type="button" onClick={onUseAsRule} className={LINK}>Replace with the current filters</button>
      <button type="button" onClick={() => (requestable ? dispatch({ type: 'setRule', rule: null }) : dispatch({ type: 'clearRule', members: candidate.members }))} className={LINK}>
        {requestable ? 'Anyone may request it' : `Drop the rule (keep these ${candidate.members.size} as chosen by hand)`}
      </button>
    </div>
  );
}

export default function RoleRuleEditor({ candidate, dispatch, unitName, accountable, people, peopleByKey, onUseAsRule }) {
  const kind = ROLE_KINDS.find(k => k.key === candidate.kind);
  const rule = candidate.rule;
  const requestable = candidate.kind === 'requestable';
  const sentence = ruleSentence(candidate, unitName, people, accountable);
  const name = (k) => peopleByKey.get(k)?.displayName ?? k;
  return (
    <section aria-label="Assignment rule" className="space-y-2 rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">Assignment rule</span>
        <span className="rounded bg-gray-100 px-1.5 text-[11px] text-gray-800 dark:bg-gray-700 dark:text-gray-100" title={`Assignment origin: ${kind.origin}`}>{kind.title}</span>
        <button type="button" onClick={() => dispatch({ type: 'setKind', kind: null })} className={LINK}>Change</button>
      </div>
      {sentence && <p className="text-xs text-gray-900 dark:text-gray-100" data-testid="rule-sentence">{sentence}</p>}
      {!rule && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
          <span>{requestable ? 'Anyone may request it.' : 'Members chosen by hand — no rule yet.'}</span>
          <button type="button" onClick={onUseAsRule} className={BTN}>{requestable ? 'Use the current filters for who may request it' : 'Use the current filters as the assignment rule'}</button>
        </div>
      )}
      {rule && <RuleControls candidate={candidate} dispatch={dispatch} onUseAsRule={onUseAsRule} requestable={requestable} />}
      {rule && !requestable && (
        <p className="text-xs text-gray-700 dark:text-gray-300">
          Matches now: <span className="font-semibold">{candidate.members.size}</span> · the rule would also apply to people who join the unit later.
        </p>
      )}
      {rule && usesOrgKnowledge(rule) && (
        <p role="note" className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
          This rule uses organisational knowledge (activity, expertise or duty) the IGA system doesn&apos;t hold; it can&apos;t be enforced automatically there.
        </p>
      )}
      {rule && !requestable && (
        <Exceptions include={[...candidate.handMembers]} exclude={[...(candidate.excluded || [])]} name={name}
          onUninclude={(k) => dispatch({ type: 'uninclude', person: k })} onUnexclude={(k) => dispatch({ type: 'unexclude', person: k })} />
      )}
      {requestable
        ? <Approver approver={candidate.approver} accountable={accountable} onChange={(v) => dispatch({ type: 'edit', field: 'approver', value: v })} />
        : <Radios legend="When someone starts matching" name={`joiner-${candidate.id}`} options={JOINER_POLICIES} value={candidate.joinerPolicy} onChange={(v) => dispatch({ type: 'edit', field: 'joinerPolicy', value: v })} />}
      <Radios legend={requestable ? 'When a holder leaves the unit' : 'When someone stops matching'} name={`leaver-${candidate.id}`} options={LEAVER_POLICIES}
        value={candidate.leaverPolicy} onChange={(v) => dispatch({ type: 'edit', field: 'leaverPolicy', value: v })} />
      <label className="block text-xs">
        <span className="font-medium text-gray-800 dark:text-gray-200">Why this role</span>
        <textarea value={candidate.rationale} onChange={e => dispatch({ type: 'edit', field: 'rationale', value: e.target.value })} rows={2}
          placeholder="e.g. Every property handler needs the claims suite to do the job" aria-label="Why this role"
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
      </label>
    </section>
  );
}

function Exceptions({ include, exclude, name, onUninclude, onUnexclude }) {
  if (include.length === 0 && exclude.length === 0) return null;
  const pill = (k, onRemove, label) => (
    <span key={k} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-800 dark:bg-gray-700 dark:text-gray-100">
      {name(k)}<button type="button" onClick={() => onRemove(k)} aria-label={`${label} ${name(k)}`} className="hover:text-red-600">✕</button>
    </span>
  );
  return (
    <div className="space-y-1 text-xs text-gray-700 dark:text-gray-300">
      {include.length > 0 && <div className="flex flex-wrap items-center gap-1">Always include: {include.map(k => pill(k, onUninclude, 'Stop always including'))}</div>}
      {exclude.length > 0 && <div className="flex flex-wrap items-center gap-1">Always exclude: {exclude.map(k => pill(k, onUnexclude, 'Stop always excluding'))}</div>}
    </div>
  );
}

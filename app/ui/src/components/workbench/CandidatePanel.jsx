import { useState } from 'react';
import { frequencies, impactSummary, roleDelta } from './workbench.model';
import { IMPACT } from './workbench.cells';
import { BusinessRoleBadge } from '@ui/components/matrix/MatrixBadges';

// ─── The candidate role ──────────────────────────────────────────────────
// A new candidate role, or a proposed update to a business role the unit already
// holds (starting from what it Contains and who holds it — the role itself is
// never changed). Members and entitlements are chosen separately. The first
// proposal is deterministic: every column at least half (or ¾, or all) of the
// members hold, minus what was marked other context or unrelated; the share is
// shown beside each entitlement. The impact counts update as the draft changes.
// Nothing here is saved or sent anywhere.

const THRESHOLDS = [{ v: 0.5, l: '≥ 50 %' }, { v: 0.75, l: '≥ 75 %' }, { v: 1, l: 'all' }];

export default function CandidatePanel({ draft, dispatch, data, cellIndex, cellsByResource, peopleByKey, columnsById, draftColor }) {
  const { candidate, marks } = draft;
  const roles = data.columns.filter(c => c.isRole);
  const baseRole = candidate.baseRoleId ? columnsById.get(candidate.baseRoleId) : null;
  const impact = impactSummary(candidate, data.people, cellIndex, marks);
  const share = new Map(frequencies(candidate.members, data.columns, cellIndex).map(f => [f.resourceId, f]));
  const n = candidate.members.size;

  return (
    <aside aria-label="Candidate role" className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-gray-900 dark:text-white">{candidate.mode === 'extend' ? 'Proposed update to a role' : 'Candidate role'}</h3>
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">Draft · not saved</span>
      </div>
      <ModePicker candidate={candidate} roles={roles} dispatch={dispatch} cellsByResource={cellsByResource} />
      <label className="block">
        <span className="text-xs text-gray-600 dark:text-gray-400">Name</span>
        <input value={candidate.name} onChange={e => dispatch({ type: 'edit', field: 'name', value: e.target.value })} placeholder="e.g. Claims handler — motor"
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
      </label>

      <Section title={`Members (${n})`} empty="Select people in the grid, then Add to candidate or Members only.">
        {[...candidate.members].map(k => (
          <Pill key={k} label={peopleByKey.get(k)?.displayName ?? k} onRemove={() => dispatch({ type: 'removeMember', person: k })} />
        ))}
      </Section>

      <Proposer n={n} dispatch={dispatch} data={data} cellIndex={cellIndex} />

      <Section title={`Entitlements (${candidate.entitlements.size})`} empty="Select cells in the grid, or propose from the members." list>
        {[...candidate.entitlements].map(id => {
          const col = columnsById.get(id);
          const f = share.get(id);
          return (
            <li key={id} className="flex items-center justify-between gap-2 py-0.5">
              <span className="min-w-0 truncate text-gray-800 dark:text-gray-200" title={col ? [col.displayName, col.systemName].filter(Boolean).join(' · ') : id}>
                {col?.isRole && <span className="mr-1"><BusinessRoleBadge /></span>}
                {col?.displayName ?? 'Not held in this unit'}
              </span>
              <span className="shrink-0 text-xs text-gray-600 dark:text-gray-400">{n ? `${f?.held ?? 0}/${n}` : ''}</span>
              <button type="button" onClick={() => dispatch({ type: 'removeEntitlement', resourceId: id })} aria-label={`Remove ${col?.displayName ?? id}`} className="shrink-0 text-gray-500 hover:text-red-600 dark:text-gray-400">✕</button>
            </li>
          );
        })}
      </Section>

      {candidate.mode === 'extend' && <RoleDelta delta={roleDelta(candidate, baseRole)} columnsById={columnsById} />}
      <ImpactBlock impact={impact} peopleByKey={peopleByKey} dispatch={dispatch} draftColor={draftColor} />
      <p className="text-[11px] leading-snug text-gray-600 dark:text-gray-400">
        Nothing here changes access or is saved. “Outside the candidate” is not a removal: the person may keep it through
        other grants, and removing access is not modelled yet — its impact is unknown.
      </p>
      <button type="button" onClick={() => dispatch({ type: 'reset' })} className="text-xs text-red-700 hover:underline dark:text-red-300">Reset the draft (selection, marks and candidate)</button>
    </aside>
  );
}

function ModePicker({ candidate, roles, dispatch, cellsByResource }) {
  const value = candidate.mode === 'extend' ? candidate.baseRoleId : '';
  const choose = (id) => {
    if (!id) { dispatch({ type: 'newCandidate' }); return; }
    const role = roles.find(r => r.id === id);
    if (role) dispatch({ type: 'fromRole', role, cellsByResource });
  };
  return (
    <label className="block">
      <span className="text-xs text-gray-600 dark:text-gray-400">Start from</span>
      <select value={value} onChange={e => choose(e.target.value)} className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
        <option value="">A new candidate role</option>
        {roles.map(r => <option key={r.id} value={r.id}>Update: {r.displayName} ({r.holders})</option>)}
      </select>
      {roles.length === 0 && <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">No business role is held in this unit.</span>}
    </label>
  );
}

function Proposer({ n, dispatch, data, cellIndex }) {
  const [threshold, setThreshold] = useState(0.5);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded bg-gray-50 p-2 text-xs dark:bg-gray-900/60">
      <span className="text-gray-700 dark:text-gray-300">Propose entitlements held by</span>
      <select value={threshold} onChange={e => setThreshold(Number(e.target.value))} aria-label="Share of the members" className="rounded border border-gray-300 bg-white px-1 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
        {THRESHOLDS.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
      </select>
      <span className="text-gray-700 dark:text-gray-300">of the members</span>
      <button type="button" disabled={n === 0} onClick={() => dispatch({ type: 'propose', threshold, columns: data.columns, cellIndex })}
        className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500">Propose</button>
    </div>
  );
}

function Section({ title, empty, list = false, children }) {
  const items = Array.isArray(children) ? children : [children];
  const has = items.filter(Boolean).length > 0;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">{title}</h4>
      {!has && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{empty}</p>}
      {has && (list
        ? <ul className="mt-1 max-h-48 overflow-auto">{children}</ul>
        : <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-auto">{children}</div>)}
    </div>
  );
}

function Pill({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="text-emerald-700 hover:text-red-600 dark:text-emerald-300">✕</button>
    </span>
  );
}

function RoleDelta({ delta, columnsById }) {
  const name = (id) => columnsById.get(id)?.displayName ?? 'not held in this unit';
  return (
    <div className="rounded border border-teal-200 p-2 text-xs dark:border-teal-800">
      <div className="font-semibold text-gray-800 dark:text-gray-200">Compared with the role today</div>
      <div className="mt-0.5 text-gray-700 dark:text-gray-300">Adds: {delta.added.length ? delta.added.map(name).join(', ') : 'nothing'}</div>
      <div className="text-gray-700 dark:text-gray-300">Leaves out of the role: {delta.leftOut.length ? delta.leftOut.map(name).join(', ') : 'nothing'}</div>
      {delta.leftOut.length > 0 && <div className="mt-0.5 text-gray-600 dark:text-gray-400">Holders may keep these through other grants — impact unknown.</div>}
    </div>
  );
}

const IMPACT_ROWS = ['covered', 'gain', 'outside', 'other', 'unrelated', 'investigate'];

// The swatch of each row as the grid shows it: the draft's colour, the matrix's
// amber provisioning-gap marker, a plain cell, or the workbench's own mark.
function Swatch({ kind, draftColor }) {
  if (kind === 'covered') return <span aria-hidden="true" className="inline-block h-4 w-4 rounded-sm border border-gray-300 dark:border-gray-600" style={{ backgroundColor: draftColor }} />;
  if (kind === 'gain') return <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center"><span className="flex h-2 w-2 items-center justify-center rounded-full bg-amber-500 text-[7px] font-bold text-white">!</span></span>;
  if (kind === 'outside') return <span aria-hidden="true" className="inline-block h-4 w-4 rounded-sm border border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800" />;
  return <span aria-hidden="true" className={`inline-flex h-4 w-4 items-center justify-center rounded-sm text-[10px] font-bold ${IMPACT[kind].mark}`}>{IMPACT[kind].glyph}</span>;
}

function ImpactBlock({ impact, peopleByKey, dispatch, draftColor }) {
  const { counts, gainers, possibleMembers } = impact;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">Impact for the members</h4>
      <ul className="mt-1 space-y-0.5 text-xs">
        {IMPACT_ROWS.map(k => (
          <li key={k} className="flex items-center gap-2">
            <Swatch kind={k} draftColor={draftColor} />
            <span className="flex-1 text-gray-700 dark:text-gray-300">{IMPACT[k].label}</span>
            <span className="font-semibold text-gray-900 dark:text-gray-100">{counts[k]}</span>
          </li>
        ))}
      </ul>
      {gainers > 0 && <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">{gainers} {gainers === 1 ? 'person' : 'people'} would gain access they do not have today.</p>}
      {possibleMembers.length > 0 && (
        <div className="mt-1 text-xs text-gray-700 dark:text-gray-300">
          Already hold all of it, not members: {possibleMembers.map(k => peopleByKey.get(k)?.displayName ?? k).join(', ')}
          <button type="button" onClick={() => dispatch({ type: 'addMembers', people: possibleMembers })} className="ml-1 text-blue-700 hover:underline dark:text-blue-300">Add them</button>
        </div>
      )}
    </div>
  );
}

import { useDialog } from '@ui/components/dialogContext';
import { frequencies, impactSummary, roleDelta } from './workbench.model';
import { IMPACT } from './workbench.cells';
import { activeDraft } from './useWorkbench';
import { BusinessRoleBadge } from '@ui/components/matrix/MatrixBadges';
import RoleRuleEditor, { KindPicker } from './RoleRuleEditor';
import { roleProblems, roleNotes } from './workbench.rule';

// ─── The proposed roles ──────────────────────────────────────────────────
// The session's proposed roles, each a Draft column in the role band in its own
// colour: the list at the top picks the one to edit (so does its band header);
// "New candidate role" starts another; "Update an existing role" starts one from
// a role the unit holds (what it Contains and who holds it — the role itself is
// never changed). The active one is edited here — members and entitlements chosen
// separately — entitlements only as the analyst selects them in the grid (the
// list shows how many members hold each) — its impact, and it can be removed when
// it is not right. An existing role clicked in the band shows here read-only, with
// "Propose update". Saved only with the investigation (Save in the strip above;
// saveLabel says which state it is in).

export default function CandidatePanel({
  draft, dispatch, data, cellIndex, cellsByResource, peopleByKey, columnsById, roles = [], color = () => undefined,
  candidate = null, unitName = '', onUseAsRule = () => {}, saveLabel = 'Draft · not saved',
  // Optional: the actions at the end of the role (a screen that saves passes "Save role" here).
  roleActions = null,
}) {
  const existing = data.columns.filter(c => c.isRole);
  const colorOf = (id) => { const r = roles.find(x => x.id === id); return r ? color(r.idx) : undefined; };
  // How many hold a proposed role: its band role's holders (computed from its rule), else those chosen by hand.
  const countOf = (d) => roles.find(r => r.id === d.id)?.holders.size ?? d.members.size;
  const viewed = draft.viewRoleId ? columnsById.get(draft.viewRoleId) : null;
  // The page passes the active role with its members resolved (by rule, or by hand).
  const active = candidate ?? activeDraft(draft);
  return (
    <aside aria-label="Candidate role" className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-800">
      <DraftList draft={draft} dispatch={dispatch} existing={existing} cellsByResource={cellsByResource} colorOf={colorOf} countOf={countOf} saveLabel={saveLabel} />
      {viewed && <ExistingRole role={viewed} dispatch={dispatch} cellsByResource={cellsByResource} peopleByKey={peopleByKey} columnsById={columnsById} color={colorOf(viewed.id)} />}
      {!viewed && active.id && (
        <DraftEditor candidate={active} draft={draft} dispatch={dispatch} data={data} cellIndex={cellIndex} peopleByKey={peopleByKey}
          columnsById={columnsById} draftColor={colorOf(active.id) ?? color(roles.length)}
          rule={{ unitName, accountable: data.unit?.accountable ?? null, onUseAsRule }} roleActions={roleActions} />
      )}
      {!viewed && !active.id && (
        <p className="text-xs text-gray-600 dark:text-gray-400">No proposed role yet. Filter or select people and cells, then <span className="font-medium">Add to candidate</span> — or start one here.</p>
      )}
      <button type="button" onClick={() => dispatch({ type: 'reset' })} className="text-xs text-red-700 hover:underline dark:text-red-300">Reset everything (selection, marks and all proposed roles)</button>
    </aside>
  );
}

// What the role still needs (blocks a save) and what is worth knowing (does not), above its actions.
function RoleChecks({ candidate, children }) {
  const problems = roleProblems(candidate);
  const notes = roleNotes(candidate);
  return (
    <div className="space-y-1 border-t border-gray-100 pt-2 dark:border-gray-700">
      {problems.length > 0 && (
        <ul aria-label="Before saving" className="list-disc pl-4 text-xs text-red-700 dark:text-red-300">{problems.map(p => <li key={p}>{p}</li>)}</ul>
      )}
      {notes.map(n => <p key={n} className="text-xs text-gray-600 dark:text-gray-400">{n}</p>)}
      {children}
    </div>
  );
}

function ColorSwatch({ color }) {
  return <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-sm border border-gray-300 dark:border-gray-600" style={{ backgroundColor: color }} />;
}

function DraftList({ draft, dispatch, existing, cellsByResource, colorOf, countOf, saveLabel }) {
  const startFrom = (id) => {
    const role = existing.find(r => r.id === id);
    if (role) dispatch({ type: 'fromRole', role, cellsByResource });
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">Proposed roles</h3>
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">{saveLabel}</span>
      </div>
      <ul aria-label="Proposed roles" className="mt-1 space-y-0.5">
        {draft.drafts.map(d => (
          <li key={d.id}>
            <button type="button" onClick={() => dispatch({ type: 'selectDraft', id: d.id })} aria-current={d.id === draft.activeId && !draft.viewRoleId ? 'true' : undefined}
              className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs ${d.id === draft.activeId && !draft.viewRoleId ? 'bg-blue-50 font-medium text-blue-900 dark:bg-blue-900/40 dark:text-blue-100' : 'text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700'}`}>
              <ColorSwatch color={colorOf(d.id)} />
              <span className="truncate">{d.name || 'Unnamed'}</span>
              <span className="ml-auto shrink-0 text-gray-600 dark:text-gray-400" title="people · entitlements">{countOf(d)} · {d.entitlements.size}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => dispatch({ type: 'newCandidate' })} className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700">New candidate role</button>
        {existing.length > 0 && (
          <select value="" onChange={e => startFrom(e.target.value)} aria-label="Update an existing role"
            className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
            <option value="">Update an existing role…</option>
            {existing.map(r => <option key={r.id} value={r.id}>{r.displayName} ({r.holders})</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

// An existing business role, read-only: who holds it here and what it Contains.
function ExistingRole({ role, dispatch, cellsByResource, peopleByKey, columnsById, color }) {
  const holders = (cellsByResource.get(role.id) || []).map(c => peopleByKey.get(c.person)?.displayName ?? c.person);
  return (
    <section aria-label="Existing business role" className="space-y-2 border-t border-gray-100 pt-2 dark:border-gray-700">
      <div className="flex items-center gap-2">
        <ColorSwatch color={color} /><BusinessRoleBadge />
        <h3 className="min-w-0 truncate font-semibold text-gray-900 dark:text-white">{role.displayName}</h3>
      </div>
      <p className="text-[11px] text-gray-600 dark:text-gray-400">Business role from the source · read-only here</p>
      <Section title={`Held here by (${holders.length})`} empty="Nobody in this unit holds it.">
        {holders.map(n => <span key={n} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-800 dark:bg-gray-700 dark:text-gray-100">{n}</span>)}
      </Section>
      <Section title={`Contains (${role.contains.length})`} empty="It contains nothing." list>
        {role.contains.map(id => <li key={id} className="py-0.5 text-xs text-gray-800 dark:text-gray-200">{columnsById.get(id)?.displayName ?? 'Not held in this unit'}</li>)}
      </Section>
      <div className="flex gap-2">
        <button type="button" onClick={() => dispatch({ type: 'fromRole', role, cellsByResource })} className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700 dark:bg-blue-500">Propose update</button>
        <button type="button" onClick={() => dispatch({ type: 'closeRole' })} className="text-xs text-gray-700 hover:underline dark:text-gray-300">Close</button>
      </div>
    </section>
  );
}

// The members list's title: how they were chosen.
function membersTitle(candidate) {
  const n = candidate.members.size;
  if (candidate.kind === 'requestable') return `Expected initial holders (${n})`;
  if (candidate.kind === 'rule' && candidate.rule) return `Members by rule (${n})`;
  return `Members chosen by hand (${n})`;
}

function DraftEditor({ candidate, draft, dispatch, data, cellIndex, peopleByKey, columnsById, draftColor, rule, roleActions }) {
  const dialog = useDialog();
  const baseRole = candidate.baseBusinessRoleId ? columnsById.get(candidate.baseBusinessRoleId) : null;
  const impact = impactSummary(candidate, data.people, cellIndex, draft.marks);
  const share = new Map(frequencies(candidate.members, data.columns, cellIndex).map(f => [f.resourceId, f]));
  const n = candidate.members.size;
  const remove = async () => {
    const ok = await dialog.confirm({
      title: 'Remove proposed role',
      message: `Remove the proposed role “${candidate.name || 'Unnamed'}”? Its column and colours go; nothing else changes.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (ok) dispatch({ type: 'removeDraft', id: candidate.id });
  };
  return (
    <section aria-label="Proposed role" className="space-y-3 border-t border-gray-100 pt-2 dark:border-gray-700">
      <div className="flex items-center gap-2">
        <ColorSwatch color={draftColor} />
        <h3 className="font-semibold text-gray-900 dark:text-white">{baseRole ? 'Proposed update to a role' : 'Candidate role'}</h3>
      </div>
      <label className="block">
        <span className="text-xs text-gray-600 dark:text-gray-400">Name</span>
        <input value={candidate.name} onChange={e => dispatch({ type: 'edit', field: 'name', value: e.target.value })} placeholder="e.g. Claims handler — motor"
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
      </label>

      {candidate.kind
        ? <RoleRuleEditor candidate={candidate} dispatch={dispatch} unitName={rule.unitName} accountable={rule.accountable} people={data.people}
            peopleByKey={peopleByKey} onUseAsRule={rule.onUseAsRule} />
        : <KindPicker onPick={(kind) => dispatch({ type: 'setKind', kind })} suggested={baseRole?.policyKind} />}

      <Section title={membersTitle(candidate)} empty="Select people in the grid, then Add to candidate or Members only — or give it a rule.">
        {[...candidate.members].map(k => (
          <Pill key={k} label={peopleByKey.get(k)?.displayName ?? k} onRemove={() => dispatch({ type: 'removeMember', person: k })} />
        ))}
      </Section>

      <Section title={`Entitlements (${candidate.entitlements.size})`} empty="Select cells, a range or a column header in the grid, then Add to candidate." list>
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

      {baseRole && <RoleDelta delta={roleDelta(candidate, baseRole)} columnsById={columnsById} />}
      <ImpactBlock impact={impact} peopleByKey={peopleByKey} dispatch={dispatch} draftColor={draftColor} />
      <p className="text-[11px] leading-snug text-gray-600 dark:text-gray-400">
        Nothing here changes access or is saved. “Outside the candidate” is not a removal: the person may keep it through
        other grants, and removing access is not modelled yet — its impact is unknown.
      </p>
      {roleActions && <RoleChecks candidate={candidate}>{roleActions({ candidate, problems: roleProblems(candidate) })}</RoleChecks>}
      <button type="button" onClick={remove} className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30">Remove this proposed role</button>
    </section>
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

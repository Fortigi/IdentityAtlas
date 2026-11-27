import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { ownersOf, ownerChanges, personKey } from './reviewSteps';

// ─── Step 1: who answers for the role ────────────────────────────────────
// Shows the Accountable and Responsible people as they are now. When the
// reviewer says it needs a change, ProposedOwners lets them pick who it should
// be from the directory — a proposal stored with the review, never a change to
// the role.

const MUTED = 'text-xs text-gray-600 dark:text-gray-400';
const CHIP = 'inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

const nameOf = (p) => p.displayName || 'Unnamed';

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[9rem_1fr]">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</div>
      <div className="text-sm text-gray-800 dark:text-gray-200">{children}</div>
    </div>
  );
}

function sourceNote(owner) {
  if (!owner.derivedFrom?.length) return null;
  return ` (${owner.derivedFrom.join(' and ').toLowerCase()} in a policy)`;
}

export function CurrentOwners({ snapshot }) {
  const owners = snapshot?.owners ?? [];
  const accountable = owners.filter(o => o.role === 'Accountable');
  const responsible = owners.filter(o => o.role === 'Responsible');
  const list = (people) => (people.length === 0
    ? <span className="text-amber-800 dark:text-amber-300">Nobody</span>
    : <ul>{people.map((o, i) => <li key={`${personKey(o) ?? o.displayName}-${i}`}>{nameOf(o)}<span className={MUTED}>{sourceNote(o)}</span></li>)}</ul>);
  return (
    <section aria-label="Who answers for this role now" className="space-y-2 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <Row label="Accountable">{list(accountable)}</Row>
      <Row label="Responsible">{list(responsible)}</Row>
    </section>
  );
}

export function ProposedOwners({ roleId, snapshot, proposal, onChange }) {
  const current = ownersOf(snapshot);
  const changes = ownerChanges(current, proposal);
  const searchUrl = (term) => `/api/access-package/${encodeURIComponent(roleId)}/composition-reviews/people?search=${encodeURIComponent(term)}`;
  const picked = (p) => ({ principalId: p.id, displayName: p.displayName });
  const addResponsible = (p) => {
    const person = picked(p);
    if (proposal.responsible.some(r => personKey(r) === personKey(person))) return;
    onChange({ ...proposal, responsible: [...proposal.responsible, person] });
  };
  const removeResponsible = (key) => onChange({ ...proposal, responsible: proposal.responsible.filter(r => personKey(r) !== key) });

  return (
    <div className="space-y-3 rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40" data-testid="proposed-owners">
      <p className={MUTED}>Choose who it should be. This is a proposal: nothing changes on the role until someone makes the change.</p>
      <Row label="Accountable">
        <div className="space-y-1.5">
          <p>
            <span className="font-medium">{proposal.accountable ? nameOf(proposal.accountable) : 'Nobody'}</span>
            {proposal.accountable && (
              <button type="button" onClick={() => onChange({ ...proposal, accountable: null })}
                className="ml-2 text-xs text-blue-700 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300">Nobody</button>
            )}
          </p>
          <div className="max-w-sm text-xs">
            <PersonSearch inputId="propose-accountable" label="Propose someone else" autoFocus={false} searchUrl={searchUrl}
              onPick={p => onChange({ ...proposal, accountable: picked(p) })} />
          </div>
        </div>
      </Row>
      <Row label="Responsible">
        <div className="space-y-1.5">
          {proposal.responsible.length === 0
            ? <p>Nobody</p>
            : (
              <ul aria-label="Proposed Responsible" className="flex flex-wrap gap-1.5">
                {proposal.responsible.map(r => (
                  <li key={personKey(r)} className={CHIP}>
                    <span>{nameOf(r)}</span>
                    <button type="button" onClick={() => removeResponsible(personKey(r))} aria-label={`Remove ${nameOf(r)} as Responsible`}
                      className="leading-none text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400">✕</button>
                  </li>
                ))}
              </ul>
            )}
          <div className="max-w-sm text-xs">
            <PersonSearch inputId="propose-responsible" label="Add a person" autoFocus={false} searchUrl={searchUrl} onPick={addResponsible} />
          </div>
        </div>
      </Row>
      {changes.length > 0 && (
        <div data-testid="proposed-changes">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">You propose</p>
          <ul className="list-disc pl-5 text-sm text-gray-800 dark:text-gray-200">{changes.map(c => <li key={c}>{c}</li>)}</ul>
          <button type="button" onClick={() => onChange(current)}
            className="mt-1 text-xs text-blue-700 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300">Undo these choices</button>
        </div>
      )}
    </div>
  );
}

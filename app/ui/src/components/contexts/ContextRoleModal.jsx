import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import { Modal, ErrorBox, PrimaryButton, SecondaryButton } from './ModalPrimitives';

// ─── Change who holds a role on a context ────────────────────────────────
// Opened by the pencil beside the Accountable or the Responsible fact (and by
// the best guess's "Choose someone else"). ContextPeople owns the API calls —
// PUT /api/contexts/:id/roles to add, DELETE …/roles/:roleId to remove — and
// hands them in as onAdd(holder) / onRemove(roleId), each resolving to true
// when the write went through.
//
//   Accountable  one holder at most: pick someone, then Save (the API
//                replaces whoever held it), Clear (removes the holder) or
//                Cancel.
//   Responsible  any number: the list of holders, each with a remove cross,
//                and the lookup to add one. Each change is made straight
//                away, as the API calls are one per holder; Done closes.

export default function ContextRoleModal({ role, label, helper, holders, onAdd, onRemove, onClose, error }) {
  const title = `${role === 'Accountable' ? 'Set' : 'Edit'} ${label}`;
  return (
    <Modal title={title} onClose={onClose} width={440}>
      {helper && <p data-testid="role-helper" className="mb-3 text-sm text-gray-600 dark:text-gray-400">{label}: {helper.charAt(0).toLowerCase() + helper.slice(1)}.</p>}
      {role === 'Accountable'
        ? <AccountableBody label={label} holder={holders[0] || null} onAdd={onAdd} onRemove={onRemove} onClose={onClose} />
        : <ResponsibleBody holders={holders} onAdd={onAdd} onRemove={onRemove} onClose={onClose} />}
      <ErrorBox message={error} />
    </Modal>
  );
}

const holderName = (r) => r.displayName || r.principalId || r.identityId;

function AccountableBody({ label, holder, onAdd, onRemove, onClose }) {
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(write) {
    setBusy(true);
    const ok = await write();
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <div className="space-y-3 text-xs">
      <p className="text-gray-700 dark:text-gray-300">
        Current: <span className="font-medium text-gray-900 dark:text-white">{holder ? holderName(holder) : 'not set'}</span>
      </p>
      <PersonSearch inputId="role-accountable-search" onPick={setChosen} />
      {chosen && (
        <p className="text-gray-700 dark:text-gray-300">
          New {label}: <span className="font-medium text-gray-900 dark:text-white">{chosen.displayName}</span>
        </p>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div>
          {holder && <SecondaryButton onClick={() => run(() => onRemove(holder.id))} disabled={busy}>Clear</SecondaryButton>}
        </div>
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
          <PrimaryButton onClick={() => run(() => onAdd({ principalId: chosen.id }))} disabled={!chosen || busy}>Save</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function ResponsibleBody({ holders, onAdd, onRemove, onClose }) {
  const held = new Set(holders.map(h => h.principalId).filter(Boolean));
  return (
    <div className="space-y-3 text-xs">
      {holders.length === 0
        ? <p className="text-gray-600 dark:text-gray-400">Nobody is responsible yet.</p>
        : (
          <ul aria-label="Responsible" className="flex flex-wrap gap-1.5">
            {holders.map(r => (
              <li key={r.id} title={`Added by ${r.addedBy}`} className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                <span>{holderName(r)}</span>
                <button type="button" onClick={() => onRemove(r.id)} aria-label={`Remove ${holderName(r)} as Responsible`} className="leading-none text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400">✕</button>
              </li>
            ))}
          </ul>
        )}
      <PersonSearch inputId="role-responsible-search" label="Add a person" onPick={p => (held.has(p.id) ? null : onAdd({ principalId: p.id }))} />
      <div className="flex justify-end pt-1">
        <PrimaryButton onClick={onClose}>Done</PrimaryButton>
      </div>
    </div>
  );
}

// Search accounts (/api/users, debounced) and hand the chosen row to onPick;
// the list closes and the box clears once one is picked.
function PersonSearch({ inputId, label = 'Find a person', onPick }) {
  const { authFetch } = useAuth();
  const [query, setQuery] = useState('');
  const term = useDebouncedValue(query.trim(), 250);
  const { data: hits } = useFetch(
    `/api/users?search=${encodeURIComponent(term)}&limit=10`,
    { authFetch, enabled: term !== '', initialData: [], transform: b => b.data || [] },
  );
  const results = term === '' ? [] : hits;

  async function pick(p) {
    setQuery('');
    await onPick(p);
  }

  return (
    <div className="relative">
      <label htmlFor={inputId} className="block font-medium text-gray-700 dark:text-gray-300">{label}</label>
      <input
        id={inputId}
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search by name or e-mail…"
        className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
      />
      {results.length > 0 && (
        <ul className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-auto rounded border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          {results.map(p => (
            <li key={p.id}>
              <button type="button" onClick={() => pick(p)} className="w-full px-2 py-1 text-left text-xs text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50">
                {p.displayName}
                {p.userPrincipalName && <span className="ml-1 text-gray-600 dark:text-gray-400">{p.userPrincipalName}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

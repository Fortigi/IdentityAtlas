import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useHasPermission } from '@ui/auth/usePermissions';
import { PencilIcon } from '@ui/components/admin/adminIcons';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import ContextBestGuess from './ContextBestGuess';
import ContextRoleModal from './ContextRoleModal';

// ─── The people who answer for a context ─────────────────────────────────
// An organizational unit and a logical application carry roles: one
// Accountable at most, any number of Responsible. Segments and tags carry
// none (the API refuses a role on them), so this renders nothing for them.
//
// Reads GET /api/contexts/:id/roles and shows each role as a small people
// block: the role, one line on what it means, and who holds it (initials,
// name opening their page, e-mail on hover when the API gives one). Someone
// with data.write.contexts gets "Set <role>" while nobody holds it and a
// pencil once somebody does, both opening ContextRoleModal (search
// /api/users, PUT the chosen account with the role, DELETE one).
//
// The template profiles pass their own vocabulary (an application's
// Accountable is its Owner; `noun` is "this unit" / "this application"), drop
// the heading when they draw their own, and turn on `suggest`: with no
// Accountable set, the API's suggestion shows under it with Confirm / Not
// this person / Choose someone else — the last opens the same modal.
//
// In a read-only shell (a context owner's page) the names are plain text and
// there is no suggestion: the owner sees who answers for the unit, nothing to act on.
//
// A role the source sync stated (a synced context's owner, addedBy 'sync')
// says which system it came from; an analyst's choice replaces it and then
// survives the next sync.

const ROLED_CATEGORIES = new Set(['OrganizationalUnit', 'LogicalApplication']);

const ROLE_HELPERS = {
  Accountable: (noun) => `Answers for who may access ${noun}`,
  Responsible: () => 'Keeps the membership and access correct day to day',
};

export default function ContextPeople({ attrs, onOpenDetail, heading = 'People', accountableLabel = 'Accountable', noun = 'this unit', suggest = false }) {
  if (!ROLED_CATEGORIES.has(attrs?.contextCategory)) return null;
  return (
    <PeopleBlocks contextId={attrs.id} sourceName={attrs.scopeSystemName} onOpenDetail={onOpenDetail} heading={heading}
      accountableLabel={accountableLabel} noun={noun} suggest={suggest} />
  );
}

// Loads the roles of one context and holds the writes on them. Each write
// resolves to true when it went through, so the modal knows whether to close.
function useContextRoles(contextId) {
  const { authFetch } = useAuth();
  const { data: roles, loading, error, reload } = useFetch(`/api/contexts/${contextId}/roles`, { authFetch, initialData: [] });
  const [actionError, setActionError] = useState(null);

  async function write(url, init, fallback) {
    setActionError(null);
    try {
      const r = await authFetch(url, init);
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      reload();
      return true;
    } catch (e) {
      setActionError(e.message || fallback);
      return false;
    }
  }

  const remove = (roleId) => write(`/api/contexts/${contextId}/roles/${roleId}`, { method: 'DELETE' }, 'Remove failed');

  // holder = { principalId } or { identityId }: the lookup adds accounts, a
  // suggestion may name either.
  const add = (role, holder) => write(`/api/contexts/${contextId}/roles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, ...holder }),
  }, 'Add failed');

  const list = Array.isArray(roles) ? roles : [];
  return {
    accountable: list.filter(r => r.role === 'Accountable'),
    responsible: list.filter(r => r.role === 'Responsible'),
    loading,
    error,
    actionError,
    clearActionError: () => setActionError(null),
    add,
    remove,
  };
}

function PeopleBlocks({ contextId, sourceName, onOpenDetail, heading, accountableLabel, noun, suggest }) {
  const readOnly = useIsSharedView();
  const canWrite = useHasPermission('data.write.contexts') && !readOnly;
  const openPerson = readOnly ? undefined : onOpenDetail;
  const { accountable, responsible, loading, error, actionError, clearActionError, add, remove } = useContextRoles(contextId);
  // Which role's modal is open: 'Accountable', 'Responsible' or null.
  const [editing, setEditing] = useState(null);

  function open(role) {
    clearActionError();
    setEditing(role);
  }

  const message = actionError || error?.message;
  // Only once the roles have loaded: before that "no Accountable" is not known.
  const showGuess = accountable.length === 0 && suggest && !readOnly && !loading && !error;

  return (
    <div className="mt-3 space-y-3" data-testid="context-people">
      {heading && <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">{heading}</div>}
      <RoleBlock label={accountableLabel} helper={ROLE_HELPERS.Accountable(noun)} holders={accountable} loading={loading}
        sourceName={sourceName} canWrite={canWrite} onSet={() => open('Accountable')} onOpenDetail={openPerson}>
        {showGuess && (
          <ContextBestGuess contextId={contextId} canWrite={canWrite}
            onConfirm={holder => add('Accountable', holder)} onChooseOther={() => open('Accountable')} />
        )}
      </RoleBlock>
      <RoleBlock label="Responsible" helper={ROLE_HELPERS.Responsible(noun)} holders={responsible} loading={loading}
        sourceName={sourceName} canWrite={canWrite} onSet={() => open('Responsible')} onOpenDetail={openPerson} />
      {message && !editing && (
        <div role="alert" className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">{message}</div>
      )}
      {editing && (
        <RoleEditor role={editing} accountableLabel={accountableLabel} noun={noun}
          holders={editing === 'Accountable' ? accountable : responsible}
          onAdd={holder => add(editing, holder)} onRemove={remove}
          onClose={() => setEditing(null)} error={actionError} />
      )}
    </div>
  );
}

// The pop-up for one role, in the profile's vocabulary.
function RoleEditor({ role, accountableLabel, noun, ...rest }) {
  return (
    <ContextRoleModal role={role} label={role === 'Accountable' ? accountableLabel : 'Responsible'}
      helper={ROLE_HELPERS[role](noun)} {...rest} />
  );
}

// "Nobody is accountable yet." — an application's Owner reads "No owner yet."
function emptyRoleText(label) {
  return label === 'Owner' ? 'No owner yet.' : `Nobody is ${label.toLowerCase()} yet.`;
}

// One role: its name and meaning on the left, who holds it on the right.
function RoleBlock({ label, helper, holders, loading, sourceName, canWrite, onSet, onOpenDetail, children }) {
  const empty = holders.length === 0;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-start gap-x-4 gap-y-1">
      <div className="w-full sm:w-48 shrink-0">
        <div className="text-sm font-medium text-gray-900 dark:text-white">{label}</div>
        <div className="text-xs text-gray-600 dark:text-gray-400">{helper}</div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {!empty && (
          <div className="flex flex-wrap items-center gap-3">
            {holders.map(role => <Holder key={role.id} role={role} sourceName={sourceName} onOpenDetail={onOpenDetail} />)}
            {canWrite && <EditButton label={label} onClick={onSet} />}
          </div>
        )}
        {empty && !loading && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-600 dark:text-gray-400">{emptyRoleText(label)}</span>
            {canWrite && (
              <button type="button" onClick={onSet}
                className="rounded border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50">
                Set {label.toLowerCase()}
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function initials(name) {
  const words = String(name || '?').trim().split(/\s+/);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

// One holder: initials, the name opening the account (or the person), and
// the source system when a sync stated the role.
function Holder({ role, sourceName, onOpenDetail }) {
  const name = role.displayName || role.principalId || role.identityId;
  const kind = role.principalId ? 'user' : 'identity';
  const linkable = !!onOpenDetail && !!(role.principalId || role.identityId);
  return (
    <span className="inline-flex items-center gap-2 text-sm text-gray-900 dark:text-gray-200" title={role.email || undefined}>
      <span aria-hidden="true" className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
        {initials(name)}
      </span>
      {linkable
        ? <button type="button" onClick={() => onOpenDetail(kind, role.principalId || role.identityId, name)} className="font-medium hover:underline hover:text-blue-700 dark:hover:text-blue-300">{name}</button>
        : <span className="font-medium">{name}</span>}
      {role.addedBy === 'sync' && sourceName && <span className="text-xs text-gray-600 dark:text-gray-400">from {sourceName}</span>}
    </span>
  );
}

function EditButton({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-label={`Edit ${label}`} title={`Edit ${label}`}
      className="rounded p-1 text-gray-600 hover:bg-gray-100 hover:text-blue-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-blue-300">
      <PencilIcon className="w-4 h-4" />
    </button>
  );
}

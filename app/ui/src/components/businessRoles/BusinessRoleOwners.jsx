import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { useContextOwnerScope } from '@ui/contexts/ContextOwnerScopeContext';
import { RoleBlock } from '@ui/components/contexts/ContextPeople';
import ContextRoleModal from '@ui/components/contexts/ContextRoleModal';
import SuggestionRow from '@ui/components/contexts/SuggestionRow';

// ─── Who answers for a business role ─────────────────────────────────────
// One Accountable at most, any number of Responsible, in the same blocks and
// pop-up contexts use. While a place is empty, the API's guess shows under it
// with Confirm / Not this person / Choose someone else. A read-only view (a
// share link, a context owner's page) shows the names and asks for no guess.

const HELPERS = {
  Accountable: 'Answers for who may hold this role and what it contains',
  Responsible: 'Keeps the role and its contents correct day to day',
};

async function send(authFetch, url, init) {
  const r = await authFetch(url, init);
  if (r.ok || r.status === 204) return;
  const body = await r.json().catch(() => ({}));
  throw new Error(body.error || `HTTP ${r.status}`);
}

const jsonInit = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function useOwners(roleId, withSuggestions) {
  const { authFetch } = useAuth();
  const base = `/api/access-package/${encodeURIComponent(roleId)}/owners`;
  const owners = useFetch(base, { authFetch, initialData: [] });
  const suggestions = useFetch(`${base}/suggestions`, { authFetch, enabled: withSuggestions, initialData: {} });
  const [actionError, setActionError] = useState(null);

  async function write(url, init, fallback) {
    setActionError(null);
    try {
      await send(authFetch, url, init);
      owners.reload();
      if (withSuggestions) suggestions.reload();
      return true;
    } catch (e) {
      setActionError(e.message || fallback);
      return false;
    }
  }

  const list = Array.isArray(owners.data) ? owners.data : [];
  return {
    accountable: list.filter(o => o.role === 'Accountable'),
    responsible: list.filter(o => o.role === 'Responsible'),
    loading: owners.loading,
    loadError: owners.error,
    suggestions: suggestions.data || {},
    actionError,
    clearError: () => setActionError(null),
    add: (role, holder) => write(base, jsonInit('PUT', { role, ...holder }), 'Could not set this person'),
    remove: (ownerId) => write(`${base}/${encodeURIComponent(ownerId)}`, { method: 'DELETE' }, 'Could not remove this person'),
    reject: (role, principalId) => write(`${base}/suggestions/reject`, jsonInit('POST', { role, principalId }), 'Could not record that'),
  };
}

function Guess({ role, suggestion, canWrite, onAdd, onReject, onChoose }) {
  const [busy, setBusy] = useState(false);
  if (!suggestion?.principalId) return null;
  const run = async (action) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  return (
    <SuggestionRow testId={`owner-guess-${role}`} name={suggestion.displayName || suggestion.principalId} reason={suggestion.reason}
      canWrite={canWrite} busy={busy}
      onConfirm={() => run(() => onAdd(role, { principalId: suggestion.principalId }))}
      onReject={() => run(() => onReject(role, suggestion.principalId))}
      onChooseOther={() => onChoose(role)} />
  );
}

export default function BusinessRoleOwners({ roleId, onOpenDetail }) {
  const readOnly = useIsSharedView();
  const ownerScope = useContextOwnerScope();
  const canWrite = useHasPermission('data.write.contexts', 'admin.context-plugins') && !readOnly;
  const o = useOwners(roleId, !readOnly);
  const [editing, setEditing] = useState(null);
  const open = (role) => { o.clearError(); setEditing(role); };
  const message = o.actionError || o.loadError?.message;
  // A read-only view links no person, except a context owner's page, where the
  // API marks each holder they may open (owner.accessible).
  const openPerson = readOnly && !ownerScope ? undefined : onOpenDetail;
  const guess = (role, holders) => (!readOnly && !o.loading && holders.length === 0 ? (
    <Guess role={role} suggestion={o.suggestions[role]} canWrite={canWrite} onAdd={o.add} onReject={o.reject} onChoose={open} />
  ) : null);

  return (
    <div className="space-y-1.5" data-testid="business-role-owners">
      <RoleBlock label="Accountable" helper={HELPERS.Accountable} holders={o.accountable} loading={o.loading}
        canWrite={canWrite} onSet={() => open('Accountable')} onOpenDetail={openPerson}>
        {guess('Accountable', o.accountable)}
      </RoleBlock>
      <RoleBlock label="Responsible" helper={HELPERS.Responsible} holders={o.responsible} loading={o.loading}
        canWrite={canWrite} onSet={() => open('Responsible')} onOpenDetail={openPerson}>
        {guess('Responsible', o.responsible)}
      </RoleBlock>
      {message && !editing && (
        <div role="alert" className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">{message}</div>
      )}
      {editing && (
        <ContextRoleModal role={editing} label={editing} helper={HELPERS[editing]}
          holders={editing === 'Accountable' ? o.accountable : o.responsible.filter(r => !String(r.id).startsWith('policy:'))}
          onAdd={holder => o.add(editing, holder)} onRemove={o.remove}
          onClose={() => setEditing(null)} error={o.actionError} />
      )}
    </div>
  );
}

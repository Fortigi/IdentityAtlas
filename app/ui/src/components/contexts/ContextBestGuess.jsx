import { useCallback, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import SuggestionRow from './SuggestionRow';

// ─── Suggested Accountable ───────────────────────────────────────────────
// Shown under the Accountable role while nobody holds it. The API names one
// candidate and why (GET /api/contexts/:id/roles/suggestion → the candidate,
// or 204 for none): the manager of most members of a people unit, the owner of
// most resources of an application. Someone who can edit contexts can:
//   Confirm             — sets the role (the caller PUTs it and refreshes)
//   Not this person     — remembered by the API, never suggested again here
//   Choose someone else — opens the Accountable modal (ContextRoleModal)
// A reader sees the suggestion and its reason, without the buttons.

// 204 has no body; turn it into "no suggestion" so useFetch can parse it.
function useSuggestionFetch(authFetch) {
  return useCallback(async (url) => {
    const r = await authFetch(url);
    return r.status === 204 ? { ok: true, status: 204, json: async () => null } : r;
  }, [authFetch]);
}

// A usable suggestion names a holder; anything else counts as none.
function holderOf(s) {
  if (s?.principalId) return { principalId: s.principalId };
  if (s?.identityId) return { identityId: s.identityId };
  return null;
}

export default function ContextBestGuess({ contextId, canWrite, onConfirm, onChooseOther }) {
  const { authFetch } = useAuth();
  const fetch204 = useSuggestionFetch(authFetch);
  const { data: suggestion } = useFetch(`/api/contexts/${contextId}/roles/suggestion`, { authFetch: fetch204 });
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const holder = holderOf(suggestion);
  if (!holder || rejected) return null;
  const name = suggestion.displayName || holder.principalId || holder.identityId;

  async function reject() {
    setBusy(true); setActionError(null);
    try {
      const r = await authFetch(`/api/contexts/${contextId}/roles/suggestion/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(holder),
      });
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      setRejected(true);
    } catch (e) { setActionError(e.message || 'Could not record that'); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true);
    await onConfirm(holder);
    setBusy(false);
  }

  return (
    <SuggestionRow testId="best-guess" name={name} reason={suggestion.reason} canWrite={canWrite} busy={busy}
      onConfirm={confirm} onReject={reject} onChooseOther={onChooseOther} error={actionError} />
  );
}

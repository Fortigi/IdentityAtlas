import { useCallback, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

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

  const btn = 'px-2 py-0.5 rounded text-xs disabled:opacity-50';
  return (
    <div data-testid="best-guess" className="flex flex-wrap items-center gap-1.5 rounded border border-dashed border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900/40 dark:text-gray-200">
      <span><span className="font-semibold">Suggested:</span> {name}</span>
      {suggestion.reason && <span className="text-gray-600 dark:text-gray-400">· {suggestion.reason}</span>}
      {canWrite && (
        <>
          <button type="button" onClick={confirm} disabled={busy} className={`${btn} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`}>Confirm</button>
          <button type="button" onClick={reject} disabled={busy} className={`${btn} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`}>Not this person</button>
          <button type="button" onClick={onChooseOther} className={`${btn} text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200`}>Choose someone else</button>
        </>
      )}
      {actionError && <span role="alert" className="text-red-700 dark:text-red-400">{actionError}</span>}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import { closedLine, countLabel, raisedLine, splitRequests } from './changeRequests.helpers';

// ─── Change requests — what the source still has to change ───────────────
// A decision that overrides this unit's source (a member marked former while
// the uploaded list or synced system still lists them) shows its corrected
// picture at once; the correction the SOURCE still owes is a change request.
// Listed here, open first. Nobody closes one by hand: the API resolves it when
// the source shows the change, and an undone decision withdraws it. Re-read
// whenever the unit's claims change, so a decision shows up straight away.
// Nothing at all while the unit never had a request.

export default function ChangeRequestsPanel({ contextId }) {
  const { authFetch } = useAuth();
  const claimsCtx = useContextClaims();
  const [showClosed, setShowClosed] = useState(false);
  const { data, reload } = useFetch(`/api/change-requests?contextId=${encodeURIComponent(contextId)}`, {
    authFetch, enabled: !!contextId, initialData: null,
  });
  // The first fetch is useFetch's own; read again only when the claims change after it.
  const claims = claimsCtx?.claims;
  const seenClaims = useRef(claims);
  useEffect(() => {
    if (seenClaims.current === claims) return;
    seenClaims.current = claims;
    reload();
  }, [claims, reload]);

  const { open, closed } = splitRequests(data?.items);
  if (open.length === 0 && closed.length === 0) return null;

  return (
    <section aria-label="Change requests" className="space-y-2 rounded-lg border border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Change requests</h3>
        <span className="text-xs text-gray-600 dark:text-gray-400" data-testid="change-requests-count">{countLabel({ open, closed })}</span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        What the source still has to change. Identity Atlas already shows the decision; a request closes itself when the source is corrected.
      </p>
      {open.length > 0 && (
        <ul className="space-y-1">
          {open.map(r => (
            <li key={r.id} className="text-sm">
              <span className="text-gray-900 dark:text-gray-100">{r.summary}</span>
              <span className="block text-xs text-gray-600 dark:text-gray-400">{raisedLine(r)}</span>
            </li>
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowClosed(v => !v)} aria-expanded={showClosed}
            className="text-xs text-blue-700 hover:underline dark:text-blue-300">
            {showClosed ? 'Hide' : 'Show'} closed ({closed.length})
          </button>
          {showClosed && (
            <ul className="mt-1 space-y-1">
              {closed.map(r => (
                <li key={r.id} className="text-sm">
                  <span className="text-gray-700 line-through decoration-gray-400 dark:text-gray-300">{r.summary}</span>
                  <span className="block text-xs text-gray-600 dark:text-gray-400">{closedLine(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

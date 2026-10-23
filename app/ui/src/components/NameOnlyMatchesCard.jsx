// Admin → Account Linking → "Name-only matches (held for review)".
//
// Read-only. Account linking refuses to attach an account to a person on a display-name
// match alone, because a namesake — or an owner whose name is spelled slightly
// differently — produces a confidently wrong link. Counting the refusals is not enough to
// act on them, so each run also records WHICH account nearly linked to WHOM and on what
// evidence; this card shows the newest run's list.
//
// There is deliberately no confirm/reject action here: a reviewable link object is its own
// feature (it would have to not act as linked while awaiting review). The analyst acts
// through the existing per-account controls on the identity page.

import { useEffect } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { latestNameOnlyRun } from '@ui/utils/accountLinkingRuns';

const CELL = 'px-3 py-2 align-top';

function SuggestionRow({ s }) {
  return (
    <tr className="border-t border-gray-200 dark:border-gray-700">
      <td className={`${CELL} text-gray-900 dark:text-white`}>
        {s.displayName || s.principalId}
        {s.accountType && (
          <span className="ml-2 text-[11px] text-gray-600 dark:text-gray-400">{s.accountType}</span>
        )}
      </td>
      <td className={`${CELL} text-gray-900 dark:text-white`}>
        {s.identityName || s.identityId}
        {s.ties > 1 && (
          <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            {s.ties} candidates tied
          </span>
        )}
      </td>
      <td className={`${CELL} font-mono text-gray-700 dark:text-gray-300`}>{s.confidence}%</td>
      <td className={CELL}>
        <span className="inline-flex flex-wrap gap-1">
          {(s.signals || []).map(sig => (
            <span key={sig}
              className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
              {sig}
            </span>
          ))}
        </span>
      </td>
    </tr>
  );
}

export default function NameOnlyMatchesCard({ refreshKey = 0 }) {
  const { authFetch } = useAuth();
  const { data: run, loading, error, reload } = useFetch('/api/account-linking/runs', {
    authFetch,
    transform: latestNameOnlyRun,
  });

  // A finished run changes the answer, so the parent bumps refreshKey when one completes.
  useEffect(() => { if (refreshKey) reload(); }, [refreshKey, reload]);

  const suggestions = run?.nameOnlySuggestions ?? [];
  const truncated = (run?.nameOnlyMatches ?? 0) - suggestions.length;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">
        Name-only matches (held for review)
      </h3>
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
        Accounts the last run would have linked on name signals alone. They are still in the
        Orphaned Accounts context — link or dismiss one from the identity it was matched to.
      </p>

      {loading && <p className="text-xs text-gray-600 dark:text-gray-400">Loading…</p>}
      {error && (
        <p className="text-xs text-red-700 dark:text-red-300">Could not load the last run ({error.message}).</p>
      )}

      {!loading && !error && suggestions.length === 0 && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {run
            ? 'The last run held nothing back — every link it made had a second signal.'
            : 'No completed run has reported name-only matches yet.'}
        </p>
      )}

      {suggestions.length > 0 && (
        <>
          <table className="w-full text-xs" aria-label="Name-only matches held for review">
            <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-700 dark:text-gray-200">
              <tr>
                <th scope="col" className={`${CELL} text-left font-semibold`}>Account</th>
                <th scope="col" className={`${CELL} text-left font-semibold`}>Matched identity</th>
                <th scope="col" className={`${CELL} text-left font-semibold`}>Confidence</th>
                <th scope="col" className={`${CELL} text-left font-semibold`}>Signals</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map(s => <SuggestionRow key={`${s.principalId}:${s.identityId}`} s={s} />)}
            </tbody>
          </table>
          {truncated > 0 && (
            <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-2">
              Showing {suggestions.length} of {run.nameOnlyMatches} — {truncated} more were held back but not listed.
            </p>
          )}
        </>
      )}
    </div>
  );
}

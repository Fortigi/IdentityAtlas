// Admin → Account Linking → "Name-only matches (held for review)".
//
// Read-only. Account linking refuses to attach an account to a person on a display name
// somebody else answers to at the level the match rests on, because a namesake — or, where
// nobody is spelled the name at all, an owner whose name is spelled slightly differently —
// produces a confidently wrong link. Counting the refusals is not enough to act on them,
// so each run also records WHICH account nearly linked to WHOM, on what evidence, which
// name the rivals share and who they are; this card shows the newest run's list.
//
// There is deliberately no confirm/reject action here: a reviewable link object is its own
// feature (it would have to not act as linked while awaiting review). The analyst acts
// through the existing per-account controls on the identity page.

import { useEffect } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { latestNameOnlyRun } from '@ui/utils/accountLinkingRuns';

const CELL = 'px-3 py-2 align-top';

/**
 * What the rivals of an ambiguous hold actually share with the account, which is not the
 * same finding in the two cases: at `full` they are spelled exactly its name, at
 * `surnameInitial` the account is an exact match for nobody and they merely share its
 * surname and first initial. One sentence for both would send the analyst looking for a
 * namesake who does not exist. A run stored before the level was recorded cannot say
 * which, so it keeps the wording that makes no claim either way.
 */
const SHARED_NAME = {
  full: 'full name also answered to by',
  surnameInitial: 'surname and first initial also shared by',
};

/**
 * Why the match was held, which is what tells the analyst what to do with it: a name
 * somebody else answers to needs the right person picking, a login numbered away from
 * the person it names needs the *other* holder of that name finding, and a name nobody
 * contests is held only because this tenant asks every link for a second signal.
 */
function WhyHeld({ s }) {
  if (s.reason === 'numberedLogin') {
    return (
      <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
        numbered login — the un-numbered form is this person’s own address
      </div>
    );
  }
  if (s.reason !== 'ambiguousName') {
    return <div className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">no second signal</div>;
  }
  const rivals = s.rivals || [];
  const unlisted = (s.rivalCount ?? rivals.length) - rivals.length;
  return (
    <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
      {SHARED_NAME[s.matchLevel] || 'name also answered to by'}
      {' '}
      {rivals.map(r => r.identityName || r.identityId).join(', ') || 'another identity'}
      {unlisted > 0 && ` and ${unlisted} more`}
    </div>
  );
}

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
        <WhyHeld s={s} />
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
        Accounts the last run matched on a name alone and did not link. They are still in the
        Orphaned Accounts context — link or dismiss one from the identity it was matched to.
      </p>

      {loading && <p className="text-xs text-gray-600 dark:text-gray-400">Loading…</p>}
      {error && (
        <p className="text-xs text-red-700 dark:text-red-300">Could not load the last run ({error.message}).</p>
      )}

      {!loading && !error && suggestions.length === 0 && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {run
            ? 'The last run held nothing back — every name it matched on identified one person.'
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

import { useEffect } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useContextClaims } from './claimsContext';
import { InterviewRole } from './MemberInterviewFacts';
import { earlierStintText, entitlementText, factClass, factTitle, LEFT_WORDS, memberRowId, rejoinedTitle } from './memberInterview.helpers';
import { periodLabel, sourceLabel } from './claims.helpers';

// ─── Previous members — who the interviews say left ───────────────────────
// Below the current members: the people whose latest membership claim — or a
// role claim that says so ("recently left") — says they left or used to work
// on it, and who are not a member now (GET
// /api/contexts/:id/previous-members). Each with their role there, when they
// left as said, the interview it comes from, and — matched to an account or a
// person — what they STILL hold: their live entitlements, and how many of
// those are on this context's resources (its own, or a resources variant's;
// highlighted when there are any). The question it answers: "does this person
// still have access?". A name the interviews gave but nobody matched is shown
// as said, with "no account found" and no counts. A person who left once and came
// back is listed for the EARLIER stint ("Junior developer (earlier period)"), with
// "now a member again" pointing at their row in the members list above (the API's
// stint 'earlier'). Proposed claims read dashed and italic; confirming
// one never changes the members (they come from their source). A reader is
// sent confirmed claims only (the API decides). Nothing when nobody left.

const CELL = 'py-1.5 pr-3 align-baseline';

function NameCell({ person, onOpenDetail }) {
  const kind = person.principalId ? 'user' : person.identityId ? 'identity' : null;
  const id = person.principalId || person.identityId;
  if (!kind || !onOpenDetail) return <span className="text-gray-900 dark:text-gray-100">{person.displayName}</span>;
  return (
    <button type="button" className="text-left text-blue-700 hover:underline dark:text-blue-300" onClick={() => onOpenDetail(kind, id, person.displayName)}>
      {person.displayName}
    </button>
  );
}

// Scrolls to the person's current row in the members list, and marks it for a moment.
function showCurrentRow(id) {
  const row = document.getElementById(memberRowId(id));
  if (!row) return;
  row.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  row.classList.add('bg-sky-50', 'dark:bg-sky-900/30');
  setTimeout(() => row.classList.remove('bg-sky-50', 'dark:bg-sky-900/30'), 2000);
}

function NowMemberCell({ person }) {
  const id = person.principalId || person.identityId;
  if (!person.nowMember || !id) return <span className="text-xs text-gray-600 dark:text-gray-400">back again, says the interview</span>;
  return (
    <button type="button" data-testid="previous-member-now-member" onClick={() => showCurrentRow(id)}
      className="text-xs text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">now a member again</button>
  );
}

// The Role / Left cells of a row: the role then and when they left — or, for an
// earlier stint, the roles they had then and the claim that says they came back.
function StintCells({ person }) {
  if (person.stint === 'earlier') {
    return (
      <>
        <td className={CELL}>
          <span data-testid="previous-member-earlier" title={rejoinedTitle(person.rejoined)}
            className={`text-gray-700 dark:text-gray-300 ${factClass(person.rejoined.status)}`}>{earlierStintText(person)}</span>
        </td>
        <td className={`${CELL} text-xs text-gray-700 dark:text-gray-300`}>left, came back</td>
      </>
    );
  }
  return (
    <>
      <td className={CELL}><InterviewRole role={person.role} /></td>
      <td className={CELL}>
        <span className={`text-gray-700 dark:text-gray-300 ${factClass(person.left.status)}`} title={factTitle(person.left)}>
          {LEFT_WORDS[person.left.membershipStatus] || person.left.membershipStatus}{periodLabel(person.left) ? ` (${periodLabel(person.left)})` : ''}
        </span>
      </td>
    </>
  );
}

function AccessCell({ person, linkedResources }) {
  const live = entitlementText(person.liveEntitlements);
  if (live === null) return <span className="text-xs text-gray-600 dark:text-gray-400">no account found</span>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="tabular-nums text-gray-700 dark:text-gray-300" data-testid="previous-member-live">{live}</span>
      {linkedResources > 0 && person.linkedEntitlements > 0 && (
        <span className="rounded bg-red-50 px-1.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300" data-testid="previous-member-linked">
          {person.linkedEntitlements} on this application
        </span>
      )}
      {person.accountDeleted && <span className="text-xs text-gray-600 dark:text-gray-400">account removed</span>}
    </span>
  );
}

export default function PreviousMembers({ contextId, onOpenDetail }) {
  const ctx = useContextClaims();
  const { authFetch } = useAuth();
  const { data, reload } = useFetch(ctx ? `/api/contexts/${contextId}/previous-members` : null, { authFetch, initialData: { data: [], linkedResources: 0 } });
  const version = ctx?.rolesVersion;
  useEffect(() => { if (version) reload(); }, [version, reload]);

  const people = data?.data || [];
  if (!ctx || people.length === 0) return null;
  return (
    <section aria-label="Previous members" className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Previous members ({people.length})</h3>
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">People the interviews say left — and what they still hold — and the earlier stint of anyone who came back.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="hidden sm:table-header-group">
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Role</th>
              <th className="pb-2 font-medium">Left</th>
              <th className="pb-2 font-medium">Source</th>
              <th className="pb-2 font-medium">Still has access</th>
            </tr>
          </thead>
          <tbody>
            {people.map(p => (
              <tr key={p.key} data-testid="previous-member" data-stint={p.stint || 'left'} className="flex flex-wrap gap-x-3 border-b border-gray-100 dark:border-gray-700 sm:table-row">
                <td className={`w-full sm:w-auto ${CELL}`}><NameCell person={p} onOpenDetail={onOpenDetail} /></td>
                <StintCells person={p} />
                <td className={`${CELL} text-xs text-gray-600 dark:text-gray-400`}>{sourceLabel(p.left || p.rejoined)}</td>
                <td className={CELL}>
                  {p.stint === 'earlier' ? <NowMemberCell person={p} /> : <AccessCell person={p} linkedResources={data.linkedResources} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

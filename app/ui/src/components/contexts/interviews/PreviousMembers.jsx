import { useEffect } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useContextClaims } from './claimsContext';
import { InterviewRole } from './MemberInterviewFacts';
import { entitlementText, factClass, factTitle, LEFT_WORDS } from './memberInterview.helpers';
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
// as said, with "no account found" and no counts. Proposed claims read dashed and italic; confirming
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
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">People the interviews say left — and what they still hold.</p>
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
              <tr key={p.key} data-testid="previous-member" className="flex flex-wrap gap-x-3 border-b border-gray-100 dark:border-gray-700 sm:table-row">
                <td className={`w-full sm:w-auto ${CELL}`}><NameCell person={p} onOpenDetail={onOpenDetail} /></td>
                <td className={CELL}><InterviewRole role={p.role} /></td>
                <td className={CELL}>
                  <span className={`text-gray-700 dark:text-gray-300 ${factClass(p.left.status)}`} title={factTitle(p.left)}>
                    {LEFT_WORDS[p.left.membershipStatus] || p.left.membershipStatus}{periodLabel(p.left) ? ` (${periodLabel(p.left)})` : ''}
                  </span>
                </td>
                <td className={`${CELL} text-xs text-gray-600 dark:text-gray-400`}>{sourceLabel(p.left)}</td>
                <td className={CELL}><AccessCell person={p} linkedResources={data.linkedResources} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import { ReviewRequestsContext, useLoadReviewRequests } from '@ui/contexts/ReviewRequestsContext';
import { formatUtcDay } from '@ui/utils/formatters';
import { requestsByRole, requestsHeadline } from '@ui/components/reviewCampaigns/campaigns';

// ─── "A review is waiting for you" ───────────────────────────────────────
// The first thing an owner sees after signing in when a review campaign asks
// them to review a business role: how many wait, by when, and the roles
// themselves, each opening straight on its review. A role they cannot open
// (the relative permissions give their role no view) is named without a link.

const MAX_SHOWN = 6;
const lower = (v) => String(v ?? '').toLowerCase();

export function ReviewRequestsBanner({ requests, roles, onOpenRole }) {
  if (!requests?.length) return null;
  const byRole = requestsByRole(requests);
  const { what, late, firstDue } = requestsHeadline(byRole);
  const openable = new Map((roles || []).map(r => [lower(r.id), r]));
  const shown = byRole.slice(0, MAX_SHOWN);
  return (
    <section role="status" aria-label="Reviews waiting for you" data-testid="review-requests-banner"
      className="border-b border-amber-300 bg-amber-50 px-6 py-3 text-amber-950 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-semibold">{what}</p>
        <p className="text-sm">
          {late > 0
            ? <span className="font-medium text-red-800 dark:text-red-300">{late === byRole.length ? 'Past the date it was due.' : `${late} past the date ${late === 1 ? 'it was' : 'they were'} due.`}</span>
            : <>Due by {formatUtcDay(firstDue)}.</>}
          {' '}You find them under Role portfolios.
        </p>
      </div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {shown.map((r) => {
          const role = openable.get(lower(r.roleId));
          const label = r.roleName || r.roleId;
          return (
            <li key={r.id}>
              {role ? (
                <button type="button" onClick={() => onOpenRole(role)} title={`${r.campaignName} · due ${formatUtcDay(r.dueAt)}`}
                  className="rounded border border-amber-400 bg-white px-2.5 py-1 text-sm font-medium text-amber-950 hover:bg-amber-100 dark:border-amber-600 dark:bg-gray-800 dark:text-amber-100 dark:hover:bg-gray-700">
                  Review {label}
                </button>
              ) : (
                <span className="inline-block rounded border border-amber-300 px-2.5 py-1 text-sm dark:border-amber-700" title="You cannot open this role yet. Ask an administrator.">
                  {label} <span className="text-xs">(you cannot open this role yet)</span>
                </span>
              )}
            </li>
          );
        })}
        {byRole.length > MAX_SHOWN && <li className="self-center text-sm">and {byRole.length - MAX_SHOWN} more</li>}
      </ul>
    </section>
  );
}

/**
 * Loads what the owner is asked to review, shows the notice above `children`
 * and shares the requests with them (the tree marks the roles, the role page
 * refreshes the notice after a review is signed). `enabled`: Composition review
 * is on — the owner's page provides the flags itself, so it says so.
 */
export default function OwnerReviewRequests({ enabled, roles, onOpenRole, children }) {
  const value = useLoadReviewRequests(enabled);
  return (
    <ReviewRequestsContext.Provider value={value}>
      <ReviewRequestsBanner requests={value.requests} roles={roles} onOpenRole={onOpenRole} />
      {children}
    </ReviewRequestsContext.Provider>
  );
}

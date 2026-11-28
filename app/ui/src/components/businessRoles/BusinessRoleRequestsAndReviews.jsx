// ─── Requests & reviews of a business role ───────────────────────────────
// Everything about checking who has the role and what it holds, on one tab: the
// composition review (the role judged step by step and signed by its owner;
// behind the compositionReview flag) and, for a role people request or that is
// reviewed, its pending requests and access reviews. The policies are on
// Lifecycle, so they are not repeated here.

import AccessPackageGovernance from '@ui/components/AccessPackageGovernance';
import BusinessRoleCompositionReview from './BusinessRoleCompositionReview';

export default function BusinessRoleRequestsAndReviews({ roleId, data, authFetch, showComposition, showRequests, answersForRole, onOpenDetail }) {
  return (
    <div className="space-y-4">
      {showComposition && (
        <section aria-label="Composition review" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Composition review</h3>
          <BusinessRoleCompositionReview roleId={roleId} data={data} onOpenDetail={onOpenDetail} answersForRole={answersForRole} />
        </section>
      )}
      {showRequests && <AccessPackageGovernance accessPackageId={roleId} authFetch={authFetch} showPolicies={false} />}
    </div>
  );
}

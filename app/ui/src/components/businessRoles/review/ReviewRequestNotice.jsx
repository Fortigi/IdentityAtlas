import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { requestLine } from './reviewSteps';

// ─── "You are asked to review this role" ─────────────────────────────────
// On top of a business role's Overview when a review campaign asks the
// signed-in person to review it (the `request` of
// /api/access-package/:id/composition-reviews). One button starts the review.
// Nothing shows for anyone who is not asked.

export default function ReviewRequestNotice({ roleId, onStart }) {
  const { authFetch } = useAuth();
  const { data } = useFetch(`/api/access-package/${encodeURIComponent(roleId)}/composition-reviews`, { authFetch });
  const request = data?.request;
  if (!request || data.canReview !== true) return null;
  return (
    <div role="status" data-testid="review-request-notice"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
      <p><span className="font-semibold">A review is waiting for you.</span> {requestLine(request)}</p>
      <button type="button" onClick={onStart} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800">Start the review</button>
    </div>
  );
}

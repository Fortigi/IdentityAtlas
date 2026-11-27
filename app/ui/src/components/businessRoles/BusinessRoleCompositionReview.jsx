import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { formatDate } from '@ui/utils/formatters';
import { changeText } from './accessModel';
import RoleSnapshot from './RoleSnapshot';
import ReviewWizard from './review/ReviewWizard';
import ReviewRecord from './review/ReviewRecord';
import { findingsCount, outcomeText } from './review/reviewSteps';

// ─── Composition review of a business role ───────────────────────────────
// Somebody walks through the role step by step — who answers for it, its
// lifecycle, the permissions it contains — gives each step a verdict and signs
// (review/ReviewWizard). Every review is an object of its own, kept with who
// signed it, when, what they said per step and a snapshot of the role at that
// moment (RoleSnapshot), so the page shows what was reviewed, what was found and
// what changed since the last review. A review changes nothing on the role.
// Data: /api/access-package/:id/composition-reviews (lib/businessRoleCompositionReview.js).

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const MUTED = 'text-xs text-gray-600 dark:text-gray-400';
const CLEAN = 'border-green-200 bg-green-100 text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300';
const FINDINGS = 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200';

const whoOf = (review) => review.reviewedByName || review.reviewedBy;

function Outcome({ steps }) {
  const clean = findingsCount(steps) === 0;
  return (
    <span data-testid="review-outcome" className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${clean ? CLEAN : FINDINGS}`}>
      Reviewed: {outcomeText(steps)}
    </span>
  );
}

function ReviewStatus({ summary, canWrite, onStart }) {
  const latest = summary.latestReview;
  const changed = latest && changeText(latest.changesSince);
  return (
    <section className={CARD} aria-label="Review status" data-testid="review-status">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {latest ? (
          <p className="text-sm text-gray-900 dark:text-gray-100">
            <span className="mr-2"><Outcome steps={latest.steps} /></span>
            by <span className="font-medium">{whoOf(latest)}</span> on {formatDate(latest.reviewedAt)}.
          </p>
        ) : (
          <p className="text-sm text-gray-800 dark:text-gray-200">Nobody has reviewed this role yet.</p>
        )}
        {canWrite && (
          <button type="button" onClick={onStart}
            className="rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800">
            Review this role
          </button>
        )}
      </div>
      {changed && <p role="alert" className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">{changed}</p>}
    </section>
  );
}

function History({ reviews }) {
  if (reviews.length === 0) return null;
  return (
    <section className={CARD} aria-label="Earlier reviews">
      <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Reviews</h3>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {reviews.map(r => (
          <li key={r.id} className="space-y-2 py-3 first:pt-0 last:pb-0" data-testid="review">
            <p className={MUTED}>
              <span className="font-medium text-gray-900 dark:text-gray-100">{whoOf(r)}</span> · {formatDate(r.reviewedAt)}
              <span className="ml-2"><Outcome steps={r.steps} /></span>
            </p>
            <ReviewRecord steps={r.steps} snapshot={r.snapshot} />
            {r.notes && (
              <div>
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">General comments</p>
                <p className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">{r.notes}</p>
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-xs font-medium text-blue-700 hover:underline dark:text-blue-300">What was reviewed</summary>
              <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"><RoleSnapshot snapshot={r.snapshot} /></div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

const EMPTY = { reviews: [], current: null, latestReview: null, steps: [], verdicts: [] };

export default function BusinessRoleCompositionReview({ roleId, data, onOpenDetail, answersForRole = false }) {
  const { authFetch } = useAuth();
  // Read-only in a shared view, unless it is the owner's own page for a role they answer for.
  const readOnly = useIsSharedView() && !answersForRole;
  const url = `/api/access-package/${encodeURIComponent(roleId)}/composition-reviews`;
  const { data: loaded, loading, error, reload } = useFetch(url, { authFetch });
  const [reviewing, setReviewing] = useState(false);

  async function save(body) {
    try {
      const r = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) return (await r.json().catch(() => ({}))).error || `Could not save the review (HTTP ${r.status})`;
      setReviewing(false);
      reload();
      return null;
    } catch (e) {
      return e.message || 'Could not save the review';
    }
  }

  if (loading && !loaded) return <p className={MUTED}>Loading the reviews…</p>;
  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">The reviews could not be loaded: {error.message}</p>;
  const summary = loaded || EMPTY;
  const steps = summary.steps || [];
  // The API says who may review: the certification permission, or answering for
  // the role while that relative permission is on. Never in a shared view.
  const canWrite = summary.canReview === true && !readOnly && steps.length > 0;
  if (reviewing && canWrite) {
    return (
      <ReviewWizard roleId={roleId} data={data || {}} steps={steps} verdicts={summary.verdicts || []} current={summary.current}
        onSave={save} onCancel={() => setReviewing(false)} onOpenDetail={onOpenDetail} />
    );
  }
  return (
    <div className="space-y-4" data-testid="composition-review">
      <ReviewStatus summary={summary} canWrite={canWrite} onStart={() => setReviewing(true)} />
      <History reviews={summary.reviews} />
    </div>
  );
}

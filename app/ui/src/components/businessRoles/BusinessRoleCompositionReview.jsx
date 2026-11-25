import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { formatDate } from '@ui/utils/formatters';
import { changeText } from './accessModel';
import RoleSnapshot from './RoleSnapshot';

// ─── Composition review of a business role ───────────────────────────────
// Somebody reads what the role contains, writes notes and, when they agree,
// signs it off. Every review is an object of its own, kept with who saved it,
// when, and a snapshot of the role at that moment (RoleSnapshot), so the page
// shows what was reviewed and what changed since the last sign-off.
// Data: /api/access-package/:id/composition-reviews (lib/businessRoleCompositionReview.js).

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const MUTED = 'text-xs text-gray-600 dark:text-gray-400';

const whoOf = (review) => review.reviewedByName || review.reviewedBy;
const resourcesWord = (n) => `${n} resource${n === 1 ? '' : 's'}`;
const resourceCount = (snapshot) => snapshot?.resources?.length ?? 0;

function SignOffStatus({ summary, onOpenResources }) {
  const latest = summary.latestSignOff;
  const changed = latest && changeText(latest.changesSince);
  return (
    <section className={CARD} aria-label="Sign-off" data-testid="sign-off-status">
      {latest ? (
        <p className="text-sm text-gray-900 dark:text-gray-100">
          <span className="mr-2 inline-block rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300">Signed off</span>{' '}
          by <span className="font-medium">{whoOf(latest)}</span> on {formatDate(latest.reviewedAt)}, when it contained {resourcesWord(resourceCount(latest.snapshot))}.
        </p>
      ) : (
        <p className="text-sm text-gray-800 dark:text-gray-200">Nobody has signed off what this role contains yet.</p>
      )}
      {changed && <p role="alert" className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">{changed}</p>}
      <p className={`${MUTED} mt-2`}>
        It contains {resourcesWord(resourceCount(summary.current))} now.{' '}
        <button type="button" onClick={onOpenResources} className="text-blue-700 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300">See the resources</button>
      </p>
    </section>
  );
}

function ReviewForm({ onSave }) {
  const [notes, setNotes] = useState('');
  const [signedOff, setSignedOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const empty = !signedOff && notes.trim() === '';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const problem = await onSave({ notes, signedOff });
    setBusy(false);
    if (problem) { setError(problem); return; }
    setNotes('');
    setSignedOff(false);
  }

  return (
    <form onSubmit={submit} className={`${CARD} space-y-3`} aria-label="Your review">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100">Notes</span>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} maxLength={10000}
          placeholder="What you checked, what you agree with, and any questions"
          className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
      </label>
      <label className="flex items-start gap-2 text-sm text-gray-900 dark:text-gray-100">
        <input type="checkbox" checked={signedOff} onChange={e => setSignedOff(e.target.checked)} className="mt-0.5 rounded" />
        <span><span className="font-medium">Signed off</span> <span className={MUTED}>I have reviewed what this role contains and agree with it.</span></span>
      </label>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={empty || busy}
        className="rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? 'Saving…' : 'Save review'}
      </button>
    </form>
  );
}

function History({ reviews }) {
  if (reviews.length === 0) return null;
  return (
    <section className={CARD} aria-label="Earlier reviews">
      <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Reviews</h3>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {reviews.map(r => (
          <li key={r.id} className="py-2">
            <p className={MUTED}>
              <span className="font-medium text-gray-900 dark:text-gray-100">{whoOf(r)}</span> · {formatDate(r.reviewedAt)}
              {r.signedOff && <span className="ml-2 rounded-full border border-green-200 bg-green-100 px-1.5 text-[11px] font-medium text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300">Signed off</span>}
            </p>
            {r.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">{r.notes}</p>}
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium text-blue-700 hover:underline dark:text-blue-300">What was reviewed</summary>
              <div className="mt-2 rounded border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"><RoleSnapshot snapshot={r.snapshot} /></div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function BusinessRoleCompositionReview({ roleId, onOpenTab }) {
  const { authFetch } = useAuth();
  const readOnly = useIsSharedView();
  const url = `/api/access-package/${encodeURIComponent(roleId)}/composition-reviews`;
  const { data, loading, error, reload } = useFetch(url, { authFetch });

  async function save(body) {
    try {
      const r = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) return (await r.json().catch(() => ({}))).error || `Could not save the review (HTTP ${r.status})`;
      reload();
      return null;
    } catch (e) {
      return e.message || 'Could not save the review';
    }
  }

  if (loading && !data) return <p className={MUTED}>Loading the reviews…</p>;
  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">The reviews could not be loaded: {error.message}</p>;
  const summary = data || { reviews: [], current: null, latestSignOff: null };
  // The API says who may review: the certification permission, or answering for
  // the role while that relative permission is on. Never in a shared view.
  const canWrite = summary.canReview === true && !readOnly;
  return (
    <div className="space-y-4" data-testid="composition-review">
      <SignOffStatus summary={summary} onOpenResources={() => onOpenTab('resources')} />
      {canWrite && <ReviewForm onSave={save} />}
      <History reviews={summary.reviews} />
    </div>
  );
}

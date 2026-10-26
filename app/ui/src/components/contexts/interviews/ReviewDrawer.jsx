import { useEffect, useRef } from 'react';
import { useContextClaims } from './claimsContext';
import ClaimReviewList from './ClaimReviewList';
import { proposedClaims } from './claims.helpers';

// ─── Everything waiting for review, in one drawer ────────────────────────
// Opened from "n to review" in the attention line under the page header: every
// proposed claim of the context — about the unit and about its people — in the
// review list (Confirm / Edit / Reject, the relevance fold, the bulk rejects),
// with "In transcript" beside each quote. The same claims can be decided where
// they show on the page (a person's row in People, What we know); this is the
// one place that walks them all. Escape or the backdrop closes it.

export default function ReviewDrawer({ onClose }) {
  const ctx = useContextClaims();
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const claims = proposedClaims(ctx?.claims);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30 dark:bg-black/60" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="To review" onClick={e => e.stopPropagation()}
        className="h-full w-full max-w-2xl overflow-auto border-l border-gray-200 bg-white px-5 py-4 shadow-xl outline-none dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">To review</h3>
          <button type="button" onClick={onClose} aria-label="Close the review" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">✕</button>
        </div>
        {claims.length === 0
          ? <p className="text-sm text-gray-600 dark:text-gray-400">Nothing left to review.</p>
          : <ClaimReviewList claims={claims} decide={ctx.decide} rejectMany={ctx.rejectMany} openTranscript={ctx.openTranscript} />}
      </div>
    </div>
  );
}

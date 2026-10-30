import { Glyph } from './people/ClaimIcon';

// ─── The analyst's work on this page, in one line under the header ────────
// "2 to decide · 13 to review · 1 to correct in the source", each part a link to
// where that work is done: to decide filters People to the people with an open
// contradiction (or opens What we know when it is about the unit), to review opens
// the review drawer, to correct opens the change requests. Parts with nothing to
// do are left out; with nothing at all, nothing renders. A reader never gets it.

const LINK = 'text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200';

export default function AttentionLine({ toDecide = 0, toReview = 0, toCorrect = 0, onDecide, onReview, onCorrect }) {
  const parts = [
    toDecide > 0 && { key: 'decide', text: `${toDecide} to decide`, onClick: onDecide },
    toReview > 0 && { key: 'review', text: `${toReview} to review`, onClick: onReview },
    toCorrect > 0 && { key: 'correct', text: `${toCorrect} to correct in the source`, onClick: onCorrect },
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p data-testid="attention-line" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
      <Glyph name="warning" className="h-4 w-4" />
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden="true">·</span>}
          <button type="button" onClick={p.onClick} className={LINK}>{p.text}</button>
        </span>
      ))}
    </p>
  );
}

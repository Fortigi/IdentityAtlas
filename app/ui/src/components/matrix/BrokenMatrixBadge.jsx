// The small amber marker on a matrix that names a context somebody deleted.
//
// One component for every list that shows saved matrices, so the marker cannot
// mean one thing in "Open a matrix" and another in the name menu. It renders
// nothing for a healthy matrix, so callers can drop it in unconditionally.
//
// The reason is carried as the accessible name rather than only as a tooltip:
// "broken" on its own tells a screen-reader user nothing about what to do.

import { isMatrixBroken, brokenMatrixTitle } from './matrixHealth';

export default function BrokenMatrixBadge({ row }) {
  if (!isMatrixBroken(row)) return null;
  const title = brokenMatrixTitle(row);
  return (
    <span
      title={title}
      aria-label={title}
      className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
    >
      <span aria-hidden="true">⚠ </span>broken
    </span>
  );
}

// "Share view" — turn the matrix on screen into a link for a business user (#1166).
//
// Distinct from the toolbar's existing "Copy link", which copies the current
// URL and only works for someone who can already build a matrix. This mints a
// share: a stored SNAPSHOT of the filter, managed toggle and display mode, plus
// a one-time token. The recipient needs no Identity Atlas role — they sign in
// with their normal Microsoft account and see the matrix and nothing else.
//
// The button OPENS the dialog but does not own it: MatrixArea does, because the
// three matrix views (and this toolbar with them) are unmounted and remounted
// whenever the data decides a different view should render. See MatrixArea.
//
// Self-gating: renders nothing without `data.share`, so the button doesn't
// advertise a door that would 403 on click.

import { useHasPermission } from '@ui/auth/usePermissions';

export default function ShareMatrixButton({ filter, onShareView }) {
  const canShare = useHasPermission('data.share');

  if (!canShare || !filter || !onShareView) return null;

  return (
    <button
      type="button"
      onClick={onShareView}
      className="px-2 py-1 rounded text-xs font-medium border border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30"
      title="Create a link that shows this matrix to a colleague, read-only"
    >
      Share view…
    </button>
  );
}

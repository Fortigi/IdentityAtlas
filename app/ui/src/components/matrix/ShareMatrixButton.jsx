// "Share view" — turn the matrix on screen into a link for a business user (#1166).
//
// Distinct from the toolbar's existing "Share Link", which copies the current
// URL and only works for someone who can already build a matrix. This mints a
// share: a stored SNAPSHOT of the filter, managed toggle and display mode, plus
// a one-time token. The recipient needs no Identity Atlas role — they sign in
// with their normal Microsoft account and see the matrix and nothing else.
//
// Self-gating: renders nothing without `data.share`, so the button doesn't
// advertise a door that would 403 on click.

import { useState } from 'react';
import { useHasPermission } from '@ui/auth/usePermissions';
import ShareMatrixDialog from './ShareMatrixDialog';

export default function ShareMatrixButton({ filter, managed }) {
  const canShare = useHasPermission('data.share');
  const [open, setOpen] = useState(false);

  if (!canShare || !filter) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-2 py-1 rounded text-xs font-medium border border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30"
        title="Create a link that shows this matrix to a colleague, read-only"
      >
        Share view…
      </button>
      {open && (
        <ShareMatrixDialog
          filter={filter}
          managed={managed}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

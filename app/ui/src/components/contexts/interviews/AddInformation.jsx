import { useState } from 'react';
import { useDialog } from '@ui/components/dialogContext';
import { useContextClaims } from './claimsContext';
import AddInformationModal from './AddInformationModal';

// "Add information" — in the page header and on the Sources section. An
// analyst's move: a reader never sees sources or unreviewed claims
// (docs/architecture/context-interviews.md), so nothing renders for one.
// What the source says lands for review (the ClaimsProvider refreshes); nothing
// is written to the context until then.

const STYLE = {
  primary: 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600 whitespace-nowrap',
  secondary: 'rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/50 whitespace-nowrap',
};

export default function AddInformation({ contextId, variant = 'secondary' }) {
  const ctx = useContextClaims();
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  if (!ctx?.canWrite) return null;

  function added(source) {
    ctx.reload();
    dialog.toast(source.llmConfigured
      ? 'Added. What it says appears for review once it is read.'
      : 'Added. No model is configured: add claims by hand under Sources.', { variant: 'success' });
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={STYLE[variant] || STYLE.secondary}>Add information</button>
      {open && <AddInformationModal contextId={contextId} onAdded={added} onClose={() => setOpen(false)} />}
    </>
  );
}

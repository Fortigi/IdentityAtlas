import { useState } from 'react';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useDialog } from '@ui/components/dialogContext';
import UploadActivityWizard from './UploadActivityWizard';
import { notifyActivityChanged } from './activityEvents';

// Action card: upload an activity export (a time registration, an audit log)
// onto this context. On a root or parent each row lands on the sub-unit it
// names. Analysts only — the registry marks it analystOnly, so a read-only
// shared view never shows it, and a reader without data.write.contexts gets
// nothing here either.

export default function UploadActivityCard({ attrs }) {
  const canWrite = useHasPermission('data.write.contexts');
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;

  function imported(result) {
    setOpen(false);
    notifyActivityChanged(attrs.id);
    const replaced = result.replaced ? `, ${result.replaced} earlier rows replaced` : '';
    dialog.toast(`Imported ${result.imported} activity rows${replaced}.`, { variant: 'success' });
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="action-upload-activity">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Upload activity</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">
        Import who worked on this — hours from a time registration, events from an audit log — to compare with the members.
      </p>
      <button type="button" onClick={() => setOpen(true)}
        className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
        Upload activity…
      </button>
      {open && <UploadActivityWizard attrs={attrs} onClose={() => setOpen(false)} onImported={imported} />}
    </div>
  );
}

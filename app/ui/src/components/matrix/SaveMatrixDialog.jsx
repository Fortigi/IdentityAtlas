// "Save this matrix" — name it, save it (#768/#1202).
//
// One dialog, two hosts: the matrix's Load/Save/Share bar and the wizard's
// Save button. Saving is deliberately a separate verb from Apply — Apply
// changes what is on screen, Save stores it for the org — so the two must not
// drift on what saving asks for or how a name clash reads.
//
// A name that is taken comes back from the API as a 409 and is shown right
// here, under the field, rather than overwriting somebody else's matrix.
//
// When the wizard is editing an existing saved matrix, `target` names it and
// the dialog offers to save the change back to it — and, if people are looking
// at that matrix through a share, says so before the change reaches them.
//
// The strip's name menu reuses it for Rename and Duplicate (#1202): the same
// field and the same inline name-clash error, with its own `title` and
// `saveLabel` and — for a shared matrix being renamed — a `notice` naming who
// will see the change.

import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { liveShareWarning } from './shareState';

export default function SaveMatrixDialog({
  name, onNameChange, onSave, onUpdate, onClose, saving, error, target = null,
  title = 'Save matrix', saveLabel = 'Save as new matrix', notice = '',
}) {
  const warning = target?.shared ? liveShareWarning(target) : '';
  return (
    <Modal title={title} onClose={onClose} width={440} dismissOnBackdrop={false}>
      <p className="text-[11px] text-gray-600 dark:text-gray-400">
        Saved matrices are visible to everyone in the org. The name must be unique.
      </p>
      {notice && (
        <p className="mt-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
          {notice}
        </p>
      )}

      {target && onUpdate && (
        <div className="mt-3 rounded border border-gray-200 p-2 dark:border-gray-700">
          <p className="text-xs text-gray-800 dark:text-gray-200">
            Save these changes to <span className="font-medium">{target.name}</span>?
          </p>
          {/* Recipients track the live matrix — they are not sent a frozen copy —
              so the author is told who this change reaches before it does. */}
          {warning && (
            <p className="mt-1.5 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
              {warning}
            </p>
          )}
          <div className="mt-2 flex justify-end">
            <PrimaryButton onClick={onUpdate} disabled={saving}>
              {saving ? 'Saving…' : `Save changes to ${target.name}`}
            </PrimaryButton>
          </div>
        </div>
      )}

      <Field label={target && onUpdate ? 'Or save as a new matrix' : 'Name'}>
        <input
          type="text"
          aria-label="Matrix name"
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="e.g. HR users · M365 apps"
          autoFocus
          className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
        />
      </Field>
      <ErrorBox message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={saving}>Cancel</SecondaryButton>
        <PrimaryButton onClick={onSave} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : saveLabel}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

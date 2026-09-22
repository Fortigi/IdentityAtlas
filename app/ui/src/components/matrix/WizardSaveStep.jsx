// The Matrix wizard's last step: keep this matrix, and share it (#1202).
//
// "A matrix is a document." Naming it is what saves it: leave the name empty and
// the wizard just shows the matrix; fill it in and the one primary button saves
// (and, with people picked, shares) before showing it. The button itself lives
// in the wizard's footer — its label and behaviour come from saveStepState.js —
// so this step is only the fields.

import { useCanShareMatrix } from '@ui/hooks/useCanShareMatrix';
import WizardShareStep from './WizardShareStep';
import { Disclosure, SectionHeading } from './wizardControls';

const INPUT = 'mt-1 w-full rounded border bg-white px-2 py-1 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500';
const LINK = 'text-xs text-blue-700 hover:underline dark:text-blue-300';

function CopyNotice({ editing, copy, onCopy, onCancelCopy }) {
  if (!editing) return null;
  if (!copy) {
    return <button type="button" onClick={onCopy} className={LINK}>Save as a copy instead</button>;
  }
  return (
    <p className="text-xs text-gray-600 dark:text-gray-400">
      Saving a new copy of <span className="font-medium">{editing.name}</span>.{' '}
      <button type="button" onClick={onCancelCopy} className={LINK}>Save changes to the original instead</button>
    </p>
  );
}

export default function WizardSaveStep({
  save, editing, filter, managed, blocked, onSharingChanged,
}) {
  const canShare = useCanShareMatrix();
  const { name, setName, nameError, description, setDescription, copy, startCopy, cancelCopy, recipients, setRecipients, error } = save;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="wizard-matrix-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label>
        <input
          id="wizard-matrix-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sales team access"
          aria-invalid={!!nameError}
          aria-describedby="wizard-matrix-name-help"
          className={`${INPUT} ${nameError ? 'border-red-400 dark:border-red-500' : 'border-gray-200 dark:border-gray-600'}`}
        />
        {nameError && <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">{nameError}</p>}
        <p id="wizard-matrix-name-help" className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          Leave empty to show it without saving. Saved matrices are visible to everyone in the org.
        </p>
        <div className="mt-1">
          <CopyNotice editing={editing} copy={copy} onCopy={startCopy} onCancelCopy={cancelCopy} />
        </div>
      </div>

      <Disclosure label="Add a description" defaultOpen={!!description}>
        <label htmlFor="wizard-matrix-description" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Description</label>
        <textarea
          id="wizard-matrix-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${INPUT} border-gray-200 dark:border-gray-600`}
        />
      </Disclosure>

      {canShare && (
        <div className="pt-3 border-t border-gray-100 dark:border-gray-700">
          {/* An already-shared matrix says who has it right below, in the
              recipients editor; the introduction would only repeat that. */}
          <SectionHeading hint={editing?.shared && !copy ? null : 'Send it to colleagues who have no Identity Atlas role. They see it read-only, as it stands. Naming the first person saves this matrix and shares it right away.'}>
            Share with
          </SectionHeading>
          <WizardShareStep
            saved={editing}
            copy={copy}
            filter={filter}
            managed={managed}
            recipients={recipients}
            onRecipientsChange={setRecipients}
            onSharingChanged={onSharingChanged}
            blocked={blocked}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">
          {error}
        </p>
      )}
    </div>
  );
}

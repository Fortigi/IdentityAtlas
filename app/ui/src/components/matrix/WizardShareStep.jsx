// The matrix wizard's final step: share what you just built (#1166).
//
// An analyst usually configures a matrix *for* somebody — a team manager, a
// resource owner — so the offer to send it belongs at the end of the same
// sitting, not on a toolbar they have to find afterwards. The step is
// optional: skipping it and pressing Apply is the ordinary path, and Apply
// stays available while the form is open.
//
// The form itself is ShareMatrixForm, shared with the toolbar's dialog — the
// two must not drift on what a share captures or who it is for.

import ShareMatrixForm from './ShareMatrixForm';

export default function WizardShareStep({ filter, managed }) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
          Share this matrix (optional)
        </h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Send this exact view to colleagues who have no Identity Atlas role. Skip this step and
          press Apply if you are only building it for yourself — you can still share it later from
          the matrix toolbar.
        </p>
      </div>
      <ShareMatrixForm filter={filter} managed={managed} />
    </div>
  );
}

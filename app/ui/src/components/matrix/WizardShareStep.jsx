// "Share with" — the sharing half of the Matrix wizard's Save & share step
// (#1166, reworked twice by #1202).
//
// An analyst usually configures a matrix *for* somebody, so the offer to send it
// belongs at the end of the same sitting. What this section shows depends on the
// matrix:
//
//   * already shared (and not being saved as a copy) — who it is shared with,
//     with the same add/remove, copy-link and stop-sharing controls as the
//     matrix bar and Admin. The body is SharePanel in all three places, so they
//     cannot drift.
//   * not shared yet — just the people field. Picking people here does NOT
//     share on its own: the wizard's one primary button saves the matrix and
//     then shares it, so there is never a second "Share" button to find.
//
// Only rendered for a user who may share (useCanShareMatrix).

import SharePanel from './SharePanel';
import { SharePeopleField } from './ShareMatrixForm';

export default function WizardShareStep({
  saved = null, copy = false, filter, managed, recipients, onRecipientsChange, onSharingChanged, blocked = false,
}) {
  if (saved?.shared && !copy) {
    return (
      <SharePanel
        savedFilterId={saved.id}
        savedName={saved.name}
        filter={filter}
        managed={managed}
        onChanged={onSharingChanged}
      />
    );
  }
  // A share can't be adjusted by the person who receives it, so a matrix that is
  // too large to load must not become a link at all — they would have no way out
  // of it. An existing share (above) is still managed: taking somebody off a
  // share must never depend on the matrix loading.
  if (blocked) {
    return (
      <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
        This matrix is too large to load, so there is nothing to share yet. Go back and narrow it
        down — or roll it up by an attribute — to share it.
      </p>
    );
  }
  return <SharePeopleField value={recipients} onChange={onRecipientsChange} />;
}

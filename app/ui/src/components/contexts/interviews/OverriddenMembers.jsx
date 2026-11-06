import { decisionText, overriddenNoteText, overriddenRowText } from './memberInterview.helpers';

// ─── Members a decision marked former, in the members list ───────────────
// The API leaves them out of the current members and says how many it left out
// (GET …/members → overriddenCount); `?includeOverridden=true` lists them too,
// each with `overridden` (the decision). OverriddenNote: "1 marked as former by a
// decision — show", toggling them in. OverriddenFlag: on a revealed row, the
// decision and the source it overrides (the name is struck through by the row).

export function OverriddenNote({ count, shown, onToggle }) {
  if (!count) return null;
  return (
    <p className="mb-2 text-xs text-gray-600 dark:text-gray-400" data-testid="overridden-note">
      {overriddenNoteText(count)}
      {onToggle && (
        <>
          {' — '}
          <button type="button" aria-pressed={shown} onClick={() => onToggle(!shown)}
            className="text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">
            {shown ? 'hide' : 'show'}
          </button>
        </>
      )}
    </p>
  );
}

export function OverriddenFlag({ decision }) {
  if (!decision) return null;
  return (
    <span className="ml-2 rounded bg-gray-100 px-1.5 text-xs text-gray-600 no-underline dark:bg-gray-700 dark:text-gray-300"
      data-testid="overridden-flag" title={decisionText(decision)}>
      {overriddenRowText(decision)}
    </span>
  );
}

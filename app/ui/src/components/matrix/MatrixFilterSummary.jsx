// The one strip above the matrix (#1202):
//
//   [<Matrix name> ▾]  [Unsaved changes]  [Shared with N ▾]  ·····  45 users × 39 resources · 127 assignments  [Adjust]
//
// "A matrix is a document": the left half names it and holds its document verbs
// (MatrixNameBar), the right half is what it selects — three live numbers — and
// the one primary action, Adjust. The scope chips (ROWS / SUBJECTS / RESOURCES)
// and the Load / Save / Share buttons it used to carry are gone: the numbers say
// what the chips said at a glance, the wizard says the rest, and saving and
// sharing happen in the wizard's last step.
//
// `onAdjust(options?)` opens the wizard: with no options on its first step for
// the matrix on screen, with `{ step }` on that step, and with `{ fresh: true }`
// as a brand-new, empty matrix.

import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import MatrixNameBar from './MatrixNameBar';
import { stripCountsLabel } from './MatrixFilterSummary.helpers';

// A share recipient gets the matrix and nothing around it: the strip is analyst
// context (the saved-matrix name, its sharing, Adjust) and is dropped whole —
// which also skips the fetch behind it (#1166).
export default function MatrixFilterSummary(props) {
  if (useIsSharedView()) return null;
  return <FilterSummary {...props} />;
}

function FilterSummary({ filter, preview, onAdjust, onLoadSaved, onShareView }) {
  if (!filter) return null;
  const counts = stripCountsLabel(preview, filter.rowType);

  return (
    <div className="bg-blue-50/30 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <MatrixNameBar filter={filter} onLoad={onLoadSaved} onAdjust={onAdjust} onShare={onShareView} />

      <span className="ml-auto whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">{counts}</span>

      <button
        type="button"
        onClick={() => onAdjust?.()}
        aria-label="Adjust matrix"
        className="px-3 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
      >
        Adjust
      </button>
    </div>
  );
}

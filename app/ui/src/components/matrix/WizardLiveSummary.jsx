// The live counts under every Matrix wizard step: how many subjects × resources
// the current filter selects, how many assignments that is, and whether it can
// be loaded at all. Extracted from MatrixFilterWizard.jsx, which may only shrink.

import {
  WARN_ASSIGNMENTS, BLOCK_ASSIGNMENTS, isServerAggregated, matrixIsBlocked,
} from './MatrixFilterWizard.helpers';

const pctOf = (count, total) => (total > 0 ? Math.round((count / total) * 100) : 0);

function sizeState(filter, rollupOn, assignmentCount) {
  // Server-aggregated views (roll-up / Manager-Hierarchy) return a compact
  // payload, so they load at any size. A flat per-subject matrix ships every
  // row — folding only collapses the render, not the fetch — so an oversized
  // flat matrix is hard-blocked regardless of fold.
  const aggregated = isServerAggregated(filter, rollupOn, assignmentCount);
  const blocked = matrixIsBlocked(filter, rollupOn, assignmentCount);
  return {
    blocked,
    bigAgg: aggregated && assignmentCount > WARN_ASSIGNMENTS,
    large: !aggregated && !blocked && assignmentCount > WARN_ASSIGNMENTS,
  };
}

function tone({ blocked, large }) {
  if (blocked) return { count: 'font-semibold text-red-700 dark:text-red-400', border: 'border-red-300 dark:border-red-700' };
  if (large) return { count: 'font-semibold text-amber-700 dark:text-amber-400', border: 'border-amber-300 dark:border-amber-700' };
  return { count: 'font-semibold text-gray-800 dark:text-gray-200', border: 'border-gray-100 dark:border-gray-700' };
}

export default function WizardLiveSummary({ preview, loading, filter, rollupOn }) {
  const subjectLabel = filter.rowType === 'identity' ? 'identities' : 'users';
  const state = sizeState(filter, rollupOn, preview.assignmentCount);
  const cls = tone(state);

  return (
    <div className={`mt-3 text-xs bg-gray-50 dark:bg-gray-700/30 border rounded px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 ${cls.border} text-gray-600 dark:text-gray-400`}>
      <div>
        <span className="font-semibold text-gray-800 dark:text-gray-200">{preview.subjectCount.toLocaleString()}</span>
        {' '}of {preview.subjectTotal.toLocaleString()} {subjectLabel}
        <span className="text-gray-600 dark:text-gray-400"> · {pctOf(preview.subjectCount, preview.subjectTotal)}%</span>
      </div>
      <div className="text-gray-500 dark:text-gray-400">×</div>
      <div>
        <span className="font-semibold text-gray-800 dark:text-gray-200">{preview.resourceCount.toLocaleString()}</span>
        {' '}of {preview.resourceTotal.toLocaleString()} resources
        <span className="text-gray-600 dark:text-gray-400"> · {pctOf(preview.resourceCount, preview.resourceTotal)}%</span>
      </div>
      <div className="text-gray-500 dark:text-gray-400">·</div>
      <div>
        <span className={cls.count}>{preview.assignmentCount.toLocaleString()}</span>
        {' '}assignments
        {state.blocked && <span className="ml-1 text-red-700 dark:text-red-400">— too large to load as a per-subject grid (folding only collapses the view, not the load). Sort by Manager Hierarchy or roll up by an attribute, or add filters to get below {BLOCK_ASSIGNMENTS.toLocaleString()}.</span>}
        {state.large  && <span className="ml-1 text-amber-700 dark:text-amber-400">— large, consider narrowing</span>}
        {state.bigAgg && <span className="ml-1 text-blue-700 dark:text-blue-400">— aggregated on the server, loads at any size</span>}
      </div>
      {loading && (
        <div className="ml-auto text-[10px] text-gray-600 dark:text-gray-400">updating…</div>
      )}
    </div>
  );
}

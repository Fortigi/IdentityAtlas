// Step 5 of the Risk Profile wizard — kick off a scoring run against the saved
// classifiers and poll its progress. Scoring can also be run later from the
// Risk Scoring page, so this step is optional.

// Status → text colour. Completed is green, failed is red, everything in
// between (queued / running) stays blue.
const STATUS_CLASS = {
  completed: 'text-green-700 dark:text-green-400',
  failed: 'text-red-700 dark:text-red-400',
};
const statusClass = (status) => STATUS_CLASS[status] || 'text-blue-700 dark:text-blue-400';
const isTerminal = (status) => status === 'completed' || status === 'failed';

export default function RiskProfileScoringStep({
  scoring, scoringRun, scoringError, handleStartScoring, onSaved, onClose,
}) {
  const done = () => { onSaved?.(); onClose(); };
  return (
    <div className="space-y-4 max-w-lg">
      <h3 className="text-base font-semibold dark:text-white">Run scoring</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        This applies the saved classifiers to every Principal and Resource and writes the results to the RiskScores table.
        You can also run it later from the Risk Scoring page.
      </p>
      {!scoringRun && !scoring && (
        <div className="flex gap-2">
          <button onClick={handleStartScoring} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
            Run scoring now
          </button>
          <button onClick={done} className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:text-gray-300 dark:hover:bg-gray-700">Done</button>
        </div>
      )}
      {scoringError && <div className="text-sm text-red-700 dark:text-red-400">{scoringError}</div>}
      {scoringRun && (
        <div className="space-y-2">
          <div className="text-sm dark:text-gray-300">
            Status: <span className={`font-semibold ${statusClass(scoringRun.status)}`}>{scoringRun.status}</span>
            {scoringRun.step && <span className="text-gray-500 dark:text-gray-400"> · {scoringRun.step}</span>}
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded h-2">
            <div className="bg-blue-600 h-2 rounded transition-all" style={{ width: `${scoringRun.pct || 0}%` }} />
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{scoringRun.scoredEntities || 0} / {scoringRun.totalEntities || '?'} entities</div>
          {scoringRun.errorMessage && <div className="text-sm text-red-700 dark:text-red-400">{scoringRun.errorMessage}</div>}
          {isTerminal(scoringRun.status) && (
            <button onClick={done} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
              Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}

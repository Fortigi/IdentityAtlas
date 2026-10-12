// Presentational pieces of an extraction run: the live progress panel and the
// run history table. The data comes from RunPanel.
import { formatDate, formatDurationSeconds } from '@ui/utils/formatters';
import { StatusPill, TH, TD, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { isRunActive, progressCount, elapsedSeconds, runResult } from './knowledgeFormat';

const runMode = (run) => run?.details?.config?.mode ?? 'pipeline';

export function RunProgress({ run, canCancel, onCancel }) {
  const pct = Math.max(0, Math.min(100, Number(run.pct) || 0));
  const count = progressCount(run);
  const model = run.details?.model;
  return (
    <div className="space-y-2" aria-label="Extraction progress">
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <StatusPill status={run.status} />
        {run.step && <span>{run.step}</span>}
        {count && <span>{count} passages</span>}
        <span>{pct}%</span>
        {model && <span className="text-gray-600 dark:text-gray-400">model {model}</span>}
        <span className="text-gray-600 dark:text-gray-400">{formatDurationSeconds(elapsedSeconds(run))}</span>
        {canCancel && isRunActive(run) && (
          <button type="button" className={SMALL_BUTTON} onClick={onCancel}>Cancel</button>
        )}
      </div>
      <div role="progressbar" aria-label="Extraction" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
        className="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
        <div className="h-full bg-blue-600 dark:bg-blue-400" style={{ width: `${pct}%` }} />
      </div>
      {!isRunActive(run) && runResult(run) && <p className="text-sm text-gray-700 dark:text-gray-300">{runResult(run)}</p>}
    </div>
  );
}

export function RunHistory({ runs }) {
  if (!runs.length) return <p className="text-xs text-gray-600 dark:text-gray-400">Not extracted yet.</p>;
  return (
    <table className="w-full text-xs" aria-label="Run history">
      <thead>
        <tr>{['Status', 'Mode', 'Model', 'Started', 'Finished', 'Result'].map(h => <th key={h} scope="col" className={TH}>{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
        {runs.map(r => (
          <tr key={r.id}>
            <td className={TD}><StatusPill status={r.status} /></td>
            <td className={TD}>{runMode(r)}</td>
            <td className={TD}>{r.details?.model || '—'}</td>
            <td className={TD}>{formatDate(r.createdAt)}</td>
            <td className={TD}>{formatDate(r.finishedAt)}</td>
            <td className={TD}>{runResult(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

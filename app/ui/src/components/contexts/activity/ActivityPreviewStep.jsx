import { FuzzyMatches, Unmatched, Messages } from '@ui/components/contexts/upload/UploadPreviewStep';
import { membersLine } from '@ui/components/contexts/upload/uploadMapping.helpers';
import { formatDate } from '@ui/utils/formatters';
import { importLine, skippedLine, formatAmount } from './activity.helpers';

// Step "Preview" of Upload activity: what the import would do — the rows it
// imports and the period, rows it skips, how the sub-unit values matched (near
// misses visibly marked, misses with the rows they hold back), how the people
// matched, and which earlier upload of the same source it replaces. The lists
// are the list upload's (UploadPreviewStep.jsx).

const unitMiss = (s) => `${s.reason}${s.rows ? `, ${s.rows} row${s.rows === 1 ? '' : 's'}` : ''}`;
const personMiss = (s) => s.reason;

export default function ActivityPreviewStep({ preview }) {
  if (!preview) return <p className="text-xs text-gray-600 dark:text-gray-400">Working out what would change…</p>;
  const skipped = skippedLine(preview.skipped);
  return (
    <div className="space-y-3 text-xs">
      <div className="rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-700/50">
        <div className="font-semibold text-gray-900 dark:text-gray-100" data-testid="activity-import-line">{importLine(preview)}</div>
        {preview.period && <div className="mt-1 text-gray-700 dark:text-gray-300">Period: {preview.period.start} – {preview.period.end}</div>}
        {preview.contexts && <div className="mt-1 text-gray-700 dark:text-gray-300" data-testid="activity-units">Sub-units: {membersLine(preview.contexts)}{preview.contexts.emptyRows ? ` · ${preview.contexts.emptyRows} rows without one` : ''}</div>}
        <div className="mt-1 text-gray-700 dark:text-gray-300" data-testid="activity-people">People: {membersLine(preview.subjects)}</div>
        {skipped && <div className="mt-1 text-gray-700 dark:text-gray-300" data-testid="activity-skipped">Skipped: {skipped}</div>}
      </div>
      {preview.replaces?.rows > 0 && (
        <Messages tone="warning" title={`Replaces ${preview.replaces.rows} rows of earlier uploads of this source in the same period`}
          items={preview.replaces.uploads.map(u => `${u.fileName} (${formatDate(u.uploadedAt)}): ${u.rows} rows`)} />
      )}
      {preview.rowsToImport === 0 && <Messages tone="error" title="Nothing to import" items={['No row lands on a context: check the sub-unit, date, amount and person columns.']} />}
      <FuzzyMatches title="Sub-units matched by a near miss" samples={preview.contexts?.fuzzySamples} testId="activity-fuzzy-units" />
      <FuzzyMatches title="People matched by a near miss" samples={preview.subjects?.fuzzySamples} testId="activity-fuzzy-people" />
      <Unmatched title="Sub-unit values that matched nothing (their rows are not imported)" samples={preview.contexts?.unmatchedSamples} describe={unitMiss} />
      <Unmatched title="People not found (imported as unknown people)" samples={preview.subjects?.unmatchedSamples} describe={personMiss} />
      {preview.sample?.length > 0 && (
        <details>
          <summary className="cursor-pointer text-gray-700 dark:text-gray-300">The first rows</summary>
          <ul className="mt-1 pl-4 text-gray-700 dark:text-gray-300">
            {preview.sample.map((r, i) => (
              <li key={`${i}:${r.date}:${r.subject}`}>{r.date} · {r.context} · {r.subject} · {formatAmount(r.amount, preview.unit)}{r.kind ? ` · ${r.kind}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

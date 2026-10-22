import { countsLine, membersLine } from './uploadMapping.helpers';
import { memberKindLabel } from '@ui/utils/contextStyles';

// Step "Preview": what the import would do — units new / changed / unchanged /
// not in this file, how the members matched (with the first values that did
// not), rows that stop the import, and for a list uploaded before the choice
// to remove units the file no longer has.

export default function UploadPreviewStep({ preview, updating, removeMissing, onRemoveMissing }) {
  if (!preview) return <p className="text-xs text-gray-600 dark:text-gray-400">Working out what would change…</p>;
  return (
    <div className="space-y-3 text-xs">
      <div className="rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-700/50">
        <div className="font-semibold text-gray-900 dark:text-gray-100">{preview.unitCount} units in {preview.trees.length === 1 ? 'one tree' : `${preview.trees.length} trees`}</div>
        <div className="mt-1 text-gray-700 dark:text-gray-300" data-testid="upload-counts">{countsLine(preview.contexts)}</div>
        <div className="mt-1 text-gray-700 dark:text-gray-300" data-testid="upload-members">Members: {membersLine(preview.members)}</div>
        {preview.trees.length > 1 && <p className="mt-1 text-gray-600 dark:text-gray-400">Each unit is linked to its twin in the other tree.</p>}
      </div>
      <Messages title="These rows stop the import" items={preview.errors} tone="error" />
      <Messages title="Warnings" items={preview.warnings} tone="warning" />
      <Unmatched samples={preview.members?.unmatchedSamples} />
      {updating && (
        <label className="flex items-start gap-2 text-gray-800 dark:text-gray-200">
          <input type="checkbox" checked={removeMissing} onChange={e => onRemoveMissing(e.target.checked)} className="mt-0.5" />
          <span>
            Remove units no longer in the file
            <span className="block text-[11px] text-gray-600 dark:text-gray-400">
              {preview.contexts.notInFile ? `${preview.contexts.notInFile} unit(s) of this list are not in the file. ` : ''}Unticked, they are kept as they are.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

const TONES = {
  error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
};

function Messages({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <div className={`rounded border px-3 py-2 ${TONES[tone]}`}>
      <div className="font-medium">{title}</div>
      <ul className="mt-1 list-disc pl-4">{items.map(m => <li key={m}>{m}</li>)}</ul>
    </div>
  );
}

function Unmatched({ samples }) {
  if (!samples?.length) return null;
  return (
    <details>
      <summary className="cursor-pointer text-gray-700 dark:text-gray-300">Members that matched nothing ({samples.length}{samples.length === 50 ? '+' : ''})</summary>
      <ul className="mt-1 max-h-40 overflow-auto pl-4 text-gray-700 dark:text-gray-300">
        {samples.map(s => (
          <li key={`${s.kind}:${s.value}`}>
            {s.value} <span className="text-gray-600 dark:text-gray-400">— {memberKindLabel(s.kind).toLowerCase()}, {s.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

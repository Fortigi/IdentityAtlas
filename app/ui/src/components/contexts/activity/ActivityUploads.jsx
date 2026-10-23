import { formatDate } from '@ui/utils/formatters';
import { uploadLine } from './activity.helpers';

// The upload history of a context's activity, newest first: the uploads made
// on it, and those made on a context above it that put rows here (named so).
// Undo is offered to an analyst on the context the upload was made on.

export default function ActivityUploads({ uploads, contextId, canUndo, onUndo, busyId }) {
  if (!uploads?.length) return null;
  return (
    <details className="text-xs" data-testid="activity-uploads">
      <summary className="cursor-pointer font-medium text-gray-800 dark:text-gray-200">Uploads ({uploads.length})</summary>
      <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
        {uploads.map(u => (
          <li key={u.id} className="flex items-start justify-between gap-2 py-1">
            <span className="text-gray-800 dark:text-gray-200">
              {uploadLine(u)}
              <span className="block text-[11px] text-gray-600 dark:text-gray-400">
                {formatDate(u.uploadedAt)}{u.uploadedBy ? ` by ${u.uploadedBy}` : ''}{u.contextId !== contextId ? ` · uploaded on ${u.contextName}` : ''}
              </span>
            </span>
            {canUndo && u.contextId === contextId && (
              <button type="button" onClick={() => onUndo(u)} disabled={busyId === u.id}
                className="shrink-0 rounded border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
                Undo
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

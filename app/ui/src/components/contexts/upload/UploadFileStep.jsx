import { Field } from '@ui/components/contexts/ModalPrimitives';
import { formatDate } from '@ui/utils/formatters';

// Step "File": the list to upload, and whether it updates a list uploaded before.
// Re-importing the same list updates its units instead of making a new tree.

const INPUT = 'w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600';

export default function UploadFileStep({ file, onFile, lists, listId, onChooseList, locked }) {
  return (
    <div className="space-y-3">
      <Field label="File" help="A .csv (comma, semicolon or tab separated) or an Excel .xlsx; the first sheet is read. One row per unit, with a header row.">
        <input
          type="file"
          accept=".csv,.txt,.xlsx"
          aria-label="List file"
          onChange={e => onFile(e.target.files?.[0] || null)}
          className="mt-1 block w-full text-sm text-gray-700 dark:text-gray-300"
        />
      </Field>
      {file && <p className="text-xs text-gray-600 dark:text-gray-400">Chosen: <span className="font-medium text-gray-900 dark:text-gray-100">{file.name}</span></p>}
      <Field label="Update an existing list" help="Pick a list you uploaded before to update its units instead of creating a new tree.">
        <select
          aria-label="Update an existing list"
          value={listId}
          disabled={locked}
          onChange={e => onChooseList(e.target.value)}
          className={`${INPUT} mt-1 disabled:opacity-60`}
        >
          <option value="">No — this is a new list</option>
          {lists.map(l => (
            <option key={l.id} value={String(l.id)}>
              {l.displayName.replace(/ \(upload\)$/, '')} · last {l.fileName} on {formatDate(l.uploadedAt)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
